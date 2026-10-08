#!/usr/bin/env bun
/**
 * End-to-end story across two "machines" sharing one memory remote, with the
 * kernel sandbox on. Exits non-zero on the first broken expectation.
 *
 *   bun scripts/e2e.ts                 # everything in temp dirs
 *   PALACE_URL=http://palace:8787 MINI_LETTA_HOME=/data bun scripts/e2e.ts
 *                                      # also check a running Palace (compose)
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTurn } from "@/agent/loop";
import { MockProvider } from "@/llm/mock";
import { git } from "@/memory/git";
import { getMemoryDir } from "@/memory/memfs";
import { maybeReflectAfterTurn } from "@/reflection/post-turn";
import { isBwrapAvailable } from "@/sandbox/policy";
import { createAgent, loadOrCreateAgent } from "@/store/agent-store";
import { ConversationStore } from "@/store/conversation-store";
import { bashTool, FILE_TOOLS } from "@/tools/file-tools";
import { recallSearchTool } from "@/tools/recall-tool";
import { memoryEnv } from "@/tools/types";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
process.env.MINI_LETTA_REMOTE_ROOT ??= tmp("e2e-remote-");
process.env.MINI_LETTA_FS_SANDBOX ??= "1";
const laptop = process.env.MINI_LETTA_HOME ?? tmp("e2e-laptop-");
const desktop = tmp("e2e-desktop-");
const tools = [...FILE_TOOLS, recallSearchTool];
let step = 0;

function check(label: string, ok: boolean, detail = ""): void {
  step += 1;
  console.log(`${ok ? "✓" : "✗"} ${String(step).padStart(2)} ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) process.exit(1);
}

async function say(home: string, text: string, conversationId = "main", window = 1_400) {
  const agent = loadOrCreateAgent("agent-e2e", home);
  const store = new ConversationStore(agent.id, conversationId, home);
  const events: string[] = [];
  const result = await runTurn({
    agent, provider: new MockProvider({ contextWindow: window }), store, tools, home, userText: text,
    onEvent: (e) => { if (e.type !== "text") events.push(e.type); },
  });
  const reflection = await maybeReflectAfterTurn({ home, agent, conversationId, provider: new MockProvider() });
  return { ...result, events, reflection };
}

console.log(`laptop=${laptop}\ndesktop=${desktop}\nremote=${process.env.MINI_LETTA_REMOTE_ROOT}\nbwrap=${isBwrapAvailable()}\n`);

const first = await say(laptop, "记住：我叫小陆，主要写 TypeScript");
check("remember → tool call → committed", first.events.includes("tool_call"), first.finalText);
const laptopDir = getMemoryDir("agent-e2e", laptop);
check("commit is on the remote", git(laptopDir, ["log", "-1", "--format=%s", "origin/main"]).stdout.trim() === "chore: remember user fact");

await say(laptop, "设定：回答末尾总是加上 🦉");
const signed = await say(laptop, "你好");
check("persona change visible next turn (same conversation)", signed.finalText.endsWith("🦉"), signed.finalText);

await say(laptop, "我们的数据库端口是 5433，别用默认的 5432");
let compactions = 0;
let merged = 0;
for (let i = 0; i < 14; i++) {
  const r = await say(laptop, i === 2 ? "我更喜欢用 tabs 缩进" : `话题 ${i}：${"今天天气不错。".repeat(10)}`);
  compactions += r.events.filter((e) => e === "compaction").length;
  if (r.reflection?.launched && r.reflection.status === "merged") merged += 1;
}
check("long conversation compacted", compactions > 0, `${compactions} compactions`);
check("compaction-triggered reflection merged a preference", merged > 0, `${merged} merged`);
check("human.md now has the preference", readFileSync(join(laptopDir, "human.md"), "utf8").includes("- 我更喜欢用 tabs 缩进"));

const recalled = await say(laptop, "还记得数据库端口吗？");
check("recall brings back an evicted detail", recalled.finalText.includes("5433"), recalled.finalText);

const elsewhere = await say(desktop, "你知道我什么？", "desktop-1");
check("the other machine cloned the memory", elsewhere.finalText.includes("tabs") && elsewhere.finalText.includes("小陆"), elsewhere.finalText);

if (!isBwrapAvailable()) {
  console.log("! bwrap unavailable here (e.g. inside Docker): shells run unconfined, isolation check skipped");
} else {
  const intruder = createAgent({ id: "agent-intruder" }, laptop);
  const memoryDir = getMemoryDir(intruder.id, laptop);
  const ctx = { agent: intruder, home: laptop, conversationId: "x", memoryDir, env: memoryEnv(intruder, memoryDir) };
  const { crossAgentProfile } = await import("@/agent/sandbox-profiles");
  const read = await bashTool
    .run({ command: `cat ${join(laptopDir, "human.md")}` }, { ...ctx, sandbox: crossAgentProfile(laptop, intruder.id) })
    .then(() => "read it", (e: Error) => e.message.split("\n").at(-1) ?? "");
  check("another agent's shell cannot see agent-e2e's memory", read.includes("No such file"), read);
}

if (process.env.PALACE_URL) {
  const agents = (await (await fetch(`${process.env.PALACE_URL}/api/agents`)).json()) as Array<{ id: string; commits: number }>;
  const e2e = agents.find((a) => a.id === "agent-e2e");
  check("Palace serves the agent", Boolean(e2e && e2e.commits >= 4), JSON.stringify(e2e));
  const historyJson = (await (await fetch(`${process.env.PALACE_URL}/api/agents/agent-e2e/history`)).json()) as Array<{ isReflection: boolean }>;
  check("Palace shows a reflection commit", historyJson.some((c) => c.isReflection));
}
console.log("\nall good");
