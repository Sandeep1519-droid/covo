import { AnthropicProvider } from "./anthropic.ts";
import { DEFAULT_CONTEXT, OllamaProvider } from "./ollama.ts";
import { OpenAICompatibleProvider } from "./openai-compatible.ts";
import { type Preset, type ProviderKind, presetById, presetForUrl } from "./presets.ts";
import { ResponsesProvider } from "./responses.ts";
import type { ModelProvider } from "./types.ts";

// Phase 2 M0: model settings come from environment variables and the provider presets. M1 replaces
// this with `covo models add` and keys in the macOS Keychain.
//
//   COVO_PROVIDER       a preset: anthropic, openai, gemini, xai, deepseek, mistral, groq,
//                       openrouter, ollama (default), lmstudio
//   COVO_MODEL          model name (default: the preset's first suggestion, qwen3.5:4b for Ollama)
//   COVO_MODEL_API_KEY  key (otherwise the provider's usual variable, e.g. ANTHROPIC_API_KEY)
//   COVO_MODEL_BASE_URL any other OpenAI-compatible service, or a proxy
//   COVO_MODEL_CONTEXT  Ollama context window in tokens, default 8192
//   COVO_MODEL_THINK    "on" lets local thinking models think (slower); default off

export const DEFAULT_PROVIDER = "ollama";
/** Fast, reliable tool calls on an 8 GB Mac with thinking off (measured: one edit in ~30 s). */
export const DEFAULT_MODEL = "qwen3.5:4b";

export class ModelConfigError extends Error {}

export interface ModelConfig {
  /** Preset id, or "custom". */
  name: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** Where the key came from, for messages (never the key itself). */
  keySource?: string;
  local: boolean;
  /** Ollama only. */
  numCtx?: number;
  think?: boolean;
  /** How long Ollama keeps the model loaded, e.g. "60s". */
  keepAlive?: string;
  /** Your ChatGPT plan (openai-responses): a fresh access token for each request. */
  token?: () => Promise<string>;
  /** Set when a subscription pays, not per use: "chatgpt" or an engine id. */
  subscription?: string;
}

type Env = Record<string, string | undefined>;

/** With `requireModel: false`, a missing model name is allowed (the doctor then lists them). */
export function modelConfig(env: Env = process.env, opts: { requireModel?: boolean } = {}): ModelConfig {
  let preset: Preset | undefined;
  if (env.COVO_PROVIDER) {
    preset = presetById(env.COVO_PROVIDER.toLowerCase());
    if (!preset) {
      throw new ModelConfigError(
        `Unknown provider "${env.COVO_PROVIDER}". Choose one of: anthropic, openai, gemini, xai, deepseek, mistral, groq, openrouter, ollama, lmstudio.`,
      );
    }
  } else if (env.COVO_MODEL_BASE_URL) {
    preset = presetForUrl(env.COVO_MODEL_BASE_URL);
  } else {
    preset = presetById(DEFAULT_PROVIDER);
  }

  const baseUrl = env.COVO_MODEL_BASE_URL || preset?.baseUrl;
  if (!baseUrl) throw new ModelConfigError("Set COVO_PROVIDER or COVO_MODEL_BASE_URL.");
  const model = env.COVO_MODEL || preset?.models[0] || "";
  if (!model && opts.requireModel !== false) {
    throw new ModelConfigError(
      `Choose a ${preset?.label ?? "model"} model with COVO_MODEL=<name>. List them with: covo doctor models`,
    );
  }

  let apiKey: string | undefined;
  let keySource: string | undefined;
  for (const v of ["COVO_MODEL_API_KEY", ...(preset?.keyEnv ?? [])]) {
    if (env[v]) {
      apiKey = env[v];
      keySource = v;
      break;
    }
  }

  const c: ModelConfig = {
    name: preset?.id ?? "custom",
    label: preset?.label ?? new URL(baseUrl).host,
    kind: preset?.kind ?? "openai-compatible",
    baseUrl,
    model,
    local: preset ? preset.local === true : /^(127\.0\.0\.1|localhost|\[::1\])$/.test(new URL(baseUrl).hostname),
    ...(apiKey ? { apiKey, keySource } : {}),
  };
  if (c.kind === "ollama") {
    const n = Number(env.COVO_MODEL_CONTEXT);
    c.numCtx = Number.isInteger(n) && n >= 2048 ? n : DEFAULT_CONTEXT;
    c.think = /^(on|1|true|yes)$/i.test(env.COVO_MODEL_THINK ?? "");
    if (env.COVO_MODEL_KEEP_ALIVE && /^\d+[smh]?$/.test(env.COVO_MODEL_KEEP_ALIVE))
      c.keepAlive = env.COVO_MODEL_KEEP_ALIVE;
  }
  return c;
}

/** Needs a key but has none: says where to put one. */
export function missingKey(c: ModelConfig): string | undefined {
  if (c.local || c.apiKey) return undefined;
  const preset = presetById(c.name);
  const vars = ["COVO_MODEL_API_KEY", ...(preset?.keyEnv ?? [])].join(" or ");
  return `No API key for ${c.label}. Set ${vars}${preset?.keyUrl ? ` (get one at ${preset.keyUrl})` : ""}.`;
}

export function providerFromConfig(c: ModelConfig): ModelProvider {
  if (c.kind === "openai-responses") {
    if (!c.token)
      throw new ModelConfigError("Sign in with ChatGPT first: Settings → AI models, or covo models add chatgpt.");
    return new ResponsesProvider({ name: c.name, baseUrl: c.baseUrl, model: c.model, token: c.token });
  }
  if (c.kind === "anthropic") {
    if (!c.apiKey) throw new ModelConfigError(missingKey(c));
    const official = c.baseUrl.replace(/\/+$/, "") === "https://api.anthropic.com";
    return new AnthropicProvider({ apiKey: c.apiKey, model: c.model, ...(official ? {} : { baseUrl: c.baseUrl }) });
  }
  if (c.kind === "ollama") {
    return new OllamaProvider({
      baseUrl: c.baseUrl,
      model: c.model,
      numCtx: c.numCtx,
      think: c.think,
      ...(c.keepAlive ? { keepAlive: c.keepAlive } : {}),
    });
  }
  return new OpenAICompatibleProvider({ name: c.name, baseUrl: c.baseUrl, model: c.model, apiKey: c.apiKey });
}
