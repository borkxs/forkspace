#!/usr/bin/env node
import { Command } from "commander";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  CONFIG_FILENAME,
  checkConfig,
  findRoot,
  loadConfig,
  type Config,
  type EnvironmentDef,
} from "./config";
import { allocateSlot, portFor } from "./ports";
import {
  instanceKey,
  loadState,
  projectName,
  saveState,
  takenSlots,
  type InstanceRecord,
} from "./state";
import {
  composeDown,
  composePs,
  composeUp,
  planComposeRuns,
  runHook,
  type PlannedService,
} from "./compose";
import { envToRecord, renderEnvFile, writeEnvFile } from "./env";

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

program
  .command("up")
  .description("Start an environment (optionally as an isolated fork)")
  .argument("<env>", "environment name from forkspace.yml")
  .option("--fork <name>", "start an isolated fork of this environment")
  .option(
    "--isolate <services>",
    "comma-separated services to isolate; others reuse baseline (overrides config isolation)"
  )
  .option("--no-hooks", "skip bootstrap/seed hooks")
  .action(async (envName: string, opts: { fork?: string; isolate?: string; hooks: boolean }) => {
    const { root, config, state } = ctx();
    const env = resolveEnv(config, envName);
    const fork = opts.fork ?? null;
    const key = instanceKey(envName, fork);

    if (state.instances[key]) {
      console.log(`Instance ${key} already exists (project ${state.instances[key].project}).`);
      console.log(`Run \`forkspace down ${envName}${fork ? ` --fork ${fork}` : ""}\` first, or use it as-is.`);
      return;
    }

    // Partition services into container-isolated vs baseline-reused for THIS instance.
    const isolateSet = opts.isolate
      ? new Set(opts.isolate.split(",").map((s) => s.trim()))
      : null;
    if (isolateSet) {
      for (const name of isolateSet) {
        if (!env.services[name]) throw new Error(`--isolate: unknown service "${name}"`);
      }
    }
    const allNames = Object.keys(env.services);
    const containerIsolated = (name: string) =>
      isolateSet
        ? isolateSet.has(name)
        : env.services[name].isolation === "container";

    const ownNames = fork ? allNames.filter(containerIsolated) : allNames;
    const sharedNames = fork ? allNames.filter((n) => !containerIsolated(n)) : [];

    // A fork's shared services live in the baseline instance — make sure it exists.
    if (fork && sharedNames.length > 0 && !state.instances[envName]) {
      throw new Error(
        `Fork "${fork}" shares services (${sharedNames.join(", ")}) with the baseline ` +
          `"${envName}" instance, which isn't up. Run \`forkspace up ${envName}\` first.`
      );
    }

    // Slot: baseline is always 0; forks get the lowest free slot >= 1.
    const slot = fork
      ? await allocateSlot({
          basePorts: ownNames.map((n) => env.services[n].basePort),
          slotSize: config.slotSize,
          takenSlots: takenSlots(state, envName),
          minSlot: 1,
        })
      : 0;

    const project = projectName(config.workspace, envName, fork);
    const planned: PlannedService[] = ownNames.map((name) => ({
      name,
      def: env.services[name],
      hostPort: portFor(env.services[name].basePort, slot, config.slotSize),
    }));

    console.log(`▲ ${key} → project ${project} (slot ${slot})`);
    for (const p of planned) {
      console.log(`  ${p.name.padEnd(12)} :${p.hostPort}`);
    }

    const runs = planComposeRuns(root, project, planned);
    for (const run of runs) composeUp(root, run);

    // Env file covers own services at fork ports + shared services at baseline ports.
    const baseline = state.instances[envName];
    const entries = [
      ...planned.map((p) => ({ name: p.name, def: p.def, hostPort: p.hostPort })),
      ...sharedNames.map((name) => ({
        name,
        def: env.services[name],
        hostPort:
          baseline?.ports[name] ?? portFor(env.services[name].basePort, 0, config.slotSize),
      })),
    ];
    const content = renderEnvFile({ env: envName, fork, project, entries });
    const envFile = writeEnvFile(root, envName, fork, content);
    console.log(`  env file → ${envFile}`);

    const record: InstanceRecord = {
      key,
      env: envName,
      fork,
      slot,
      project,
      ports: Object.fromEntries(entries.map((e) => [e.name, e.hostPort])),
      services: ownNames,
      envFile,
      createdAt: new Date().toISOString(),
    };
    state.instances[key] = record;
    saveState(root, state);

    if (opts.hooks) {
      const hookEnv = envToRecord(content);
      if (env.hooks.bootstrap) {
        console.log(`  bootstrap: ${env.hooks.bootstrap}`);
        runHook(root, env.hooks.bootstrap, hookEnv);
      }
      if (env.hooks.seed) {
        console.log(`  seed: ${env.hooks.seed}`);
        runHook(root, env.hooks.seed, hookEnv);
      }
    }
    console.log(`✓ ${key} is up`);
  });

program
  .command("down")
  .description("Stop an instance (drops volumes unless the environment is persistent)")
  .argument("<env>")
  .option("--fork <name>")
  .option("--keep-volumes", "keep volumes even for non-persistent environments")
  .action((envName: string, opts: { fork?: string; keepVolumes?: boolean }) => {
    const { root, config, state } = ctx();
    const env = resolveEnv(config, envName);
    const fork = opts.fork ?? null;
    const key = instanceKey(envName, fork);
    const inst = state.instances[key];
    if (!inst) {
      console.log(`No instance ${key} in state. Nothing to do.`);
      return;
    }
    // Refuse to drop a baseline that live forks depend on.
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
    composeDown(root, inst.project, removeVolumes);

    const overrideDir = path.join(root, ".forkspace", inst.project);
    if (existsSync(overrideDir)) rmSync(overrideDir, { recursive: true });
    const envFilePath = path.join(root, inst.envFile);
    if (existsSync(envFilePath)) rmSync(envFilePath);

    delete state.instances[key];
    saveState(root, state);
    console.log(`✓ ${key} is down`);
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
      const ports = Object.entries(inst.ports)
        .filter(([name]) => inst.services.includes(name))
        .map(([name, port]) => `${name}:${port}`)
        .join(" ");
      console.log(`${inst.key.padEnd(20)} slot ${inst.slot}  ${inst.project}  ${ports}`);
      if (opts.ps) {
        const ps = composePs(root, inst.project);
        console.log(ps ? ps.split("\n").map((l) => `    ${l}`).join("\n") : "    (no containers)");
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
    process.stdout.write(require("node:fs").readFileSync(file, "utf8"));
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
