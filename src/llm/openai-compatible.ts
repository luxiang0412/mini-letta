import type { CompletionRequest, CompletionResult, LLMProvider, Message } from "./types";

/**
 * Minimal OpenAI-compatible chat client (works with Ollama's /v1 endpoint).
 * letta-code hands this job to pi-ai; we only need text + tool calls.
 */
export interface OpenAICompatibleOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  contextWindow?: number;
}

interface WireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

function toWire(message: Message): Record<string, unknown> {
  if (message.role === "tool") {
    return { role: "tool", content: message.content, tool_call_id: message.toolCallId };
  }
  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })),
    };
  }
  return { role: message.role, content: message.content };
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  readonly contextWindow: number;

  constructor(private readonly options: OpenAICompatibleOptions) {
    this.name = `openai:${options.model}`;
    this.contextWindow = options.contextWindow ?? 32_000;
  }

  async complete(
    request: CompletionRequest,
    onText?: (delta: string) => void,
  ): Promise<CompletionResult> {
    const body = {
      model: this.options.model,
      messages: [{ role: "system", content: request.system }, ...request.messages.map(toWire)],
      ...(request.tools.length
        ? {
            tools: request.tools.map((tool) => ({
              type: "function",
              function: tool,
            })),
          }
        : {}),
      temperature: 0,
    };
    const response = await fetch(`${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.options.apiKey ?? "none"}`,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`LLM HTTP ${response.status}: ${await response.text()}`);
    }
    const json = (await response.json()) as {
      choices: Array<{ message: { content: string | null; tool_calls?: WireToolCall[] } }>;
    };
    const message = json.choices[0]?.message;
    const content = message?.content ?? "";
    if (content) onText?.(content);
    return {
      content,
      toolCalls: (message?.tool_calls ?? []).map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: parseArguments(call.function.arguments),
      })),
    };
  }
}
