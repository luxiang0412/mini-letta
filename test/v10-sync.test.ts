import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTurn } from "@/agent/loop";
import { MockProvider } from "@/llm/mock";
import { git } from "@/memory/git";
import { getMemoryDir } from "@/memory/memfs";
import { launchReflection } from "@/reflection/launcher";
import { loadOrCreateAgent } from "@/store/agent-store";
import { ConversationStore } from "@/store/conversation-store";
import { syncAfterTurn } from "@/sync/remote";
import { FILE_TOOLS } from "@/tools/file-tools";
import { tempHome } from "./helpers";

/** Two machines (homes) sharing one "server" of bare repos. */
function twoMachines() {
  const remoteRoot = mkdtempSync(join(tmpdir(), "mini-letta-remote-"));
  process.env.MINI_LETTA_REMOTE_ROOT = remoteRoot;
  return { remoteRoot, laptop: tempHome(), desktop: tempHome() };
}

async function say(home: string, text: string, conversation = "c1") {
  const agent = loadOrCreateAgent("agent-sync", home);
  const store = new ConversationStore(agent.id, conversation, home);
  return runTurn({ agent, provider: new MockProvider(), store, tools: FILE_TOOLS, home, userText: text });
}

describe("v1.0 memory travels between machines", () => {
  afterEach(() => {
    delete process.env.MINI_LETTA_REMOTE_ROOT;
  });

  test("laptop remembers → desktop knows", async () => {
    const { remoteRoot, laptop, desktop } = twoMachines();
    await say(laptop, "记住：我用 pnpm");
    expect(git(join(remoteRoot, "agent-sync.git"), ["log", "-1", "--format=%s", "main"]).stdout.trim()).toBe(
      "chore: remember user fact",
    );
    const answer = await say(desktop, "你知道我什么？");
    expect(answer.finalText).toContain("- 我用 pnpm");
  });

  test("concurrent edits to different files rebase cleanly", async () => {
    const { laptop, desktop } = twoMachines();
    await say(laptop, "hi");
    await say(desktop, "hi");
    await say(laptop, "记住：我用 pnpm");
    // desktop has not pulled yet: it commits on top of the old head
    const desktopDir = getMemoryDir("agent-sync", desktop);
    writeFileSync(join(desktopDir, "persona.md"), "---\nname: Persona\ndescription: Who I am.\n---\nTerse.\n");
    git(desktopDir, ["commit", "-qam", "feat: terse"]);
    expect(syncAfterTurn(desktopDir).status).toBe("pushed");
    expect(git(desktopDir, ["log", "--format=%s"]).stdout).toContain("chore: remember user fact");
  });

  test("conflicting edits: commits kept, rebase aborted, agent told", async () => {
    const { laptop, desktop } = twoMachines();
    await say(laptop, "记住：我用 pnpm");
    await say(desktop, "hi"); // desktop pulls: both machines now share one head
    const laptopDir = getMemoryDir("agent-sync", laptop);
    const desktopDir = getMemoryDir("agent-sync", desktop);
    // A real race: both rewrite the same line without pulling.
    for (const [dir, line] of [[laptopDir, "- 我用 bun"], [desktopDir, "- 我用 yarn"]] as const) {
      const path = join(dir, "human.md");
      writeFileSync(path, readFileSync(path, "utf8").replace("- 我用 pnpm", line));
      const commit = git(dir, ["commit", "-qam", `chore: ${line}`]);
      expect(commit.ok).toBe(true);
    }
    expect(syncAfterTurn(laptopDir).status).toBe("pushed");
    const result = syncAfterTurn(desktopDir);
    expect(result.status).toBe("conflict");
    expect(result.summary).toContain("human.md");
    // The rebase was aborted: a clean checkout, desktop's commit still on top.
    expect(git(desktopDir, ["status", "--porcelain"]).stdout).toBe("");
    expect(git(desktopDir, ["log", "-1", "--format=%s"]).stdout.trim()).toBe("chore: - 我用 yarn");
    // The next turn tells the agent.
    const store = new ConversationStore("agent-sync", "c1", desktop);
    await say(desktop, "继续");
    const turnMessage = store.all().find((m) => m.role === "user" && m.content.endsWith("继续"))?.content ?? "";
    expect(turnMessage).toContain("MEMORY GIT CONFLICT");
  });

  test("reflection merges on top of what other machines pushed", async () => {
    const { laptop, desktop } = twoMachines();
    await say(laptop, "我更喜欢用 tabs 缩进");
    await say(desktop, "记住：我用 pnpm"); // desktop pushes a newer head
    const agent = loadOrCreateAgent("agent-sync", laptop);
    const outcome = await launchReflection({ home: laptop, agent, conversationId: "c1", provider: new MockProvider() });
    expect(outcome.launched && outcome.status).toBe("merged");
    const human = readFileSync(join(getMemoryDir("agent-sync", laptop), "human.md"), "utf8");
    expect(human).toContain("- 我用 pnpm");
    expect(human).toContain("- 我更喜欢用 tabs 缩进");
    const desktopAnswer = await say(desktop, "你知道我什么？");
    expect(desktopAnswer.finalText).toContain("tabs");
  });
});
