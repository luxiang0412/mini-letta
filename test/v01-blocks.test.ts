import { describe, expect, test } from "bun:test";
import { runTurn } from "@/agent/loop";
import { MockProvider } from "@/llm/mock";
import { compileBlocksSystemPrompt, injectCoreMemory } from "@/memory/compile";
import { createAgent, loadAgent } from "@/store/agent-store";
import { ConversationStore } from "@/store/conversation-store";
import { memoryAppendTool, memoryReplaceTool } from "@/tools/memory-block-tools";
import { tempHome } from "./helpers";

describe("v0.1 core memory blocks", () => {
  test("injectCoreMemory replaces the variable or appends it", () => {
    expect(injectCoreMemory("A {CORE_MEMORY} B", "M")).toBe("A M B");
    expect(injectCoreMemory("A", "M")).toBe("A\n\nM");
  });

  test("compiled prompt contains every block", () => {
    const home = tempHome();
    const agent = createAgent({ id: "agent-t" }, home);
    const prompt = compileBlocksSystemPrompt({ agent, conversationId: "c1", previousMessageCount: 0 });
    expect(prompt).toContain("<persona>");
    expect(prompt).toContain("<human>");
    expect(prompt).toContain("- AGENT_ID: agent-t");
    expect(prompt).not.toContain("{CORE_MEMORY}");
  });

  test("remember → memory_append → visible in the next step's prompt", async () => {
    const home = tempHome();
    const agent = createAgent({ id: "agent-t" }, home);
    const store = new ConversationStore(agent.id, "c1", home);
    const tools = [memoryAppendTool, memoryReplaceTool];
    const provider = new MockProvider();

    const first = await runTurn({ agent, provider, store, tools, home, userText: "记住：我用 pnpm 而不是 npm" });
    expect(first.steps).toBe(2); // tool call step + final answer step
    expect(first.systemPrompt).toContain("- 我用 pnpm 而不是 npm");
    expect(loadAgent("agent-t", home).blocks[1]?.value).toBe("- 我用 pnpm 而不是 npm");

    const second = await runTurn({ agent, provider, store, tools, home, userText: "你知道我什么？" });
    expect(second.finalText).toContain("我用 pnpm 而不是 npm");
    expect(store.all().map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "user", "assistant"]);
  });

  test("read-only blocks reject edits", async () => {
    const home = tempHome();
    const agent = createAgent({ id: "agent-ro", blocks: [{ label: "human", value: "x", readOnly: true }] }, home);
    const out = await memoryAppendTool.run({ label: "human", content: "y" }, { agent, home, conversationId: "c" }).catch((e: Error) => e.message);
    expect(out).toContain("read-only");
  });
});
