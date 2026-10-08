import { isReminderOnly, stripReminders } from "@/agent/reminders";
import { type CompletionRequest, type CompletionResult, type Message, newId } from "./types";

/**
 * A deterministic "model" so every chapter runs offline and every test is
 * repeatable. Rules are tried in order; the first that returns a result wins.
 * Later versions register more rules (compaction summaries, reflection, recall).
 */
export type MockRule = (request: CompletionRequest) => CompletionResult | null;

/** The last message that needs an answer (reminder-only messages don't). */
export function lastMessage(request: CompletionRequest): Message | undefined {
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const message = request.messages[i];
    if (message && !(message.role === "user" && isReminderOnly(message.content))) return message;
  }
  return undefined;
}

/** What the human last typed, with harness reminders stripped. */
export function lastUserText(request: CompletionRequest): string {
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const message = request.messages[i];
    if (message?.role !== "user" || isReminderOnly(message.content)) continue;
    return stripReminders(message.content);
  }
  return "";
}

export function hasTool(request: CompletionRequest, name: string): boolean {
  return request.tools.some((tool) => tool.name === name);
}

export function callTool(name: string, args: Record<string, unknown>, content = ""): CompletionResult {
  return { content, toolCalls: [{ id: newId("call"), name, arguments: args }] };
}

export function say(content: string): CompletionResult {
  return { content, toolCalls: [] };
}

/** Text of a `<label>...</label>` section of the system prompt, if present. */
export function promptSection(system: string, label: string): string | undefined {
  const match = system.match(new RegExp(`<${label}>\\n([\\s\\S]*?)\\n</${label}>`));
  if (!match?.[1]) return undefined;
  return match[1]
    .split("\n")
    .filter((line) => !line.startsWith("<description>") && !line.startsWith("<projection>"))
    .join("\n")
    .trim();
}

export function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/**
 * A memory section as the model should believe it: the newest
 * <memory_update> wins over the (possibly stale) system prompt.
 */
export function currentMemorySection(request: CompletionRequest, label: string): string | undefined {
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const content = request.messages[i]?.content ?? "";
    if (content.includes("<memory_update>")) {
      const section = promptSection(content, label);
      if (section !== undefined) return section;
    }
  }
  return promptSection(request.system, label);
}

