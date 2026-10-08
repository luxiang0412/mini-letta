/**
 * Provider-neutral message and completion types.
 *
 * letta-code delegates provider payloads to pi-ai and stores `LocalMessage`
 * rows (src/backend/local/local-message.ts). mini-letta keeps one flat shape
 * that is easy to print, persist as JSONL and feed to any chat API.
 */

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface Message {
  id: string;
  role: Role;
  content: string;
  /** Assistant messages may request tools. */
  toolCalls?: ToolCall[];
  /** Tool messages answer exactly one tool call. */
  toolCallId?: string;
  /** Harness-made messages: a compaction summary (letta's summary_message). */
  kind?: "summary";
  createdAt: string;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface CompletionRequest {
  system: string;
  messages: Message[];
  tools: ToolSchema[];
}

export interface CompletionResult {
  content: string;
  toolCalls: ToolCall[];
}

export interface LLMProvider {
  readonly name: string;
  /** Context window in tokens; used by the compaction policy (Part IV). */
  readonly contextWindow: number;
  complete(
    request: CompletionRequest,
    onText?: (delta: string) => void,
  ): Promise<CompletionResult>;
}

let counter = 0;

export function newId(prefix: string): string {
  counter += 1;
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}${counter.toString(36)}${random}`;
}

export function makeMessage(
  role: Role,
  content: string,
  extra: Partial<Message> = {},
): Message {
  return {
    id: newId("msg"),
    role,
    content,
    createdAt: new Date().toISOString(),
    ...extra,
  };
}

/** The request did not fit the model's context window. */
export class ContextOverflowError extends Error {
  constructor(readonly requestTokens: number, readonly contextWindow: number) {
    super(`Context overflow: ~${requestTokens} tokens > window ${contextWindow}`);
    this.name = "ContextOverflowError";
  }
}
