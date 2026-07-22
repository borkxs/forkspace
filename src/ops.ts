import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import {
  findRoot,
  loadConfig,
  type Config,
  type EnvironmentDef,
} from "./config.js";
import { allocateSlot } from "./ports.js";
import {
  instanceKey,
  loadState,
  saveState,
  takenSlots,
  type InstanceRecord,
  type State,
} from "./state.js";
import {
  composeDown,
  composePs,
  composeUp,
  listComposeProjects,
  planComposeRuns,
  runHook,
} from "./compose.js";
import { envToRecord, envFileName, renderEnvFile, writeEnvFile } from "./env.js";
import { assertNoForkCollisions, validateForkName } from "./fork.js";
import { withStateLock } from "./lock.js";
import { planInstance, planSlotProbe, type InstancePlan } from "./plan.js";
import {
  formatPrunePlan,
  planPrune,
  pruneNeedsForce,
} from "./prune.js";
import type { OrphanReport } from "./orphans.js";

export function loadWorkspace(cwd: string = process.cwd()) {
  const root = findRoot(cwd);
  const config = loadConfig(root);
  const state = loadState(root);
  return { root, config, state };
}

export function resolveEnv(config: Config, envName: string): EnvironmentDef {
  const env = config.environments[envName];
  if (!env) {
    const known = Object.keys(config.environments).join(", ");
    throw new Error(`Unknown environment "${envName}". Known: ${known}`);
  }
  return env;
}

