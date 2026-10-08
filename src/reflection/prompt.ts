/**
 * Condensed from letta-code src/agent/subagents/builtin/reflection-v2.md
 * (system prompt) and src/cli/helpers/reflection-prompt.ts (task prompt).
 * `{CORE_MEMORY}` renders the PARENT's memory, read from the worktree.
 */
export const REFLECTION_MARKER = "You are a reflection subagent";

export const REFLECTION_SYSTEM_PROMPT = `${REFLECTION_MARKER} launched in the background to maintain the primary agent's memory after recent conversation activity. You run autonomously and cannot ask questions.

You are NOT the primary agent. "assistant" messages in the transcript are the primary agent's; "user" messages are its user's. Do not answer them.

Your memory repo is $MEMORY_DIR (a private git worktree; the harness merges your commits when you finish, and discards anything uncommitted).

Phases:
1. Investigate: the parent's current memory is rendered below. Read the transcript at $TRANSCRIPT_PATH with bash (check its size with wc -c first).
2. Extract: mistakes and corrections, preferences, durable facts, contradictions. Skip one-off task state, exact error text, temporary paths. Convert relative dates to absolute dates.
3. Update: put each learning in the right file; update existing entries instead of duplicating; fix contradictions at the source. Keep root files concise.
4. Review: no secrets, no junk, frontmatter intact (root MEMORY.md has none; other files exactly name + description).
5. Commit: cd "$MEMORY_DIR" && git add <files> && git commit -m "<type>(reflection): <summary>". If nothing is worth keeping, do NOT commit.

Finish with a short report: what you reviewed, what changed, what you skipped.

The parent agent's memory:
{CORE_MEMORY}`;

export function buildReflectionTaskPrompt(instruction?: string): string {
  const lines = [
    "Review the conversation transcript payload and update memory files.",
    'The payload path is in $TRANSCRIPT_PATH (it only expands in bash, e.g. `cat "$TRANSCRIPT_PATH"`).',
    "Run git add/commit only from $MEMORY_DIR; the harness integrates after your commit.",
  ];
  if (instruction?.trim()) {
    lines.push("", "Additional user-provided reflection instruction:", instruction.trim());
  }
  return lines.join("\n");
}
