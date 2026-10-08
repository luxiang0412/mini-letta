#!/usr/bin/env bun
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { runTurn, type TurnEvent } from "@/agent/loop";
import { createProvider } from "@/llm/provider";
import { compileSystemPrompt } from "@/memory/compile";
import { git } from "@/memory/git";
import { getMemoryDir } from "@/memory/memfs";
import { listAgents, loadOrCreateAgent } from "@/store/agent-store";
import { ConversationStore } from "@/store/conversation-store";
import { getHome } from "@/store/paths";
import { FILE_TOOLS } from "@/tools/file-tools";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    agent: { type: "string", short: "a", default: "agent-default" },
    conversation: { type: "string", short: "c", default: "default" },
    prompt: { type: "string", short: "p" },
  },
});

const home = getHome();
const command = positionals[0] ?? "chat";

function printEvent(event: TurnEvent): void {
  if (event.type === "text") process.stdout.write(event.delta);
  if (event.type === "tool_call") {
    console.log(`\n  ⚙ ${event.name}(${JSON.stringify(event.arguments)})`);
  }
  if (event.type === "tool_result") {
    console.log(`  ${event.ok ? "✓" : "✗"} ${event.content.split("\n")[0]}`);
  }
}

async function chatOnce(text: string): Promise<void> {
  const agent = loadOrCreateAgent(values.agent, home);
  const store = new ConversationStore(agent.id, values.conversation, home);
  await runTurn({
    agent,
    provider: createProvider(),
    store,
    tools: FILE_TOOLS,
    userText: text,
    home,
    onEvent: printEvent,
  });
  process.stdout.write("\n");
}

async function main(): Promise<void> {
  if (command === "agents") {
    for (const agent of listAgents(home)) console.log(`${agent.id}\t${agent.name}`);
    return;
  }
  if (command === "prompt") {
    const agent = loadOrCreateAgent(values.agent, home);
    const store = new ConversationStore(agent.id, values.conversation, home);
    console.log(
      compileSystemPrompt({
        agent,
        conversationId: store.conversationId,
        memoryDir: getMemoryDir(agent.id, home),
        previousMessageCount: store.all().length,
      }).content,
    );
    return;
  }
  if (command === "memory") {
    const agent = loadOrCreateAgent(values.agent, home);
    const memoryDir = getMemoryDir(agent.id, home);
    const sub = positionals[1] ?? "path";
    if (sub === "path") console.log(memoryDir);
    else if (sub === "log") process.stdout.write(git(memoryDir, ["log", "--oneline", "--decorate"]).stdout);
    else if (sub === "tree") process.stdout.write(git(memoryDir, ["ls-tree", "-r", "--name-only", "HEAD"]).stdout);
    else throw new Error(`Unknown memory subcommand '${sub}' (path|log|tree)`);
    return;
  }
  if (command !== "chat") throw new Error(`Unknown command '${command}'`);
  if (values.prompt) return chatOnce(values.prompt);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(`mini-letta · agent=${values.agent} · conversation=${values.conversation} (Ctrl+D to exit)`);
  while (true) {
    let line: string;
    try {
      line = await rl.question("> ");
    } catch {
      break;
    }
    if (line.trim()) await chatOnce(line.trim());
  }
  rl.close();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
