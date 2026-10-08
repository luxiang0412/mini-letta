import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Storage root. Mirrors letta-code's LETTA_LOCAL_BACKEND_DIR: tests and demos
 * point MINI_LETTA_HOME at a temp dir so they never touch real state.
 */
export function getHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.MINI_LETTA_HOME || join(homedir(), ".mini-letta");
}

export function agentDir(agentId: string, home = getHome()): string {
  return join(home, "agents", agentId);
}

export function conversationsDir(agentId: string, home = getHome()): string {
  return join(agentDir(agentId, home), "conversations");
}
