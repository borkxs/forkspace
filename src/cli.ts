#!/usr/bin/env node
import { Command } from "commander";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  CONFIG_FILENAME,
  checkConfig,
  findRoot,
  loadConfig,
  type Config,
  type EnvironmentDef,
} from "./config";
import { allocateSlot } from "./ports";
import {
  instanceKey,
  loadState,
  saveState,
  takenSlots,
  type InstanceRecord,
  type State,
} from "./state";
import {
  composeDown,
  composePs,
  composeUp,
  planComposeRuns,
  runHook,
} from "./compose";
import { envToRecord, renderEnvFile, writeEnvFile } from "./env";
import { planInstance, planSlotProbe } from "./plan";

const program = new Command();
program
  .name("forkspace")
  .description("Isolated local dev/test environments for multi-repo compose stacks")
  .version("0.1.0");

function ctx() {
  const root = findRoot(process.cwd());
  const config = loadConfig(root);
  const state = loadState(root);
  return { root, config, state };
}

function resolveEnv(config: Config, envName: string): EnvironmentDef {
  const env = config.environments[envName];
  if (!env) {
    const known = Object.keys(config.environments).join(", ");
    throw new Error(`Unknown environment "${envName}". Known: ${known}`);
  }
  return env;
}

function parseIsolateSet(
  env: EnvironmentDef,
  isolate?: string
): Set<string> | null {
  if (!isolate) return null;
  const isolateSet = new Set(isolate.split(",").map((s) => s.trim()));
  for (const name of isolateSet) {
    if (!env.services[name]) throw new Error(`--isolate: unknown service "${name}"`);
  }
  return isolateSet;
}

export async function doUp(
  root: string,
  config: Config,
  state: State,
  envName: string,
  opts: { fork?: string; isolate?: string; hooks: boolean }
): Promise<void> {
  const env = resolveEnv(config, envName);
  const fork = opts.fork ?? null;
  const key = instanceKey(envName, fork);
  const isolateSet = parseIsolateSet(env, opts.isolate);

  if (state.instances[key]) {
    console.log(`Instance ${key} already exists (project ${state.instances[key].project}).`);
    console.log(`Run \`forkspace down ${envName}${fork ? ` --fork ${fork}` : ""}\` first, or use it as-is.`);
    return;
  }

  const slot = fork
    ? await allocateSlot({
        basePorts: planSlotProbe({ env, fork, isolateSet }),
        slotSize: config.slotSize,
        takenSlots: takenSlots(state, envName),
        minSlot: 1,
      })
    : 0;

  const plan = planInstance({
    config,
    env,
    envName,
    fork,
    state,
    isolateSet,
    slot,
  });

  if (plan.requiresBaseline && !state.instances[envName]) {
    throw new Error(
      `Fork "${fork}" depends on baseline services (${plan.baselineDependentServices.join(", ")}) ` +
        `from "${envName}", which isn't up. Run \`forkspace up ${envName}\` first.`
    );
  }

  console.log(
    `▲ ${plan.key} → project ${plan.project} (slot ${plan.slot}, ${plan.backing})`
  );
  if (plan.ns) console.log(`  ns ${plan.ns}`);
  for (const p of plan.containersToStart) {
    console.log(`  ${p.name.padEnd(12)} :${p.hostPort}`);
  }
  if (plan.containersToStart.length === 0 && fork) {
    console.log(`  (no container services — namespace-only fork)`);
  }

  if (plan.containersToStart.length > 0) {
    const runs = planComposeRuns(root, plan.project, plan.containersToStart);
    for (const run of runs) composeUp(root, run);
  }

  const content = renderEnvFile({
    env: envName,
    fork,
    project: plan.project,
    ns: plan.ns,
    entries: plan.envEntries,
    allocations: plan.allocationEntries,
  });
  const envFile = writeEnvFile(root, envName, fork, content);
  console.log(`  env file → ${envFile}`);

  const record: InstanceRecord = {
    key: plan.key,
    env: envName,
    fork,
    slot: plan.slot,
    project: plan.project,
    ns: plan.ns,
    backing: plan.backing,
    ports: plan.ports,
    services: plan.containerServiceNames,
    envFile,
    createdAt: new Date().toISOString(),
  };
  state.instances[key] = record;
  saveState(root, state);

  if (opts.hooks && plan.hooks.up.length > 0) {
    const hookEnv = envToRecord(content);
    for (const cmd of plan.hooks.up) {
      console.log(`  hook: ${cmd}`);
      runHook(root, cmd, hookEnv);
    }
  }
  console.log(`✓ ${plan.key} is up`);
}

