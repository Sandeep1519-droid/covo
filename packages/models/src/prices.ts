import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// What a model costs, in US dollars per million tokens. Covo ships prices only for models whose
// prices it knows from the provider's own published list, with the date they were checked. Any
// other cloud model is charged at a cautious estimate (marked "estimated") until you set its real
// price, so a spending limit can't be slipped past by an unknown model. Local models are free.
//
// Your own prices go in ~/Covo/prices.json: { "model-name": { "in": 0.5, "out": 1.5 } }

export interface Price {
  /** $ per million input tokens. */
  in: number;
  /** $ per million output tokens. */
  out: number;
}

export interface PriceLookup extends Price {
  source: "built-in" | "yours" | "local" | "estimate";
}

/** When the built-in prices were last checked. */
export const PRICES_AS_OF = "2026-11-03";

/** Anthropic's first-party API prices. */
const BUILT_IN: Record<string, Price> = {
  "claude-fable-5-2": { in: 8, out: 40 },
  "claude-fable-5-1": { in: 10, out: 50 },
  "claude-fable-5": { in: 10, out: 50 },
  "claude-opus-5-5": { in: 4, out: 20 },
  "claude-opus-5": { in: 5, out: 25 },
  "claude-opus-4-8": { in: 5, out: 25 },
  "claude-opus-4-7": { in: 5, out: 25 },
  "claude-opus-4-6": { in: 5, out: 25 },
  "claude-sonnet-5-5": { in: 2, out: 10 },
  "claude-sonnet-5": { in: 2, out: 10 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-haiku-5-5": { in: 0.1, out: 0.5 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};

/** Used for cloud models without a known price: on the high side, so limits stay safe. */
export const CAUTIOUS_ESTIMATE: Price = { in: 5, out: 25 };

const LOCAL_PROVIDERS = new Set(["ollama", "lmstudio", "mock"]);

export const pricesPath = (home: string) => join(home, "prices.json");

export function loadUserPrices(home: string): Record<string, Price> {
  const p = pricesPath(home);
  if (!existsSync(p)) return {};
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Record<string, Price>;
    const out: Record<string, Price> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v && Number.isFinite(v.in) && Number.isFinite(v.out) && v.in >= 0 && v.out >= 0) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * The price for a provider id like "anthropic:claude-opus-5-5" or "openrouter:x/y:free".
 * Your prices win; then built-in; local models cost nothing; anything else is a cautious estimate.
 * Models marked ":free" (OpenRouter's free models) cost nothing.
 */
export function priceFor(providerId: string, user: Record<string, Price> = {}): PriceLookup {
  const i = providerId.indexOf(":");
  const provider = i < 0 ? providerId : providerId.slice(0, i);
  const model = i < 0 ? providerId : providerId.slice(i + 1);
  const mine = user[model] ?? user[providerId];
  if (mine) return { ...mine, source: "yours" };
  if (LOCAL_PROVIDERS.has(provider)) return { in: 0, out: 0, source: "local" };
  const known = BUILT_IN[model];
  if (known) return { ...known, source: "built-in" };
  if (model.endsWith(":free")) return { in: 0, out: 0, source: "built-in" };
  return { ...CAUTIOUS_ESTIMATE, source: "estimate" };
}

export function costOf(p: Price, tokensIn: number, tokensOut: number): number {
  return (tokensIn * p.in + tokensOut * p.out) / 1_000_000;
}
