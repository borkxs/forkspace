import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import { recordedProjects, stateDir, type State } from "./state.js";

export interface InferredProject {
  env: string;
  fork: string | null;
}

export function workspaceProjectPrefix(workspace: string): string {
  return `fs-${workspace.toLowerCase()}-`;
}

export function strandedProjects(
  workspace: string,
  state: State,
  dockerProjects: string[]
): string[] {
  const prefix = workspaceProjectPrefix(workspace);
  const recorded = recordedProjects(state);
  return dockerProjects
    .filter((project) => project.startsWith(prefix) && !recorded.has(project))
    .sort();
}

/** Infer env (and optional fork) from a compose project name. Longest env match wins. */
export function inferEnvFromProject(
  project: string,
  workspace: string,
  envNames: string[]
): InferredProject | null {
  const prefix = workspaceProjectPrefix(workspace);
  if (!project.startsWith(prefix)) return null;

  const rest = project.slice(prefix.length);
  const sorted = [...envNames].sort((a, b) => b.length - a.length);
  for (const env of sorted) {
    if (rest === env) return { env, fork: null };
    const forkPrefix = `${env}-`;
    if (rest.startsWith(forkPrefix)) {
      return { env, fork: rest.slice(forkPrefix.length) };
    }
  }
  return null;
}

export function shouldRemoveVolumesForProject(
  project: string,
  config: Config,
  force: boolean
): boolean {
  const inferred = inferEnvFromProject(
    project,
    config.workspace,
    Object.keys(config.environments)
  );
  if (!inferred) return force;
  return !config.environments[inferred.env].persistent;
}

export function orphanedOverrideDirs(root: string, state: State): string[] {
  const dir = stateDir(root);
  if (!existsSync(dir)) return [];

  const recorded = recordedProjects(state);
  return readdirSync(dir)
    .filter((name) => name !== "state.json" && !name.endsWith(".tmp"))
    .map((name) => path.join(dir, name))
    .filter((p) => existsSync(p) && statSync(p).isDirectory())
    .filter((p) => !recorded.has(path.basename(p)))
    .sort();
}

export function orphanedEnvFiles(root: string, state: State): string[] {
  if (!existsSync(root)) return [];

  const recorded = new Set(Object.values(state.instances).map((i) => i.envFile));
  return readdirSync(root)
    .filter((name) => name.startsWith(".env.forkspace."))
    .filter((name) => !recorded.has(name))
    .sort();
}

export interface PrunePlan {
  projects: Array<{ project: string; removeVolumes: boolean; inferred: InferredProject | null }>;
  overrideDirs: string[];
  envFiles: string[];
}

export function planPrune(
  root: string,
  config: Config,
  state: State,
  dockerProjects: string[],
  force: boolean
): PrunePlan {
  const projects = strandedProjects(config.workspace, state, dockerProjects).map((project) => ({
    project,
    removeVolumes: shouldRemoveVolumesForProject(project, config, force),
    inferred: inferEnvFromProject(project, config.workspace, Object.keys(config.environments)),
  }));

  return {
    projects,
    overrideDirs: orphanedOverrideDirs(root, state),
    envFiles: orphanedEnvFiles(root, state),
  };
}

/** True when any stranded project would keep volumes without --force. */
export function pruneNeedsForce(plan: PrunePlan): boolean {
  return plan.projects.some((p) => p.inferred === null && !p.removeVolumes);
}

export function formatPrunePlan(plan: PrunePlan, root: string): string[] {
  const lines: string[] = [];
  for (const { project, removeVolumes, inferred } of plan.projects) {
    const envLabel = inferred
      ? inferred.fork
        ? `${inferred.env} (fork ${inferred.fork})`
        : inferred.env
      : "unknown env";
    lines.push(
      `project ${project}  [${envLabel}]${removeVolumes ? "  -v" : "  (keep volumes — use --force to drop)"}`
    );
  }
  for (const dir of plan.overrideDirs) {
    lines.push(`override dir ${path.relative(root, dir) || dir}`);
  }
  for (const file of plan.envFiles) {
    lines.push(`env file ${file}`);
  }
  return lines;
}
