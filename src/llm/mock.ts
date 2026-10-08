import {
  type CompletionRequest,
  type CompletionResult,
  type LLMProvider,
  type Message,
  newId,
} from "./types";

/**
 * A deterministic "model" so every chapter runs offline and every test is
 * repeatable. Rules are tried in order; the first that returns a result wins.
 * Later versions register more rules (compaction summaries, reflection, recall).
 */
export type MockRule = (request: CompletionRequest) => CompletionResult | null;

export function lastMessage(request: CompletionRequest): Message | undefined {
  return request.messages.at(-1);
}

export function lastUserText(request: CompletionRequest): string {
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const message = request.messages[i];
    if (message?.role === "user") return message.content.trim();
  }
  return "";
}

export function hasTool(request: CompletionRequest, name: string): boolean {
  return request.tools.some((tool) => tool.name === name);
}

export function callTool(name: string, args: Record<string, unknown>, content = ""): CompletionResult {
  return { content, toolCalls: [{ id: newId("call"), name, arguments: args }] };
}

export function say(content: string): CompletionResult {
  return { content, toolCalls: [] };
}

/** Text of a `<label>...</label>` section of the system prompt, if present. */
export function promptSection(system: string, label: string): string | undefined {
  const match = system.match(new RegExp(`<${label}>\\n([\\s\\S]*?)\\n</${label}>`));
  if (!match?.[1]) return undefined;
  return match[1]
    .split("\n")
    .filter((line) => !line.startsWith("<description>") && !line.startsWith("<projection>"))
    .join("\n")
    .trim();
}

const REMEMBER = /^(?:请)?(?:记住|remember)\s*[:：]?\s*(.+)$/is;
const WHO_AM_I = /我是谁|你(?:都)?知道我(?:什么|哪些)|关于我|what do you know about me/i;

/** After a tool ran, summarise its result in one sentence. */
const afterToolRule: MockRule = (request) => {
  const last = lastMessage(request);
  if (last?.role !== "tool") return null;
  if (last.content.startsWith("Error:")) return say(`操作失败：${last.content.slice(7).trim()}`);
  return say("好的，我已经把这件事记进记忆里了。");
};

/** "记住：X" → write X into the human block (v0.1) or file (v0.2+). */
const rememberRule: MockRule = (request) => {
  if (lastMessage(request)?.role !== "user") return null;
  const fact = lastUserText(request).match(REMEMBER)?.[1]?.trim();
  if (!fact) return null;
  if (hasTool(request, "memory_append")) {
    return callTool("memory_append", { label: "human", content: `- ${fact}` });
  }
  return null;
};

/** "你知道我什么？" → answer only from what the compiled prompt contains. */
const whoAmIRule: MockRule = (request) => {
  if (lastMessage(request)?.role !== "user") return null;
  if (!WHO_AM_I.test(lastUserText(request))) return null;
  const human = promptSection(request.system, "human");
  return say(human && human !== "(nothing yet)" ? `我记得关于你的这些：\n${human}` : "我对你还一无所知。");
};

const echoRule: MockRule = (request) => say(`（mock）我听到了：${lastUserText(request)}`);

export class MockProvider implements LLMProvider {
  readonly name = "mock";
  readonly contextWindow: number;
  private readonly rules: MockRule[];

  constructor(options: { contextWindow?: number; rules?: MockRule[] } = {}) {
    this.contextWindow = options.contextWindow ?? 8_000;
    this.rules = [...(options.rules ?? []), afterToolRule, rememberRule, whoAmIRule, echoRule];
  }

  async complete(
    request: CompletionRequest,
    onText?: (delta: string) => void,
  ): Promise<CompletionResult> {
    for (const rule of this.rules) {
      const result = rule(request);
      if (!result) continue;
      for (let i = 0; i < result.content.length; i += 8) {
        onText?.(result.content.slice(i, i + 8));
      }
      return result;
    }
    throw new Error("unreachable: echoRule always answers");
  }
}