export function doDown(
  root: string,
  config: Config,
  state: State,
  envName: string,
  opts: { fork?: string; keepVolumes?: boolean; force?: boolean }
): void {
  const env = resolveEnv(config, envName);
  const fork = opts.fork ?? null;
  const key = instanceKey(envName, fork);
  const inst = state.instances[key];
  if (!inst) {
    console.log(`No instance ${key} in state. Nothing to do.`);
    return;
  }

  if (!fork) {
    const dependents = Object.values(state.instances).filter(
      (i) => i.env === envName && i.fork
    );
    if (dependents.length > 0) {
      throw new Error(
        `Baseline "${envName}" has live forks (${dependents
          .map((d) => d.fork)
          .join(", ")}). Take them down first.`
      );
    }
  }

  const removeVolumes = !env.persistent && !opts.keepVolumes;
  console.log(`▼ ${key} → project ${inst.project}${removeVolumes ? " (dropping volumes)" : ""}`);

  if (fork && env.hooks.forkDestroy && !opts.force) {
    const envFilePath = path.join(root, inst.envFile);
    if (!existsSync(envFilePath)) {
      throw new Error(`Env file missing: ${inst.envFile}. Use --force to clean up state anyway.`);
    }
    const hookEnv = envToRecord(readFileSync(envFilePath, "utf8"));
    console.log(`  forkDestroy: ${env.hooks.forkDestroy}`);
    try {
      runHook(root, env.hooks.forkDestroy, hookEnv);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${msg} Use \`forkspace down ${envName} --fork ${fork} --force\` to skip forkDestroy.`);
    }
  } else if (fork && env.hooks.forkDestroy && opts.force) {
    console.log(`  forkDestroy: skipped (--force)`);
  }

  if (inst.services.length > 0) {
    composeDown(root, inst.project, removeVolumes);
  } else {
    console.log(`  (no container services to stop)`);
  }

  const overrideDir = path.join(root, ".forkspace", inst.project);
  if (existsSync(overrideDir)) rmSync(overrideDir, { recursive: true });
  const envFilePath = path.join(root, inst.envFile);
  if (existsSync(envFilePath)) rmSync(envFilePath);

  delete state.instances[key];
  saveState(root, state);
  console.log(`✓ ${key} is down`);
}

program
  .command("up")
  .description("Start an environment (optionally as an isolated fork)")
  .argument("<env>", "environment name from forkspace.yml")
  .option("--fork <name>", "start an isolated fork of this environment")
  .option(
    "--isolate <services>",
    "comma-separated services to run as container-isolated for this fork (overrides config isolation)"
  )
  .option("--no-hooks", "skip lifecycle hooks")
  .action(async (envName: string, opts: { fork?: string; isolate?: string; hooks: boolean }) => {
    const { root, config, state } = ctx();
    await doUp(root, config, state, envName, opts);
  });

program
  .command("down")
  .description("Stop an instance (drops volumes unless the environment is persistent)")
  .argument("<env>")
  .option("--fork <name>")
  .option("--keep-volumes", "keep volumes even for non-persistent environments")
  .option("--force", "skip forkDestroy and clean up state anyway")
  .action((envName: string, opts: { fork?: string; keepVolumes?: boolean; force?: boolean }) => {
    const { root, config, state } = ctx();
    doDown(root, config, state, envName, opts);
  });

