import { existsSync, readdirSync } from "node:fs";
import { isReminderOnly, stripReminders } from "@/agent/reminders";
import type { Message } from "@/llm/types";
import { ConversationStore } from "@/store/conversation-store";
import { conversationsDir } from "@/store/paths";

/**
 * Recall memory search: BM25 over every message the agent ever exchanged,
 * including messages compaction evicted from the context window. Tokenizing
 * and scoring follow letta-code's local transcript search
 * (src/backend/local/transcript-search.ts).
 */
const CJK_RUN = /^[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}]+$/u;
const CJK_CHARACTER = /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}]/u;

/** Words of letters/digits; mixed words split into CJK and non-CJK runs. */
export function tokenize(value: string): string[] {
  const words = value.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.flatMap((word) => {
    if (CJK_RUN.test(word) || !CJK_CHARACTER.test(word)) return [word];
    const runs: string[] = [];
    let run = "";
    let previousCjk = false;
    for (const character of word) {
      const cjk = CJK_RUN.test(character);
      if (run && cjk !== previousCjk) {
        runs.push(run);
        run = "";
      }
      run += character;
      previousCjk = cjk;
    }
    if (run) runs.push(run);
    return runs;
  });
}

/** CJK has no spaces, so a CJK term matches as a substring of a run. */
export function termFrequency(tokens: string[], term: string): number {
  if (CJK_RUN.test(term)) return tokens.reduce((n, token) => n + token.split(term).length - 1, 0);
  return tokens.reduce((n, token) => n + Number(token === term), 0);
}

export interface RecallHit {
  conversationId: string;
  messageId: string;
  role: Message["role"];
  createdAt: string;
  text: string;
  score: number;
}

interface Record {
  hit: Omit<RecallHit, "score">;
  tokens: string[];
  isSearchEcho: boolean;
}

export const RECALL_TOOL_NAME = "recall_search";

function searchableText(message: Message): string | null {
  if (message.role === "user") {
    if (message.kind === "summary" || isReminderOnly(message.content)) return null;
    return stripReminders(message.content);
  }
  const calls = (message.toolCalls ?? []).map((c) => `${c.name} ${JSON.stringify(c.arguments)}`).join(" ");
  return `${message.content} ${calls}`.trim();
}

function loadRecords(home: string, agentId: string, currentConversationId?: string): Record[] {
  const root = conversationsDir(agentId, home);
  if (!existsSync(root)) return [];
  const records: Record[] = [];
  for (const conversationId of readdirSync(root)) {
    const messages = new ConversationStore(agentId, conversationId, home).all();
    // The newest user message of the current conversation is usually the
    // question being recalled — demote it (letta-code transcript-search.ts).
    const latestUser =
      conversationId === currentConversationId
        ? messages.filter((m) => m.role === "user" && searchableText(m) !== null).at(-1)?.id
        : undefined;
    const searchCallIds = new Set(
      messages.flatMap((m) => (m.toolCalls ?? []).filter((c) => c.name === RECALL_TOOL_NAME).map((c) => c.id)),
    );
    for (const message of messages) {
      const text = searchableText(message);
      if (!text) continue;
      const tokens = tokenize(text);
      if (!tokens.length) continue;
      records.push({
        hit: { conversationId, messageId: message.id, role: message.role, createdAt: message.createdAt, text },
        tokens,
        // Earlier searches must not drown out the history they searched.
        isSearchEcho:
          message.id === latestUser ||
          (message.toolCalls ?? []).some((c) => c.name === RECALL_TOOL_NAME) ||
          (message.role === "tool" && searchCallIds.has(message.toolCallId ?? "")),
      });
    }
  }
  return records;
}

export function searchRecall(input: {
  home: string;
  agentId: string;
  query: string;
  limit?: number;
  currentConversationId?: string;
}): RecallHit[] {
  const terms = [...new Set(tokenize(input.query))];
  if (!terms.length) return [];
  const records = loadRecords(input.home, input.agentId, input.currentConversationId);
  const corpus = records.filter((r) => !r.isSearchEcho);
  if (!corpus.length) return [];
  const averageLength = corpus.reduce((sum, r) => sum + r.tokens.length, 0) / corpus.length;
  const documentFrequency = new Map(
    terms.map((term) => [term, corpus.filter((r) => termFrequency(r.tokens, term) > 0).length]),
  );
  const k1 = 1.2;
  const b = 0.75;
  const hits: RecallHit[] = [];
  for (const record of records) {
    let score = 0;
    for (const term of terms) {
      const frequency = termFrequency(record.tokens, term);
      if (!frequency) continue;
      const df = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (corpus.length - df + 0.5) / (df + 0.5));
      const norm = 1 - b + b * (record.tokens.length / Math.max(averageLength, 1));
      score += idf * ((frequency * (k1 + 1)) / (frequency + k1 * norm));
    }
    if (score > 0) hits.push({ ...record.hit, score: score * (record.isSearchEcho ? 0.1 : 1) });
  }
  return hits.sort((a, b2) => b2.score - a.score).slice(0, input.limit ?? 5);
}
