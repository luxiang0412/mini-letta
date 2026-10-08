import type { Message, ToolSchema } from "@/llm/types";

/**
 * The same cheap heuristic letta-code uses before it has provider usage
 * numbers (src/backend/local/local-context-estimate.ts): ~4 chars per token.
 */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateMessageTokens(message: Message): number {
  let chars = message.content.length;
  for (const call of message.toolCalls ?? []) {
    chars += call.name.length + JSON.stringify(call.arguments).length;
  }
  return Math.ceil(chars / 4);
}

export function estimateMessagesTokens(messages: Message[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

export function estimateRequestTokens(input: {
  system: string;
  messages: Message[];
  tools: ToolSchema[];
}): number {
  return (
    estimateTextTokens(input.system) +
    estimateTextTokens(JSON.stringify(input.tools)) +
    estimateMessagesTokens(input.messages)
  );
}
