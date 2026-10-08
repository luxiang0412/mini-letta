import { describe, expect, test } from "bun:test";
import { runTurn, type TurnEvent } from "@/agent/loop";
import {
  clipSummary,
  compactionThreshold,
  planAll,
  planSlidingWindow,
  SUMMARY_TRUNCATION_SUFFIX,
} from "@/context/compaction";
import { MockProvider } from "@/llm/mock";
import { makeMessage, type Message } from "@/llm/types";
import { searchRecall, tokenize } from "@/recall/search";
import { createAgent } from "@/store/agent-store";
import { ConversationStore } from "@/store/conversation-store";
import { FILE_TOOLS } from "@/tools/file-tools";
import { recallSearchTool } from "@/tools/recall-tool";
import { tempHome } from "./helpers";

const TOOLS = [...FILE_TOOLS, recallSearchTool];

function conversation(n: number, size = 100): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < n; i++) {
    out.push(makeMessage("user", `u${i} ${"x".repeat(size)}`));
    out.push(makeMessage("assistant", `a${i} ${"y".repeat(size)}`));
  }
  return out;
}

describe("v0.4 budget", () => {
  test("threshold reserves 16384 tokens, or 20% of small windows", () => {
    expect(compactionThreshold(200_000)).toBe(183_616);
    expect(compactionThreshold(32_000)).toBe(25_600);
    expect(compactionThreshold(2_000)).toBe(1_600);
  });
});

describe("v0.4 summary clipping", () => {
  test("a long-winded summary is clipped to ~10% of the window", () => {
    const clipped = clipSummary("字".repeat(1_000), 1_200);
    expect(clipped).toBe(`${"字".repeat(480)}${SUMMARY_TRUNCATION_SUFFIX}`);
    expect(clipSummary("short", 1_200)).toBe("short");
  });
});

describe("v0.4 compaction planning", () => {
  test("sliding window cuts right before an assistant message", () => {
    const messages = conversation(10); // 20 messages, 27 tokens each
    const roomy = planSlidingWindow(messages, { contextWindow: 1_000 });
    expect(roomy.messagesToKeep[0]?.role).toBe("assistant");
    expect(roomy.messagesToSummarize.length + roomy.messagesToKeep.length).toBe(20);
    // First attempt evicts 40%: round(0.4 * 20) = 8 → index 7 is the nearest assistant.
    expect(roomy.messagesToSummarize.length).toBe(7);
    // A tighter window keeps growing the cut (50%, 60%) until the tail fits 70%.
    const tight = planSlidingWindow(messages, { contextWindow: 400 });
    expect(tight.messagesToSummarize.length).toBe(11);
  });

  test("a trailing pending tool call is kept with its context", () => {
    const messages = [...conversation(1), makeMessage("assistant", "", { toolCalls: [{ id: "c", name: "bash", arguments: {} }] })];
    expect(planAll(messages).messagesToKeep).toHaveLength(1);
  });
});

describe("v0.4 recall search", () => {
  test("tokenizer splits CJK from latin runs", () => {
    expect(tokenize("数据库端口是5433,用Postgres")).toEqual(["数据库端口是", "5433", "用", "postgres"]);
  });
});

describe("v0.4 long conversations", () => {
  test("compaction happens before overflow; recall finds evicted details", async () => {
    const home = tempHome();
    const agent = createAgent({ id: "agent-long" }, home);
    const store = new ConversationStore(agent.id, "c1", home);
    const provider = new MockProvider({ contextWindow: 1_200 });
    const events: TurnEvent[] = [];
    const say = (userText: string) =>
      runTurn({ agent, provider, store, tools: TOOLS, home, userText, onEvent: (e) => events.push(e) });

    await say("我们的数据库端口是 5433，别用默认的 5432");
    for (let i = 0; i < 16; i++) await say(`第 ${i} 个无关话题：${"今天天气不错。".repeat(12)}`);

    const compactions = events.filter((e) => e.type === "compaction");
    expect(compactions.length).toBeGreaterThan(0);
    expect(compactions[0]?.type === "compaction" && compactions[0].stats.trigger).toBe("context_pressure");
    // The port is gone from the context window...
    expect(store.inContext().some((m) => m.content.includes("5433"))).toBe(false);
    // ...but not from recall memory.
    expect(store.all().some((m) => m.content.includes("5433"))).toBe(true);
    const answer = await say("还记得数据库端口吗？");
    expect(answer.finalText).toContain("5433");
    // Regression: without demotion the question itself was the top hit.
    expect(searchRecall({ home, agentId: agent.id, query: "数据库端口" })[0]?.text).toBe("还记得数据库端口吗？");
    expect(
      searchRecall({ home, agentId: agent.id, query: "数据库端口", currentConversationId: "c1" })[0]?.text,
    ).toContain("5433");
  });
});
