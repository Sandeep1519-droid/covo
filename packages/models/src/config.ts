import { DEFAULT_CONTEXT, OllamaProvider } from "./ollama.ts";
import { OpenAICompatibleProvider } from "./openai-compatible.ts";
import type { ModelProvider } from "./types.ts";

// Phase 1 model settings come from environment variables, with free local Ollama as the default.
// A settings screen and the encrypted key vault replace this in Phase 2.
//
//   CW_MODEL_BASE_URL  default http://127.0.0.1:11434/v1  (Ollama)
//   CW_MODEL           default qwen3.5:4b
//   CW_MODEL_API_KEY   only needed for hosted services (OpenRouter, Gemini, …)
//   CW_MODEL_CONTEXT   Ollama context window in tokens, default 8192
//   CW_MODEL_THINK     "on" lets thinking models think (slower); default off

export const DEFAULT_BASE_URL = "http://127.0.0.1:11434/v1";
/** Fast, reliable tool calls on an 8 GB Mac with thinking off (measured: one edit in ~30 s). */
export const DEFAULT_MODEL = "qwen3.5:4b";

export interface ModelConfig {
  name: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** Ollama only. */
  numCtx?: number;
  think?: boolean;
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
  const c: ModelConfig = {
    name,
    baseUrl,
    model: env.CW_MODEL || DEFAULT_MODEL,
    apiKey: env.CW_MODEL_API_KEY || undefined,
  };
  if (name === "ollama") {
    const n = Number(env.CW_MODEL_CONTEXT);
    c.numCtx = Number.isInteger(n) && n >= 2048 ? n : DEFAULT_CONTEXT;
    c.think = /^(on|1|true|yes)$/i.test(env.CW_MODEL_THINK ?? "");
  }
  return c;
}

export function providerFromConfig(c: ModelConfig): ModelProvider {
  if (c.name === "ollama") {
    return new OllamaProvider({ baseUrl: c.baseUrl, model: c.model, numCtx: c.numCtx, think: c.think });
  }
  return new OpenAICompatibleProvider(c);
}
