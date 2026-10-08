import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Message } from "@/llm/types";
import { conversationsDir, getHome } from "./paths";

const CONTEXT = "context.json";

/**
 * Append-only message log per conversation. Every message ever produced lands
 * here; this is the "recall memory" that Part IV searches.
 *
 * The context window is a separate list of message ids (letta-code's
 * conversation.in_context_message_ids). Compaction rewrites that list to
 * [summary, ...kept]; the log itself is never rewritten.
 */
export class ConversationStore {
  constructor(
    readonly agentId: string,
    readonly conversationId: string,
    readonly home = getHome(),
  ) {}

  get dir(): string {
    return join(conversationsDir(this.agentId, this.home), this.conversationId);
  }

  get messagesPath(): string {
    return join(this.dir, "messages.jsonl");
  }

  append(...messages: Message[]): void {
    mkdirSync(this.dir, { recursive: true });
    const lines = messages.map((m) => JSON.stringify(m)).join("\n");
    appendFileSync(this.messagesPath, `${lines}\n`);
    const context = this.readJson<{ inContextIds: string[] }>(CONTEXT);
    if (context) {
      this.writeJson(CONTEXT, { inContextIds: [...context.inContextIds, ...messages.map((m) => m.id)] });
    }
  }

  /** Messages currently in the context window, in order. */
  inContext(): Message[] {
    const all = this.all();
    const context = this.readJson<{ inContextIds: string[] }>(CONTEXT);
    if (!context) return all;
    const byId = new Map(all.map((m) => [m.id, m]));
    return context.inContextIds.flatMap((id) => byId.get(id) ?? []);
  }

  setContext(messageIds: string[]): void {
    this.writeJson(CONTEXT, { inContextIds: messageIds });
  }

  all(): Message[] {
    if (!existsSync(this.messagesPath)) return [];
    return readFileSync(this.messagesPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Message);
  }

  /** Small per-conversation state files (prompt cache, pending reminders, ...). */
  readJson<T>(name: string): T | undefined {
    const path = join(this.dir, name);
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : undefined;
  }

  writeJson(name: string, value: unknown): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, name), `${JSON.stringify(value, null, 2)}\n`);
  }

  removeJson(name: string): void {
    rmSync(join(this.dir, name), { force: true });
  }
}