export function parseIsolateSet(
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

export async function rollbackFailedUp(
  root: string,
  envName: string,
  env: EnvironmentDef,
  plan: InstancePlan,
  fork: string | null,
  composeStarted: boolean
): Promise<void> {
  if (composeStarted) {
    composeDown(root, plan.project, !env.persistent);
  }

  const overrideDir = path.join(root, ".forkspace", plan.project);
  if (existsSync(overrideDir)) rmSync(overrideDir, { recursive: true });

  const envFilePath = path.join(root, envFileName(envName, fork));
  if (existsSync(envFilePath)) rmSync(envFilePath);

  await withStateLock(root, () => {
    const state = loadState(root);
    delete state.instances[plan.key];
    saveState(root, state);
  });
}

export async function doUp(
  root: string,
  config: Config,
  envName: string,
  opts: { fork?: string; isolate?: string; hooks: boolean; noRollback?: boolean }
): Promise<void> {
  const env = resolveEnv(config, envName);
  const fork = opts.fork ?? null;
  const invokeDir = process.cwd();
  if (fork) {
    validateForkName(fork);
  }
  const isolateSet = parseIsolateSet(env, opts.isolate);

  type UpReservation =
    | { kind: "exists"; key: string; project: string; fork: string | null }
    | {
        kind: "created";
        plan: InstancePlan;
        content: string;
        envFile: string;
      };

  const reservation = await withStateLock(root, async (): Promise<UpReservation> => {
    const state = loadState(root);
    const key = instanceKey(envName, fork);

    if (fork) {
      assertNoForkCollisions({
        fork,
        envName,
        workspace: config.workspace,
        state,
        baselineNs: env.baselineNs,
      });
    }

    if (state.instances[key]) {
      return {
        kind: "exists",
        key,
        project: state.instances[key].project,
        fork,
      };
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

    const baseline = state.instances[envName];
    const content = renderEnvFile({
      env: envName,
      fork,
      project: plan.project,
      ns: plan.ns,
      nsDash: plan.nsDash,
      invokeDir,
      entries: plan.envEntries,
      allocations: plan.allocationEntries,
      baseline:
        fork && baseline
          ? { ns: baseline.ns, ports: baseline.ports }
          : undefined,
    });
    const envFile = envFileName(envName, fork);

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

    return { kind: "created", plan, content, envFile };
  });

  if (reservation.kind === "exists") {
    const { key, project, fork: existingFork } = reservation;
    console.log(`Instance ${key} already exists (project ${project}).`);
    console.log(
      `Run \`forkspace down ${envName}${existingFork ? ` --fork ${existingFork}` : ""}\` first, or use it as-is.`
    );
    return;
  }

  const { plan, content, envFile } = reservation;

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

  let composeStarted = false;
  try {
    if (plan.containersToStart.length > 0) {
      const runs = planComposeRuns(root, plan.project, plan.containersToStart);
      for (const run of runs) {
        composeUp(root, run);
        composeStarted = true;
      }
    }

    writeEnvFile(root, envName, fork, content);
    console.log(`  env file → ${envFile}`);
  } catch (err) {
    if (!opts.noRollback) {
      await rollbackFailedUp(root, envName, env, plan, fork, composeStarted);
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`up failed; rolled back started resources for ${plan.key}: ${msg}`);
    }
    throw err;
  }

  if (opts.hooks && plan.hooks.up.length > 0) {
    const hookEnv = envToRecord(content);
    try {
      for (const cmd of plan.hooks.up) {
        console.log(`  hook: ${cmd}`);
        runHook(root, cmd, hookEnv);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  hook failed: ${msg}`);
      await rollbackAfterHookFailure(root, env, fork, plan, envFile);
      throw new Error(`${msg} (rolled back ${plan.key})`);
    }
  }
  console.log(`✓ ${plan.key} is up`);
}

async function rollbackAfterHookFailure(
  root: string,
  env: EnvironmentDef,
  fork: string | null,
  plan: InstancePlan,
  envFile: string
): Promise<void> {
  const rolledBack: string[] = [];

  if (fork && env.hooks.forkDestroy) {
    const envFilePath = path.join(root, envFile);
    if (existsSync(envFilePath)) {
      const hookEnv = envToRecord(readFileSync(envFilePath, "utf8"));
      console.log(`  rollback forkDestroy: ${env.hooks.forkDestroy}`);
      try {
        runHook(root, env.hooks.forkDestroy, hookEnv);
        rolledBack.push("forkDestroy");
      } catch (destroyErr) {
        const msg = destroyErr instanceof Error ? destroyErr.message : String(destroyErr);
        console.error(`  rollback forkDestroy failed: ${msg}`);
      }
    }
  }

  if (plan.containersToStart.length > 0) {
    const removeVolumes = !env.persistent;
    console.log(`  rollback compose down (project ${plan.project})`);
    try {
      composeDown(root, plan.project, removeVolumes);
      rolledBack.push("containers");
    } catch (downErr) {
      const msg = downErr instanceof Error ? downErr.message : String(downErr);
      console.error(`  rollback compose down failed: ${msg}`);
    }
  }

  const overrideDir = path.join(root, ".forkspace", plan.project);
  if (existsSync(overrideDir)) {
    rmSync(overrideDir, { recursive: true });
    rolledBack.push("override dir");
  }

  const envFilePath = path.join(root, envFile);
  if (existsSync(envFilePath)) {
    rmSync(envFilePath);
    rolledBack.push("env file");
  }

  await withStateLock(root, () => {
    const state = loadState(root);
    if (state.instances[plan.key]) {
      delete state.instances[plan.key];
      saveState(root, state);
      rolledBack.push("state");
    }
  });

  if (rolledBack.length > 0) {
    console.log(`  rolled back: ${rolledBack.join(", ")}`);
  }
}

export async function doDown(
  root: string,
  config: Config,
  envName: string,
  opts: { fork?: string; keepVolumes?: boolean; force?: boolean }
): Promise<void> {
  await withStateLock(root, () => {
    const state = loadState(root);
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
        throw new Error(
          `${msg} Use \`forkspace down ${envName} --fork ${fork} --force\` to skip forkDestroy.`
        );
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
  });
}

export function doPrune(
  root: string,
  config: Config,
  opts: { dryRun?: boolean; force?: boolean }
): void {
  const state = loadState(root);
  const dockerProjects = listComposeProjects(root);
  const plan = planPrune(root, config, state, dockerProjects, !!opts.force);

  if (
    plan.projects.length === 0 &&
    plan.overrideDirs.length === 0 &&
    plan.envFiles.length === 0
  ) {
    console.log("Nothing to prune.");
    return;
  }

  if (!opts.dryRun && pruneNeedsForce(plan)) {
    throw new Error(
      "Some stranded projects have unknown environments; pass --force to drop their volumes, " +
        "or use --dry-run to inspect."
    );
  }

  const lines = formatPrunePlan(plan, root);
  for (const line of lines) {
    console.log(opts.dryRun ? `would remove ${line}` : `removing ${line}`);
  }

  if (opts.dryRun) return;

  for (const { project, removeVolumes } of plan.projects) {
    composeDown(root, project, removeVolumes);
  }
  for (const dir of plan.overrideDirs) {
    rmSync(dir, { recursive: true });
  }
  for (const file of plan.envFiles) {
    rmSync(path.join(root, file));
  }

  console.log(`✓ pruned ${lines.length} item${lines.length === 1 ? "" : "s"}`);
}

export function loadInstanceEnv(root: string, envFileRel: string): Record<string, string> {
  const envFilePath = path.join(root, envFileRel);
  if (!existsSync(envFilePath)) {
    throw new Error(`Env file missing: ${envFileRel}`);
  }
  return envToRecord(readFileSync(envFilePath, "utf8"));
}

export function printOrphanReports(reports: OrphanReport[]): void {
  for (const report of reports) {
    console.log(`${report.env}:`);
    if (report.skip) {
      console.log(`  (skipped: ${report.skip})`);
      continue;
    }
    const { orphans, ghosts } = report.diff!;
    if (orphans.length === 0 && ghosts.length === 0) {
      console.log("  ✓ namespaces in sync");
      continue;
    }
    for (const ns of orphans) {
      console.log(`  orphan  ${ns}  (in engine, not in state)`);
    }
    for (const ns of ghosts) {
      console.log(`  ghost   ${ns}  (in state, not in engine)`);
    }
  }
}

export function listInstances(root: string, state: State, ps: boolean): void {
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
    if (ps && inst.services.length > 0) {
      const psOut = composePs(root, inst.project);
      console.log(psOut ? psOut.split("\n").map((l) => `    ${l}`).join("\n") : "    (no containers)");
    } else if (ps) {
      console.log("    (namespace-only — no containers)");
    }
  }
}

