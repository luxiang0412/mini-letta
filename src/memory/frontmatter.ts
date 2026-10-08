/**
 * Memory Markdown rules (MemFS v2), ported from letta-code's
 * validateMemoryFileFrontmatter (src/memory-frontmatter.ts):
 *
 * - every `MEMORY.md` (root or child index) has NO frontmatter;
 * - every other memory `.md` has frontmatter with exactly `name` and
 *   `description`, both non-empty, no duplicates, no other keys.
 *
 * The function is self-contained on purpose: the pre-commit hook embeds its
 * source text (`validateMemoryFile.toString()`), so the hook keeps working
 * without mini-letta installed in the memory repository.
 */
export function validateMemoryFile(path: string, content: string): string[] {
  const lines = content.split("\n");
  if (path.split("/").at(-1) === "MEMORY.md") {
    return lines[0] === "---" ? [`${path}: MEMORY.md must not have frontmatter`] : [];
  }
  if (lines[0] !== "---") return [`${path}: missing frontmatter (must start with ---)`];
  const closing = lines.indexOf("---", 1);
  if (closing < 0) return [`${path}: frontmatter opened but never closed (missing closing ---)`];

  const errors: string[] = [];
  const seen = new Set<string>();
  for (const line of lines.slice(1, closing)) {
    if (!line) continue;
    const separator = line.indexOf(":");
    const key = (separator < 0 ? line : line.slice(0, separator)).trim();
    const value = separator < 0 ? "" : line.slice(separator + 1).trim();
    if (key !== "name" && key !== "description") {
      errors.push(`${path}: unknown frontmatter key '${key}' (allowed: name description)`);
      continue;
    }
    if (seen.has(key)) errors.push(`${path}: duplicate frontmatter key '${key}'`);
    seen.add(key);
    if (!value || value === '""' || value === "''") errors.push(`${path}: '${key}' must not be empty`);
  }
  for (const key of ["name", "description"]) {
    if (!seen.has(key)) errors.push(`${path}: missing required field '${key}'`);
  }
  return errors;
}

/**
 * Split `---` frontmatter (simple `key: value` lines) from the body. Like
 * letta-code's parseFrontmatter (src/utils/frontmatter.ts): strip a BOM,
 * normalize CRLF, and trim the body — a differential run against letta's
 * compiler showed an extra blank line here before this matched.
 */
export function parseFrontmatter(raw: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const content = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const match = content.match(/^---\n([\s\S]*?)\n---(?:\n([\s\S]*))?$/);
  if (!match) return { frontmatter: {}, body: content };
  const frontmatter: Record<string, string> = {};
  for (const line of (match[1] ?? "").split("\n")) {
    const separator = line.indexOf(":");
    if (separator > 0) frontmatter[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return { frontmatter, body: (match[2] ?? "").trim() };
}
