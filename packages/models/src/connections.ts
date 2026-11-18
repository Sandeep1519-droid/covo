import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SecretStore } from "@covo/platform";
import { type ModelConfig, ModelConfigError, modelConfig } from "./config.ts";
import { engineById } from "./engines.ts";
import { presetById } from "./presets.ts";

// Saved model connections: "claude" = Anthropic + claude-opus-5-5 + a key in the Keychain.
// The list lives in ~/Covo/config.json, which never contains a key: only the id of the Keychain
// item that holds it.

export interface Connection {
  /** Short name you use: "claude", "gemini", "local". */
  name: string;
  /** Preset id (anthropic, gemini, ollama, …), an engine id (claude-code), or "custom". */
  provider: string;
  model: string;
  /** For custom services or proxies. */
  baseUrl?: string;
  /** Keychain item id; absent for local models. */
  keyId?: string;
  addedAt: number;
}

export interface Limits {
  /** Most one task may spend, in US dollars; null = no limit. */
  runUsd: number | null;
  /** Most all bots together may spend per day (your local midnight to midnight). */
  dayUsd: number | null;
}

/** Defaults: generous for real work, small enough that a runaway task can't cost much. */
export const DEFAULT_LIMITS: Limits = { runUsd: 1, dayUsd: 5 };

export interface Settings {
  version: 1;
  default?: string;
  connections: Connection[];
  limits?: Partial<Limits>;
  /** A power profile you chose (covo profile set); absent = detect from the Mac. */
  profile?: string;
}

const EMPTY: Settings = { version: 1, connections: [] };
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export const settingsPath = (home: string) => join(home, "config.json");

export function loadSettings(home: string): Settings {
  const p = settingsPath(home);
  if (!existsSync(p)) return structuredClone(EMPTY);
  try {
    const s = JSON.parse(readFileSync(p, "utf8")) as Settings;
    return {
      version: 1,
      connections: Array.isArray(s.connections) ? s.connections : [],
      default: s.default,
      ...(s.limits ? { limits: s.limits } : {}),
      ...(s.profile ? { profile: s.profile } : {}),
    };
  } catch (e) {
    throw new ModelConfigError(`${p} is damaged (${(e as Error).message}). Fix or delete it.`);
  }
}

export function saveSettings(home: string, s: Settings): void {
  const p = settingsPath(home);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, p);
  chmodSync(p, 0o600);
}

/** A free name based on the provider: "gemini", then "gemini-2", … */
export function suggestName(s: Settings, provider: string): string {
  const base =
    engineById(provider)?.suggestedName ??
    (provider === "ollama" || provider === "lmstudio" ? "local" : provider === "anthropic" ? "claude" : provider);
  if (!s.connections.some((c) => c.name === base)) return base;
  for (let i = 2; ; i++) if (!s.connections.some((c) => c.name === `${base}-${i}`)) return `${base}-${i}`;
}

export interface AddConnection {
  name: string;
  provider: string;
  model: string;
  baseUrl?: string;
  key?: string;
  makeDefault?: boolean;
}

export async function addConnection(home: string, store: SecretStore, a: AddConnection): Promise<Connection> {
  if (!NAME_RE.test(a.name)) {
    throw new ModelConfigError(`"${a.name}" can't be a name: use lowercase letters, digits and dashes (up to 32).`);
  }
  if (a.provider !== "custom" && !presetById(a.provider) && !engineById(a.provider))
    throw new ModelConfigError(`Unknown provider "${a.provider}".`);
  if (engineById(a.provider) && a.key) throw new ModelConfigError("An engine uses its own sign-in, not a key.");
  const s = loadSettings(home);
  if (s.connections.some((c) => c.name === a.name)) {
    throw new ModelConfigError(`There's already a model called "${a.name}". Remove it first or pick another name.`);
  }
  const c: Connection = {
    name: a.name,
    provider: a.provider,
    model: a.model,
    ...(a.baseUrl ? { baseUrl: a.baseUrl } : {}),
    addedAt: Date.now(),
  };
  if (a.key) {
    c.keyId = `key-${randomUUID()}`;
    await store.put(c.keyId, a.key, `${a.name} (${presetById(a.provider)?.label ?? a.provider})`);
  }
  s.connections.push(c);
  if (a.makeDefault || !s.default) s.default = c.name;
  saveSettings(home, s);
  return c;
}

