import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runTurn } from "@/agent/loop";
import { invalidateSystemPrompt, resolveSystemPrompt } from "@/agent/system-prompt";
import { MockProvider } from "@/llm/mock";
import { renderCoreMemory } from "@/memory/compile";
import { git } from "@/memory/git";
import { getMemoryDir } from "@/memory/memfs";
import { createAgent } from "@/store/agent-store";
import { ConversationStore } from "@/store/conversation-store";
import { FILE_TOOLS } from "@/tools/file-tools";
import { tempHome } from "./helpers";

function setup(id: string) {
  const home = tempHome();
  const agent = createAgent({ id }, home);
  const memoryDir = getMemoryDir(id, home);
  const store = new ConversationStore(id, "c1", home);
  return { home, agent, memoryDir, store };
}

function commitFile(dir: string, path: string, content: string, message = `test: ${path}`) {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), content);
  git(dir, ["add", path]);
  const result = git(dir, ["commit", "-q", "-m", message, "--", path]);
  if (!result.ok) throw new Error(result.stderr);
}

describe("v0.3 compiler", () => {
  test("root core files, index and deferred directories", () => {
    const out = renderCoreMemory([
      { relativePath: "MEMORY.md", label: "MEMORY", description: "", body: "# Memory\n- [projects](projects/MEMORY.md)\n" },
      { relativePath: "human.md", label: "human", description: "The user", body: "- likes pnpm\n" },
      { relativePath: "projects/MEMORY.md", label: "projects/MEMORY", description: "", body: "# Projects\n" },
      { relativePath: "projects/mini.md", label: "projects/mini", description: "Mini", body: "" },
      { relativePath: "skills/x/MEMORY.md", label: "skills/x/MEMORY", description: "", body: "" },
    ]);
    expect(out).toBe(
      [
        "<human>",
        "<description>The user</description>",
        "- likes pnpm",
        "</human>",
        "",
        "<memory>",
        "# Memory",
        "- [projects](projects/MEMORY.md)",
        "<deferred-memory>",
        '<directory path="projects/" index="projects/MEMORY.md" />',
        "</deferred-memory>",
        "</memory>",
      ].join("\n"),
    );
  });
});

describe("v0.3 per-conversation prompt cache", () => {
  test("stable revision → identical prompt, no update", () => {
    const { agent, memoryDir, store } = setup("agent-s");
    const a = resolveSystemPrompt({ agent, memoryDir, store });
    const b = resolveSystemPrompt({ agent, memoryDir, store });
    expect(b.systemPrompt).toBe(a.systemPrompt);
    expect(a.memoryUpdate).toBeUndefined();
    expect(b.memoryUpdate).toBeUndefined();
  });

  test("new revision → same system prompt + one <memory_update>", () => {
    const { agent, memoryDir, store } = setup("agent-u");
    const before = resolveSystemPrompt({ agent, memoryDir, store });
    commitFile(memoryDir, "human.md", "---\nname: Human\ndescription: The user\n---\n- prefers tabs\n");
    const after = resolveSystemPrompt({ agent, memoryDir, store });
    expect(after.systemPrompt).toBe(before.systemPrompt);
    expect(after.memoryUpdate).toContain("<memory_update>");
    expect(after.memoryUpdate).toContain("- prefers tabs");
    expect(resolveSystemPrompt({ agent, memoryDir, store }).memoryUpdate).toBeUndefined();
    invalidateSystemPrompt(store);
    expect(resolveSystemPrompt({ agent, memoryDir, store }).systemPrompt).toContain("- prefers tabs");
  });
});

describe("v0.3 turns", () => {
  test("first message carries the agent-info reminder", async () => {
    const { home, agent, store } = setup("agent-i");
    await runTurn({ agent, provider: new MockProvider(), store, tools: FILE_TOOLS, home, userText: "hi" });
    const first = store.all()[0]?.content ?? "";
    expect(first).toStartWith("<system-reminder>\nAgent info:");
    expect(first).toEndWith("hi");
  });

  test("persona edit changes behaviour on the next turn of the SAME conversation", async () => {
    const { home, agent, store } = setup("agent-p");
    const provider = new MockProvider();
    await runTurn({ agent, provider, store, tools: FILE_TOOLS, home, userText: "设定：回答末尾总是加上 🦉" });
    const next = await runTurn({ agent, provider, store, tools: FILE_TOOLS, home, userText: "你好" });
    expect(next.finalText).toEndWith("🦉");
    // The system prompt itself did not change (prompt-cache friendly)...
    expect(next.systemPrompt).not.toContain("🦉");
    // ...the update lives in a persisted reminder, so later turns still see it.
    const later = await runTurn({ agent, provider, store, tools: FILE_TOOLS, home, userText: "再说一次" });
    expect(later.finalText).toEndWith("🦉");
    expect(store.all().filter((m) => m.content.includes("<memory_update>"))).toHaveLength(1);
  });

  test("a new conversation compiles the change into its system prompt", async () => {
    const { home, agent } = setup("agent-n");
    const provider = new MockProvider();
    await runTurn({ agent, provider, store: new ConversationStore(agent.id, "c1", home), tools: FILE_TOOLS, home, userText: "设定：回答末尾总是加上 🦉" });
    const fresh = await runTurn({ agent, provider, store: new ConversationStore(agent.id, "c2", home), tools: FILE_TOOLS, home, userText: "你好" });
    expect(fresh.systemPrompt).toContain("- 回答末尾总是加上 🦉");
    expect(fresh.finalText).toEndWith("🦉");
  });

  test("uncommitted memory → MEMORY COMMIT NEEDED on the next turn", async () => {
    const { home, agent, memoryDir, store } = setup("agent-d");
    // A model that edits memory during the turn but forgets to commit
    // (what qwen2.5:3b actually did in chapter 6).
    const forgetful = new MockProvider({
      rules: [
        (request) =>
          request.messages.at(-1)?.role === "user" && request.messages.at(-1)?.content.endsWith("记一下")
            ? { content: "", toolCalls: [{ id: "call-1", name: "bash", arguments: { command: 'echo "- half-done edit" >> "$MEMORY_DIR/human.md"' } }] }
            : null,
      ],
    });
    await runTurn({ agent, provider: forgetful, store, tools: FILE_TOOLS, home, userText: "记一下" });
    expect(git(memoryDir, ["status", "--porcelain"]).stdout).toContain("human.md");
    await runTurn({ agent, provider: forgetful, store, tools: FILE_TOOLS, home, userText: "继续" });
    const userMessages = store.all().filter((m) => m.role === "user");
    expect(userMessages[0]?.content).not.toContain("MEMORY COMMIT NEEDED");
    expect(userMessages[1]?.content).toContain("MEMORY COMMIT NEEDED");
    expect(userMessages[1]?.content).toEndWith("继续");
  });
});
