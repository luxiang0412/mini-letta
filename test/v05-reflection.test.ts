import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runTurn } from "@/agent/loop";
import { MockProvider } from "@/llm/mock";
import { localDate } from "@/llm/mock-reflection";
import { git } from "@/memory/git";
import { getMemoryDir } from "@/memory/memfs";
import { launchReflection } from "@/reflection/launcher";
import { maybeReflectAfterTurn } from "@/reflection/post-turn";
import { readReflectionState, stepsSinceLastReflection } from "@/reflection/transcript";
import { createMemoryWorktree, finalizeMemoryWorktree } from "@/reflection/worktree";
import { createAgent, saveAgent } from "@/store/agent-store";
import { ConversationStore } from "@/store/conversation-store";
import { agentDir } from "@/store/paths";
import { FILE_TOOLS } from "@/tools/file-tools";
import { tryAcquireLock } from "@/utils/file-lock";
import { tempHome } from "./helpers";

function commitIn(dir: string, file: string, content: string, message: string) {
  writeFileSync(join(dir, file), content);
  git(dir, ["add", file]);
  const r = git(dir, ["commit", "-q", "-m", message, "--", file]);
  if (!r.ok) throw new Error(r.stderr);
}

const HUMAN = (body: string) => `---\nname: Human\ndescription: What I know about the user.\n---\n${body}`;

function setup(id: string) {
  const home = tempHome();
  const agent = createAgent({ id }, home);
  return { home, agent, memoryDir: getMemoryDir(id, home) };
}

describe("v0.5 worktree finalize state machine", () => {
  test("no_changes / merged / failed / dirty_uncommitted", async () => {
    const { memoryDir } = setup("agent-w");
    const noop = createMemoryWorktree(memoryDir);
    expect((await finalizeMemoryWorktree(noop, { subagentSucceeded: true })).status).toBe("no_changes");
    expect(existsSync(noop.worktreeDir)).toBe(false);

    const ok = createMemoryWorktree(memoryDir);
    commitIn(ok.worktreeDir, "human.md", HUMAN("- likes tabs\n"), "chore(reflection): likes tabs");
    const merged = await finalizeMemoryWorktree(ok, { subagentSucceeded: true });
    expect(merged.status).toBe("merged");
    expect(readFileSync(join(memoryDir, "human.md"), "utf8")).toContain("- likes tabs");
    expect(git(memoryDir, ["branch", "--list", ok.branchName]).stdout).toBe("");

    const crashed = createMemoryWorktree(memoryDir);
    commitIn(crashed.worktreeDir, "human.md", HUMAN("- half\n"), "chore(reflection): half");
    expect((await finalizeMemoryWorktree(crashed, { subagentSucceeded: false })).status).toBe("failed");
    expect(readFileSync(join(memoryDir, "human.md"), "utf8")).not.toContain("- half");

    const messy = createMemoryWorktree(memoryDir);
    writeFileSync(join(messy.worktreeDir, "human.md"), HUMAN("- never committed\n"));
    expect((await finalizeMemoryWorktree(messy, { subagentSucceeded: true })).status).toBe("dirty_uncommitted");
  });

  test("parent_dirty and merge_conflict leave the parent untouched", async () => {
    const { memoryDir } = setup("agent-c");
    const a = createMemoryWorktree(memoryDir);
    commitIn(a.worktreeDir, "human.md", HUMAN("- from reflection\n"), "chore(reflection): a");
    writeFileSync(join(memoryDir, "scratch.md"), "dirty");
    expect((await finalizeMemoryWorktree(a, { subagentSucceeded: true })).status).toBe("parent_dirty");
    git(memoryDir, ["clean", "-fq"]);

    const b = createMemoryWorktree(memoryDir);
    commitIn(b.worktreeDir, "human.md", HUMAN("- from reflection\n"), "chore(reflection): b");
    commitIn(memoryDir, "human.md", HUMAN("- from the primary agent\n"), "chore: primary edit");
    const conflict = await finalizeMemoryWorktree(b, { subagentSucceeded: true });
    expect(conflict.status).toBe("merge_conflict");
    expect(git(memoryDir, ["status", "--porcelain"]).stdout).toBe("");
    expect(readFileSync(join(memoryDir, "human.md"), "utf8")).toContain("- from the primary agent");
  });

  test("a non-fast-forward merge gets a merge(reflection) commit", async () => {
    const { memoryDir } = setup("agent-m");
    const w = createMemoryWorktree(memoryDir);
    commitIn(w.worktreeDir, "human.md", HUMAN("- likes tabs\n"), "chore(reflection): remember tabs");
    commitIn(memoryDir, "persona.md", "---\nname: Persona\ndescription: Who I am.\n---\nTerse.\n", "feat: terse");
    expect((await finalizeMemoryWorktree(w, { subagentSucceeded: true })).status).toBe("merged");
    expect(git(memoryDir, ["log", "-1", "--format=%s"]).stdout.trim()).toBe("merge(reflection): remember tabs");
  });
});

