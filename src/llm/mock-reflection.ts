import { REFLECTION_MARKER } from "@/reflection/prompt";
import { callTool, type MockRule, promptSection, say, shellQuote } from "./mock-helpers";

/**
 * The mock reflection subagent. Deterministic stand-in for phases 1–5 of the
 * reflection prompt: read the transcript, keep durable preferences/corrections,
 * skip what memory already has, convert relative dates, commit or not.
 */
const DURABLE = /(我(?:更)?(?:喜欢|偏好|习惯|讨厌|不喜欢|总是|从不)|以后|别再|不要再|一律|prefer|always|never)/i;

interface TranscriptEntry {
  role: string;
  created_at: string;
  content: string;
}

/** The user's calendar date (local time), not the UTC date of the timestamp. */
export function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function absoluteDates(text: string, createdAt: string): string {
  const day = new Date(createdAt);
  const iso = localDate;
  const yesterday = new Date(day.getTime() - 86_400_000);
  return text.replaceAll("今天", `${iso(day)} `).replaceAll("昨天", `${iso(yesterday)} `);
}

export function extractDurableFacts(entries: TranscriptEntry[], existing: string): string[] {
  const facts: string[] = [];
  for (const entry of entries) {
    if (entry.role !== "user") continue;
    const text = entry.content.trim();
    if (!DURABLE.test(text) || text.length > 120) continue;
    const fact = `- ${absoluteDates(text, entry.created_at).replace(/^记住[:：]\s*/, "")}`;
    if (!existing.includes(fact) && !facts.includes(fact)) facts.push(fact);
  }
  return facts;
}

function parseTranscript(toolOutput: string): TranscriptEntry[] {
  const start = toolOutput.indexOf("[");
  try {
    return start < 0 ? [] : (JSON.parse(toolOutput.slice(start)) as TranscriptEntry[]);
  } catch {
    return [];
  }
}

export const reflectionRule: MockRule = (request) => {
  if (!request.system.startsWith(REFLECTION_MARKER)) return null;
  const toolMessages = request.messages.filter((m) => m.role === "tool");
  if (toolMessages.length === 0) {
    return callTool("bash", { command: 'wc -c "$TRANSCRIPT_PATH" && cat "$TRANSCRIPT_PATH"' });
  }
  if (toolMessages.length === 1) {
    const entries = parseTranscript(toolMessages[0]?.content ?? "");
    const facts = extractDurableFacts(entries, promptSection(request.system, "human") ?? "");
    if (facts.length === 0) {
      return say(`Summary: reviewed ${entries.length} messages; nothing durable to persist.\nCommit: no commit`);
    }
    const message = `chore(reflection): remember ${facts.length} user preference(s) 🔮`;
    return callTool("bash", {
      command: [
        'cd "$MEMORY_DIR"',
        ...facts.map((fact) => `printf '%s\\n' ${shellQuote(fact)} >> human.md`),
        "git add human.md",
        `git commit -q --author="Reflection Subagent <reflection@mini-letta.local>" -m ${shellQuote(message)}`,
        "git log --oneline -1",
      ].join(" && "),
    });
  }
  const last = toolMessages.at(-1)?.content ?? "";
  if (last.startsWith("Error:")) return say(`Issues: commit failed — ${last.slice(7, 200)}`);
  return say(`Summary: updated human.md.\nCommit: ${last.split("\n")[0]}`);
};
