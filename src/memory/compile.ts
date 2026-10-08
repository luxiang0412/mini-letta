import { createHash } from "node:crypto";
import type { AgentRecord } from "@/store/agent-store";
import { isCoreMemoryPath, isProjectedMemoryPath, labelFromPath } from "./format";
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

const CHILD_INDEX = /^[^/]+\/MEMORY\.md$/;

/** Read the committed tree; only core files and child indexes need bodies. */
export function readCommittedMemory(memoryDir: string): {
  files: CommittedMemoryFile[];
  revision?: string;
} {
  const revision = headRevision(memoryDir);
  if (!revision) return { files: [] };
  const paths = git(memoryDir, ["ls-tree", "-r", "--name-only", "HEAD"])
    .stdout.split("\n")
    .filter((path) => path.endsWith(".md"));
  const allPaths = new Set(paths);
  const files = paths.map((relativePath) => {
    const needsBody =
      isCoreMemoryPath(relativePath) ||
      (CHILD_INDEX.test(relativePath) && isProjectedMemoryPath(relativePath, allPaths));
    const raw = needsBody ? git(memoryDir, ["show", `HEAD:${relativePath}`]).stdout : "";
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

/**
 * Root core files → `<label>` sections. Root MEMORY.md → `<memory>`, with a
 * `<deferred-memory>` list of indexed child directories the agent can open
 * on demand (letta-code's renderRootMemoryProjection).
 */
export function renderCoreMemory(files: CommittedMemoryFile[]): string {
  const allPaths = new Set(files.map((f) => f.relativePath));
  const sections: string[] = [];
  for (const file of files.filter((f) => isCoreMemoryPath(f.relativePath) && f.relativePath !== "MEMORY.md")) {
    const lines = [`<${file.label}>`];
    if (file.description.trim()) lines.push(`<description>${file.description.trim()}</description>`);
    if (file.body.trimEnd()) lines.push(file.body.trimEnd());
    lines.push(`</${file.label}>`);
    sections.push(lines.join("\n"));
  }
  const index = files.find((f) => f.relativePath === "MEMORY.md");
  if (index) {
    const childIndexes = files
      .filter((f) => CHILD_INDEX.test(f.relativePath) && !f.relativePath.startsWith("skills/"))
      .filter((f) => isProjectedMemoryPath(f.relativePath, allPaths));
    const lines = ["<memory>"];
    if (index.body.trimEnd()) lines.push(index.body.trimEnd());
    if (childIndexes.length) {
      lines.push("<deferred-memory>");
      for (const child of childIndexes) {
        const directory = child.relativePath.slice(0, -"/MEMORY.md".length);
        lines.push(`<directory path="${directory}/" index="${directory}/MEMORY.md" />`);
      }
      lines.push("</deferred-memory>");
    }
    lines.push("</memory>");
    sections.push(lines.join("\n"));
  }
  return sections.join("\n\n");
}

/** Replace `{CORE_MEMORY}`, appending it when the raw prompt lacks one. */
export function injectCoreMemory(rawSystemPrompt: string, coreMemory: string): string {
  const prompt = rawSystemPrompt.includes(CORE_MEMORY_VARIABLE)
    ? rawSystemPrompt
    : `${rawSystemPrompt.trimEnd()}\n\n${CORE_MEMORY_VARIABLE}`;
  return prompt.replaceAll(CORE_MEMORY_VARIABLE, coreMemory);
}

export function hashRawSystemPrompt(system: string): string {
  return createHash("sha256").update(system).digest("hex");
}

export interface CompiledSystemPrompt {
  content: string;
  coreMemory: string;
  compiledAt: string;
  rawSystemHash: string;
  memfsRevision?: string;
}

export function compileSystemPrompt(input: {
  agent: AgentRecord;
  memoryDir: string;
  now?: Date;
}): CompiledSystemPrompt {
  const { files, revision } = readCommittedMemory(input.memoryDir);
  const coreMemory = renderCoreMemory(files);
  return {
    content: injectCoreMemory(input.agent.system, coreMemory),
    coreMemory,
    compiledAt: (input.now ?? new Date()).toISOString(),
    rawSystemHash: hashRawSystemPrompt(input.agent.system),
    memfsRevision: revision,
  };
}
