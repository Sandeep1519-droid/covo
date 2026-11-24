// Ready-made settings for the AI services people already use. A preset says how to reach the
// service and where its key comes from. Model names for most services are read from the service
// itself when you add it (covo models add, M1), so this list doesn't go stale; only Anthropic's
// current models are listed because Covo talks to Anthropic natively.

/** "openai-responses": OpenAI's Responses API, used for your ChatGPT plan (Phase 4 M1). */
export type ProviderKind = "anthropic" | "openai-compatible" | "ollama" | "openai-responses";

export interface Preset {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  /** Environment variables checked for a key, in order (COVO_MODEL_API_KEY always wins). */
  keyEnv: string[];
  /** Where to create a key. */
  keyUrl?: string;
  /** Suggested models, best first. Empty means "ask the service". */
  models: string[];
  /** Runs on this computer; no key, no cost. */
  local?: boolean;
  /** A short note shown in setup, e.g. about a free tier. */
  note?: string;
}

export const PRESETS: Preset[] = [
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com",
    keyEnv: ["ANTHROPIC_API_KEY"],
    keyUrl: "https://platform.claude.com",
    models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
  },
  {
    id: "openai",
    label: "OpenAI (GPT)",
    kind: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    keyEnv: ["OPENAI_API_KEY"],
    keyUrl: "https://platform.openai.com/api-keys",
    models: [],
  },
  {
    id: "gemini",
    label: "Google Gemini",
    kind: "openai-compatible",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    keyUrl: "https://aistudio.google.com/apikey",
    models: [],
    note: "Has a free tier with daily limits.",
  },
  {
    id: "xai",
    label: "xAI (Grok)",
    kind: "openai-compatible",
    baseUrl: "https://api.x.ai/v1",
    keyEnv: ["XAI_API_KEY"],
    keyUrl: "https://console.x.ai",
    models: [],
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    kind: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    keyEnv: ["DEEPSEEK_API_KEY"],
    keyUrl: "https://platform.deepseek.com/api_keys",
    models: [],
  },
  {
    id: "mistral",
    label: "Mistral",
    kind: "openai-compatible",
    baseUrl: "https://api.mistral.ai/v1",
    keyEnv: ["MISTRAL_API_KEY"],
    keyUrl: "https://console.mistral.ai/api-keys",
    models: [],
  },
  {
    id: "groq",
    label: "Groq",
    kind: "openai-compatible",
    baseUrl: "https://api.groq.com/openai/v1",
    keyEnv: ["GROQ_API_KEY"],
    keyUrl: "https://console.groq.com/keys",
    models: [],
    note: "Fast, with a free tier.",
  },
  {
    id: "openrouter",
    label: "OpenRouter (hundreds of models with one key)",
    kind: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    keyEnv: ["OPENROUTER_API_KEY"],
    keyUrl: "https://openrouter.ai/keys",
    models: [],
    note: "Includes free models (their names end in :free).",
  },
  {
    id: "cerebras",
    label: "Cerebras",
    kind: "openai-compatible",
    baseUrl: "https://api.cerebras.ai/v1",
    keyEnv: ["CEREBRAS_API_KEY"],
    keyUrl: "https://cloud.cerebras.ai",
    models: [],
    note: "Very fast open models, with a free tier.",
  },
  {
    id: "together",
    label: "Together AI",
    kind: "openai-compatible",
    baseUrl: "https://api.together.xyz/v1",
    keyEnv: ["TOGETHER_API_KEY"],
    keyUrl: "https://api.together.ai/settings/api-keys",
    models: [],
    note: "Open models such as Llama, Qwen and DeepSeek.",
  },
  {
    id: "fireworks",
    label: "Fireworks AI",
    kind: "openai-compatible",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    keyEnv: ["FIREWORKS_API_KEY"],
    keyUrl: "https://fireworks.ai/account/api-keys",
    models: [],
  },
  {
    id: "huggingface",
    label: "Hugging Face",
    kind: "openai-compatible",
    baseUrl: "https://router.huggingface.co/v1",
    keyEnv: ["HF_TOKEN", "HUGGINGFACE_API_KEY"],
    keyUrl: "https://huggingface.co/settings/tokens",
    models: [],
    note: "Many open models through one token, with free monthly credits.",
  },
  {
    id: "nvidia",
    label: "NVIDIA NIM",
    kind: "openai-compatible",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    keyEnv: ["NVIDIA_API_KEY"],
    keyUrl: "https://build.nvidia.com",
    models: [],
    note: "Free credits to start.",
  },
  {
    id: "moonshot",
    label: "Moonshot (Kimi)",
    kind: "openai-compatible",
    baseUrl: "https://api.moonshot.ai/v1",
    keyEnv: ["MOONSHOT_API_KEY"],
    keyUrl: "https://platform.moonshot.ai/console/api-keys",
    models: [],
  },
  {
    id: "qwen",
    label: "Alibaba Qwen (Model Studio)",
    kind: "openai-compatible",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    keyEnv: ["DASHSCOPE_API_KEY"],
    keyUrl: "https://modelstudio.console.alibabacloud.com",
    models: [],
  },
  {
    id: "sambanova",
    label: "SambaNova",
    kind: "openai-compatible",
    baseUrl: "https://api.sambanova.ai/v1",
    keyEnv: ["SAMBANOVA_API_KEY"],
    keyUrl: "https://cloud.sambanova.ai/apis",
    models: [],
  },
  {
    id: "ollama",
    label: "Ollama (free, on this Mac)",
    kind: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    keyEnv: [],
    models: ["qwen3.5:4b"],
    local: true,
  },
  {
    id: "lmstudio",
    label: "LM Studio (free, on this Mac)",
    kind: "openai-compatible",
    baseUrl: "http://127.0.0.1:1234/v1",
    keyEnv: [],
    models: [],
    local: true,
  },
];

export function presetById(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}

/** Recognises a preset from a base URL, e.g. one set with COVO_MODEL_BASE_URL. */
export function presetForUrl(baseUrl: string): Preset | undefined {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    return undefined;
  }
  return PRESETS.find((p) => {
    const q = new URL(p.baseUrl);
    return (
      q.host === u.host || (p.local === true && q.port === u.port && /^(127\.0\.0\.1|localhost)$/.test(u.hostname))
    );
  });
}
