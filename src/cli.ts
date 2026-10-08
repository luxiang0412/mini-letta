#!/usr/bin/env bun
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { runTurn, type TurnEvent } from "@/agent/loop";
import { invalidateSystemPrompt, readCachedSystemPrompt } from "@/agent/system-prompt";
import { createProvider } from "@/llm/provider";
import { compileSystemPrompt } from "@/memory/compile";
import { git } from "@/memory/git";
import { getMemoryDir } from "@/memory/memfs";
import { listAgents, loadOrCreateAgent, type ReflectionTrigger, saveAgent } from "@/store/agent-store";
import { ConversationStore } from "@/store/conversation-store";
import { getHome } from "@/store/paths";
import { compactConversation } from "@/context/compact-conversation";
import { searchRecall } from "@/recall/search";
import { launchReflection, type ReflectionOutcome } from "@/reflection/launcher";
import { maybeReflectAfterTurn } from "@/reflection/post-turn";
import { FILE_TOOLS } from "@/tools/file-tools";
import { recallSearchTool } from "@/tools/recall-tool";

const TOOLS = [...FILE_TOOLS, recallSearchTool];

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    agent: { type: "string", short: "a", default: "agent-default" },
    conversation: { type: "string", short: "c", default: "default" },
    prompt: { type: "string", short: "p" },
    fresh: { type: "boolean", default: false },
    trigger: { type: "string" },
    steps: { type: "string" },
    instruction: { type: "string" },
  },
});

const home = getHome();
const command = positionals[0] ?? "chat";

function printEvent(event: TurnEvent): void {
  if (event.type === "text") process.stdout.write(event.delta);
  if (event.type === "tool_call") {
    console.log(`\n  ⚙ ${event.name}(${JSON.stringify(event.arguments)})`);
  }
  if (event.type === "compaction") {
    const s = event.stats;
    console.log(`\n  ⇣ compacted (${s.trigger}): ${s.messagesBefore} → ${s.messagesAfter} messages, ~${s.tokensBefore} → ~${s.tokensAfter} tokens`);
  }
  if (event.type === "memory_update") {
    console.log("\n  ↻ memory changed — injected <memory_update> reminder");
  }
  if (event.type === "tool_result") {
    console.log(`  ${event.ok ? "✓" : "✗"} ${event.content.split("\n")[0]}`);
  }
}

function printReflection(outcome: ReflectionOutcome | null): void {
  if (!outcome) return;
  if (!outcome.launched) console.log(`  ☾ reflection skipped: ${outcome.reason}`);
  else console.log(`  ☾ reflection ${outcome.reflectionId}: ${outcome.status} — ${outcome.summary}`);
}

/**
 * One turn, then the post-turn reflection check. The check is returned inside
 * an object: an async function returning a bare promise would flatten it and
 * make the caller wait for reflection.
 */
async function chatOnce(text: string): Promise<{ reflection: Promise<void> }> {
  const agent = loadOrCreateAgent(values.agent, home);
  const store = new ConversationStore(agent.id, values.conversation, home);
  const provider = createProvider();
  await runTurn({ agent, provider, store, tools: TOOLS, userText: text, home, onEvent: printEvent });
  process.stdout.write("\n");
  return {
    reflection: maybeReflectAfterTurn({ home, agent, conversationId: store.conversationId, provider }).then(
      printReflection,
    ),
  };
}

async function main(): Promise<void> {
  if (command === "agents") {
    for (const agent of listAgents(home)) console.log(`${agent.id}\t${agent.name}`);
    return;
  }
  if (command === "prompt") {
    // The prompt this conversation is using; --fresh shows what a recompile would produce.
    const agent = loadOrCreateAgent(values.agent, home);
    const store = new ConversationStore(agent.id, values.conversation, home);
    const cached = values.fresh ? undefined : readCachedSystemPrompt(store);
    const prompt = cached ?? compileSystemPrompt({ agent, memoryDir: getMemoryDir(agent.id, home) });
    console.log(prompt.content);
    console.error(`[${cached ? "cached" : "fresh"} · compiled ${prompt.compiledAt} · memfs ${prompt.memfsRevision?.slice(0, 7)}]`);
    return;
  }
  if (command === "compact") {
    const agent = loadOrCreateAgent(values.agent, home);
    const stats = await compactConversation({
      store: new ConversationStore(agent.id, values.conversation, home),
      provider: createProvider(),
      trigger: "manual",
    });
    console.log(JSON.stringify(stats));
    return;
  }
  if (command === "search") {
    const agent = loadOrCreateAgent(values.agent, home);
    for (const hit of searchRecall({ home, agentId: agent.id, query: positionals.slice(1).join(" ") })) {
      console.log(`${hit.score.toFixed(2)}\t${hit.conversationId}\t${hit.role}\t${hit.text.replace(/\s+/g, " ").slice(0, 100)}`);
    }
    return;
  }
  if (command === "reflect") {
    const agent = loadOrCreateAgent(values.agent, home);
    printReflection(
      await launchReflection({
        home,
        agent,
        conversationId: values.conversation,
        provider: createProvider(),
        instruction: values.instruction,
        onEvent: (e) => (e.type === "tool_call" ? printEvent(e) : undefined),
      }),
    );
    return;
  }
  if (command === "sleeptime") {
    const agent = loadOrCreateAgent(values.agent, home);
    if (values.trigger) {
      agent.reflection = {
        trigger: values.trigger as ReflectionTrigger,
        stepCount: Number(values.steps ?? agent.reflection?.stepCount ?? 25),
      };
      saveAgent(agent, home);
    }
    console.log(JSON.stringify(agent.reflection ?? { trigger: "compaction-event", stepCount: 25 }));
    return;
  }
  if (command === "recompile") {
    const agent = loadOrCreateAgent(values.agent, home);
    invalidateSystemPrompt(new ConversationStore(agent.id, values.conversation, home));
    console.log(`Conversation ${values.conversation} will recompile its system prompt on the next step.`);
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
  if (values.prompt) return (await chatOnce(values.prompt)).reflection;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const background: Promise<void>[] = [];
  console.log(`mini-letta · agent=${values.agent} · conversation=${values.conversation} (Ctrl+D to exit)`);
  while (true) {
    let line: string;
    try {
      line = await rl.question("> ");
    } catch {
      break;
    }
    // Reflection runs in the background; the next prompt does not wait for it.
    if (line.trim()) background.push((await chatOnce(line.trim())).reflection);
  }
  rl.close();
  await Promise.all(background);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
