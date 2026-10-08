import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number;
}

/** Run git synchronously in `cwd`; never throws. */
export function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): GitResult {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? -1,
  };
}

/** Like git(), but throws with stderr on failure. */
export function gitOrThrow(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  const result = git(cwd, args, env);
  if (!result.ok) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout;
}

export function headRevision(cwd: string): string | undefined {
  const result = git(cwd, ["rev-parse", "--verify", "HEAD"]);
  return result.ok ? result.stdout.trim() : undefined;
}

/**
 * This checkout's own git directory (letta-code's getMemoryGitDir,
 * src/agent/memory-git-dir.ts). In a worktree `.git` is a FILE pointing to
 * `<common>/worktrees/<name>`, so never build paths as `<checkout>/.git/...`.
 */
export function gitDir(cwd: string): string {
  return resolve(cwd, gitOrThrow(cwd, ["rev-parse", "--git-dir"]).trim());
}
