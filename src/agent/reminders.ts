import type { CompiledSystemPrompt } from "@/memory/compile";
import { git } from "@/memory/git";
import type { AgentRecord } from "@/store/agent-store";
import type { ConversationStore } from "@/store/conversation-store";

/**
 * Harness → model notifications. Following letta-code's rule (CLAUDE.md,
 * "Automated notifications use user-role reminders"), they are user-role
 * messages wrapped in <system-reminder>, never extra system messages.
 */
export const SYSTEM_REMINDER_OPEN = "<system-reminder>";
export const SYSTEM_REMINDER_CLOSE = "</system-reminder>";

export function wrapReminder(text: string): string {
  return `${SYSTEM_REMINDER_OPEN}\n${text.trim()}\n${SYSTEM_REMINDER_CLOSE}`;
}

/** Remove every reminder block; what is left is what the human typed. */
export function stripReminders(content: string): string {
  return content.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
}

export function isReminderOnly(content: string): boolean {
  return content.includes(SYSTEM_REMINDER_OPEN) && stripReminders(content) === "";
}

/** letta-code's formatMidConversationMemoryUpdate (src/backend/local/local-backend.ts). */
export function formatMemoryUpdate(compiled: CompiledSystemPrompt): string {
  return [
    "<memory_update>",
    `The memory filesystem has been edited and committed at revision ${compiled.memfsRevision ?? "unknown"}.`,
    "Treat the following freshly rendered memory context as authoritative from now on; where it conflicts with earlier memory context, this newer memory context wins.",
    "",
    compiled.coreMemory.trimEnd(),
    "</memory_update>",
  ].join("\n");
}

/** Sent once at the start of a conversation (letta-code's agent-info reminder). */
export function formatAgentInfo(agent: AgentRecord, memoryDir: string, conversationId: string): string {
  return [
    "Agent info:",
    `- AGENT_ID: ${agent.id}`,
    `- AGENT_NAME: ${agent.name}`,
    `- CONVERSATION_ID: ${conversationId}`,
    `- MEMORY_DIR: ${memoryDir} (file tools need this absolute path; $MEMORY_DIR only expands in bash)`,
  ].join("\n");
}

/**
 * Post-turn check, after letta-code's syncPendingMemoryCommitsAfterTurn +
 * formatMemoryPostTurnSyncReminder: uncommitted memory never reaches the
 * prompt, so tell the agent on its next turn.
 */
export function checkMemoryAfterTurn(memoryDir: string): string | null {
  const status = git(memoryDir, ["status", "--porcelain"]).stdout.trim();
  if (!status) return null;
  const changed = status.split("\n").length;
  return [
    "MEMORY COMMIT NEEDED: The memory repository has uncommitted changes.",
    "",
    `Memory directory: ${memoryDir}`,
    `Status: ${changed} uncommitted memory change(s).`,
    "",
    "Commit these memory changes when appropriate, staging only the files you changed. Uncommitted memory does not reach your future prompts.",
  ].join("\n");
}

const PENDING = "pending-reminders.json";

export function enqueueReminder(store: ConversationStore, text: string): void {
  const pending = store.readJson<string[]>(PENDING) ?? [];
  store.writeJson(PENDING, [...pending, text]);
}

export function drainReminders(store: ConversationStore): string[] {
  const pending = store.readJson<string[]>(PENDING) ?? [];
  if (pending.length) store.writeJson(PENDING, []);
  return pending;
}
