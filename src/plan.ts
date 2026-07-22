import type { Config, EnvironmentDef } from "./config.js";
import type { PlannedService } from "./compose.js";
import type { AllocationEntry, EnvEntry } from "./env.js";
import { effectiveNs, nsDashFor } from "./ns.js";
import { portFor } from "./ports.js";
import { instanceKey, projectName, type State } from "./state.js";

export interface InstancePlan {
  containersToStart: PlannedService[];
  ns: string;
  nsDash: string;
  ports: Record<string, number>;
  hooks: {
    up: string[];
    down?: string;
  };
  slot: number;
  project: string;
  key: string;
  envEntries: EnvEntry[];
  allocationEntries: AllocationEntry[];
  containerServiceNames: string[];
  backing: "container" | "namespace-only";
  requiresBaseline: boolean;
  baselineDependentServices: string[];
}

/** Whether a service gets its own compose instance for this fork. */
export function containerIsolated(
  name: string,
  env: EnvironmentDef,
  isolateSet: Set<string> | null
): boolean {
  if (isolateSet) return isolateSet.has(name);
  return env.services[name].isolation === "container";
}

/** Host base ports to probe when allocating a fork slot. */
export function planSlotProbe(opts: {
  env: EnvironmentDef;
  fork: string | null;
  isolateSet: Set<string> | null;
}): number[] {
  const { env, fork, isolateSet } = opts;
  if (!fork) return [];
  const containerNames = Object.keys(env.services).filter((n) =>
    containerIsolated(n, env, isolateSet)
  );
  const allocationBasePorts = Object.values(env.allocations).map((a) => a.basePort);
  return [
    ...containerNames.map((n) => env.services[n].basePort),
    ...allocationBasePorts,
  ];
}

export function planInstance(opts: {
  config: Config;
  env: EnvironmentDef;
  envName: string;
  fork: string | null;
  state: State;
  isolateSet: Set<string> | null;
  slot: number;
}): InstancePlan {
  const { config, env, envName, fork, state, isolateSet, slot } = opts;
  const allNames = Object.keys(env.services);
  const ns = effectiveNs(fork, env.baselineNs);
  const nsDash = fork ? nsDashFor(fork) : "";
  const key = instanceKey(envName, fork);
  const project = projectName(config.workspace, envName, fork);
  const baseline = state.instances[envName];

  const containerNames = fork
    ? allNames.filter((n) => containerIsolated(n, env, isolateSet))
    : allNames;

  const baselineDependent = fork
    ? allNames.filter((n) => !containerIsolated(n, env, isolateSet))
    : [];

  const containersToStart: PlannedService[] = containerNames.map((name) => ({
    name,
    def: env.services[name],
    hostPort: portFor(env.services[name].basePort, slot, config.slotSize),
  }));

  const envEntries: EnvEntry[] = allNames.map((name) => {
    const def = env.services[name];
    const useForkPort = !fork || containerIsolated(name, env, isolateSet);
    const hostPort = useForkPort
      ? portFor(def.basePort, slot, config.slotSize)
      : (baseline?.ports[name] ?? portFor(def.basePort, 0, config.slotSize));
    return { name, def, hostPort };
  });

  const allocationEntries: AllocationEntry[] = Object.entries(env.allocations).map(
    ([name, def]) => ({
      name,
      hostPort: portFor(def.basePort, slot, config.slotSize),
    })
  );

  const ports: Record<string, number> = {
    ...Object.fromEntries(envEntries.map((e) => [e.name, e.hostPort])),
    ...Object.fromEntries(allocationEntries.map((a) => [a.name, a.hostPort])),
  };

  const hooks = {
    up: fork
      ? [env.hooks.forkCreate, env.hooks.seed].filter((h): h is string => !!h)
      : [env.hooks.bootstrap, env.hooks.seed].filter((h): h is string => !!h),
    down: fork ? env.hooks.forkDestroy : undefined,
  };

  const backing: "container" | "namespace-only" =
    fork && containerNames.length === 0 ? "namespace-only" : "container";

  return {
    containersToStart,
    ns,
    nsDash,
    ports,
    hooks,
    slot,
    project,
    key,
    envEntries,
    allocationEntries,
    containerServiceNames: containerNames,
    backing,
    requiresBaseline: baselineDependent.length > 0,
    baselineDependentServices: baselineDependent,
  };
}
