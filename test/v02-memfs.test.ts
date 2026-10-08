import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runTurn } from "@/agent/loop";
import { MockProvider } from "@/llm/mock";
import { compileSystemPrompt } from "@/memory/compile";
import { validateMemoryTree } from "@/memory/constraints";
import { isCoreMemoryPath, isProjectedMemoryPath } from "@/memory/format";
import { validateMemoryFile } from "@/memory/frontmatter";
import { git } from "@/memory/git";
import { getMemoryDir } from "@/memory/memfs";
import { createAgent } from "@/store/agent-store";
import { ConversationStore } from "@/store/conversation-store";
import { FILE_TOOLS } from "@/tools/file-tools";
import { tempHome } from "./helpers";

function commit(dir: string, file: string, content: string, env: NodeJS.ProcessEnv = {}) {
  writeFileSync(join(dir, file), content);
  git(dir, ["add", file]);
  return git(dir, ["commit", "-q", "-m", `test: ${file}`], env);
}

describe("v0.2 MemFS layout rules", () => {
  test("core vs projected paths", () => {
    const all = new Set(["MEMORY.md", "human.md", "projects/MEMORY.md", "projects/a.md", "notes/b.md", "skills/x/SKILL.md"]);
    expect(isCoreMemoryPath("human.md")).toBe(true);
    expect(isCoreMemoryPath("projects/a.md")).toBe(false);
    expect(isProjectedMemoryPath("projects/a.md", all)).toBe(true);
    expect(isProjectedMemoryPath("notes/b.md", all)).toBe(false);
    expect(isProjectedMemoryPath("skills/x/SKILL.md", all)).toBe(false);
  });

  test("frontmatter validator", () => {
    expect(validateMemoryFile("MEMORY.md", "# Memory\n")).toEqual([]);
    expect(validateMemoryFile("MEMORY.md", "---\nname: x\n---\n")).toEqual(["MEMORY.md: MEMORY.md must not have frontmatter"]);
    expect(validateMemoryFile("a.md", "hello")).toEqual(["a.md: missing frontmatter (must start with ---)"]);
    expect(validateMemoryFile("a.md", "---\nname: A\ndescription: d\n---\nbody")).toEqual([]);
    expect(validateMemoryFile("a.md", "---\nname: A\ntags: x\n---\n")).toEqual([
      "a.md: unknown frontmatter key 'tags' (allowed: name description)",
      "a.md: missing required field 'description'",
    ]);
  });

  test("tree constraints: index, depth, budget, read-only", () => {
    const head = [{ path: "MEMORY.md", content: "# M" }, { path: "persona.md", content: "p" }];
    const proposed = [
      { path: "MEMORY.md", content: "# M" },
      { path: "persona.md", content: "changed" },
      { path: "a/b/c/d.md", content: "x" },
    ];
    const errors = validateMemoryTree(proposed, head, { version: 1, maxDepth: 2, readOnlyFiles: ["persona.md"] });
    expect(errors).toContain("a/b/c/d.md: missing required index a/MEMORY.md");
    expect(errors).toContain("a/b/c/d.md: depth 3 exceeds maxDepth 2");
    expect(errors).toContain("persona.md: read-only file cannot be created, changed or removed");
  });
});

describe("v0.2 git-backed memory", () => {
  test("agent is born with a committed v2 memory repo", () => {
    const home = tempHome();
    createAgent({ id: "agent-a" }, home);
    const dir = getMemoryDir("agent-a", home);
    expect(git(dir, ["ls-tree", "-r", "--name-only", "HEAD"]).stdout.split("\n").filter(Boolean)).toEqual([
      "MEMORY.md",
      "human.md",
      "persona.md",
    ]);
    expect(git(dir, ["log", "--format=%an <%ae> %s"]).stdout.trim()).toBe(
      "mini-letta <agent-a@mini-letta.local> chore: initialize local memory",
    );
  });

  test("pre-commit hook rejects invalid memory and accepts valid memory", () => {
    const home = tempHome();
    createAgent({ id: "agent-h" }, home);
    const dir = getMemoryDir("agent-h", home);
    const bad = commit(dir, "notes.md", "no frontmatter here\n");
    expect(bad.ok).toBe(false);
    expect(bad.stderr).toContain("notes.md: missing frontmatter (must start with ---)");
    git(dir, ["reset", "-q", "HEAD", "notes.md"]);
    const good = commit(dir, "notes.md", "---\nname: Notes\ndescription: Scratch notes\n---\nhi\n");
    expect(good.ok).toBe(true);
  });

  test("the policy file itself is protected", () => {
    const home = tempHome();
    createAgent({ id: "agent-p" }, home);
    const dir = getMemoryDir("agent-p", home);
    const denied = commit(dir, ".memfs.config.json", '{"version":1,"maxFileCharacters":120}\n');
    expect(denied.stderr).toContain(".memfs.config.json is protected and requires human approval to change");
    const approved = git(dir, ["commit", "-q", "-m", "policy"], { MINI_LETTA_CONSTRAINTS_UPDATE: "1" });
    expect(approved.ok).toBe(true);
    const tooBig = commit(dir, "big.md", `---\nname: Big\ndescription: too big\n---\n${"x".repeat(100)}\n`);
    expect(tooBig.stderr).toContain("big.md: 140 characters exceeds 120 from maxFileCharacters");
  });

  test("only committed memory reaches the prompt", () => {
    const home = tempHome();
    const agent = createAgent({ id: "agent-c" }, home);
    const dir = getMemoryDir(agent.id, home);
    const path = join(dir, "human.md");
    writeFileSync(path, `${readFileSync(path, "utf8")}- uncommitted fact\n`);
    const before = compileSystemPrompt({ agent, conversationId: "c", memoryDir: dir, previousMessageCount: 0 });
    expect(before.content).not.toContain("uncommitted fact");
    git(dir, ["commit", "-qam", "chore: commit fact"]);
    const after = compileSystemPrompt({ agent, conversationId: "c", memoryDir: dir, previousMessageCount: 0 });
    expect(after.content).toContain("- uncommitted fact");
    expect(after.revision).not.toBe(before.revision);
  });

  test("remember → bash edits human.md and commits → next turn knows it", async () => {
    const home = tempHome();
    const agent = createAgent({ id: "agent-r" }, home);
    const store = new ConversationStore(agent.id, "c1", home);
    const provider = new MockProvider();
    const first = await runTurn({ agent, provider, store, tools: FILE_TOOLS, home, userText: "记住：我用 pnpm，不用 npm" });
    expect(first.steps).toBe(2);
    const dir = getMemoryDir(agent.id, home);
    expect(git(dir, ["log", "-1", "--format=%s"]).stdout.trim()).toBe("chore: remember user fact");
    expect(git(dir, ["status", "--porcelain"]).stdout).toBe("");
    const second = await runTurn({ agent, provider, store: new ConversationStore(agent.id, "c2", home), tools: FILE_TOOLS, home, userText: "你知道我什么？" });
    expect(second.finalText).toContain("- 我用 pnpm，不用 npm");
  });
});
