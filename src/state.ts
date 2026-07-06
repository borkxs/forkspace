import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface InstanceRecord {
  /** e.g. "test" or "test@agent-a" */
  key: string;
  env: string;
  fork: string | null;
  slot: number;
  /** docker compose project name */
  project: string;
  /** namespace token; empty for baseline */
  ns: string;
  /** container = compose project has containers; namespace-only = fork with no container services */
  backing: "container" | "namespace-only";
  /** service name → host port */
  ports: Record<string, number>;
  /** container-isolated services running in THIS project (empty for namespace-only forks) */
  services: string[];
  /** path to the generated env file, relative to root */
  envFile: string;
  createdAt: string;
}

export interface State {
  instances: Record<string, InstanceRecord>;
}

const STATE_DIR = ".forkspace";
const STATE_FILE = "state.json";

export function stateDir(root: string): string {
  return path.join(root, STATE_DIR);
}

export function loadState(root: string): State {
  const file = path.join(stateDir(root), STATE_FILE);
  if (!existsSync(file)) return { instances: {} };
  return JSON.parse(readFileSync(file, "utf8")) as State;
}

export function saveState(root: string, state: State): void {
  const dir = stateDir(root);
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, STATE_FILE);
  const tmp = path.join(dir, `${STATE_FILE}.${process.pid}.${Date.now()}.tmp`);
  const content = JSON.stringify(state, null, 2) + "\n";
  writeFileSync(tmp, content);
  renameSync(tmp, target);
}

export function instanceKey(env: string, fork: string | null): string {
  return fork ? `${env}@${fork}` : env;
}

export function projectName(workspace: string, env: string, fork: string | null): string {
  const parts = ["fs", workspace, env];
  if (fork) parts.push(fork);
  return parts
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-");
}

export function takenSlots(state: State, env: string): Set<number> {
  const s = new Set<number>();
  for (const inst of Object.values(state.instances)) {
    if (inst.env === env) s.add(inst.slot);
  }
  return s;
}
