import { compileSystemPrompt } from "@/memory/compile";
import { getMemoryDir } from "@/memory/memfs";
import { type LLMProvider, type Message, makeMessage } from "@/llm/types";
import type { AgentRecord } from "@/store/agent-store";
import type { ConversationStore } from "@/store/conversation-store";
import { memoryEnv, type Tool, type ToolContext } from "@/tools/types";

export type TurnEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; name: string; arguments: Record<string, unknown> }
  | { type: "tool_result"; name: string; ok: boolean; content: string };

export interface TurnInput {
  agent: AgentRecord;
  provider: LLMProvider;
  store: ConversationStore;
  tools: Tool[];
  userText: string;
  home: string;
  /** Defaults to the agent's MemFS checkout. */
  memoryDir?: string;
  maxSteps?: number;
  onEvent?: (event: TurnEvent) => void;
}

export interface TurnResult {
  steps: number;
  finalText: string;
  systemPrompt: string;
}

/**
 * One user turn: call the model, run requested tools, feed results back, and
 * stop when the model answers without tool calls. Each model call is a "step"
 * — the unit letta-code's reflection trigger counts (Part V).
 */
export async function runTurn(input: TurnInput): Promise<TurnResult> {
  const { agent, provider, store, tools, onEvent } = input;
  const maxSteps = input.maxSteps ?? 8;
  const toolsByName = new Map(tools.map((t) => [t.schema.name, t]));
  const memoryDir = input.memoryDir ?? getMemoryDir(agent.id, input.home);
  const ctx: ToolContext = {
    agent,
    home: input.home,
    conversationId: store.conversationId,
    memoryDir,
    env: memoryEnv(agent, memoryDir),
  };

  store.append(makeMessage("user", input.userText));

  let systemPrompt = "";
  for (let step = 1; step <= maxSteps; step++) {
    const history = store.all();
    // v0.2 still recompiles every step, but only from COMMITTED memory.
    systemPrompt = compileSystemPrompt({
      agent,
      conversationId: store.conversationId,
      memoryDir,
      previousMessageCount: history.length,
    }).content;
    const result = await provider.complete(
      { system: systemPrompt, messages: history, tools: tools.map((t) => t.schema) },
      (delta) => onEvent?.({ type: "text", delta }),
    );
    store.append(
      makeMessage("assistant", result.content, {
        ...(result.toolCalls.length ? { toolCalls: result.toolCalls } : {}),
      }),
    );
    if (result.toolCalls.length === 0) {
      return { steps: step, finalText: result.content, systemPrompt };
    }
    for (const call of result.toolCalls) {
      onEvent?.({ type: "tool_call", name: call.name, arguments: call.arguments });
      const toolMessage = await executeTool(toolsByName.get(call.name), call, ctx);
      store.append(toolMessage);
      onEvent?.({
        type: "tool_result",
        name: call.name,
        ok: !toolMessage.content.startsWith("Error:"),
        content: toolMessage.content,
      });
    }
  }
  return { steps: maxSteps, finalText: "(stopped: max steps reached)", systemPrompt };
}

async function executeTool(
  tool: Tool | undefined,
  call: { id: string; name: string; arguments: Record<string, unknown> },
  ctx: ToolContext,
): Promise<Message> {
  let content: string;
  try {
    if (!tool) throw new Error(`Unknown tool '${call.name}'`);
    content = await tool.run(call.arguments, ctx);
  } catch (error) {
    content = `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
  return makeMessage("tool", content, { toolCallId: call.id });
}