describe("v0.5 reflection runs", () => {
  async function chat(home: string, agent: ReturnType<typeof createAgent>, texts: string[]) {
    const store = new ConversationStore(agent.id, "c1", home);
    for (const userText of texts) {
      await runTurn({ agent, provider: new MockProvider(), store, tools: FILE_TOOLS, home, userText });
    }
    return store;
  }

  test("reflection extracts durable preferences, merges them, advances the watermark", async () => {
    const { home, agent, memoryDir } = setup("agent-r");
    const store = await chat(home, agent, ["帮我看下这个报错", "我更喜欢用 tabs 缩进", "今天我们决定以后一律用 pnpm"]);
    expect(stepsSinceLastReflection(store)).toBe(3);
    const outcome = await launchReflection({ home, agent, conversationId: "c1", provider: new MockProvider() });
    expect(outcome.launched && outcome.status).toBe("merged");
    const human = readFileSync(join(memoryDir, "human.md"), "utf8");
    const today = localDate(new Date());
    expect(human).toContain("- 我更喜欢用 tabs 缩进");
    expect(human).toContain(`- ${today} 我们决定以后一律用 pnpm`);
    expect(human).not.toContain("报错");
    expect(git(memoryDir, ["log", "-1", "--format=%an %s"]).stdout.trim()).toBe(
      "Reflection Subagent chore(reflection): remember 2 user preference(s) 🔮",
    );
    expect(stepsSinceLastReflection(store)).toBe(0);
    expect(await launchReflection({ home, agent, conversationId: "c1", provider: new MockProvider() })).toEqual({
      launched: false,
      reason: "no_payload",
    });
    // The primary agent learns about it on its next step.
    const next = await runTurn({ agent, provider: new MockProvider(), store, tools: FILE_TOOLS, home, userText: "你知道我什么？" });
    expect(next.finalText).toContain("tabs");
  });

  test("nothing durable → no commit, but the slice still counts as reflected", async () => {
    const { home, agent, memoryDir } = setup("agent-n");
    const store = await chat(home, agent, ["帮我看下这个报错"]);
    const outcome = await launchReflection({ home, agent, conversationId: "c1", provider: new MockProvider() });
    expect(outcome.launched && outcome.status).toBe("no_changes");
    expect(git(memoryDir, ["rev-list", "--count", "HEAD"]).stdout.trim()).toBe("1");
    expect(readReflectionState(store).reflectedThroughMessageId).toBe(store.all().at(-1)?.id);
  });

  test("an empty reflection is a failure: the slice stays unreflected", async () => {
    const { home, agent } = setup("agent-empty");
    const store = await chat(home, agent, ["我更喜欢用 tabs 缩进"]);
    const silent = new MockProvider({
      rules: [(request) => (request.system.startsWith("You are a reflection") ? { content: "", toolCalls: [] } : null)],
    });
    const outcome = await launchReflection({ home, agent, conversationId: "c1", provider: silent });
    expect(outcome.launched && outcome.status).toBe("failed");
    expect(readReflectionState(store).reflectedThroughMessageId).toBeUndefined();
    expect(stepsSinceLastReflection(store)).toBe(1);
  });

  test("a reflector that never reads the payload has not reflected", async () => {
    const { home, agent } = setup("agent-narrate");
    const store = await chat(home, agent, ["我更喜欢用 tabs 缩进"]);
    const narrator = new MockProvider({
      rules: [
        (request) =>
          request.system.startsWith("You are a reflection")
            ? { content: "I will now proceed to read the transcript file and prepare the necessary updates.", toolCalls: [] }
            : null,
      ],
    });
    const outcome = await launchReflection({ home, agent, conversationId: "c1", provider: narrator });
    expect(outcome.launched && outcome.status).toBe("failed");
    expect(stepsSinceLastReflection(store)).toBe(1);
  });

  test("one reflection per agent at a time", async () => {
    const { home, agent } = setup("agent-l");
    await chat(home, agent, ["我更喜欢用 tabs 缩进"]);
    const release = tryAcquireLock(join(agentDir(agent.id, home), "reflection.lock"));
    expect(await launchReflection({ home, agent, conversationId: "c1", provider: new MockProvider() })).toEqual({
      launched: false,
      reason: "already_active",
    });
    release?.();
  });

  test("a conflicted reflection is retried with the same transcript slice", async () => {
    const { home, agent, memoryDir } = setup("agent-x");
    const store = await chat(home, agent, ["我更喜欢用 tabs 缩进"]);
    // The primary agent edits human.md while reflection runs.
    const racing = new MockProvider({
      rules: [
        (request) => {
          if (request.messages.filter((m) => m.role === "tool").length === 1 && request.system.startsWith("You are a reflection")) {
            commitIn(memoryDir, "human.md", HUMAN("- edited by primary\n"), "chore: primary edit");
          }
          return null;
        },
      ],
    });
    const first = await launchReflection({ home, agent, conversationId: "c1", provider: racing });
    expect(first.launched && first.status).toBe("merge_conflict");
    expect(stepsSinceLastReflection(store)).toBe(1);
    const retry = await launchReflection({ home, agent, conversationId: "c1", provider: new MockProvider() });
    expect(retry.launched && retry.status).toBe("merged");
    expect(readFileSync(join(memoryDir, "human.md"), "utf8")).toContain("- edited by primary\n- 我更喜欢用 tabs 缩进");
  });
});

