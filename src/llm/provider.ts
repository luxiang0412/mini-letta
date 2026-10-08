import { MockProvider } from "./mock";
import { OpenAICompatibleProvider } from "./openai-compatible";
import type { LLMProvider } from "./types";

/**
 * MINI_LETTA_PROVIDER=mock (default) | openai
 * For Ollama: MINI_LETTA_PROVIDER=openai OPENAI_BASE_URL=http://localhost:11434/v1
 *             MINI_LETTA_MODEL=qwen2.5:3b
 */
export function createProvider(
  env: NodeJS.ProcessEnv = process.env,
  options: { role?: "primary" | "reflection" } = {},
): LLMProvider {
  const kind = env.MINI_LETTA_PROVIDER ?? "mock";
  // Reflection reads whole transcripts; in a tiny shared window it compacts
  // away what it just read and loops (chapter 15). Let it have its own window.
  const windowSetting =
    (options.role === "reflection" ? env.MINI_LETTA_REFLECTION_CONTEXT_WINDOW : undefined) ??
    env.MINI_LETTA_CONTEXT_WINDOW;
  const contextWindow = windowSetting ? Number(windowSetting) : undefined;
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
