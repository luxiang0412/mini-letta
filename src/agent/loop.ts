import { compactConversation } from "@/context/compact-conversation";
import type { CompactionStats } from "@/context/compaction";
import { shouldCompact } from "@/context/compaction";
import { estimateRequestTokens } from "@/context/tokens";
import { getMemoryDir } from "@/memory/memfs";
import {
  type CompletionResult,
  ContextOverflowError,
  type LLMProvider,
  type Message,
  makeMessage,
} from "@/llm/types";
import type { AgentRecord } from "@/store/agent-store";
import type { ConversationStore } from "@/store/conversation-store";
import { memoryEnv, type Tool, type ToolContext } from "@/tools/types";
import {
  checkMemoryAfterTurn,
  drainReminders,
  enqueueReminder,
  formatAgentInfo,
  wrapReminder,
} from "./reminders";
import { resolveSystemPrompt } from "./system-prompt";

export type TurnEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; name: string; arguments: Record<string, unknown> }
  | { type: "tool_result"; name: string; ok: boolean; content: string }
  | { type: "memory_update"; content: string }
  | { type: "compaction"; stats: CompactionStats };

export interface TurnInput {
  agent: AgentRecord;
  provider: LLMProvider;
  store: ConversationStore;
  tools: Tool[];
  userText: string;
  home: string;
  /** Defaults to the agent's MemFS checkout. */
  memoryDir?: string;
  /** Extra shell environment (a subagent's TRANSCRIPT_PATH, PARENT_AGENT_ID, ...). */
  extraEnv?: Record<string, string>;
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
    env: { ...memoryEnv(agent, memoryDir), ...input.extraEnv },
  };

  // Reminders ride along with the user's message, before what they typed.
  const reminders = drainReminders(store);
  if (store.all().length === 0) {
    reminders.unshift(formatAgentInfo(agent, memoryDir, store.conversationId));
  }
  store.append(makeMessage("user", [...reminders.map(wrapReminder), input.userText].join("\n\n")));

  const schemas = tools.map((t) => t.schema);
  const compact = async (trigger: CompactionStats["trigger"]) => {
    const stats = await compactConversation({ store, provider, trigger });
    onEvent?.({ type: "compaction", stats });
  };
  /** Resolve the prompt (and any memory update) for the next model call. */
  const prepare = () => {
    const resolved = resolveSystemPrompt({ agent, memoryDir, store });
    if (resolved.memoryUpdate) {
      // Persisted, so the update stays in context on every later step and turn.
      store.append(makeMessage("user", wrapReminder(resolved.memoryUpdate)));
      onEvent?.({ type: "memory_update", content: resolved.memoryUpdate });
    }
    return { system: resolved.systemPrompt, messages: store.inContext(), tools: schemas };
  };

  let systemPrompt = "";
  let result: TurnResult | undefined;
  for (let step = 1; step <= maxSteps && !result; step++) {
    let request = prepare();
    // Compact BEFORE the request when usage nears the window (not only after an overflow).
    if (shouldCompact(estimateRequestTokens(request), provider.contextWindow)) {
      await compact("context_pressure");
      request = prepare();
    }
    systemPrompt = request.system;
    let response: CompletionResult;
    try {
      response = await provider.complete(request, (delta) => onEvent?.({ type: "text", delta }));
    } catch (error) {
      if (!(error instanceof ContextOverflowError)) throw error;
      await compact("context_overflow");
      request = prepare();
      systemPrompt = request.system;
      response = await provider.complete(request, (delta) => onEvent?.({ type: "text", delta }));
    }
    store.append(
      makeMessage("assistant", response.content, {
        ...(response.toolCalls.length ? { toolCalls: response.toolCalls } : {}),
      }),
    );
    if (response.toolCalls.length === 0) {
      result = { steps: step, finalText: response.content, systemPrompt };
      break;
    }
    for (const call of response.toolCalls) {
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

  const dirty = checkMemoryAfterTurn(memoryDir);
  if (dirty) enqueueReminder(store, dirty);
  return result ?? { steps: maxSteps, finalText: "(stopped: max steps reached)", systemPrompt };
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
