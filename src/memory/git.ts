import { spawnSync } from "node:child_process";

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
