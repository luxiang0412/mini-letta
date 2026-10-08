#!/usr/bin/env bun
/**
 * Build a realistic demo state (offline, mock LLM) in $MINI_LETTA_HOME and
 * print what happened. Used by Lab 6, the Palace screenshots and e2e.ts.
 *
 *   MINI_LETTA_HOME=$(mktemp -d) bun scripts/demo.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runTurn, type TurnEvent } from "@/agent/loop";
import { MockProvider } from "@/llm/mock";
import { git } from "@/memory/git";
import { getMemoryDir } from "@/memory/memfs";
import { maybeReflectAfterTurn } from "@/reflection/post-turn";
import { loadOrCreateAgent } from "@/store/agent-store";
import { ConversationStore } from "@/store/conversation-store";
import { getHome } from "@/store/paths";
import { FILE_TOOLS } from "@/tools/file-tools";
import { recallSearchTool } from "@/tools/recall-tool";

const home = getHome();
const agent = loadOrCreateAgent("agent-demo", home);
const memoryDir = getMemoryDir(agent.id, home);
const provider = new MockProvider({ contextWindow: 1_400 });
// Reflection runs on its own model/window. Sharing the tiny 1.4k window made
// the reflector compact away the transcript it had just read, re-read it, and
// loop until max steps (observed while writing chapter 15).
const reflectionProvider = new MockProvider();
const tools = [...FILE_TOOLS, recallSearchTool];
const log: string[] = [];

async function say(conversationId: string, text: string): Promise<string> {
  const store = new ConversationStore(agent.id, conversationId, home);
  const onEvent = (e: TurnEvent) => {
    if (e.type === "compaction") log.push(`[${conversationId}] compaction ${e.stats.messagesBefore}→${e.stats.messagesAfter}`);
    if (e.type === "memory_update") log.push(`[${conversationId}] <memory_update> injected`);
  };
  const result = await runTurn({ agent, provider, store, tools, home, userText: text, onEvent });
  const reflection = await maybeReflectAfterTurn({ home, agent, conversationId, provider: reflectionProvider });
  if (reflection?.launched) log.push(`[${conversationId}] reflection ${reflection.status}`);
  return result.finalText;
}

// 1. The agent organizes deferred memory: an indexed child directory + a skill.
mkdirSync(join(memoryDir, "projects"), { recursive: true });
mkdirSync(join(memoryDir, "skills", "release-notes"), { recursive: true });
writeFileSync(join(memoryDir, "projects", "MEMORY.md"), "# Projects\n\n- [mini-letta](mini-letta.md) — the companion project of the book\n");
writeFileSync(
  join(memoryDir, "projects", "mini-letta.md"),
  "---\nname: mini-letta\ndescription: Companion project; Bun + TypeScript, tags v0.1..v1.0\n---\nTests: `bun test`. Never commit to main without tests passing.\n",
);
writeFileSync(
  join(memoryDir, "skills", "release-notes", "SKILL.md"),
  "---\nname: release-notes\ndescription: This skill should be used when the user asks for release notes.\n---\n# Release notes\n1. git log --oneline <prev>..HEAD\n2. Group by feat/fix/chore.\n",
);
writeFileSync(
  join(memoryDir, "MEMORY.md"),
  "# Memory\n\n- [persona](persona.md) — Who I am and how I behave.\n- [human](human.md) — What I know about the user.\n- [projects](projects/MEMORY.md) — project notes, read on demand\n",
);
git(memoryDir, ["add", "--", "MEMORY.md", "projects", "skills"]);
git(memoryDir, ["commit", "-q", "-m", "feat: index projects and add release-notes skill", "--", "MEMORY.md", "projects", "skills"]);

// 2. Explicit memory edits by the primary agent.
log.push(await say("main", "记住：我叫小陆，主要写 TypeScript"));
log.push(await say("main", "设定：回答末尾总是加上 🦉"));
log.push(await say("main", "我们的数据库端口是 5433，别用默认的 5432"));

// 3. A long conversation: compaction fires, which (by default) triggers reflection.
for (let i = 0; i < 14; i++) {
  await say("main", i === 3 ? "我更喜欢用 tabs 缩进" : `第 ${i} 个话题：${"今天天气不错。".repeat(10)}`);
}

// 4. Recall pulls an evicted detail back; a new conversation starts from compiled memory.
log.push(await say("main", "还记得数据库端口吗？"));
log.push(await say("second", "你知道我什么？"));

console.log(log.join("\n"));
console.log(`\nmemory: ${memoryDir}`);
console.log(git(memoryDir, ["log", "--oneline", "--graph"]).stdout);
