import { type CompiledSystemPrompt, compileSystemPrompt, hashRawSystemPrompt } from "@/memory/compile";
import { headRevision } from "@/memory/git";
import type { AgentRecord } from "@/store/agent-store";
import type { ConversationStore } from "@/store/conversation-store";
import { formatMemoryUpdate } from "./reminders";

const RECORD = "system-prompt.json";

export interface ResolvedSystemPrompt {
  systemPrompt: string;
  /** Set when committed memory moved since the prompt was compiled. */
  memoryUpdate?: string;
}

/**
 * The per-conversation system prompt cache, after letta-code's
 * LocalBackend.getOrCompileSystemPrompt (src/backend/local/local-backend.ts):
 *
 * 1. no record, or the raw system prompt changed → compile and store;
 * 2. same raw prompt and same memfs revision    → reuse (cache-friendly);
 * 3. same raw prompt, new memfs revision        → keep the old system prompt
 *    byte-for-byte, and describe the new memory in a <memory_update>.
 */
export function resolveSystemPrompt(input: {
  agent: AgentRecord;
  memoryDir: string;
  store: ConversationStore;
}): ResolvedSystemPrompt {
  const { agent, memoryDir, store } = input;
  const existing = store.readJson<CompiledSystemPrompt>(RECORD);
  const rawSystemHash = hashRawSystemPrompt(agent.system);
  const revision = headRevision(memoryDir);

  if (existing?.rawSystemHash === rawSystemHash && existing.memfsRevision === revision) {
    return { systemPrompt: existing.content };
  }
  if (existing?.rawSystemHash === rawSystemHash) {
    const compiled = compileSystemPrompt({ agent, memoryDir });
    store.writeJson(RECORD, {
      ...existing,
      coreMemory: compiled.coreMemory,
      memfsRevision: compiled.memfsRevision,
      compiledAt: compiled.compiledAt,
    });
    return { systemPrompt: existing.content, memoryUpdate: formatMemoryUpdate(compiled) };
  }
  const compiled = compileSystemPrompt({ agent, memoryDir });
  store.writeJson(RECORD, compiled);
  return { systemPrompt: compiled.content };
}

/** Drop the cached prompt; the next step compiles from scratch (letta's /recompile). */
export function invalidateSystemPrompt(store: ConversationStore): void {
  store.removeJson(RECORD);
}

export function readCachedSystemPrompt(store: ConversationStore): CompiledSystemPrompt | undefined {
  return store.readJson<CompiledSystemPrompt>(RECORD);
}
