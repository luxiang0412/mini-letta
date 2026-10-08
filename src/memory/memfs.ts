import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentDir, getHome } from "@/store/paths";
import { git, gitOrThrow } from "./git";
import { installMemoryHooks } from "./hooks";

/**
 * MemFS: each agent's memory is a git repository of Markdown files.
 * letta-code (local backend) keeps it at $LETTA_LOCAL_BACKEND_DIR/memfs/<agent>/memory;
 * mini-letta keeps it next to the agent record.
 */
export function getMemoryDir(agentId: string, home = getHome()): string {
  return join(agentDir(agentId, home), "memory");
}

export interface InitialMemoryBlock {
  label: string;
  value: string;
  description?: string;
}

export interface MemoryFile {
  relativePath: string;
  content: string;
}

export const ROOT_MEMORY_INDEX = "# Memory\n";

function titleFromLabel(label: string): string {
  return label
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`)
    .join(" ");
}

/**
 * Turn create-agent blocks into MemFS v2 files, after letta-code's
 * initialMemoryFilesFromCreateBody (src/backend/local/initial-memory.ts):
 * a frontmatter-free root MEMORY.md plus one root core file per block.
 */
export function initialMemoryFiles(blocks: InitialMemoryBlock[]): MemoryFile[] {
  const links = blocks.map(
    (block) => `- [${block.label}](${block.label}.md) — ${block.description ?? block.label}`,
  );
  const files: MemoryFile[] = [
    { relativePath: "MEMORY.md", content: `${ROOT_MEMORY_INDEX}\n${links.join("\n")}\n` },
  ];
  for (const block of blocks) {
    const description = (block.description ?? `Memory block ${block.label}`).replace(/\r?\n/g, " ");
    files.push({
      relativePath: `${block.label}.md`,
      content: `---\nname: ${titleFromLabel(block.label)}\ndescription: ${description}\n---\n${block.value}\n`,
    });
  }
  return files;
}

export interface CommitAuthor {
  name: string;
  email: string;
}

export function agentAuthor(agentId: string, agentName: string): CommitAuthor {
  return { name: agentName || "mini-letta", email: `${agentId}@mini-letta.local` };
}

/**
 * Create the repo on first use (idempotent), after letta-code's
 * initializeLocalMemoryRepo (src/agent/memory-git.ts): `git init` on `main`,
 * hooks installed, initial files committed in one commit.
 */
export function initMemoryRepo(input: {
  memoryDir: string;
  author: CommitAuthor;
  files: MemoryFile[];
}): void {
  const { memoryDir, author } = input;
  mkdirSync(memoryDir, { recursive: true });
  if (!existsSync(join(memoryDir, ".git"))) {
    gitOrThrow(memoryDir, ["init", "-q", "-b", "main"]);
  }
  gitOrThrow(memoryDir, ["config", "user.name", author.name]);
  gitOrThrow(memoryDir, ["config", "user.email", author.email]);
  // Memory bytes must not depend on the host: a global core.autocrlf=true
  // would check worktrees and merges out with CRLF.
  gitOrThrow(memoryDir, ["config", "core.autocrlf", "false"]);
  gitOrThrow(memoryDir, ["config", "core.eol", "lf"]);
  installMemoryHooks(memoryDir);
  if (git(memoryDir, ["rev-parse", "--verify", "HEAD"]).ok) return;

  for (const file of input.files) {
    const fullPath = join(memoryDir, file.relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, file.content);
  }
  const paths = input.files.map((file) => file.relativePath);
  if (paths.length) gitOrThrow(memoryDir, ["add", "--", ...paths]);
  gitOrThrow(memoryDir, [
    "commit",
    "-q",
    ...(paths.length ? [] : ["--allow-empty"]),
    "-m",
    paths.length ? "chore: initialize local memory" : "chore: initialize empty local memory",
  ]);
}

/** Commit exactly these paths (never `git add -A`); returns false when nothing changed. */
export function commitMemoryPaths(memoryDir: string, paths: string[], message: string): boolean {
  gitOrThrow(memoryDir, ["add", "--", ...paths]);
  if (git(memoryDir, ["diff", "--cached", "--quiet", "--", ...paths]).ok) return false;
  gitOrThrow(memoryDir, ["commit", "-q", "-m", message, "--", ...paths]);
  return true;
}