describe("v0.5 absolute dates", () => {
  test("relative dates resolve in local time, not UTC", () => {
    const lateNight = new Date(2026, 9, 9, 0, 6); // 00:06 local on Oct 9
    expect(localDate(lateNight)).toBe("2026-10-09");
  });
});

describe("v0.5 triggers", () => {
  test("step-count fires once enough assistant steps accumulate", async () => {
    const { home, agent } = setup("agent-t");
    agent.reflection = { trigger: "step-count", stepCount: 3 };
    saveAgent(agent, home);
    const store = new ConversationStore(agent.id, "c1", home);
    const outcomes = [];
    for (const userText of ["我更喜欢用 tabs 缩进", "嗯", "好的"]) {
      await runTurn({ agent, provider: new MockProvider(), store, tools: FILE_TOOLS, home, userText });
      outcomes.push(await maybeReflectAfterTurn({ home, agent, conversationId: "c1", provider: new MockProvider() }));
    }
    expect(outcomes.slice(0, 2)).toEqual([null, null]);
    expect(outcomes[2]?.launched && outcomes[2].status).toBe("merged");
  });

  test("compaction-event (default) fires only after a compaction", async () => {
    const { home, agent } = setup("agent-e");
    const store = new ConversationStore(agent.id, "c1", home);
    const provider = new MockProvider({ contextWindow: 1_200 });
    let fired = 0;
    let compacted = 0;
    for (let i = 0; i < 12; i++) {
      await runTurn({
        agent, provider, store, tools: FILE_TOOLS, home,
        userText: i === 0 ? "我更喜欢用 tabs 缩进" : `话题 ${i}：${"今天天气不错。".repeat(12)}`,
        onEvent: (e) => { if (e.type === "compaction") compacted++; },
      });
      const outcome = await maybeReflectAfterTurn({ home, agent, conversationId: "c1", provider });
      if (outcome) fired++;
    }
    expect(compacted).toBeGreaterThan(0);
    expect(fired).toBe(compacted);
  });
});
