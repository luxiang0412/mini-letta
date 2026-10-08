import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { git } from "./git";
import { buildValidatorScript } from "./hooks";

/**
 * Validate the COMMITTED tree, not the index. The pre-commit hook can be
 * skipped (`git commit --no-verify`, a hook-less clone); this second check,
 * after letta-code's validateMemoryConstraintsHead
 * (src/agent/memory-constraints-audit.ts), runs the same validator against
 * HEAD through a throwaway GIT_INDEX_FILE, leaving the real index untouched.
 */
export function auditCommittedMemory(memoryDir: string): string[] {
  if (!git(memoryDir, ["rev-parse", "--verify", "HEAD"]).ok) return [];
  const temp = mkdtempSync(join(tmpdir(), "mini-letta-audit-"));
  const env = { ...process.env, GIT_INDEX_FILE: join(temp, "index") };
  try {
    const readTree = spawnSync("git", ["read-tree", "HEAD"], { cwd: memoryDir, env, encoding: "utf8" });
    if (readTree.status !== 0) return [`could not read HEAD: ${readTree.stderr.trim()}`];
    const validator = join(temp, "validate.js");
    writeFileSync(validator, buildValidatorScript());
    const result = spawnSync(process.execPath, [validator], { cwd: memoryDir, env, encoding: "utf8" });
    if (result.status === 0) return [];
    return `${result.stdout}${result.stderr}`
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && line !== "Memory validation failed:");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
