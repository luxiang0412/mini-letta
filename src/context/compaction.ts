import { stripReminders } from "@/agent/reminders";
import { type LLMProvider, type Message, makeMessage } from "@/llm/types";
import { estimateMessagesTokens } from "./tokens";

/**
 * Context-window compaction, ported from letta-code's
 * src/backend/local/compaction.ts and src/backend/dev/provider-turn-executor.ts.
 */
export const COMPACTION_RESERVE_TOKENS = 16_384;
export const SMALL_CONTEXT_RESERVE_RATIO = 0.2;
export const DEFAULT_SLIDING_WINDOW_PERCENTAGE = 0.3;

/** Compact before the request once usage passes window − reserve. */
export function compactionThreshold(contextWindow: number): number {
  const reserve = Math.min(
    COMPACTION_RESERVE_TOKENS,
    Math.max(1, Math.floor(contextWindow * SMALL_CONTEXT_RESERVE_RATIO)),
  );
  return Math.max(0, contextWindow - reserve);
}

export function shouldCompact(contextTokens: number, contextWindow: number): boolean {
  return contextTokens > compactionThreshold(contextWindow);
}

export class CompactionPlanningError extends Error {}

export interface CompactionPlan {
  messagesToSummarize: Message[];
  messagesToKeep: Message[];
}

function hasPendingToolCall(message: Message | undefined): boolean {
  return message?.role === "assistant" && (message.toolCalls?.length ?? 0) > 0;
}

/**
 * Evict the oldest messages, cutting only right before an assistant message
 * so a tool call is never separated from its results. Like letta-code, the
 * eviction share starts at percentage + 10% and grows by 10% until the kept
 * tail fits in (1 − percentage) of the window.
 */
export function planSlidingWindow(
  messages: Message[],
  options: { contextWindow: number; percentage?: number },
): CompactionPlan {
  if (messages.length < 4) throw new CompactionPlanningError("Not enough messages for sliding window compaction.");
  const percentage = options.percentage ?? DEFAULT_SLIDING_WINDOW_PERCENTAGE;
  const maximumCutoff = hasPendingToolCall(messages.at(-1)) ? messages.length - 2 : messages.length - 1;
  const goalTokens = (1 - percentage) * options.contextWindow;
  let keptTokens = Number.POSITIVE_INFINITY;
  let cutoff: number | undefined;
  let eviction = percentage;
  while (keptTokens >= goalTokens && eviction < 1.0) {
    eviction += 0.1;
    const candidate = Math.min(Math.round(eviction * messages.length), messages.length - 1);
    cutoff = undefined;
    for (let index = candidate; index > 0; index--) {
      if (messages[index]?.role === "assistant" && index < maximumCutoff) {
        cutoff = index;
        break;
      }
    }
    if (cutoff === undefined) continue;
    keptTokens = estimateMessagesTokens(messages.slice(cutoff));
  }
  if (cutoff === undefined || eviction >= 1.0) {
    throw new CompactionPlanningError("No assistant message found for sliding window compaction.");
  }
  return { messagesToSummarize: messages.slice(0, cutoff), messagesToKeep: messages.slice(cutoff) };
}

/** Fallback: summarize everything except a still-pending tool call. */
export function planAll(messages: Message[]): CompactionPlan {
  const last = messages.at(-1);
  if (last && hasPendingToolCall(last)) {
    return { messagesToSummarize: messages.slice(0, -1), messagesToKeep: [last] };
  }
  return { messagesToSummarize: messages, messagesToKeep: [] };
}

export const SLIDING_WINDOW_SUMMARY_PROMPT = `The following messages are being evicted from the BEGINNING of your context window. Write a detailed summary that captures what happened in these messages to appear BEFORE the remaining recent messages in context, providing background for what comes after. Include: the user's goals, what happened, important details (verbatim identifiers), errors and fixes, and lookup hints for details that did not fit. Keep it under 300 words.`;

const TOOL_RESULT_LIMIT = 2_000;

/** Render messages as a plain transcript for the summarizer. */
export function formatTranscript(messages: Message[]): string {
  return messages
    .map((m) => {
      if (m.role === "tool") return `tool: ${m.content.slice(0, TOOL_RESULT_LIMIT)}`;
      const calls = (m.toolCalls ?? []).map((c) => ` [calls ${c.name} ${JSON.stringify(c.arguments)}]`).join("");
      const text = m.role === "user" ? stripReminders(m.content) : m.content;
      return `${m.role}: ${text}${calls}`;
    })
    .filter((line) => !/^user:\s*$/.test(line))
    .join("\n");
}

/** Keep the head and tail when the transcript itself is too big to summarize. */
export function middleTruncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor((maxChars - 40) / 2);
  return `${text.slice(0, half)}\n…[${text.length - 2 * half} chars omitted]…\n${text.slice(-half)}`;
}

export const SUMMARY_TRUNCATION_SUFFIX = "... [summary truncated to fit]";

/**
 * Models do not reliably obey "under 300 words" (qwen2.5:3b returned a
 * summary almost as long as what it replaced), so clip like letta-code's
 * clip_chars — scaled to the window: at most ~10% of it.
 */
export function clipSummary(summary: string, contextWindow: number): string {
  const clipChars = Math.max(200, Math.floor(contextWindow * 4 * 0.1));
  return summary.length > clipChars ? `${summary.slice(0, clipChars)}${SUMMARY_TRUNCATION_SUFFIX}` : summary;
}

export async function summarize(provider: LLMProvider, messages: Message[]): Promise<string> {
  // letta-code retries with shrinking transcript budgets; one budget is enough here.
  const transcript = middleTruncate(formatTranscript(messages), provider.contextWindow * 2);
  const result = await provider.complete({
    system: SLIDING_WINDOW_SUMMARY_PROMPT,
    messages: [makeMessage("user", transcript)],
    tools: [],
  });
  return clipSummary(result.content.trim(), provider.contextWindow);
}

export interface CompactionStats {
  trigger: "context_pressure" | "context_overflow" | "manual";
  messagesBefore: number;
  messagesAfter: number;
  tokensBefore: number;
  tokensAfter: number;
}

/** letta-code's packageLocalSummaryMessage: a user message holding a system_alert. */
export function packageSummary(summary: string, stats: CompactionStats): string {
  const evicted = stats.messagesBefore - (stats.messagesAfter - 1);
  return JSON.stringify({
    type: "system_alert",
    message: `Note: ${evicted} messages from the beginning of the conversation have been hidden from view due to memory constraints.\nThe following is a summary of the previous messages:\n ${summary}`,
    time: new Date().toISOString(),
    compaction_stats: stats,
  });
}
