import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { doDown, doUp } from "../src/ops.js";
import { loadConfig } from "../src/config.js";
import {
  acquireLock,
  isLockStale,
  lockFilePath,
  readLockFile,
  tryAcquireLock,
  withStateLock,
} from "../src/lock.js";
import { loadState, saveState, stateDir } from "../src/state.js";

function tempRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), "forkspace-lock-"));
}

describe("state lock", () => {
  it("acquires and releases exclusively", () => {
    const root = tempRoot();
    try {
      const first = tryAcquireLock(root);
      expect(first).not.toBeNull();
      expect(readLockFile(root)?.pid).toBe(process.pid);

      const second = tryAcquireLock(root);
      expect(second).toBeNull();

      first!.release();
      expect(existsSync(lockFilePath(root))).toBe(false);

      const third = tryAcquireLock(root);
      expect(third).not.toBeNull();
      third!.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("steals stale locks from dead processes", async () => {
    const root = tempRoot();
    try {
      mkdirSync(stateDir(root), { recursive: true });
      writeFileSync(
        lockFilePath(root),
        JSON.stringify({ pid: 999_999_999, acquiredAt: Date.now() }) + "\n"
      );
      expect(isLockStale(readLockFile(root)!, 60_000)).toBe(true);

      const handle = await acquireLock(root, { maxRetries: 3, retryBaseMs: 1 });
      expect(handle).toBeDefined();
      handle.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("withStateLock serializes concurrent writers", async () => {
    const root = tempRoot();
    try {
      saveState(root, { instances: {} });

      await Promise.all(
        [1, 2, 3].map((slot) =>
          withStateLock(root, () => {
            const state = loadState(root);
            state.instances[`test@fork-${slot}`] = {
              key: `test@fork-${slot}`,
              env: "test",
              fork: `fork-${slot}`,
              slot,
              project: `fs-acme-test-fork-${slot}`,
              ns: `fork_${slot}`,
              backing: "namespace-only",
              ports: {},
              services: [],
              envFile: `.env.forkspace.test.fork-${slot}`,
              createdAt: "",
            };
            saveState(root, state);
          })
        )
      );

      const final = loadState(root);
      const slots = Object.values(final.instances).map((i) => i.slot);
      expect(slots.sort()).toEqual([1, 2, 3]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("concurrent namespace-only ups allocate distinct slots", async () => {
    const root = path.join(__dirname, "fixtures", "workspace");
    const config = loadConfig(root);
    const previous = loadState(root);

    saveState(root, {
      instances: {
        test: {
          key: "test",
          env: "test",
          fork: null,
          slot: 0,
          project: "fs-acme-test",
          ns: "",
          backing: "container",
          ports: { mysql: 3406, dynamodb: 8000 },
          services: ["mysql", "dynamodb", "queue", "s3"],
          envFile: ".env.forkspace.test",
          createdAt: "",
        },
      },
    });

    try {
      await Promise.all([
        doUp(root, config, "test", { fork: "agent-a", hooks: false }),
        doUp(root, config, "test", { fork: "agent-b", hooks: false }),
      ]);

      const final = loadState(root);
      const forks = Object.values(final.instances).filter((i) => i.fork);
      expect(forks).toHaveLength(2);
      expect(new Set(forks.map((i) => i.slot)).size).toBe(2);
    } finally {
      for (const fork of ["agent-a", "agent-b"]) {
        await doDown(root, config, "test", { fork, force: true });
      }
      saveState(root, previous);
    }
  });
});
