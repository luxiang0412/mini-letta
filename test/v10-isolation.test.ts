import { afterEach, describe, expect, test } from "bun:test";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crossAgentProfile, reflectionProfile } from "@/agent/sandbox-profiles";
import { getMemoryDir } from "@/memory/memfs";
import { buildBwrapArgs, isBwrapAvailable } from "@/sandbox/policy";
import { createAgent } from "@/store/agent-store";
import { agentDir } from "@/store/paths";
import { bashTool, readFileTool } from "@/tools/file-tools";
import { memoryEnv, type ToolContext } from "@/tools/types";
import { tempHome } from "./helpers";

function twoAgents() {
  const home = tempHome();
  const alice = createAgent({ id: "agent-alice", blocks: [{ label: "human", value: "alice's secret" }] }, home);
  const bob = createAgent({ id: "agent-bob", blocks: [{ label: "human", value: "bob's secret" }] }, home);
  const ctx = (sandbox?: ToolContext["sandbox"]): ToolContext => ({
    agent: alice,
    home,
    conversationId: "c",
    memoryDir: getMemoryDir(alice.id, home),
    env: memoryEnv(alice, getMemoryDir(alice.id, home)),
    sandbox,
  });
  return { home, alice, bob, ctx, bobHuman: join(getMemoryDir(bob.id, home), "human.md") };
}

const bwrapTest = isBwrapAvailable() ? test : test.skip;

describe("v1.0 in-process guard (file tools)", () => {
  test("own memory readable, another agent's denied", async () => {
    const { ctx, bobHuman, home, alice } = twoAgents();
    expect(await readFileTool.run({ path: join(getMemoryDir(alice.id, home), "human.md") }, ctx())).toContain("alice's secret");
    await expect(readFileTool.run({ path: bobHuman }, ctx())).rejects.toThrow("belongs to agent 'agent-bob'");
  });

  test("a symlink inside my own tree cannot escape into another agent's", async () => {
    const { ctx, bobHuman, home, alice } = twoAgents();
    const link = join(agentDir(alice.id, home), "innocent.md");
    symlinkSync(bobHuman, link);
    await expect(readFileTool.run({ path: link }, ctx())).rejects.toThrow("belongs to agent 'agent-bob'");
  });

  test("a reflection subagent acts for its parent", async () => {
    const { ctx, home, alice } = twoAgents();
    const c = { ...ctx(), agent: { ...alice, id: "agent-alice~reflection" } };
    expect(await readFileTool.run({ path: join(getMemoryDir(alice.id, home), "human.md") }, c)).toContain("alice");
  });
});

describe("v1.0 kernel sandbox (bash)", () => {
  afterEach(() => {
    delete process.env.MINI_LETTA_FS_SANDBOX;
  });

  test("bwrap args follow the mount order", () => {
    expect(buildBwrapArgs({ restrictWrites: true, deniedRoots: ["/d"], readonlyRoots: ["/r"], writableRoots: ["/w"] })).toEqual([
      "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc",
      "--tmpfs", "/d", "--ro-bind-try", "/r", "/r", "--bind-try", "/w", "/w", "--die-with-parent",
    ]);
  });

  bwrapTest("unconfined shell can read another agent's memory (the default trade-off)", async () => {
    const { ctx, bobHuman } = twoAgents();
    expect(await bashTool.run({ command: `cat ${bobHuman}` }, ctx())).toContain("bob's secret");
  });

  bwrapTest("cross-agent profile: other agents are absent, own memory works", async () => {
    const { ctx, bobHuman, home, alice } = twoAgents();
    const c = ctx(crossAgentProfile(home, alice.id));
    await expect(bashTool.run({ command: `cat ${bobHuman}` }, c)).rejects.toThrow("No such file or directory");
    expect(await bashTool.run({ command: `ls ${join(home, "agents")}` }, c)).toBe("agent-alice");
    expect(await bashTool.run({ command: 'cd "$MEMORY_DIR" && git log --oneline | wc -l' }, c)).toBe("1");
    expect(await bashTool.run({ command: "touch /tmp/mini-letta-sandbox-probe && echo ok" }, c)).toBe("ok");
  });

  bwrapTest("reflection profile: read-only everywhere except its worktree", async () => {
    const { ctx, home, alice } = twoAgents();
    const payloadDir = join(agentDir(alice.id, home), "reflections", "payloads");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(payloadDir, { recursive: true });
    writeFileSync(join(payloadDir, "payload-1.json"), "[]");
    const worktreeDir = getMemoryDir(alice.id, home); // stand-in writable root
    const c = ctx(reflectionProfile({ home, parentAgentId: alice.id, worktreeDir, payloadPath: join(payloadDir, "payload-1.json") }));
    expect(await bashTool.run({ command: `cat ${join(payloadDir, "payload-1.json")}` }, c)).toBe("[]");
    await expect(bashTool.run({ command: `echo x > ${join(payloadDir, "evil.json")}` }, c)).rejects.toThrow("Read-only file system");
    await expect(bashTool.run({ command: "touch /tmp/mini-letta-reflection-probe" }, c)).rejects.toThrow("Read-only file system");
    expect(await bashTool.run({ command: `touch ${join(worktreeDir, "ok.txt")} && echo ok` }, c)).toBe("ok");
  });
});
