/**
 * Tree-level memory budget checks, after letta-code's
 * validateMemoryTreeConstraints (src/memory-constraints.ts).
 * Like validateMemoryFile, the function bodies here are self-contained so the
 * pre-commit hook can embed their source.
 */
export interface MemoryConstraintsConfig {
  version: 1;
  maxDepth?: number;
  maxFileCharacters?: number;
  maxCoreMemoryCharacters?: number;
  /** Globs that cannot be created, changed or removed by a commit. */
  readOnlyFiles?: string[];
}

export interface TreeFile {
  path: string;
  content: string;
}

export const MEMORY_CONSTRAINTS_CONFIG_PATH = ".memfs.config.json";
export const MEMORY_CONSTRAINTS_UPDATE_ENV = "MINI_LETTA_CONSTRAINTS_UPDATE";

export const DEFAULT_MEMORY_CONSTRAINTS: MemoryConstraintsConfig = {
  version: 1,
  maxDepth: 2,
  maxFileCharacters: 20_000,
  maxCoreMemoryCharacters: 65_536,
};

/** `*` within a segment, `**` across segments, `?` one character. */
export function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern.charAt(i);
    if (c === "*" && pattern[i + 1] === "*") {
      if (pattern[i + 2] === "/") {
        source += "(?:.*/)?";
        i += 2;
      } else {
        source += ".*";
        i += 1;
      }
    } else if (c === "*") source += "[^/]*";
    else if (c === "?") source += "[^/]";
    else source += "^$.*+?()[]{}|\\".includes(c) ? `\\${c}` : c;
  }
  return new RegExp(`${source}$`);
}

/**
 * Validate the proposed tree against the accepted (HEAD) tree.
 * Returns human-readable errors; empty means the commit may proceed.
 */
export function validateMemoryTree(
  proposed: TreeFile[],
  accepted: TreeFile[],
  config: MemoryConstraintsConfig,
): string[] {
  const errors: string[] = [];
  const paths = new Set(proposed.map((file) => file.path));
  const memoryFiles = proposed.filter((f) => f.path.endsWith(".md") && !f.path.startsWith("skills/"));
  if (!paths.has("MEMORY.md")) errors.push("MEMORY.md: root memory index is required");

  for (const { path } of memoryFiles) {
    let current = "";
    for (const directory of path.split("/").slice(0, -1)) {
      current = current ? `${current}/${directory}` : directory;
      if (!paths.has(`${current}/MEMORY.md`)) {
        errors.push(`${path}: missing required index ${current}/MEMORY.md`);
        break;
      }
    }
  }

  const protectedPatterns = (config.readOnlyFiles ?? []).map(globToRegExp);
  if (protectedPatterns.length) {
    const before = new Map(accepted.map((f) => [f.path, f.content]));
    const after = new Map(proposed.map((f) => [f.path, f.content]));
    for (const path of new Set([...before.keys(), ...after.keys()])) {
      if (!protectedPatterns.some((re) => re.test(path))) continue;
      if (before.get(path) !== after.get(path)) {
        errors.push(`${path}: read-only file cannot be created, changed or removed`);
      }
    }
  }

  let coreCharacters = 0;
  for (const { path, content } of memoryFiles) {
    const depth = path.split("/").length - 1;
    if (config.maxDepth !== undefined && depth > config.maxDepth) {
      errors.push(`${path}: depth ${depth} exceeds maxDepth ${config.maxDepth}`);
    }
    const characters = [...content].length;
    if (!path.includes("/")) coreCharacters += characters;
    if (config.maxFileCharacters !== undefined && characters > config.maxFileCharacters) {
      errors.push(`${path}: ${characters} characters exceeds ${config.maxFileCharacters} from maxFileCharacters`);
    }
  }
  if (config.maxCoreMemoryCharacters !== undefined && coreCharacters > config.maxCoreMemoryCharacters) {
    errors.push(
      `core memory: ${coreCharacters} characters exceeds ${config.maxCoreMemoryCharacters} from maxCoreMemoryCharacters`,
    );
  }
  return errors;
}
