import { MockProvider } from "./mock";
import { OpenAICompatibleProvider } from "./openai-compatible";
import type { LLMProvider } from "./types";

/**
 * MINI_LETTA_PROVIDER=mock (default) | openai
 * For Ollama: MINI_LETTA_PROVIDER=openai OPENAI_BASE_URL=http://localhost:11434/v1
 *             MINI_LETTA_MODEL=qwen2.5:3b
 */
export function createProvider(env: NodeJS.ProcessEnv = process.env): LLMProvider {
  const kind = env.MINI_LETTA_PROVIDER ?? "mock";
  const contextWindow = env.MINI_LETTA_CONTEXT_WINDOW
    ? Number(env.MINI_LETTA_CONTEXT_WINDOW)
    : undefined;
  if (kind === "mock") return new MockProvider({ contextWindow });
  if (kind === "openai") {
    return new OpenAICompatibleProvider({
      baseUrl: env.OPENAI_BASE_URL ?? "http://localhost:11434/v1",
      model: env.MINI_LETTA_MODEL ?? "qwen2.5:3b",
      apiKey: env.OPENAI_API_KEY,
      contextWindow,
    });
  }
  throw new Error(`Unknown MINI_LETTA_PROVIDER '${kind}'`);
}
