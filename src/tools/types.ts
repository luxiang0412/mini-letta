import type { ToolSchema } from "@/llm/types";
import type { SandboxPolicy } from "@/sandbox/policy";
import type { AgentRecord } from "@/store/agent-store";

/** Everything a tool may touch during one turn. */
export interface ToolContext {
  agent: AgentRecord;
  home: string;
  conversationId: string;
  /** The checkout this run may write: the agent's MemFS, or a worktree of it. */
  memoryDir: string;
  /** Extra environment for shell commands (MEMORY_DIR, AGENT_ID, ...). */
  env: Record<string, string>;
  /** Kernel confinement for shell commands, when enabled. */
  sandbox?: SandboxPolicy;
}

export interface Tool {
  schema: ToolSchema;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

export function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string") {
    throw new Error(`Missing string argument '${key}'`);
  }
  return value;
}

/** Environment every shell command sees, like letta-code's MEMORY_DIR/AGENT_ID. */
export function memoryEnv(agent: AgentRecord, memoryDir: string): Record<string, string> {
  return {
    MEMORY_DIR: memoryDir,
    AGENT_ID: agent.id,
    AGENT_NAME: agent.name,
  };
}