export async function removeConnection(home: string, store: SecretStore, name: string): Promise<Connection> {
  const s = loadSettings(home);
  const c = s.connections.find((x) => x.name === name);
  if (!c) throw new ModelConfigError(`No saved model called "${name}".`);
  if (c.keyId) await store.delete(c.keyId);
  s.connections = s.connections.filter((x) => x !== c);
  if (s.default === name) s.default = s.connections[0]?.name;
  saveSettings(home, s);
  return c;
}

export function setDefault(home: string, name: string): void {
  const s = loadSettings(home);
  if (!s.connections.some((c) => c.name === name)) throw new ModelConfigError(`No saved model called "${name}".`);
  s.default = name;
  saveSettings(home, s);
}

export interface Resolved extends ModelConfig {
  /** The saved connection used, if any. */
  connection?: string;
  /** Set for a subscription engine (claude-code): the program does the whole task itself. */
  engine?: string;
}

/**
 * Which model to use. Environment settings (COVO_PROVIDER, COVO_MODEL_BASE_URL) win, for scripts
 * and tests. Otherwise `use` picks a saved connection by name, or a model name for the default
 * connection; with nothing saved, Covo falls back to local Ollama.
 */
export async function resolveModel(
  home: string,
  store: SecretStore,
  env: Record<string, string | undefined>,
  use?: string,
): Promise<Resolved> {
  if (env.COVO_PROVIDER || env.COVO_MODEL_BASE_URL) {
    return modelConfig(use ? { ...env, COVO_MODEL: use } : env);
  }
  const s = loadSettings(home);
  const byName = use ? s.connections.find((c) => c.name === use) : undefined;
  const conn = byName ?? s.connections.find((c) => c.name === s.default);
  // "local" means the free local model unless you saved a model under that name.
  if (use === "local" && !byName) return modelConfig(env);
  if (!conn) return modelConfig(use ? { ...env, COVO_MODEL: use } : env);
  const engine = engineById(conn.provider);
  // An unsaved name never means an engine: "local" is the free local model, anything else a model
  // name for the local service.
  if (use && !byName && (engine || use === "local")) {
    return modelConfig(use === "local" ? env : { ...env, COVO_MODEL: use });
  }
  if (engine) {
    return {
      name: engine.id,
      label: `${engine.label} (${engine.plan})`,
      kind: "anthropic",
      baseUrl: "",
      model: conn.model || "default",
      local: false,
      connection: conn.name,
      engine: engine.id,
    };
  }
  const cfg: Resolved = {
    ...modelConfig({
      COVO_PROVIDER: conn.provider === "custom" ? undefined : conn.provider,
      COVO_MODEL_BASE_URL: conn.baseUrl,
      COVO_MODEL: use && !byName ? use : conn.model,
      COVO_MODEL_CONTEXT: env.COVO_MODEL_CONTEXT,
      COVO_MODEL_THINK: env.COVO_MODEL_THINK,
      COVO_MODEL_KEEP_ALIVE: env.COVO_MODEL_KEEP_ALIVE,
    }),
    connection: conn.name,
  };
  if (conn.keyId) {
    const key = await store.get(conn.keyId);
    if (!key) {
      throw new ModelConfigError(
        `The key for "${conn.name}" is missing from the Keychain. Add it again with: covo models remove ${conn.name} && covo models add`,
      );
    }
    cfg.apiKey = key;
    cfg.keySource = "the Keychain";
  }
  return cfg;
}

export function getLimits(home: string): Limits {
  const l = loadSettings(home).limits ?? {};
  return {
    runUsd: l.runUsd === undefined ? DEFAULT_LIMITS.runUsd : l.runUsd,
    dayUsd: l.dayUsd === undefined ? DEFAULT_LIMITS.dayUsd : l.dayUsd,
  };
}

export function setLimits(home: string, changes: Partial<Limits>): Limits {
  for (const v of Object.values(changes)) {
    if (v !== null && (!Number.isFinite(v) || (v as number) < 0)) {
      throw new ModelConfigError("A limit must be a dollar amount of 0 or more, or none.");
    }
  }
  const s = loadSettings(home);
  s.limits = { ...s.limits, ...changes };
  saveSettings(home, s);
  return getLimits(home);
}

export function getProfileChoice(home: string): string | undefined {
  return loadSettings(home).profile;
}

/** Saves a chosen power profile; undefined goes back to detecting it. */
export function setProfileChoice(home: string, name: string | undefined): void {
  const s = loadSettings(home);
  if (name) s.profile = name;
  else delete s.profile;
  saveSettings(home, s);
}