program
  .command("ls")
  .description("List instances")
  .option("--ps", "also query docker for container status")
  .action((opts: { ps?: boolean }) => {
    const { root, state } = ctx();
    const instances = Object.values(state.instances);
    if (instances.length === 0) {
      console.log("No instances. `forkspace up <env>` to start one.");
      return;
    }
    for (const inst of instances) {
      const ns = inst.ns ?? "";
      const backing = inst.backing ?? (inst.services.length > 0 ? "container" : "namespace-only");
      const containerPorts = Object.entries(inst.ports)
        .filter(([name]) => inst.services.includes(name))
        .map(([name, port]) => `${name}:${port}`)
        .join(" ");
      const nsLabel = ns ? `ns=${ns}` : "ns=(baseline)";
      console.log(
        `${inst.key.padEnd(20)} slot ${inst.slot}  ${nsLabel.padEnd(16)} ${backing.padEnd(16)} ${inst.project}  ${containerPorts}`
      );
      if (opts.ps && inst.services.length > 0) {
        const ps = composePs(root, inst.project);
        console.log(ps ? ps.split("\n").map((l) => `    ${l}`).join("\n") : "    (no containers)");
      } else if (opts.ps) {
        console.log("    (namespace-only — no containers)");
      }
    }
  });

program
  .command("env")
  .description("Print the env file for an instance (eval-able: `source <(forkspace env test --fork a)`)")
  .argument("<env>")
  .option("--fork <name>")
  .action((envName: string, opts: { fork?: string }) => {
    const { root, state } = ctx();
    const key = instanceKey(envName, opts.fork ?? null);
    const inst = state.instances[key];
    if (!inst) throw new Error(`No instance ${key}. Run \`forkspace up\` first.`);
    const file = path.join(root, inst.envFile);
    if (!existsSync(file)) throw new Error(`Env file missing: ${inst.envFile}`);
    process.stdout.write(readFileSync(file, "utf8"));
  });

program
  .command("check")
  .description("Validate forkspace.yml against the workspace (compose files, services, port conflicts)")
  .action(() => {
    const { root, config } = ctx();
    const problems = checkConfig(config, root);
    if (problems.length === 0) {
      console.log("✓ config OK");
      return;
    }
    for (const p of problems) console.error(`✗ ${p}`);
    process.exitCode = 1;
  });

program
  .command("init")
  .description("Write a starter forkspace.yml in the current directory")
  .action(() => {
    if (existsSync(CONFIG_FILENAME)) {
      throw new Error(`${CONFIG_FILENAME} already exists here.`);
    }
    writeFileSync(CONFIG_FILENAME, STARTER_CONFIG);
    console.log(`Wrote ${CONFIG_FILENAME}. Edit it, then \`forkspace check\`.`);
  });

const STARTER_CONFIG = `# forkspace.yml — workspace-level environment definitions
workspace: myapp
slotSize: 10

environments:
  dev:
    persistent: true
    services:
      mysql:
        compose: api/docker-compose.yml
        service: db
        basePort: 3306
        containerPort: 3306
        exports:
          DATABASE_URL: "mysql://root:root@{host}:{port}/app"

  test:
    persistent: false
    allocations:
      app:
        basePort: 4100
    services:
      mysql:
        compose: api/docker-compose.yml
        service: db
        basePort: 3406
        containerPort: 3306
        isolation: namespace   # fork gets its own database namespace
        exports:
          DATABASE_URL: "mysql://root:root@{host}:{port}/{ns}"
      dynamodb:
        compose: api/docker-compose.yml
        service: dynamodb
        basePort: 8100
        containerPort: 8000
        isolation: shared      # forks reuse the baseline instance
    hooks:
      bootstrap: npm run db:create-tables
      seed: npm run db:seed-test
      forkCreate: ./scripts/fork-create.sh
      forkDestroy: ./scripts/fork-destroy.sh
`;

program.parseAsync().catch((err: unknown) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
