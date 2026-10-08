import { SLIDING_WINDOW_SUMMARY_PROMPT } from "@/context/compaction";
import { estimateRequestTokens } from "@/context/tokens";
import {
  callTool,
  currentMemorySection,
  hasTool,
  lastMessage,
  lastUserText,
  type MockRule,
  say,
  shellQuote,
} from "./mock-helpers";
import { reflectionRule } from "./mock-reflection";
import {
  type CompletionRequest,
  type CompletionResult,
  ContextOverflowError,
  type LLMProvider,
} from "./types";

export type { MockRule } from "./mock-helpers";

const REMEMBER = /^(?:请)?(?:记住|remember)\s*[:：]?\s*(.+)$/is;
const PERSONA = /^(?:设定|persona)\s*[:：]\s*(.+)$/is;
const RECALL = /还记得(.+?)吗|recall\s*[:：]\s*(.+)/i;
const SIGNATURE = /回答末尾(?:总是)?加上\s*(\S+)/;
const WHO_AM_I = /我是谁|你(?:都)?知道我(?:什么|哪些)|关于我|what do you know about me/i;

function toolNameFor(request: CompletionRequest, toolCallId: string | undefined): string | undefined {
  for (const message of request.messages) {
    const call = message.toolCalls?.find((c) => c.id === toolCallId);
    if (call) return call.name;
  }
  return undefined;
}

/** After a tool ran, summarise its result in one sentence. */
const afterToolRule: MockRule = (request) => {
  const last = lastMessage(request);
  if (last?.role !== "tool") return null;
  if (last.content.startsWith("Error:")) return say(`操作失败：${last.content.slice(7).trim()}`);
  if (toolNameFor(request, last.toolCallId) === "recall_search") {
    if (last.content === "No matching messages.") return say("我翻了过去的对话，没有找到相关内容。");
    const best = last.content.split("\n")[0]?.replace(/^\[[^\]]*\]\s*/, "");
    return say(`我在过去的对话里找到了：${best}`);
  }
  return say("好的，我已经把这件事记进记忆里了。");
};

/** The summarizer: deliberately lossy — keeps only the gist of each user line. */
const summaryRule: MockRule = (request) => {
  if (request.system !== SLIDING_WINDOW_SUMMARY_PROMPT) return null;
  const userLines = (request.messages[0]?.content ?? "")
    .split("\n")
    .filter((line) => line.startsWith("user: "))
    .map((line) => line.slice(6, 6 + 12));
  return say(`用户先后谈到：${userLines.join("；")}。（细节已省略，可用 recall 检索）`);
};

/** "还记得 X 吗？" → search recall memory for X. */
const recallRule: MockRule = (request) => {
  if (lastMessage(request)?.role !== "user" || !hasTool(request, "recall_search")) return null;
  const match = lastUserText(request).match(RECALL);
  const query = (match?.[1] ?? match?.[2])?.replace(/[我们之前说过的？?]/g, "").trim();
  return query ? callTool("recall_search", { query }) : null;
};

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
    this.rules = [
      ...(options.rules ?? []),
      reflectionRule,
      summaryRule,
      afterToolRule,
      rememberRule,
      personaRule,
      recallRule,
      whoAmIRule,
      echoRule,
    ];
  }

  async complete(
    request: CompletionRequest,
    onText?: (delta: string) => void,
  ): Promise<CompletionResult> {
    // Behave like a real provider: an oversized request is rejected.
    const requestTokens = estimateRequestTokens(request);
    if (requestTokens > this.contextWindow) throw new ContextOverflowError(requestTokens, this.contextWindow);
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
