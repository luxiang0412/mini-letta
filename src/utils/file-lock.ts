import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";

/**
 * A cross-process lock file holding the owner's pid. Like letta-code's
 * `reapOnlyDeadOwner` leases (src/agent/memory-operation.ts), a lock is
 * stolen only when its owner process is gone — a slow owner keeps it.
 */
function ownerAlive(path: string): boolean {
  try {
    const { pid } = JSON.parse(readFileSync(path, "utf8")) as { pid: number };
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function tryAcquireLock(path: string): (() => void) | null {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
      closeSync(fd);
      return () => rmSync(path, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (ownerAlive(path)) return null;
      rmSync(path, { force: true }); // reap a dead owner's lock, then retry once
    }
  }
  return null;
}

export async function withLock<T>(path: string, operation: () => Promise<T>, retryMs = 50): Promise<T> {
  let release = tryAcquireLock(path);
  while (!release) {
    await new Promise((resolve) => setTimeout(resolve, retryMs));
    release = tryAcquireLock(path);
  }
  try {
    return await operation();
  } finally {
    release();
  }
}
