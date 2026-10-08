import { invalidateSystemPrompt } from "@/agent/system-prompt";
import { type LLMProvider, makeMessage } from "@/llm/types";
import type { ConversationStore } from "@/store/conversation-store";
import {
  type CompactionPlan,
  CompactionPlanningError,
  type CompactionStats,
  packageSummary,
  planAll,
  planSlidingWindow,
  summarize,
} from "./compaction";
import { estimateMessagesTokens } from "./tokens";

export const COMPACTION_EVENT = "compaction-event.json";

/**
 * Replace the oldest in-context messages with one summary message, after
 * letta-code's LocalBackend.compactLocalConversationInner: try the sliding
 * window first, fall back to summarizing everything, then force a full system
 * prompt recompile so committed memory changes fold into the new prompt.
 */
export async function compactConversation(input: {
  store: ConversationStore;
  provider: LLMProvider;
  trigger: CompactionStats["trigger"];
}): Promise<CompactionStats> {
  const { store, provider } = input;
  const messages = store.inContext();
  const window = provider.contextWindow;
  let plan: CompactionPlan;
  try {
    plan = planSlidingWindow(messages, { contextWindow: window });
    if (estimateMessagesTokens(plan.messagesToKeep) >= window) plan = planAll(messages);
  } catch (error) {
    if (!(error instanceof CompactionPlanningError)) throw error;
    plan = planAll(messages);
  }
  const summary = await summarize(provider, plan.messagesToSummarize);
  const stats: CompactionStats = {
    trigger: input.trigger,
    messagesBefore: messages.length,
    messagesAfter: plan.messagesToKeep.length + 1,
    tokensBefore: estimateMessagesTokens(messages),
    tokensAfter: 0,
  };
  const summaryMessage = makeMessage("user", packageSummary(summary, stats), { kind: "summary" });
  stats.tokensAfter = estimateMessagesTokens([summaryMessage, ...plan.messagesToKeep]);
  store.append(summaryMessage);
  store.setContext([summaryMessage.id, ...plan.messagesToKeep.map((m) => m.id)]);
  invalidateSystemPrompt(store);
  store.writeJson(COMPACTION_EVENT, { pending: true, at: new Date().toISOString(), stats });
  return stats;
}
