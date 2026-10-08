import { isReminderOnly, stripReminders } from "@/agent/reminders";
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

/** The last message that needs an answer (reminder-only messages don't). */
export function lastMessage(request: CompletionRequest): Message | undefined {
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const message = request.messages[i];
    if (message && !(message.role === "user" && isReminderOnly(message.content))) return message;
  }
  return undefined;
}

/** What the human last typed, with harness reminders stripped. */
export function lastUserText(request: CompletionRequest): string {
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const message = request.messages[i];
    if (message?.role !== "user" || isReminderOnly(message.content)) continue;
    return stripReminders(message.content);
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

/**
 * A memory section as the model should believe it: the newest
 * <memory_update> wins over the (possibly stale) system prompt.
 */
export function currentMemorySection(request: CompletionRequest, label: string): string | undefined {
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const content = request.messages[i]?.content ?? "";
    if (content.includes("<memory_update>")) {
      const section = promptSection(content, label);
      if (section !== undefined) return section;
    }
  }
  return promptSection(request.system, label);
}

const REMEMBER = /^(?:请)?(?:记住|remember)\s*[:：]?\s*(.+)$/is;
const PERSONA = /^(?:设定|persona)\s*[:：]\s*(.+)$/is;
const SIGNATURE = /回答末尾(?:总是)?加上\s*(\S+)/;
const WHO_AM_I = /我是谁|你(?:都)?知道我(?:什么|哪些)|关于我|what do you know about me/i;

/** After a tool ran, summarise its result in one sentence. */
const afterToolRule: MockRule = (request) => {
  const last = lastMessage(request);
  if (last?.role !== "tool") return null;
  if (last.content.startsWith("Error:")) return say(`操作失败：${last.content.slice(7).trim()}`);
  return say("好的，我已经把这件事记进记忆里了。");
};

export function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/** "记住：X" → append "- X" to human.md and commit just that file. */
const rememberRule: MockRule = (request) => {
  if (lastMessage(request)?.role !== "user") return null;
  const fact = lastUserText(request).match(REMEMBER)?.[1]?.trim();
  if (!fact || !hasTool(request, "bash")) return null;
  return callTool("bash", {
    command: [
      'cd "$MEMORY_DIR"',
      `printf '%s\\n' ${shellQuote(`- ${fact}`)} >> human.md`,
      "git add human.md",
      `git commit -q -m ${shellQuote("chore: remember user fact")} -- human.md`,
      "git log --oneline -1",
    ].join(" && "),
  });
};

/** "设定：X" → append X to persona.md and commit it. */
const personaRule: MockRule = (request) => {
  if (lastMessage(request)?.role !== "user") return null;
  const rule = lastUserText(request).match(PERSONA)?.[1]?.trim();
  if (!rule || !hasTool(request, "bash")) return null;
  return callTool("bash", {
    command: [
      'cd "$MEMORY_DIR"',
      `printf '%s\\n' ${shellQuote(`- ${rule}`)} >> persona.md`,
      "git add persona.md",
      `git commit -q -m ${shellQuote("feat: update persona")} -- persona.md`,
      "git log --oneline -1",
    ].join(" && "),
  });
};

/** "你知道我什么？" → answer only from what the compiled memory contains. */
const whoAmIRule: MockRule = (request) => {
  if (lastMessage(request)?.role !== "user") return null;
  if (!WHO_AM_I.test(lastUserText(request))) return null;
  const human = currentMemorySection(request, "human");
  return say(human ? `我记得关于你的这些：\n${human}` : "我对你还一无所知。");
};

const echoRule: MockRule = (request) => say(`（mock）我听到了：${lastUserText(request)}`);

export class MockProvider implements LLMProvider {
  readonly name = "mock";
  readonly contextWindow: number;
  private readonly rules: MockRule[];

  constructor(options: { contextWindow?: number; rules?: MockRule[] } = {}) {
    this.contextWindow = options.contextWindow ?? 8_000;
    this.rules = [...(options.rules ?? []), afterToolRule, rememberRule, personaRule, whoAmIRule, echoRule];
  }

  async complete(
    request: CompletionRequest,
    onText?: (delta: string) => void,
  ): Promise<CompletionResult> {
    for (const rule of this.rules) {
      let result = rule(request);
      if (!result) continue;
      // Behaviour follows memory: a persona line can demand a signature.
      const signature = currentMemorySection(request, "persona")?.match(SIGNATURE)?.[1];
      if (signature && result.toolCalls.length === 0) {
        result = { ...result, content: `${result.content} ${signature}` };
      }
      for (let i = 0; i < result.content.length; i += 8) {
        onText?.(result.content.slice(i, i + 8));
      }
      return result;
    }
    throw new Error("unreachable: echoRule always answers");
  }
}
