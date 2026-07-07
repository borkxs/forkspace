import type {
  CommandResult,
  Config,
  EnvironmentDef,
  InstanceRecord,
  OutputLine,
  State,
} from "./types";
import { DEMO_CONFIG } from "./config";
import { effectiveNs, nsDashFor } from "@forkspace/ns";
import { allocateSlot, portFor } from "./ports";

export function instanceKey(env: string, fork: string | null): string {
  return fork ? `${env}.${fork}` : env;
}

export function projectName(workspace: string, env: string, fork: string | null): string {
  return fork ? `fs-${workspace}-${env}-${fork}` : `fs-${workspace}-${env}`;
}

export function envFileName(env: string, fork: string | null): string {
  return fork ? `.env.forkspace.${env}.${fork}` : `.env.forkspace.${env}`;
}

function out(text: string): OutputLine {
  return { kind: "stdout", text };
}

function err(text: string): OutputLine {
  return { kind: "stderr", text };
}

function warn(text: string): OutputLine {
  return { kind: "warn", text };
}

function envOut(text: string): OutputLine {
  return { kind: "env", text };
}

function ok(lines: OutputLine[]): CommandResult {
  return { lines, exitCode: 0 };
}

function fail(lines: OutputLine[]): CommandResult {
  return { lines, exitCode: 1 };
}

function containerIsolated(
  name: string,
  env: EnvironmentDef,
  isolateSet: Set<string> | null
): boolean {
  if (isolateSet) return isolateSet.has(name);
  return env.services[name].isolation === "container";
}

function takenSlots(state: State, envName: string): Set<number> {
  const slots = new Set<number>();
  for (const inst of Object.values(state.instances)) {
    if (inst.env === envName) slots.add(inst.slot);
  }
  return slots;
}

function validateForkName(fork: string): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(fork)) {
    return `Invalid fork name "${fork}". Use [A-Za-z0-9._-]+`;
  }
  if (fork.length > 32) return `Fork name too long (max 32 chars)`;
  if (fork.includes("/") || fork.includes("\\")) return `Fork name cannot contain path separators`;
  return null;
}

function substituteTemplate(
  template: string,
  host: string,
  port: number,
  ns: string,
  nsDash: string
): string {
  return template
    .replace(/\{host\}/g, host)
    .replace(/\{port\}/g, String(port))
    .replace(/\{ns\}/g, ns)
    .replace(/\{_ns\}/g, ns ? `_${ns}` : "")
    .replace(/\{ns_\}/g, ns ? `${ns}_` : "")
    .replace(/\{nsdash\}/g, nsDash)
    .replace(/\{_nsdash\}/g, nsDash ? `-${nsDash}` : "")
    .replace(/\{nsdash_\}/g, nsDash ? `${nsDash}-` : "");
}

function renderEnvFile(opts: {
  env: string;
  fork: string | null;
  project: string;
  ns: string;
  nsDash: string;
  envDef: EnvironmentDef;
  ports: Record<string, number>;
  containerNames: string[];
  isolateSet: Set<string> | null;
  baseline?: InstanceRecord;
}): string {
  const { env, fork, project, ns, nsDash, envDef, ports, containerNames, isolateSet, baseline } =
    opts;
  const lines: string[] = [
    `FORKSPACE_ENV=${env}`,
    `FORKSPACE_FORK=${fork ?? ""}`,
    `FORKSPACE_NS=${ns}`,
    `FORKSPACE_NS_DASH=${nsDash}`,
    `FORKSPACE_PROJECT=${project}`,
    `FORKSPACE_INVOKE_DIR=~/git/sb`,
  ];

  if (envDef.baselineNs) {
    lines.push(`FORKSPACE_BASELINE_NS=${envDef.baselineNs}`);
  }

  for (const [name, def] of Object.entries(envDef.services)) {
    const useForkPort = !fork || containerIsolated(name, envDef, isolateSet);
    const hostPort = useForkPort
      ? ports[name]
      : (baseline?.ports[name] ?? portFor(def.basePort, 0, 10));
    lines.push(`FORKSPACE_${name.toUpperCase()}_HOST=127.0.0.1`);
    lines.push(`FORKSPACE_${name.toUpperCase()}_PORT=${hostPort}`);
    for (const [key, template] of Object.entries(def.exports)) {
      lines.push(
        `${key}=${substituteTemplate(template, "127.0.0.1", hostPort, ns, nsDash)}`
      );
    }
  }

  if (envDef.allocations) {
    for (const [name, alloc] of Object.entries(envDef.allocations)) {
      const slot = fork
        ? Object.values(opts.ports).length > 0
          ? Math.round((ports[name] - alloc.basePort) / 10)
          : 0
        : 0;
      const hostPort = ports[name] ?? portFor(alloc.basePort, slot, 10);
      lines.push(`FORKSPACE_${name.toUpperCase()}_PORT=${hostPort}`);
    }
  }

  if (fork && baseline) {
    lines.push(`FORKSPACE_BASELINE_NS=${baseline.ns}`);
    for (const [name, port] of Object.entries(baseline.ports)) {
      lines.push(`FORKSPACE_BASELINE_${name.toUpperCase()}_HOST=127.0.0.1`);
      lines.push(`FORKSPACE_BASELINE_${name.toUpperCase()}_PORT=${port}`);
    }
  }

  return lines.join("\n") + "\n";
}

