import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { git, gitOrThrow } from "@/memory/git";
import { installMemoryHooks } from "@/memory/hooks";

/**
 * Memory that travels between machines. letta-code (Cloud) clones
 * `<server>/v1/git/<agent-id>` and pushes after turns
 * (src/agent/memory-git.ts). mini-letta's "server" is a directory of bare
 * repositories: MINI_LETTA_REMOTE_ROOT/<agent-id>.git.
 */
export function remoteUrlFor(agentId: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const root = env.MINI_LETTA_REMOTE_ROOT;
  return root ? join(root, `${agentId}.git`) : undefined;
}

function ensureBareRemote(url: string): void {
  if (existsSync(join(url, "HEAD"))) return;
  mkdirSync(url, { recursive: true });
  gitOrThrow(url, ["init", "-q", "--bare", "-b", "main"]);
}

function hasOrigin(memoryDir: string): boolean {
  return git(memoryDir, ["remote", "get-url", "origin"]).ok;
}

/** First machine: attach the remote and publish the initial history. */
export function attachRemote(memoryDir: string, url: string): void {
  ensureBareRemote(url);
  if (!hasOrigin(memoryDir)) gitOrThrow(memoryDir, ["remote", "add", "origin", url]);
  gitOrThrow(memoryDir, ["push", "-q", "-u", "origin", "main"]);
}

/** Another machine: clone the agent's memory instead of creating it. */
export function cloneMemory(url: string, memoryDir: string): void {
  mkdirSync(join(memoryDir, ".."), { recursive: true });
  // Line-ending config must apply DURING checkout: setting it after the clone
  // left a CRLF working tree (global core.autocrlf=true) that looked modified
  // and failed frontmatter validation ("---\r" is not "---").
  gitOrThrow(join(memoryDir, ".."), [
    "clone", "-q", "--config", "core.autocrlf=false", "--config", "core.eol=lf", url, memoryDir,
  ]);
  installMemoryHooks(memoryDir); // hooks are never cloned
}

export function remoteHasMemory(url: string | undefined): url is string {
  return Boolean(url && existsSync(join(url, "HEAD")) && git(url, ["rev-parse", "--verify", "main"]).ok);
}

export type SyncStatus = "skipped" | "clean" | "dirty" | "conflict" | "pushed" | "push_failed";

export interface SyncResult {
  status: SyncStatus;
  summary: string;
}

function conflictSummary(memoryDir: string): string | null {
  const unmerged = git(memoryDir, ["diff", "--name-only", "--diff-filter=U"]).stdout.trim();
  return unmerged ? `Unmerged memory files: ${unmerged.split("\n").join(", ")}` : null;
}

function aheadCount(memoryDir: string): number {
  git(memoryDir, ["fetch", "-q", "origin", "main"]);
  return Number(git(memoryDir, ["rev-list", "--count", "origin/main..HEAD"]).stdout.trim() || "0");
}

/** Before a turn: take the newest memory from other machines (fast-forward or rebase). */
export function pullMemory(memoryDir: string): SyncResult {
  if (!hasOrigin(memoryDir)) return { status: "skipped", summary: "No remote." };
  if (git(memoryDir, ["status", "--porcelain"]).stdout.trim()) {
    return { status: "dirty", summary: "Uncommitted memory changes; not pulling." };
  }
  const pulled = git(memoryDir, ["pull", "-q", "--rebase", "origin", "main"]);
  if (!pulled.ok) {
    git(memoryDir, ["rebase", "--abort"]);
    return { status: "conflict", summary: pulled.stderr.trim().split("\n")[0] ?? "pull failed" };
  }
  return { status: "clean", summary: "Up to date with remote." };
}

/**
 * After a turn: push committed memory, after letta-code's
 * syncPendingMemoryCommitsAfterTurn — never push a dirty or conflicted
 * checkout; on a non-fast-forward rejection, rebase once and retry.
 */
export function syncAfterTurn(memoryDir: string): SyncResult {
  if (!existsSync(join(memoryDir, ".git"))) return { status: "skipped", summary: "No memory repo." };
  const conflict = conflictSummary(memoryDir);
  if (conflict) return { status: "conflict", summary: conflict };
  const dirty = git(memoryDir, ["status", "--porcelain"]).stdout.trim();
  if (dirty) return { status: "dirty", summary: `${dirty.split("\n").length} uncommitted memory change(s).` };
  if (!hasOrigin(memoryDir)) return { status: "skipped", summary: "No remote to push." };
  const ahead = aheadCount(memoryDir);
  if (ahead === 0) return { status: "clean", summary: "Nothing to push." };

  const push = git(memoryDir, ["push", "-q", "origin", "main"]);
  if (push.ok) return { status: "pushed", summary: `Pushed ${ahead} memory commit(s).` };
  if (!/non-fast-forward|fetch first|rejected/.test(push.stderr)) {
    return { status: "push_failed", summary: push.stderr.trim() };
  }
  const rebase = git(memoryDir, ["pull", "-q", "--rebase", "origin", "main"]);
  if (!rebase.ok) {
    const summary = conflictSummary(memoryDir) ?? rebase.stderr.trim();
    git(memoryDir, ["rebase", "--abort"]);
    return { status: "conflict", summary };
  }
  const retry = git(memoryDir, ["push", "-q", "origin", "main"]);
  return retry.ok
    ? { status: "pushed", summary: `Rebased and pushed ${ahead} memory commit(s).` }
    : { status: "push_failed", summary: retry.stderr.trim() };
}

/**
 * letta-code's refreshParentFromOrigin (src/agent/memory-worktree.ts): before
 * merging a reflection, bring the parent up to date so the merge happens
 * on top of what other machines already pushed.
 */
export function refreshFromOrigin(memoryDir: string): void {
  if (!hasOrigin(memoryDir)) return;
  gitOrThrow(memoryDir, ["fetch", "-q", "origin", "main"]);
  if (git(memoryDir, ["merge-base", "--is-ancestor", "origin/main", "HEAD"]).ok) return;
  if (git(memoryDir, ["merge-base", "--is-ancestor", "HEAD", "origin/main"]).ok) {
    gitOrThrow(memoryDir, ["merge", "-q", "--ff-only", "origin/main"]);
    return;
  }
  const rebase = git(memoryDir, ["rebase", "-q", "origin/main"]);
  if (!rebase.ok) {
    git(memoryDir, ["rebase", "--abort"]);
    throw new Error(`Could not rebase memory onto origin/main: ${rebase.stderr.trim()}`);
  }
}
