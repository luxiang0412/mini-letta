import { dirname, join } from "node:path";
import { getMemoryDir } from "@/memory/memfs";
import { ownerAgentId, type SandboxPolicy } from "@/sandbox/policy";
import { agentDir } from "@/store/paths";

/** Cross-agent shell profile: everything writable except other agents' trees. */
export function crossAgentProfile(home: string, agentId: string): SandboxPolicy {
  return {
    restrictWrites: false,
    deniedRoots: [join(home, "agents")],
    readonlyRoots: [],
    writableRoots: [agentDir(ownerAgentId(agentId), home)],
  };
}

/**
 * Memory-subagent profile (reflection): read-only root, other agents masked,
 * writes only to the worktree and the git dir its commits land in. No temp
 * dir is carved out — hence the reflection prompt's "$MEMORY_DIR/.tmp/" rule.
 */
export function reflectionProfile(input: {
  home: string;
  parentAgentId: string;
  worktreeDir: string;
  payloadPath: string;
}): SandboxPolicy {
  return {
    restrictWrites: true,
    deniedRoots: [join(input.home, "agents")],
    readonlyRoots: [dirname(input.payloadPath)],
    writableRoots: [input.worktreeDir, join(getMemoryDir(input.parentAgentId, input.home), ".git")],
  };
}
