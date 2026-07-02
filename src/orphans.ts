import type { Config } from "./config";
import { runHookCapture } from "./compose";
import type { State } from "./state";

export interface OrphanDiff {
  orphans: string[];
  ghosts: string[];
}

export interface OrphanReport {
  env: string;
  diff?: OrphanDiff;
  /** Set when orphan detection could not run for this environment. */
  skip?: string;
}

/** Namespace tokens recorded in state for fork instances of an environment. */
export function namespacesInState(state: State, envName: string): Set<string> {
  const ns = new Set<string>();
  for (const inst of Object.values(state.instances)) {
    if (inst.env === envName && inst.fork && inst.ns) ns.add(inst.ns);
  }
  return ns;
}

/** Parse one namespace token per line from hook stdout. */
export function parseNamespaceLines(stdout: string): Set<string> {
  const ns = new Set<string>();
  for (const line of stdout.split("\n")) {
    const token = line.trim();
    if (token) ns.add(token);
  }
  return ns;
}

export function diffNamespaces(engine: Set<string>, recorded: Set<string>): OrphanDiff {
  const orphans = [...engine].filter((n) => !recorded.has(n)).sort();
  const ghosts = [...recorded].filter((n) => !engine.has(n)).sort();
  return { orphans, ghosts };
}

export function orphanReports(
  config: Config,
  state: State,
  root: string,
  loadEnv: (envFileRel: string) => Record<string, string>
): OrphanReport[] {
  const reports: OrphanReport[] = [];

  for (const [envName, env] of Object.entries(config.environments)) {
    const hook = env.hooks.listNamespaces;
    if (!hook) continue;

    const baseline = state.instances[envName];
    if (!baseline) {
      reports.push({
        env: envName,
        skip: "baseline not up — run `forkspace up` first",
      });
      continue;
    }

    let hookEnv: Record<string, string>;
    try {
      hookEnv = loadEnv(baseline.envFile);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reports.push({ env: envName, skip: msg });
      continue;
    }

    try {
      const stdout = runHookCapture(root, hook, hookEnv);
      const engine = parseNamespaceLines(stdout);
      const recorded = namespacesInState(state, envName);
      reports.push({ env: envName, diff: diffNamespaces(engine, recorded) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reports.push({ env: envName, skip: msg });
    }
  }

  return reports;
}

/** True when any environment defines listNamespaces. */
export function hasListNamespacesHook(config: Config): boolean {
  return Object.values(config.environments).some((e) => !!e.hooks.listNamespaces);
}
