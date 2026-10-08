import { existsSync, readdirSync } from "node:fs";
import { readCachedSystemPrompt } from "@/agent/system-prompt";
import { compileSystemPrompt } from "@/memory/compile";
import { DEFAULT_MEMORY_CONSTRAINTS } from "@/memory/constraints";
import { isCoreMemoryPath, isProjectedMemoryPath } from "@/memory/format";
import { parseFrontmatter } from "@/memory/frontmatter";
import { git, headRevision } from "@/memory/git";
import { getMemoryDir } from "@/memory/memfs";
import { stepsSinceLastReflection, readReflectionState } from "@/reflection/transcript";
import { estimateMessagesTokens } from "@/context/tokens";
import { listAgents, loadAgent } from "@/store/agent-store";
import { ConversationStore } from "@/store/conversation-store";
import { conversationsDir } from "@/store/paths";

/**
 * Read-only views for the Memory Palace (letta-code's /palace,
 * src/web/generate-memory-viewer.ts): files, history, prompts, conversations.
 */
export type FileKind = "index" | "core" | "deferred" | "skill" | "unindexed" | "other";

export interface PalaceFile {
  path: string;
  kind: FileKind;
  characters: number;
  description: string;
}

function classify(path: string, all: Set<string>): FileKind {
  if (path.startsWith("skills/")) return "skill";
  if (!path.endsWith(".md")) return "other";
  if (path === "MEMORY.md" || path.endsWith("/MEMORY.md")) return isProjectedMemoryPath(path, all) ? "index" : "unindexed";
  if (isCoreMemoryPath(path)) return "core";
  return isProjectedMemoryPath(path, all) ? "deferred" : "unindexed";
}

export function agentsSummary(home: string) {
  return listAgents(home).map((agent) => {
    const dir = getMemoryDir(agent.id, home);
    return {
      id: agent.id,
      name: agent.name,
      head: headRevision(dir)?.slice(0, 7) ?? null,
      commits: Number(git(dir, ["rev-list", "--count", "HEAD"]).stdout.trim() || "0"),
      conversations: existsSync(conversationsDir(agent.id, home)) ? readdirSync(conversationsDir(agent.id, home)).length : 0,
    };
  });
}

export function memoryTree(home: string, agentId: string) {
  const dir = getMemoryDir(agentId, home);
  const paths = git(dir, ["ls-tree", "-r", "--name-only", "HEAD"]).stdout.split("\n").filter(Boolean);
  const all = new Set(paths);
  const files: PalaceFile[] = paths.map((path) => {
    const content = git(dir, ["show", `HEAD:${path}`]).stdout;
    return {
      path,
      kind: classify(path, all),
      characters: [...content].length,
      description: parseFrontmatter(content).frontmatter.description ?? "",
    };
  });
  const coreCharacters = files.filter((f) => f.kind === "core" || f.path === "MEMORY.md").reduce((n, f) => n + f.characters, 0);
  const dirty = git(dir, ["status", "--porcelain"]).stdout.trim();
  return {
    files,
    coreCharacters,
    coreBudget: DEFAULT_MEMORY_CONSTRAINTS.maxCoreMemoryCharacters ?? 0,
    uncommitted: dirty ? dirty.split("\n") : [],
  };
}

export function fileAtHead(home: string, agentId: string, path: string): string | null {
  const result = git(getMemoryDir(agentId, home), ["show", `HEAD:${path}`]);
  return result.ok ? result.stdout : null;
}

export function history(home: string, agentId: string, limit = 200) {
  const SEP = "\x1e";
  const out = git(getMemoryDir(agentId, home), [
    "log",
    `-${limit}`,
    "--shortstat",
    `--format=${SEP}%H%x1f%an%x1f%aI%x1f%s%x1f%P`,
  ]).stdout;
  return out
    .split(SEP)
    .filter(Boolean)
    .map((chunk) => {
      const [header, ...rest] = chunk.trim().split("\n");
      const [sha = "", author = "", date = "", subject = "", parents = ""] = (header ?? "").split("\x1f");
      return {
        sha,
        author,
        date,
        subject,
        isReflection: /reflection/i.test(subject) || /reflection/i.test(author),
        isMerge: parents.split(" ").length > 1,
        stat: rest.join(" ").trim(),
      };
    });
}

export function commitDiff(home: string, agentId: string, sha: string): string | null {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) return null;
  const result = git(getMemoryDir(agentId, home), ["show", "--format=%H%n%an <%ae>%n%aI%n%n%B", "--stat", "-p", sha]);
  return result.ok ? result.stdout : null;
}

export function conversations(home: string, agentId: string) {
  const root = conversationsDir(agentId, home);
  if (!existsSync(root)) return [];
  const head = headRevision(getMemoryDir(agentId, home));
  return readdirSync(root).map((id) => {
    const store = new ConversationStore(agentId, id, home);
    const all = store.all();
    const inContext = store.inContext();
    const cached = readCachedSystemPrompt(store);
    const state = readReflectionState(store);
    return {
      id,
      messages: all.length,
      inContext: inContext.length,
      contextTokens: estimateMessagesTokens(inContext),
      compactions: all.filter((m) => m.kind === "summary").length,
      memoryUpdates: all.filter((m) => m.content.includes("<memory_update>")).length,
      stepsSinceReflection: stepsSinceLastReflection(store),
      lastReflectionSucceededAt: state.lastReflectionSucceededAt ?? null,
      promptCompiledAt: cached?.compiledAt ?? null,
      // Committed memory moved since this conversation last looked: the next step injects <memory_update>.
      updatePending: Boolean(cached && cached.memfsRevision !== head),
      lastMessageAt: all.at(-1)?.createdAt ?? null,
    };
  });
}

export function prompts(home: string, agentId: string, conversationId: string) {
  const agent = loadAgent(agentId, home);
  const cached = readCachedSystemPrompt(new ConversationStore(agentId, conversationId, home));
  const fresh = compileSystemPrompt({ agent, memoryDir: getMemoryDir(agentId, home) });
  return { cached: cached?.content ?? null, fresh: fresh.content, freshRevision: fresh.memfsRevision ?? null };
}