export interface Simulator {
  config: Config;
  state: State;
  hasConfigFile: boolean;
  engineNamespaces: Record<string, string[]>;
}

export function createSimulator(): Simulator {
  return {
    config: structuredClone(DEMO_CONFIG),
    state: { instances: {} },
    hasConfigFile: true,
    engineNamespaces: { test: ["main", "agent_a", "agent_b"] },
  };
}

export function resetSimulator(sim: Simulator, opts?: { freshWorkspace?: boolean }): void {
  sim.state = { instances: {} };
  sim.config = structuredClone(DEMO_CONFIG);
  sim.engineNamespaces = { test: ["main", "agent_a", "agent_b"] };
  sim.hasConfigFile = !opts?.freshWorkspace;
}

export interface ParsedCommand {
  command: string;
  args: string[];
  options: Record<string, string | boolean>;
}

export function parseCliInput(input: string): ParsedCommand | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const parts = trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
  if (!parts || parts[0] !== "forkspace") return null;

  const command = parts[1] ?? "";
  const args: string[] = [];
  const options: Record<string, string | boolean> = {};

  for (let i = 2; i < parts.length; i++) {
    const p = parts[i].replace(/^["']|["']$/g, "");
    if (p.startsWith("--")) {
      const eq = p.indexOf("=");
      if (eq > 0) {
        options[p.slice(2, eq)] = p.slice(eq + 1);
      } else if (p.startsWith("--no-")) {
        options[p.slice(5)] = false;
      } else {
        const next = parts[i + 1];
        if (next && !next.startsWith("-")) {
          options[p.slice(2)] = next.replace(/^["']|["']$/g, "");
          i++;
        } else {
          options[p.slice(2)] = true;
        }
      }
    } else if (p.startsWith("-") && p.length === 2) {
      options[p.slice(1)] = true;
    } else {
      args.push(p);
    }
  }

  return { command, args, options };
}

export function runCommand(sim: Simulator, parsed: ParsedCommand): CommandResult {
  switch (parsed.command) {
    case "up":
      return cmdUp(sim, parsed.args[0], parsed.options);
    case "down":
      return cmdDown(sim, parsed.args[0], parsed.options);
    case "ls":
      return cmdLs(sim, parsed.options);
    case "env":
      return cmdEnv(sim, parsed.args[0], parsed.options);
    case "check":
      return cmdCheck(sim);
    case "init":
      return cmdInit(sim);
    case "prune":
      return cmdPrune(sim, parsed.options);
    case "help":
    case "--help":
    case "-h":
      return cmdHelp(parsed.args[0]);
    case "version":
    case "--version":
    case "-V":
      return ok([out("0.2.0")]);
    default:
      return fail([err(`Error: unknown command '${parsed.command}'`)]);
  }
}

function resolveEnv(sim: Simulator, envName: string): EnvironmentDef | CommandResult {
  const env = sim.config.environments[envName];
  if (!env) {
    const known = Object.keys(sim.config.environments).join(", ");
    return fail([err(`Error: Unknown environment "${envName}". Known: ${known}`)]);
  }
  return env;
}

function cmdUp(
  sim: Simulator,
  envName: string | undefined,
  opts: Record<string, string | boolean>
): CommandResult {
  if (!envName) return fail([err("Error: missing required argument 'env'")]);
  const envResult = resolveEnv(sim, envName);
  if ("lines" in envResult) return envResult;
  const env = envResult;

  const fork = typeof opts.fork === "string" ? opts.fork : null;
  const hooks = opts.hooks !== false;
  const isolateRaw = typeof opts.isolate === "string" ? opts.isolate : undefined;
  const isolateSet = isolateRaw
    ? new Set(isolateRaw.split(",").map((s) => s.trim()))
    : null;

  if (fork) {
    const forkErr = validateForkName(fork);
    if (forkErr) return fail([err(`Error: ${forkErr}`)]);
  }

  const key = instanceKey(envName, fork);
  if (sim.state.instances[key]) {
    const inst = sim.state.instances[key];
    return ok([
      out(`Instance ${key} already exists (project ${inst.project}).`),
      out(
        `Run \`forkspace down ${envName}${fork ? ` --fork ${fork}` : ""}\` first, or use it as-is.`
      ),
    ]);
  }

  const slot = fork
    ? allocateSlot(takenSlots(sim.state, envName), 1)
    : 0;

  const allNames = Object.keys(env.services);
  const containerNames = fork
    ? allNames.filter((n) => containerIsolated(n, env, isolateSet))
    : allNames;

  const baselineDependent = fork
    ? allNames.filter((n) => !containerIsolated(n, env, isolateSet))
    : [];

  if (fork && baselineDependent.length > 0 && !sim.state.instances[envName]) {
    return fail([
      err(
        `Error: Fork "${fork}" depends on baseline services (${baselineDependent.join(", ")}) ` +
          `from "${envName}", which isn't up. Run \`forkspace up ${envName}\` first.`
      ),
    ]);
  }

  const ns = effectiveNs(fork, env.baselineNs);
  const nsDash = fork ? nsDashFor(fork) : "";
  const project = projectName(sim.config.workspace, envName, fork);
  const baseline = sim.state.instances[envName];

  const ports: Record<string, number> = {};
  for (const name of allNames) {
    const def = env.services[name];
    const useForkPort = !fork || containerIsolated(name, env, isolateSet);
    ports[name] = useForkPort
      ? portFor(def.basePort, slot, sim.config.slotSize)
      : (baseline?.ports[name] ?? portFor(def.basePort, 0, sim.config.slotSize));
  }
  if (env.allocations) {
    for (const [name, alloc] of Object.entries(env.allocations)) {
      ports[name] = portFor(alloc.basePort, slot, sim.config.slotSize);
    }
  }

  const backing: "container" | "namespace-only" =
    fork && containerNames.length === 0 ? "namespace-only" : "container";

  const envFile = envFileName(envName, fork);
  const record: InstanceRecord = {
    key,
    env: envName,
    fork,
    slot,
    project,
    ns,
    backing,
    ports,
    services: containerNames,
    envFile,
    createdAt: new Date().toISOString(),
  };

  sim.state.instances[key] = record;

  if (fork && ns) {
    const engineNs = sim.engineNamespaces[envName] ?? [];
    if (!engineNs.includes(ns)) engineNs.push(ns);
    sim.engineNamespaces[envName] = engineNs;
  }

  const lines: OutputLine[] = [
    out(`▲ ${key} → project ${project} (slot ${slot}, ${backing})`),
  ];
  if (ns) lines.push(out(`  ns ${ns}`));
  for (const name of containerNames) {
    lines.push(out(`  ${name.padEnd(12)} :${ports[name]}`));
  }
  if (containerNames.length === 0 && fork) {
    lines.push(out(`  (no container services — namespace-only fork)`));
  }

  lines.push(out(`  env file → ${envFile}`));

  if (hooks) {
    const hookList = fork
      ? [env.hooks?.forkCreate, env.hooks?.seed].filter(Boolean)
      : [env.hooks?.bootstrap, env.hooks?.seed].filter(Boolean);
    for (const cmd of hookList) {
      lines.push(out(`  hook: ${cmd}`));
    }
  }

  lines.push(out(`✓ ${key} is up`));
  return ok(lines);
}

function cmdDown(
  sim: Simulator,
  envName: string | undefined,
  opts: Record<string, string | boolean>
): CommandResult {
  if (!envName) return fail([err("Error: missing required argument 'env'")]);
  const envResult = resolveEnv(sim, envName);
  if ("lines" in envResult) return envResult;
  const env = envResult;

  const fork = typeof opts.fork === "string" ? opts.fork : null;
  const keepVolumes = opts["keep-volumes"] === true;
  const force = opts.force === true;
  const key = instanceKey(envName, fork);
  const inst = sim.state.instances[key];

  if (!inst) {
    return ok([out(`No instance ${key} in state. Nothing to do.`)]);
  }

  if (!fork) {
    const dependents = Object.values(sim.state.instances).filter(
      (i) => i.env === envName && i.fork
    );
    if (dependents.length > 0) {
      return fail([
        err(
          `Error: Baseline "${envName}" has live forks (${dependents.map((d) => d.fork).join(", ")}). Take them down first.`
        ),
      ]);
    }
  }

  const removeVolumes = !env.persistent && !keepVolumes;
  const lines: OutputLine[] = [
    out(`▼ ${key} → project ${inst.project}${removeVolumes ? " (dropping volumes)" : ""}`),
  ];

  if (fork && env.hooks?.forkDestroy && !force) {
    lines.push(out(`  forkDestroy: ${env.hooks.forkDestroy}`));
  } else if (fork && env.hooks?.forkDestroy && force) {
    lines.push(out(`  forkDestroy: skipped (--force)`));
  }

  if (inst.services.length === 0) {
    lines.push(out(`  (no container services to stop)`));
  }

  if (fork && inst.ns) {
    const engineNs = sim.engineNamespaces[envName] ?? [];
    sim.engineNamespaces[envName] = engineNs.filter((n) => n !== inst.ns);
  }

  delete sim.state.instances[key];
  lines.push(out(`✓ ${key} is down`));
  return ok(lines);
}

function cmdLs(sim: Simulator, opts: Record<string, string | boolean>): CommandResult {
  const lines: OutputLine[] = [];
  const ps = opts.ps === true;
  const orphans = opts.orphans === true;

  if (orphans) {
    const hasHook = Object.values(sim.config.environments).some(
      (e) => e.hooks?.listNamespaces
    );
    if (!hasHook) {
      lines.push(
        out(
          "No listNamespaces hook configured. Add hooks.listNamespaces to an environment " +
            "in forkspace.yml to enable orphan detection."
        )
      );
    } else {
      for (const [envName, envDef] of Object.entries(sim.config.environments)) {
        if (!envDef.hooks?.listNamespaces) continue;
        lines.push(out(`${envName}:`));
        const baseline = sim.state.instances[envName];
        if (!baseline) {
          lines.push(out(`  (skipped: baseline not up)`));
          continue;
        }
        const recorded = Object.values(sim.state.instances)
          .filter((i) => i.env === envName && i.fork && i.ns)
          .map((i) => i.ns);
        const engine = sim.engineNamespaces[envName] ?? [envDef.baselineNs ?? ""];
        const engineSet = new Set(engine.filter(Boolean));
        const recordedSet = new Set(recorded);
        const orphanList = [...engineSet].filter((n) => !recordedSet.has(n) && n !== envDef.baselineNs);
        const ghostList = [...recordedSet].filter((n) => !engineSet.has(n));

        if (orphanList.length === 0 && ghostList.length === 0) {
          lines.push(out("  ✓ namespaces in sync"));
        } else {
          for (const ns of orphanList) {
            lines.push(out(`  orphan  ${ns}  (in engine, not in state)`));
          }
          for (const ns of ghostList) {
            lines.push(out(`  ghost   ${ns}  (in state, not in engine)`));
          }
        }
      }
    }
    if (Object.keys(sim.state.instances).length > 0) lines.push(out(""));
  }

  const instances = Object.values(sim.state.instances);
  if (instances.length === 0) {
    lines.push(out("No instances. `forkspace up <env>` to start one."));
    return ok(lines);
  }

  for (const inst of instances) {
    const nsLabel = inst.ns ? `ns=${inst.ns}` : "ns=(baseline)";
    const containerPorts = Object.entries(inst.ports)
      .filter(([name]) => inst.services.includes(name))
      .map(([name, port]) => `${name}:${port}`)
      .join(" ");
    lines.push(
      out(
        `${inst.key.padEnd(20)} slot ${inst.slot}  ${nsLabel.padEnd(16)} ${inst.backing.padEnd(16)} ${inst.project}  ${containerPorts}`
      )
    );
    if (ps) {
      if (inst.services.length > 0) {
        for (const svc of inst.services) {
          lines.push(
            out(
              `    ${svc.padEnd(14)} running   127.0.0.1:${inst.ports[svc]}→${sim.config.environments[inst.env].services[svc]?.containerPort ?? "?"}`
            )
          );
        }
      } else {
        lines.push(out("    (namespace-only — no containers)"));
      }
    }
  }

  return ok(lines);
}

function cmdEnv(
  sim: Simulator,
  envName: string | undefined,
  opts: Record<string, string | boolean>
): CommandResult {
  if (!envName) return fail([err("Error: missing required argument 'env'")]);
  const fork = typeof opts.fork === "string" ? opts.fork : null;
  const key = instanceKey(envName, fork);
  const inst = sim.state.instances[key];
  if (!inst) {
    return fail([err(`Error: No instance ${key}. Run \`forkspace up\` first.`)]);
  }

  const env = sim.config.environments[envName];
  const isolateSet: Set<string> | null = null;
  const containerNames = inst.fork
    ? Object.keys(env.services).filter((n) => containerIsolated(n, env, isolateSet))
    : Object.keys(env.services);
  const baseline = inst.fork ? sim.state.instances[envName] : undefined;

  const content = renderEnvFile({
    env: envName,
    fork: inst.fork,
    project: inst.project,
    ns: inst.ns,
    nsDash: inst.fork ? nsDashFor(inst.fork) : "",
    envDef: env,
    ports: inst.ports,
    containerNames,
    isolateSet,
    baseline,
  });

  return ok([envOut(content)]);
}

function cmdCheck(sim: Simulator): CommandResult {
  if (!sim.hasConfigFile) {
    return fail([err("✗ forkspace.yml not found in workspace root")]);
  }
  const lines: OutputLine[] = [];
  const warnings: string[] = [];

  const testEnv = sim.config.environments.test;
  if (testEnv?.services.mysql?.isolation === "namespace") {
    const tpl = testEnv.services.mysql.exports.DATABASE_URL ?? "";
    if (!tpl.includes("{ns}")) {
      warnings.push(
        'test.mysql: namespace isolation but DATABASE_URL export lacks {ns} template'
      );
    }
  }

  for (const w of warnings) lines.push(warn(`⚠ ${w}`));

  const suffix =
    warnings.length > 0
      ? ` (${warnings.length} warning${warnings.length === 1 ? "" : "s"})`
      : "";
  lines.push(out(`✓ config OK${suffix}`));
  return ok(lines);
}

function cmdInit(sim: Simulator): CommandResult {
  if (sim.hasConfigFile) {
    return fail([err("Error: forkspace.yml already exists here.")]);
  }
  sim.hasConfigFile = true;
  return ok([out("Wrote forkspace.yml. Edit it, then `forkspace check`.")]);
}

function cmdPrune(sim: Simulator, opts: Record<string, string | boolean>): CommandResult {
  const dryRun = opts["dry-run"] === true;
  const stranded = ["fs-acme-test-old-fork", ".env.forkspace.test.old-fork"];

  if (stranded.length === 0) {
    return ok([out("Nothing to prune.")]);
  }

  const lines: OutputLine[] = [];
  for (const item of stranded) {
    lines.push(out(dryRun ? `would remove ${item}` : `removing ${item}`));
  }
  if (!dryRun) {
    lines.push(out(`✓ pruned ${stranded.length} items`));
  }
  return ok(lines);
}

function cmdHelp(sub?: string): CommandResult {
  const help: Record<string, string> = {
    up: "Start an environment (optionally as an isolated fork)\n  forkspace up <env> [--fork <name>] [--isolate <svcs>] [--no-hooks]",
    down: "Stop an instance\n  forkspace down <env> [--fork <name>] [--keep-volumes] [--force]",
    ls: "List instances\n  forkspace ls [--ps] [--orphans]",
    env: "Print env file\n  forkspace env <env> [--fork <name>]",
    check: "Validate forkspace.yml\n  forkspace check",
    init: "Write starter forkspace.yml\n  forkspace init",
    prune: "Remove stranded resources\n  forkspace prune [--dry-run] [--force]",
  };

  if (sub && help[sub]) {
    return ok([out(help[sub])]);
  }

  return ok([
    out("forkspace — isolated local dev/test environments"),
    out(""),
    out("Commands:"),
    ...Object.entries(help).map(([name, desc]) =>
      out(`  ${name.padEnd(8)} ${desc.split("\n")[0]}`)
    ),
  ]);
}

export function buildCliCommand(
  command: string,
  args: Record<string, string | boolean | undefined>
): string {
  const parts = ["forkspace", command];
  for (const [key, val] of Object.entries(args)) {
    if (val === undefined || val === "" || val === false) continue;
    if (val === true) {
      parts.push(`--${key}`);
    } else {
      parts.push(`--${key}`, String(val));
    }
  }
  return parts.join(" ");
}
