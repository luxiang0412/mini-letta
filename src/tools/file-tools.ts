import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { assertNotOtherAgentsMemory, wrapCommand } from "@/sandbox/policy";
import { stringArg, type Tool, type ToolContext } from "./types";

const MAX_OUTPUT = 4_000;

function truncate(text: string): string {
  return text.length <= MAX_OUTPUT ? text : `${text.slice(0, MAX_OUTPUT)}\n…[truncated ${text.length - MAX_OUTPUT} chars]`;
}

function absolutePath(path: string, ctx: ToolContext): string {
  // Like letta-code's file tools: paths are literal, `$MEMORY_DIR` is NOT expanded.
  if (!isAbsolute(path)) throw new Error(`Path must be absolute: ${path}`);
  assertNotOtherAgentsMemory(path, join(ctx.home, "agents"), ctx.agent.id);
  return path;
}

export const bashTool: Tool = {
  schema: {
    name: "bash",
    description:
      "Run a bash command. $MEMORY_DIR, $AGENT_ID and $AGENT_NAME are set. Use it for git in the memory repo.",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  async run(args, ctx) {
    const [binary, argv] = wrapCommand(ctx.sandbox, stringArg(args, "command"));
    const result = spawnSync(binary, argv, {
      encoding: "utf8",
      env: { ...process.env, ...ctx.env },
      timeout: 30_000,
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    if (result.status !== 0) {
      throw new Error(`exit ${result.status ?? "signal"}\n${truncate(output)}`);
    }
    return truncate(output) || "(no output)";
  },
};

export const readFileTool: Tool = {
  schema: {
    name: "read_file",
    description: "Read a UTF-8 text file by absolute path.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  async run(args, ctx) {
    return truncate(readFileSync(absolutePath(stringArg(args, "path"), ctx), "utf8"));
  },
};

export const writeFileTool: Tool = {
  schema: {
    name: "write_file",
    description: "Create or overwrite a file by absolute path.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  async run(args, ctx) {
    const path = absolutePath(stringArg(args, "path"), ctx);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, stringArg(args, "content"));
    return `Wrote ${path}`;
  },
};

export const editFileTool: Tool = {
  schema: {
    name: "edit_file",
    description: "Replace one exact occurrence of old_text with new_text in a file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_text: { type: "string" },
        new_text: { type: "string" },
      },
      required: ["path", "old_text", "new_text"],
    },
  },
  async run(args, ctx) {
    const path = absolutePath(stringArg(args, "path"), ctx);
    const before = readFileSync(path, "utf8");
    const oldText = stringArg(args, "old_text");
    const count = before.split(oldText).length - 1;
    if (count !== 1) throw new Error(`old_text must match exactly once (matched ${count})`);
    writeFileSync(path, before.replace(oldText, stringArg(args, "new_text")));
    return `Edited ${path}`;
  },
};

export const FILE_TOOLS: Tool[] = [bashTool, readFileTool, writeFileTool, editFileTool];
