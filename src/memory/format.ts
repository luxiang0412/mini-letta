/**
 * MemFS v2 path rules, from letta-code src/agent/memory-format.ts.
 *
 *   MEMORY.md            root index        → in the system prompt
 *   persona.md, human.md root core files   → in the system prompt
 *   projects/MEMORY.md   child index       → listed as deferred memory
 *   projects/foo.md      deferred file     → read on demand
 *   notes/bar.md         (no notes/MEMORY.md) → not memory at all
 *   skills/...           procedural memory → never projected
 */
export function normalizeMemoryPath(path: string): string {
  return path.replace(/\\/g, "/");
}

/** Root-level Markdown files are core memory (always in context). */
export function isCoreMemoryPath(relativePath: string): boolean {
  const normalized = normalizeMemoryPath(relativePath);
  return normalized.endsWith(".md") && !normalized.includes("/");
}

/**
 * A nested path is memory only if every ancestor directory has its own
 * MEMORY.md index. `skills/` is always excluded.
 */
export function isProjectedMemoryPath(relativePath: string, allPaths: ReadonlySet<string>): boolean {
  const normalized = normalizeMemoryPath(relativePath);
  if (normalized === "skills" || normalized.startsWith("skills/")) return false;
  if (!normalized.includes("/")) return true;
  const directories = normalized.split("/").slice(0, -1);
  let current = "";
  for (const directory of directories) {
    current = current ? `${current}/${directory}` : directory;
    if (!allPaths.has(`${current}/MEMORY.md`)) return false;
  }
  return true;
}

export function labelFromPath(relativePath: string): string {
  return normalizeMemoryPath(relativePath).replace(/\.md$/, "");
}
