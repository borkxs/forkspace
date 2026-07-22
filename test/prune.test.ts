import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseComposeLsOutput } from "../src/compose.js";
import { parseConfig } from "../src/config.js";
import { rollbackFailedUp } from "../src/ops.js";
import { planInstance } from "../src/plan.js";
import {
  formatPrunePlan,
  inferEnvFromProject,
  orphanedEnvFiles,
  orphanedOverrideDirs,
  planPrune,
  pruneNeedsForce,
  shouldRemoveVolumesForProject,
  strandedProjects,
} from "../src/prune.js";
import { loadState, saveState, type State } from "../src/state.js";

const MINIMAL_YML = `
workspace: acme
environments:
  dev:
    persistent: true
    services:
      mysql:
        compose: api/docker-compose.yml
        service: db
        basePort: 3306
        containerPort: 3306
  test:
    persistent: false
    services:
      mysql:
        compose: api/docker-compose.yml
        service: db
        basePort: 3406
        containerPort: 3306
`;

describe("compose ls parsing", () => {
  it("parses newline-delimited JSON", () => {
    const stdout = [
      '{"Name":"fs-acme-test","Status":"running"}',
      '{"Name":"fs-acme-test-agent-a","Status":"running"}',
    ].join("\n");
    expect(parseComposeLsOutput(stdout)).toEqual(["fs-acme-test", "fs-acme-test-agent-a"]);
  });

  it("parses JSON array output", () => {
    const stdout = JSON.stringify([{ Name: "fs-acme-dev" }]);
    expect(parseComposeLsOutput(stdout)).toEqual(["fs-acme-dev"]);
  });
});

describe("prune planning", () => {
  const config = parseConfig(MINIMAL_YML);
  const state: State = {
    instances: {
      test: {
        key: "test",
        env: "test",
        fork: null,
        slot: 0,
        project: "fs-acme-test",
        ns: "",
        backing: "container",
        ports: {},
        services: ["mysql"],
        envFile: ".env.forkspace.test",
        createdAt: "",
      },
    },
  };

  it("finds stranded docker projects for the workspace", () => {
    expect(
      strandedProjects("acme", state, [
        "fs-acme-test",
        "fs-acme-test-agent-a",
        "fs-other-test",
        "fs-acme-dev",
      ])
    ).toEqual(["fs-acme-dev", "fs-acme-test-agent-a"]);
  });

  it("infers env and fork from project names", () => {
    expect(inferEnvFromProject("fs-acme-test", "acme", ["test", "dev"])).toEqual({
      env: "test",
      fork: null,
    });
    expect(inferEnvFromProject("fs-acme-test-agent-a", "acme", ["test", "dev"])).toEqual({
      env: "test",
      fork: "agent-a",
    });
    expect(inferEnvFromProject("fs-acme-dev", "acme", ["test", "dev"])).toEqual({
      env: "dev",
      fork: null,
    });
  });

  it("prefers the longest matching environment name", () => {
    expect(
      inferEnvFromProject("fs-acme-test-extra", "acme", ["test", "test-extra"])
    ).toEqual({ env: "test-extra", fork: null });
  });

  it("decides volume removal from persistence and --force", () => {
    expect(shouldRemoveVolumesForProject("fs-acme-test", config, false)).toBe(true);
    expect(shouldRemoveVolumesForProject("fs-acme-dev", config, false)).toBe(false);
    expect(shouldRemoveVolumesForProject("fs-acme-mystery", config, false)).toBe(false);
    expect(shouldRemoveVolumesForProject("fs-acme-mystery", config, true)).toBe(true);
  });

  it("finds orphaned override dirs and env files", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "forkspace-prune-"));
    try {
      mkdirSync(path.join(root, ".forkspace", "fs-acme-test-agent-a"), { recursive: true });
      mkdirSync(path.join(root, ".forkspace", "fs-acme-test"), { recursive: true });
      writeFileSync(path.join(root, ".env.forkspace.test.stale"), "FORKSPACE_ENV=test\n");
      writeFileSync(path.join(root, ".env.forkspace.test"), "FORKSPACE_ENV=test\n");

      expect(orphanedOverrideDirs(root, state).map((p) => path.basename(p)).sort()).toEqual([
        "fs-acme-test-agent-a",
      ]);
      expect(orphanedEnvFiles(root, state)).toEqual([".env.forkspace.test.stale"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("builds a prune plan and detects when --force is required", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "forkspace-prune-plan-"));
    try {
      const plan = planPrune(
        root,
        config,
        state,
        ["fs-acme-test", "fs-acme-test-agent-a", "fs-acme-unknown-abc"],
        false
      );
      expect(plan.projects.map((p) => p.project)).toEqual([
        "fs-acme-test-agent-a",
        "fs-acme-unknown-abc",
      ]);
      expect(plan.projects[0].removeVolumes).toBe(true);
      expect(plan.projects[1].removeVolumes).toBe(false);
      expect(pruneNeedsForce(plan)).toBe(true);

      const lines = formatPrunePlan(plan, root);
      expect(lines.some((l) => l.includes("fs-acme-unknown-abc"))).toBe(true);
      expect(lines.some((l) => l.includes("use --force"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("rollbackFailedUp", () => {
  it("removes state, override dir, and env file without calling compose", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "forkspace-rollback-"));
    const config = parseConfig(MINIMAL_YML);
    const env = config.environments.test;
    try {
      saveState(root, { instances: {} });
      const plan = planInstance({
        config,
        env,
        envName: "test",
        fork: "agent-a",
        state: {
          instances: {
            test: {
              key: "test",
              env: "test",
              fork: null,
              slot: 0,
              project: "fs-acme-test",
              ns: "",
              backing: "container",
              ports: { mysql: 3406 },
              services: ["mysql"],
              envFile: ".env.forkspace.test",
              createdAt: "",
            },
          },
        },
        isolateSet: null,
        slot: 1,
      });

      await withStateRecord(root, plan.key, plan.project);
      mkdirSync(path.join(root, ".forkspace", plan.project), { recursive: true });
      writeFileSync(path.join(root, ".env.forkspace.test.agent-a"), "FORKSPACE_ENV=test\n");

      await rollbackFailedUp(root, "test", env, plan, "agent-a", false);

      expect(loadState(root).instances[plan.key]).toBeUndefined();
      expect(existsSync(path.join(root, ".forkspace", plan.project))).toBe(false);
      expect(existsSync(path.join(root, ".env.forkspace.test.agent-a"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

async function withStateRecord(root: string, key: string, project: string): Promise<void> {
  const state = loadState(root);
  state.instances[key] = {
    key,
    env: "test",
    fork: "agent-a",
    slot: 1,
    project,
    ns: "agent_a",
    backing: "namespace-only",
    ports: {},
    services: [],
    envFile: ".env.forkspace.test.agent-a",
    createdAt: "",
  };
  saveState(root, state);
}
