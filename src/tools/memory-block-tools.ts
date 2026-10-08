import { saveAgent } from "@/store/agent-store";
import { stringArg, type Tool, type ToolContext } from "./types";

/**
 * MemGPT-style block tools (v0.1). letta-code's non-MemFS agents edit blocks
 * through a server-side `memory` tool; MemFS agents (v0.2+) edit files instead.
 */
function findBlock(ctx: ToolContext, label: string) {
  const block = ctx.agent.blocks.find((b) => b.label === label);
  if (!block) throw new Error(`No memory block '${label}'`);
  if (block.readOnly) throw new Error(`Memory block '${label}' is read-only`);
  return block;
}

export const memoryAppendTool: Tool = {
  schema: {
    name: "memory_append",
    description: "Append a line to a core memory block (persona or human).",
    parameters: {
      type: "object",
      properties: {
        label: { type: "string", description: "Block label, e.g. human" },
        content: { type: "string", description: "Text to append" },
      },
      required: ["label", "content"],
    },
  },
  async run(args, ctx) {
    const block = findBlock(ctx, stringArg(args, "label"));
    const content = stringArg(args, "content").trim();
    block.value =
      block.value === "(nothing yet)" ? content : `${block.value.trimEnd()}\n${content}`;
    saveAgent(ctx.agent, ctx.home);
    return `Appended to ${block.label}.`;
  },
};

export const memoryReplaceTool: Tool = {
  schema: {
    name: "memory_replace",
    description: "Replace exact text inside a core memory block.",
    parameters: {
      type: "object",
      properties: {
        label: { type: "string" },
        old_text: { type: "string" },
        new_text: { type: "string" },
      },
      required: ["label", "old_text", "new_text"],
    },
  },
  async run(args, ctx) {
    const block = findBlock(ctx, stringArg(args, "label"));
    const oldText = stringArg(args, "old_text");
    if (!block.value.includes(oldText)) {
      throw new Error(`'${oldText}' not found in ${block.label}`);
    }
    block.value = block.value.replace(oldText, stringArg(args, "new_text"));
    saveAgent(ctx.agent, ctx.home);
    return `Replaced text in ${block.label}.`;
  },
};
