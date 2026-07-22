import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { stateDir } from "./state.js";

const LOCK_FILE = "state.lock";

export interface LockPayload {
  pid: number;
  acquiredAt: number;
}

export interface LockOptions {
  /** Treat locks older than this as stale and steal them. */
  staleMs?: number;
  maxRetries?: number;
  retryBaseMs?: number;
}

export interface LockHandle {
  release(): void;
}

const DEFAULT_STALE_MS = 5 * 60 * 1000;
const DEFAULT_MAX_RETRIES = 40;
const DEFAULT_RETRY_BASE_MS = 50;

export function lockFilePath(root: string): string {
  return path.join(stateDir(root), LOCK_FILE);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    return code !== "ESRCH";
  }
}

export function parseLockPayload(raw: string): LockPayload | null {
  try {
    const parsed = JSON.parse(raw) as Partial<LockPayload>;
    if (typeof parsed.pid !== "number" || typeof parsed.acquiredAt !== "number") {
      return null;
    }
    return { pid: parsed.pid, acquiredAt: parsed.acquiredAt };
  } catch {
    return null;
  }
}

export function readLockFile(root: string): LockPayload | null {
  const file = lockFilePath(root);
  if (!existsSync(file)) return null;
  try {
    return parseLockPayload(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function isLockStale(
  payload: LockPayload,
  staleMs: number,
  now = Date.now()
): boolean {
  if (!isProcessAlive(payload.pid)) return true;
  return now - payload.acquiredAt > staleMs;
}

function writeLockFile(root: string, payload: LockPayload): void {
  mkdirSync(stateDir(root), { recursive: true });
  const file = lockFilePath(root);
  const fd = openSync(file, "wx");
  try {
    writeSync(fd, JSON.stringify(payload) + "\n");
  } finally {
    closeSync(fd);
  }
}

function removeLockFile(root: string, ownerPid: number): void {
  const file = lockFilePath(root);
  if (!existsSync(file)) return;
  const payload = readLockFile(root);
  if (payload && payload.pid !== ownerPid) return;
  unlinkSync(file);
}

/** Try once to create the lock file; steal if stale. Returns null when held by a live owner. */
export function tryAcquireLock(root: string, opts?: LockOptions): LockHandle | null {
  const staleMs = opts?.staleMs ?? DEFAULT_STALE_MS;
  const file = lockFilePath(root);
  const payload: LockPayload = { pid: process.pid, acquiredAt: Date.now() };

  if (existsSync(file)) {
    const existing = readLockFile(root);
    if (existing && !isLockStale(existing, staleMs)) {
      return null;
    }
    try {
      unlinkSync(file);
    } catch {
      return null;
    }
  }

  try {
    writeLockFile(root, payload);
  } catch {
    return null;
  }

  return {
    release() {
      removeLockFile(root, payload.pid);
    },
  };
}

export async function acquireLock(root: string, opts?: LockOptions): Promise<LockHandle> {
  const maxRetries = opts?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryBaseMs = opts?.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const handle = tryAcquireLock(root, opts);
    if (handle) return handle;
    const delay = Math.min(retryBaseMs * 2 ** attempt, 1000);
    await sleep(delay);
  }

  const holder = readLockFile(root);
  const detail = holder
    ? `held by pid ${holder.pid} since ${new Date(holder.acquiredAt).toISOString()}`
    : "contended by another process";
  throw new Error(`Timed out acquiring forkspace state lock (${detail}).`);
}

export async function withStateLock<T>(
  root: string,
  fn: () => T | Promise<T>,
  opts?: LockOptions
): Promise<T> {
  const handle = await acquireLock(root, opts);
  try {
    return await fn();
  } finally {
    handle.release();
  }
}
