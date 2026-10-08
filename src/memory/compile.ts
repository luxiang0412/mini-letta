import type { AgentRecord, MemoryBlock } from "@/store/agent-store";

/**
 * Compile an agent's memory into its system prompt.
 *
 * Mirrors the shape of letta-code's compileLocalSystemPrompt
 * (src/backend/local/system-prompt-compilation.ts): memory is rendered into
 * XML-ish sections and substituted for the `{CORE_MEMORY}` variable, followed
 * by a `<memory_metadata>` footer.
 */
export const CORE_MEMORY_VARIABLE = "{CORE_MEMORY}";

export function renderBlock(block: MemoryBlock): string {
  const lines = [`<${block.label}>`];
  if (block.description?.trim()) {
    lines.push(`<description>${block.description.trim()}</description>`);
  }
  if (block.value.trimEnd()) lines.push(block.value.trimEnd());
  lines.push(`</${block.label}>`);
  return lines.join("\n");
}

export function renderMemoryMetadata(input: {
  agentId: string;
  conversationId: string;
  compiledAt: Date;
  previousMessageCount: number;
}): string {
  return [
    "<memory_metadata>",
    `- AGENT_ID: ${input.agentId}`,
    `- CONVERSATION_ID: ${input.conversationId}`,
    `- System prompt last recompiled: ${input.compiledAt.toISOString()}`,
    `- ${input.previousMessageCount} previous messages are stored in recall memory`,
    "</memory_metadata>",
  ].join("\n");
}

/** Replace `{CORE_MEMORY}`, appending it when the raw prompt lacks one. */
export function injectCoreMemory(rawSystemPrompt: string, coreMemory: string): string {
  const prompt = rawSystemPrompt.includes(CORE_MEMORY_VARIABLE)
    ? rawSystemPrompt
    : `${rawSystemPrompt.trimEnd()}\n\n${CORE_MEMORY_VARIABLE}`;
  return prompt.replaceAll(CORE_MEMORY_VARIABLE, coreMemory);
}

export function compileBlocksSystemPrompt(input: {
  agent: AgentRecord;
  conversationId: string;
  previousMessageCount: number;
  now?: Date;
}): string {
  const blocks = input.agent.blocks.map(renderBlock).join("\n\n");
  const metadata = renderMemoryMetadata({
    agentId: input.agent.id,
    conversationId: input.conversationId,
    compiledAt: input.now ?? new Date(),
    previousMessageCount: input.previousMessageCount,
  });
  return injectCoreMemory(input.agent.system, `<memory>\n${blocks}\n</memory>\n\n${metadata}`);
}
