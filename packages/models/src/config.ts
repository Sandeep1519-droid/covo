import { OpenAICompatibleProvider } from "./openai-compatible.ts";
import type { ModelProvider } from "./types.ts";

// Phase 1 model settings come from environment variables, with free local Ollama as the default.
// A settings screen and the encrypted key vault replace this in Phase 2.
//
//   CW_MODEL_BASE_URL  default http://127.0.0.1:11434/v1  (Ollama)
//   CW_MODEL           default qwen3:4b
//   CW_MODEL_API_KEY   only needed for hosted services (OpenRouter, Gemini, …)

export const DEFAULT_BASE_URL = "http://127.0.0.1:11434/v1";
export const DEFAULT_MODEL = "qwen3:4b";

export interface ModelConfig {
  name: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export function modelConfig(env: Record<string, string | undefined> = process.env): ModelConfig {
  const baseUrl = env.CW_MODEL_BASE_URL || DEFAULT_BASE_URL;
  let name = "custom";
  try {
    const u = new URL(baseUrl);
    name = u.port === "11434" ? "ollama" : u.hostname.replace(/^api\./, "").split(".")[0] || "custom";
  } catch {
    // keep "custom"; the request will report the bad URL
  }
  return { name, baseUrl, model: env.CW_MODEL || DEFAULT_MODEL, apiKey: env.CW_MODEL_API_KEY || undefined };
}

export function providerFromConfig(c: ModelConfig): ModelProvider {
  return new OpenAICompatibleProvider(c);
}
