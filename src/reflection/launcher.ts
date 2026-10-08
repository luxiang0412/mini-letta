import { join } from "node:path";
import { runTurn, type TurnEvent } from "@/agent/loop";
import type { LLMProvider } from "@/llm/types";
import { git } from "@/memory/git";
import { getMemoryDir } from "@/memory/memfs";
import type { AgentRecord } from "@/store/agent-store";
import { ConversationStore } from "@/store/conversation-store";
import { agentDir } from "@/store/paths";
import { reflectionProfile } from "@/agent/sandbox-profiles";
import { isFsSandboxEnabled } from "@/sandbox/policy";
import { syncAfterTurn } from "@/sync/remote";
import { bashTool, editFileTool } from "@/tools/file-tools";
import { tryAcquireLock } from "@/utils/file-lock";
import { buildReflectionTaskPrompt, REFLECTION_SYSTEM_PROMPT } from "./prompt";
import { buildReflectionPayload, markReflected } from "./transcript";
import { consumesTranscript, createMemoryWorktree, type FinalizeStatus, finalizeMemoryWorktree } from "./worktree";

export type ReflectionSkipReason = "already_active" | "parent_dirty" | "no_payload";

export type ReflectionOutcome =
  | { launched: false; reason: ReflectionSkipReason }
  | { launched: true; status: FinalizeStatus; summary: string; report: string; reflectionId: string };

/**
 * One reflection run, after letta-code's launchReflectionSubagent
 * (src/cli/helpers/reflection-launcher.ts):
 *   reserve → skip if parent dirty → build payload → create worktree →
 *   run the reflection subagent IN the worktree → finalize (merge) →
 *   advance the watermark only if the result consumed the transcript.
 */
export async function launchReflection(input: {
  home: string;
  agent: AgentRecord;
  conversationId: string;
  provider: LLMProvider;
  instruction?: string;
  onEvent?: (event: TurnEvent) => void;
}): Promise<ReflectionOutcome> {
  const { home, agent, provider } = input;
  const release = tryAcquireLock(join(agentDir(agent.id, home), "reflection.lock"));
  if (!release) return { launched: false, reason: "already_active" };
  try {
    const parentMemoryDir = getMemoryDir(agent.id, home);
    if (git(parentMemoryDir, ["status", "--porcelain"]).stdout.trim()) {
      return { launched: false, reason: "parent_dirty" };
    }
    const store = new ConversationStore(agent.id, input.conversationId, home);
    const payload = buildReflectionPayload(store, join(agentDir(agent.id, home), "reflections", "payloads"));
    if (!payload) return { launched: false, reason: "no_payload" };

    const worktree = createMemoryWorktree(parentMemoryDir);
    const reflector: AgentRecord = {
      id: `${agent.id}~reflection`,
      name: "Reflection Subagent",
      system: REFLECTION_SYSTEM_PROMPT,
      createdAt: new Date().toISOString(),
    };
    let report = "";
    let succeeded = false;
    // "Nothing worth keeping" must be earned: the reflector has to have read
    // the payload. qwen2.5:3b once only narrated "I will now read the
    // transcript" and stopped, which would otherwise consume the slice.
    let readPayload = false;
    const onEvent = (event: TurnEvent) => {
      if (event.type === "tool_call" && JSON.stringify(event.arguments).match(/TRANSCRIPT_PATH|payload-\d+\.json/)) {
        readPayload = true;
      }
      input.onEvent?.(event);
    };
    try {
      const result = await runTurn({
        agent: reflector,
        provider,
        store: new ConversationStore(reflector.id, `reflection-${worktree.id}`, home),
        tools: [bashTool, editFileTool],
        userText: buildReflectionTaskPrompt(input.instruction),
        home,
        memoryDir: worktree.worktreeDir,
        extraEnv: { TRANSCRIPT_PATH: payload.payloadPath, PARENT_AGENT_ID: agent.id },
        // Unattended memory writers are confined by default (letta: memory-subagent profile).
        sandbox: isFsSandboxEnabled()
          ? reflectionProfile({ home, parentAgentId: agent.id, worktreeDir: worktree.worktreeDir, payloadPath: payload.payloadPath })
          : undefined,
        maxSteps: 12,
        onEvent,
      });
      report = result.finalText;
      // The prompt demands a final report. An empty answer (qwen2.5:3b's
      // response in Lab 5) must not count as "reviewed, nothing to keep",
      // or the slice would be marked reflected and never retried.
      succeeded = readPayload && report.trim() !== "" && !report.startsWith("(stopped");
    } catch (error) {
      report = error instanceof Error ? error.message : String(error);
    }

    const finalized = await finalizeMemoryWorktree(worktree, { subagentSucceeded: succeeded });
    if (consumesTranscript(finalized)) markReflected(store, payload.endMessageId);
    if (finalized.status === "merged") syncAfterTurn(parentMemoryDir);
    return { launched: true, status: finalized.status, summary: finalized.summary, report, reflectionId: worktree.id };
  } finally {
    release();
  }
}
