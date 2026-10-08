import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "@/memory/git";
import { getMemoryDir } from "@/memory/memfs";
import { startPalace } from "@/palace/server";
import { createAgent } from "@/store/agent-store";
import { tempHome } from "./helpers";

describe("v1.0 Memory Palace", () => {
  test("classifies files and serves read-only JSON", async () => {
    const home = tempHome();
    createAgent({ id: "agent-p" }, home);
    const dir = getMemoryDir("agent-p", home);
    mkdirSync(join(dir, "projects"));
    writeFileSync(join(dir, "projects", "MEMORY.md"), "# Projects\n");
    writeFileSync(join(dir, "projects", "a.md"), "---\nname: A\ndescription: Project A\n---\nbody\n");
    git(dir, ["add", "projects"]);
    expect(git(dir, ["commit", "-qm", "feat: projects"]).ok).toBe(true);

    const server = startPalace({ home, port: 0 });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const tree = (await (await fetch(`${base}/api/agents/agent-p/tree`)).json()) as {
        files: Array<{ path: string; kind: string }>;
      };
      const kinds = Object.fromEntries(tree.files.map((f) => [f.path, f.kind]));
      expect(kinds).toEqual({
        "MEMORY.md": "index",
        "human.md": "core",
        "persona.md": "core",
        "projects/MEMORY.md": "index",
        "projects/a.md": "deferred",
      });
      const history = (await (await fetch(`${base}/api/agents/agent-p/history`)).json()) as Array<{ subject: string }>;
      expect(history.map((c) => c.subject)).toEqual(["feat: projects", "chore: initialize local memory"]);
      expect((await fetch(`${base}/api/agents/agent-p/tree`, { method: "POST" })).status).toBe(405);
      expect((await fetch(`${base}/api/agents/agent-p/commit?sha=;rm`)).status).toBe(404);
    } finally {
      server.stop(true);
    }
  });
});
