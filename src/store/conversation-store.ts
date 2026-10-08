import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Message } from "@/llm/types";
import { conversationsDir, getHome } from "./paths";

/**
 * Append-only message log per conversation. Every message ever produced lands
 * here; this is the "recall memory" that Part IV searches.
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
