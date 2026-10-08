import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newId } from "@/llm/types";
import { agentDir, getHome } from "./paths";

/** A labelled, always-in-context piece of memory (MemGPT "core memory"). */
export interface MemoryBlock {
  label: string;
  value: string;
  description?: string;
  readOnly?: boolean;
}

export interface AgentRecord {
  id: string;
  name: string;
  /** Raw system prompt; `{CORE_MEMORY}` marks where memory is compiled in. */
  system: string;
  blocks: MemoryBlock[];
  createdAt: string;
}

export interface CreateAgentInput {
  name?: string;
  system?: string;
  blocks?: MemoryBlock[];
  id?: string;
}

export const DEFAULT_SYSTEM_PROMPT = `You are mini-letta, a stateful agent with persistent memory.
Your memory is compiled into this prompt below. Keep it accurate: when the user
tells you something durable about themselves or corrects you, update memory.

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
    value: "(nothing yet)",
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
    blocks: structuredClone(input.blocks ?? DEFAULT_BLOCKS),
    createdAt: new Date().toISOString(),
  };
  saveAgent(agent, home);
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
