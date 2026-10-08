import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newId } from "@/llm/types";
import { agentAuthor, getMemoryDir, initialMemoryFiles, initMemoryRepo } from "@/memory/memfs";
import { agentDir, getHome } from "./paths";

/** A labelled piece of starter memory; becomes a root core file in MemFS. */
export interface MemoryBlock {
  label: string;
  value: string;
  description?: string;
}

export interface AgentRecord {
  id: string;
  name: string;
  /** Raw system prompt; `{CORE_MEMORY}` marks where memory is compiled in. */
  system: string;
  createdAt: string;
}

export interface CreateAgentInput {
  name?: string;
  system?: string;
  blocks?: MemoryBlock[];
  id?: string;
}

export const DEFAULT_SYSTEM_PROMPT = `You are mini-letta, a stateful agent with persistent memory.

Your memory is a git repository of Markdown files at $MEMORY_DIR. Root .md files
are core memory and are compiled into this prompt; root MEMORY.md is the index.
Every other memory file has exactly \`name\` and \`description\` frontmatter.
When the user tells you something durable or corrects you, edit the right file,
then commit only the files you changed:
  cd "$MEMORY_DIR" && git add <file> && git commit -m "<type>: <what>" -- <file>
Edits take effect only after they are committed.

{CORE_MEMORY}`;

export const DEFAULT_BLOCKS: MemoryBlock[] = [
  {
    label: "persona",
    description: "Who I am and how I behave.",
    value: "I am mini-letta, a helpful assistant that remembers.",
  },
  {
    label: "human",
    description: "What I know about the user.",
    value: "",
  },
];

function agentFile(agentId: string, home: string): string {
  return join(agentDir(agentId, home), "agent.json");
}

export function createAgent(
  input: CreateAgentInput = {},
  home = getHome(),
): AgentRecord {
  const agent: AgentRecord = {
    id: input.id ?? newId("agent"),
    name: input.name ?? "mini-letta",
    system: input.system ?? DEFAULT_SYSTEM_PROMPT,
    createdAt: new Date().toISOString(),
  };
  saveAgent(agent, home);
  initMemoryRepo({
    memoryDir: getMemoryDir(agent.id, home),
    author: agentAuthor(agent.id, agent.name),
    files: initialMemoryFiles(input.blocks ?? DEFAULT_BLOCKS),
  });
  return agent;
}

export function saveAgent(agent: AgentRecord, home = getHome()): void {
  mkdirSync(agentDir(agent.id, home), { recursive: true });
  writeFileSync(agentFile(agent.id, home), `${JSON.stringify(agent, null, 2)}\n`);
}

export function loadAgent(agentId: string, home = getHome()): AgentRecord {
  const file = agentFile(agentId, home);
  if (!existsSync(file)) throw new Error(`Unknown agent: ${agentId}`);
  return JSON.parse(readFileSync(file, "utf8")) as AgentRecord;
}

export function listAgents(home = getHome()): AgentRecord[] {
  const root = join(home, "agents");
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((id) => existsSync(agentFile(id, home)))
    .map((id) => loadAgent(id, home));
}

/** Load the agent, creating it with defaults on first use. */
export function loadOrCreateAgent(agentId: string, home = getHome()): AgentRecord {
  return existsSync(agentFile(agentId, home))
    ? loadAgent(agentId, home)
    : createAgent({ id: agentId }, home);
}
