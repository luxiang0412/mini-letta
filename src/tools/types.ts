import type { ToolSchema } from "@/llm/types";
import type { AgentRecord } from "@/store/agent-store";

/** Everything a tool may touch during one turn. */
export interface ToolContext {
  agent: AgentRecord;
  home: string;
  conversationId: string;
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
