import { COMPACTION_EVENT } from "@/context/compact-conversation";
import type { LLMProvider } from "@/llm/types";
import { type AgentRecord, DEFAULT_REFLECTION_SETTINGS } from "@/store/agent-store";
import { ConversationStore } from "@/store/conversation-store";
import { launchReflection, type ReflectionOutcome } from "./launcher";
import { stepsSinceLastReflection } from "./transcript";

/**
 * Evaluate the reflection trigger after a turn, after letta-code's
 * maybeLaunchPostTurnReflection (src/cli/helpers/post-turn-reflection.ts).
 * The compaction flag is consumed whether or not a reflection launches.
 */
export async function maybeReflectAfterTurn(input: {
  home: string;
  agent: AgentRecord;
  conversationId: string;
  provider: LLMProvider;
}): Promise<ReflectionOutcome | null> {
  const settings = input.agent.reflection ?? DEFAULT_REFLECTION_SETTINGS;
  const store = new ConversationStore(input.agent.id, input.conversationId, input.home);
  const compaction = store.readJson<{ pending?: boolean }>(COMPACTION_EVENT);
  if (compaction?.pending) store.writeJson(COMPACTION_EVENT, { ...compaction, pending: false });

  if (settings.trigger === "off") return null;
  if (settings.trigger === "compaction-event" && !compaction?.pending) return null;
  if (settings.trigger === "step-count" && stepsSinceLastReflection(store) < settings.stepCount) return null;
  return launchReflection(input);
}
