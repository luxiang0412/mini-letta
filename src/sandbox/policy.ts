import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

/**
 * Filesystem isolation between agents that share one machine, after
 * letta-code's src/sandbox/{availability,bwrap}.ts and
 * src/permissions/cross-agent-guard.ts.
 *
 * MINI_LETTA_FS_SANDBOX (same tri-state as LETTA_FS_SANDBOX):
 *   unset → reflection subagents confined; the agent's own shells unconfined
 *   1     → both confined
 *   0     → nothing confined
 */
export interface SandboxPolicy {
  /** Root view: read-only (memory subagent) or writable (cross-agent shell). */
  restrictWrites: boolean;
  /** Masked with an empty tmpfs: absent, not just unwritable. */
  deniedRoots: string[];
  readonlyRoots: string[];
  writableRoots: string[];
}

export function isFsSandboxEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.MINI_LETTA_FS_SANDBOX?.trim().toLowerCase();
  return value !== "0" && value !== "false";
}

export function isShellSandboxEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.MINI_LETTA_FS_SANDBOX?.trim().toLowerCase();
  return value === "1" || value === "true";
}

let bwrapAvailable: boolean | undefined;

/** Probe, don't just look for the binary: user namespaces may be disabled. */
export function isBwrapAvailable(): boolean {
  bwrapAvailable ??=
    spawnSync("bwrap", ["--ro-bind", "/", "/", "--unshare-user", "/bin/true"], { timeout: 5_000 }).status === 0;
  return bwrapAvailable;
}

/** Mount order: root → dev/proc → masks → readonly carve-outs → writable carve-outs. */
export function buildBwrapArgs(policy: SandboxPolicy): string[] {
  const args = [policy.restrictWrites ? "--ro-bind" : "--bind", "/", "/", "--dev", "/dev", "--proc", "/proc"];
  for (const root of policy.deniedRoots) args.push("--tmpfs", root);
  for (const root of policy.readonlyRoots) args.push("--ro-bind-try", root, root);
  for (const root of policy.writableRoots) args.push("--bind-try", root, root);
  args.push("--die-with-parent");
  return args;
}

export function wrapCommand(policy: SandboxPolicy | undefined, command: string): [string, string[]] {
  if (!policy || !isBwrapAvailable()) return ["bash", ["-c", command]];
  return ["bwrap", [...buildBwrapArgs(policy), "--", "bash", "-c", command]];
}

/** Agents may act for themselves; a subagent `<parent>~<role>` acts for its parent. */
export function ownerAgentId(agentId: string): string {
  return agentId.split("~")[0] ?? agentId;
}

function realOrLexical(path: string): string {
  // Resolve symlinks for the longest existing prefix, so a link inside your
  // own tree that points into another agent's tree is still caught.
  let current = resolve(path);
  const tail: string[] = [];
  while (!existsSync(current) && dirname(current) !== current) {
    tail.unshift(current.slice(dirname(current).length + 1));
    current = dirname(current);
  }
  const real = existsSync(current) ? realpathSync(current) : current;
  return tail.length ? join(real, ...tail) : real;
}

/**
 * The in-process guard for file tools (they never fork, so a kernel sandbox
 * cannot see them). Checks both the lexical and the symlink-resolved path.
 */
export function assertNotOtherAgentsMemory(path: string, agentsRoot: string, agentId: string): void {
  const owner = ownerAgentId(agentId);
  const roots = [resolve(agentsRoot), existsSync(agentsRoot) ? realpathSync(agentsRoot) : resolve(agentsRoot)];
  for (const candidate of [resolve(path), realOrLexical(path)]) {
    for (const root of roots) {
      if (!candidate.startsWith(root + sep)) continue;
      const target = candidate.slice(root.length + 1).split(sep)[0];
      if (target && ownerAgentId(target) !== owner) {
        throw new Error(`Access denied: ${path} belongs to agent '${target}', not '${owner}'`);
      }
    }
  }
}
