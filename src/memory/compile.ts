import type { AgentRecord } from "@/store/agent-store";
import { isCoreMemoryPath, labelFromPath } from "./format";
import { parseFrontmatter } from "./frontmatter";
import { git, headRevision } from "./git";

/**
 * Compile an agent's memory into its system prompt, after letta-code's
 * compileLocalSystemPrompt (src/backend/local/system-prompt-compilation.ts).
 *
 * Only COMMITTED memory counts: files are read from `HEAD` with `git show`,
 * so a half-finished edit in the working tree never leaks into the prompt.
 */
export const CORE_MEMORY_VARIABLE = "{CORE_MEMORY}";

export interface CommittedMemoryFile {
  relativePath: string;
  label: string;
  description: string;
  body: string;
}

export function readCommittedCoreMemory(memoryDir: string): {
  files: CommittedMemoryFile[];
  revision?: string;
} {
  const revision = headRevision(memoryDir);
  if (!revision) return { files: [] };
  const paths = git(memoryDir, ["ls-tree", "-r", "--name-only", "HEAD"])
    .stdout.split("\n")
    .filter((path) => path && isCoreMemoryPath(path));
  const files = paths.map((relativePath) => {
    const raw = git(memoryDir, ["show", `HEAD:${relativePath}`]).stdout;
    const { frontmatter, body } = parseFrontmatter(raw);
    return {
      relativePath,
      label: labelFromPath(relativePath),
      description: frontmatter.description ?? "",
      body,
    };
  });
  files.sort((a, b) => a.label.localeCompare(b.label));
  return { files, revision };
}

/** Root core files become `<label>` sections; MEMORY.md becomes `<memory>`. */
export function renderCoreMemory(files: CommittedMemoryFile[]): string {
  const sections: string[] = [];
  for (const file of files.filter((f) => f.relativePath !== "MEMORY.md")) {
    const lines = [`<${file.label}>`];
    if (file.description.trim()) lines.push(`<description>${file.description.trim()}</description>`);
    if (file.body.trimEnd()) lines.push(file.body.trimEnd());
    lines.push(`</${file.label}>`);
    sections.push(lines.join("\n"));
  }
  const index = files.find((f) => f.relativePath === "MEMORY.md");
  if (index) sections.push(["<memory>", index.body.trimEnd(), "</memory>"].join("\n"));
  return sections.join("\n\n");
}

export function renderMemoryMetadata(input: {
  agentId: string;
  conversationId: string;
  memoryDir: string;
  compiledAt: Date;
  previousMessageCount: number;
}): string {
  return [
    "<memory_metadata>",
    `- AGENT_ID: ${input.agentId}`,
    `- CONVERSATION_ID: ${input.conversationId}`,
    `- MEMORY_DIR: ${input.memoryDir}`,
    `- System prompt last recompiled: ${input.compiledAt.toISOString()}`,
    `- ${input.previousMessageCount} previous messages are stored in recall memory`,
    "</memory_metadata>",
  ].join("\n");
}

/** Replace `{CORE_MEMORY}`, appending it when the raw prompt lacks one. */
export function injectCoreMemory(rawSystemPrompt: string, coreMemory: string): string {
  const prompt = rawSystemPrompt.includes(CORE_MEMORY_VARIABLE)
    ? rawSystemPrompt
    : `${rawSystemPrompt.trimEnd()}\n\n${CORE_MEMORY_VARIABLE}`;
  return prompt.replaceAll(CORE_MEMORY_VARIABLE, coreMemory);
}

export function compileSystemPrompt(input: {
  agent: AgentRecord;
  conversationId: string;
  memoryDir: string;
  previousMessageCount: number;
  now?: Date;
}): { content: string; revision?: string } {
  const { files, revision } = readCommittedCoreMemory(input.memoryDir);
  const metadata = renderMemoryMetadata({
    agentId: input.agent.id,
    conversationId: input.conversationId,
    memoryDir: input.memoryDir,
    compiledAt: input.now ?? new Date(),
    previousMessageCount: input.previousMessageCount,
  });
  const coreMemory = [renderCoreMemory(files), metadata].filter((p) => p.trim()).join("\n\n");
  return { content: injectCoreMemory(input.agent.system, coreMemory), revision };
}
