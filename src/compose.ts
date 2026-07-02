import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ServiceDef } from "./config";

export interface PlannedService {
  name: string; // forkspace service name
  def: ServiceDef;
  hostPort: number;
}

/**
 * Generate a compose override that remaps host ports for the given services.
 * Uses the `!override` YAML tag (compose v2.24+) so the base file's port
 * bindings are replaced, not appended to. Volumes and networks need no
 * override: `docker compose -p <project>` already namespaces both.
 */
export function buildOverrideYaml(services: PlannedService[]): string {
  const lines: string[] = ["services:"];
  for (const s of services) {
    lines.push(`  ${s.def.service}:`);
    lines.push(`    ports: !override`);
    lines.push(`      - "${s.hostPort}:${s.def.containerPort}"`);
  }
  lines.push("");
  return lines.join("\n");
}

/** Group planned services by the compose file that owns them. */
export function groupByComposeFile(
  services: PlannedService[]
): Map<string, PlannedService[]> {
  const groups = new Map<string, PlannedService[]>();
  for (const s of services) {
    const list = groups.get(s.def.compose) ?? [];
    list.push(s);
    groups.set(s.def.compose, list);
  }
  return groups;
}

export interface ComposeRun {
  project: string;
  composeFile: string; // relative to root
  overrideFile: string; // absolute
  serviceNames: string[]; // compose service names to act on
}

/**
 * Write override files for each compose-file group under
 * .forkspace/<project>/override-<n>.yml and return the run plan.
 */
export function planComposeRuns(
  root: string,
  project: string,
  services: PlannedService[]
): ComposeRun[] {
  const dir = path.join(root, ".forkspace", project);
  mkdirSync(dir, { recursive: true });
  const runs: ComposeRun[] = [];
  let n = 0;
  for (const [composeFile, group] of groupByComposeFile(services)) {
    const overrideFile = path.join(dir, `override-${n++}.yml`);
    writeFileSync(overrideFile, buildOverrideYaml(group));
    runs.push({
      project,
      composeFile,
      overrideFile,
      serviceNames: group.map((s) => s.def.service),
    });
  }
  return runs;
}

export function composeUp(root: string, run: ComposeRun): void {
  exec(root, [
    "compose",
    "-p",
    run.project,
    "-f",
    path.join(root, run.composeFile),
    "-f",
    run.overrideFile,
    "up",
    "-d",
    "--wait",
    ...run.serviceNames,
  ]);
}

export function composeDown(root: string, project: string, removeVolumes: boolean): void {
  const args = ["compose", "-p", project, "down", "--remove-orphans"];
  if (removeVolumes) args.push("-v");
  exec(root, args);
}

export function composePs(root: string, project: string): string {
  const res = spawnSync("docker", ["compose", "-p", project, "ps", "--format", "json"], {
    cwd: root,
    encoding: "utf8",
  });
  return res.status === 0 ? res.stdout.trim() : "";
}

function exec(cwd: string, args: string[]): void {
  const res = spawnSync("docker", args, { cwd, stdio: "inherit" });
  if (res.error) {
    throw new Error(`Failed to run docker: ${res.error.message}. Is Docker running?`);
  }
  if (res.status !== 0) {
    throw new Error(`docker ${args.slice(0, 3).join(" ")} … exited with ${res.status}`);
  }
}

/** Run a hook command with the instance's env vars loaded. */
export function runHook(
  root: string,
  command: string,
  extraEnv: Record<string, string>
): void {
  const res = spawnSync(command, {
    cwd: root,
    shell: true,
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  });
  if (res.status !== 0) {
    throw new Error(`Hook failed (exit ${res.status}): ${command}`);
  }
}
