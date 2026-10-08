import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_MEMORY_CONSTRAINTS,
  globToRegExp,
  MEMORY_CONSTRAINTS_CONFIG_PATH,
  MEMORY_CONSTRAINTS_UPDATE_ENV,
  validateMemoryTree,
} from "./constraints";
import { isProjectedMemoryPath } from "./format";
import { validateMemoryFile } from "./frontmatter";

export const VALIDATOR_NAME = "mini-letta-validate.js";

/**
 * The validator runs inside the memory repo on every `git commit`, including
 * commits the agent makes through its bash tool. Like letta-code's
 * buildPreCommitHookScript (src/agent/memory-git-hooks.ts) it embeds the
 * validators' source, so it depends on nothing but a JS runtime and git.
 */
export function buildValidatorScript(): string {
  return `// Installed by mini-letta. Validates the staged memory tree.
const { execFileSync } = require("node:child_process");
const validateMemoryFile = ${validateMemoryFile.toString()};
const isProjectedMemoryPath = ${isProjectedMemoryPath.toString()};
const globToRegExp = ${globToRegExp.toString()};
const validateMemoryTree = ${validateMemoryTree.toString()};
const DEFAULT_CONFIG = ${JSON.stringify(DEFAULT_MEMORY_CONSTRAINTS)};
const CONFIG_PATH = ${JSON.stringify(MEMORY_CONSTRAINTS_CONFIG_PATH)};
const UPDATE_ENV = ${JSON.stringify(MEMORY_CONSTRAINTS_UPDATE_ENV)};

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: Infinity });
const tryGit = (...args) => { try { return git(...args); } catch { return null; } };
const normalizeMemoryPath = (p) => p.replace(/\\\\/g, "/");

const staged = git("ls-files", "-z").split("\\0").filter(Boolean)
  .map((path) => ({ path, content: git("show", ":" + path) }));
const hasHead = tryGit("rev-parse", "--verify", "HEAD") !== null;
const accepted = hasHead
  ? git("ls-tree", "-r", "-z", "--name-only", "HEAD").split("\\0").filter(Boolean)
      .map((path) => ({ path, content: git("show", "HEAD:" + path) }))
  : [];

const errors = [];
const allPaths = new Set(staged.map((f) => f.path));
for (const file of staged) {
  if (!file.path.endsWith(".md") || !isProjectedMemoryPath(file.path, allPaths)) continue;
  errors.push(...validateMemoryFile(file.path, file.content));
}

// The policy file is trusted only from HEAD; changing it needs a human.
const acceptedConfig = accepted.find((f) => f.path === CONFIG_PATH);
const stagedConfig = staged.find((f) => f.path === CONFIG_PATH);
if ((acceptedConfig?.content ?? null) !== (stagedConfig?.content ?? null) && process.env[UPDATE_ENV] !== "1") {
  errors.push(CONFIG_PATH + " is protected and requires human approval to change");
}
let config = DEFAULT_CONFIG;
const configSource = process.env[UPDATE_ENV] === "1" ? stagedConfig : acceptedConfig;
if (configSource) {
  try { config = { ...DEFAULT_CONFIG, ...JSON.parse(configSource.content) }; }
  catch { errors.push(CONFIG_PATH + ": invalid JSON"); }
}
errors.push(...validateMemoryTree(staged, accepted, config));

if (errors.length) {
  console.error("Memory validation failed:");
  for (const error of errors) console.error("  " + error);
  process.exit(1);
}
`;
}

export function buildPreCommitHook(runtimePath = process.execPath): string {
  return `#!/usr/bin/env bash
# Installed by mini-letta
exec '${runtimePath.replaceAll("'", `'"'"'`)}' "$(git rev-parse --git-common-dir)/hooks/${VALIDATOR_NAME}"
`;
}

export function installMemoryHooks(memoryDir: string): void {
  const hooksDir = join(memoryDir, ".git", "hooks");
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(join(hooksDir, VALIDATOR_NAME), buildValidatorScript());
  const hookPath = join(hooksDir, "pre-commit");
  writeFileSync(hookPath, buildPreCommitHook());
  chmodSync(hookPath, 0o755);
}
