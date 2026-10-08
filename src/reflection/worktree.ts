import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { git, gitOrThrow } from "@/memory/git";
import { refreshFromOrigin } from "@/sync/remote";
import { withLock } from "@/utils/file-lock";

/**
 * Reflection runs in a private git worktree of the agent's memory, then the
 * harness merges it back. Ported from letta-code src/agent/memory-worktree.ts.
 */
export interface MemoryWorktree {
  id: string;
  parentMemoryDir: string;
  worktreeDir: string;
  branchName: string;
  baseHead: string;
}

export type FinalizeStatus =
  | "merged"
  | "no_changes"
  | "parent_dirty"
  | "merge_conflict"
  | "dirty_uncommitted"
  | "failed";

export interface FinalizeResult {
  status: FinalizeStatus;
  commitCount: number;
  head?: string;
  summary: string;
}

function worktreeId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  return `${stamp}-${crypto.randomUUID().slice(0, 8)}`;
}

export function createMemoryWorktree(parentMemoryDir: string, label = "reflection"): MemoryWorktree {
  const parent = resolve(parentMemoryDir);
  const id = worktreeId();
  const baseDir = join(dirname(parent), "memory-worktrees");
  const worktreeDir = join(baseDir, `${label}-${id}`);
  const branchName = `mini/${label}/${id}`;
  mkdirSync(baseDir, { recursive: true });
  const baseHead = gitOrThrow(parent, ["rev-parse", "--verify", "HEAD"]).trim();
  gitOrThrow(parent, ["worktree", "add", "-q", worktreeDir, "-b", branchName, baseHead]);
  return { id, parentMemoryDir: parent, worktreeDir, branchName, baseHead };
}

function cleanup(worktree: MemoryWorktree): void {
  if (existsSync(worktree.worktreeDir)) {
    git(worktree.parentMemoryDir, ["worktree", "remove", "--force", worktree.worktreeDir]);
  }
  git(worktree.parentMemoryDir, ["worktree", "prune"]);
  git(worktree.parentMemoryDir, ["branch", "-D", worktree.branchName]);
}

function porcelain(dir: string): string {
  return git(dir, ["status", "--porcelain"]).stdout.trim();
}

/** Lock serializing harness-owned writers of one checkout (letta's claimMemoryOperation). */
export function memoryOperationLockPath(memoryDir: string): string {
  return join(memoryDir, ".git", "mini-letta-memory-operation.lock");
}

/**
 * The state machine. Every branch cleans the worktree up; only `merged` and
 * `no_changes` let the caller mark the transcript as reflected. Everything
 * else is retryable: the same transcript slice will be reflected again.
 */
export async function finalizeMemoryWorktree(
  worktree: MemoryWorktree,
  options: { subagentSucceeded: boolean },
): Promise<FinalizeResult> {
  return withLock(memoryOperationLockPath(worktree.parentMemoryDir), async () => {
    const commitCount = Number(
      git(worktree.worktreeDir, ["rev-list", "--count", `${worktree.baseHead}..HEAD`]).stdout.trim() || "0",
    );
    const head = git(worktree.worktreeDir, ["rev-parse", "HEAD"]).stdout.trim() || undefined;
    const done = (status: FinalizeStatus, summary: string): FinalizeResult => {
      cleanup(worktree);
      return { status, commitCount, head, summary };
    };

    if (porcelain(worktree.worktreeDir)) {
      return done("dirty_uncommitted", "Reflection left uncommitted changes; discarded so the transcript can be retried.");
    }
    if (!options.subagentSucceeded) {
      return done("failed", "Reflection did not complete; the transcript can be retried.");
    }
    if (commitCount === 0) return done("no_changes", "Reflection made no memory commits.");
    if (porcelain(worktree.parentMemoryDir)) {
      return done("parent_dirty", "Parent memory has uncommitted changes; reflection will be retried.");
    }
    try {
      refreshFromOrigin(worktree.parentMemoryDir);
    } catch {
      return done("failed", "Parent memory could not be refreshed from the remote; reflection will be retried.");
    }
    const subject = git(worktree.parentMemoryDir, ["log", "-1", "--format=%s", worktree.branchName]).stdout.trim();
    const summary = subject.replace(/^[a-z]+(?:\([^)]+\))?!?:\s*/i, "") || "reflection memory updates";
    const merge = git(worktree.parentMemoryDir, ["merge", "--no-edit", "-m", `merge(reflection): ${summary}`, worktree.branchName]);
    if (!merge.ok) {
      git(worktree.parentMemoryDir, ["merge", "--abort"]);
      return done("merge_conflict", "Merging reflection conflicted; aborted so the transcript can be retried.");
    }
    const merged = git(worktree.parentMemoryDir, ["rev-parse", "HEAD"]).stdout.trim();
    cleanup(worktree);
    return { status: "merged", commitCount, head: merged, summary: `Merged ${commitCount} reflection commit(s).` };
  });
}

export function consumesTranscript(result: FinalizeResult): boolean {
  return result.status === "merged" || result.status === "no_changes";
}
