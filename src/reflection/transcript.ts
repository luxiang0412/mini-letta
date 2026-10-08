import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isReminderOnly, stripReminders } from "@/agent/reminders";
import type { Message } from "@/llm/types";
import type { ConversationStore } from "@/store/conversation-store";

/**
 * Which part of a conversation has been reflected on. After letta-code's
 * ReflectionTranscriptState (src/cli/helpers/reflection-transcript.ts,
 * schema "v3_assistant_steps"): progress is a message-id watermark, and the
 * trigger counts completed assistant steps since the last success.
 */
export interface ReflectionState {
  reflectedThroughMessageId?: string;
  lastReflectionStartedAt?: string;
  lastReflectionSucceededAt?: string;
}

const STATE = "reflection-state.json";

export function readReflectionState(store: ConversationStore): ReflectionState {
  return store.readJson<ReflectionState>(STATE) ?? {};
}

export function writeReflectionState(store: ConversationStore, state: ReflectionState): void {
  store.writeJson(STATE, state);
}

/** Messages after the watermark (the whole log when nothing was reflected yet). */
export function unreflectedMessages(store: ConversationStore, state = readReflectionState(store)): Message[] {
  const all = store.all();
  if (!state.reflectedThroughMessageId) return all;
  const index = all.findIndex((m) => m.id === state.reflectedThroughMessageId);
  return index < 0 ? all : all.slice(index + 1);
}

export function stepsSinceLastReflection(store: ConversationStore): number {
  return unreflectedMessages(store).filter((m) => m.role === "assistant").length;
}

export interface ReflectionPayload {
  payloadPath: string;
  startMessageId: string;
  endMessageId: string;
}

const TOOL_RESULT_LIMIT = 1_000;

/** Normalize the slice into a plain JSON message array for the reflector. */
export function buildReflectionPayload(store: ConversationStore, payloadDir: string): ReflectionPayload | null {
  const state = readReflectionState(store);
  const slice = unreflectedMessages(store, state);
  const first = slice[0];
  const last = slice.at(-1);
  if (!first || !last) return null;
  const transcript = slice
    .filter((m) => m.kind !== "summary" && !(m.role === "user" && isReminderOnly(m.content)))
    .map((m) => ({
      role: m.role,
      created_at: m.createdAt,
      content: m.role === "user" ? stripReminders(m.content) : m.content.slice(0, TOOL_RESULT_LIMIT),
      ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((c) => ({ name: c.name, arguments: c.arguments })) } : {}),
    }));
  mkdirSync(payloadDir, { recursive: true });
  const payloadPath = join(payloadDir, `payload-${Date.now()}.json`);
  writeFileSync(payloadPath, `${JSON.stringify(transcript, null, 2)}\n`);
  writeReflectionState(store, { ...state, lastReflectionStartedAt: new Date().toISOString() });
  return { payloadPath, startMessageId: first.id, endMessageId: last.id };
}

/** Advance the watermark only after a successful (merged / no-op) reflection. */
export function markReflected(store: ConversationStore, endMessageId: string): void {
  writeReflectionState(store, {
    ...readReflectionState(store),
    reflectedThroughMessageId: endMessageId,
    lastReflectionSucceededAt: new Date().toISOString(),
  });
}
