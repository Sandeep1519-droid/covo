import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SecretStore } from "@covo/platform";
import { type ModelConfig, ModelConfigError, modelConfig } from "./config.ts";
import { presetById } from "./presets.ts";

// Saved model connections: "claude" = Anthropic + claude-opus-5-5 + a key in the Keychain.
// The list lives in ~/Covo/config.json, which never contains a key: only the id of the Keychain
// item that holds it.

export interface Connection {
  /** Short name you use: "claude", "gemini", "local". */
  name: string;
  /** Preset id (anthropic, gemini, ollama, …) or "custom". */
  provider: string;
  model: string;
  /** For custom services or proxies. */
  baseUrl?: string;
  /** Keychain item id; absent for local models. */
  keyId?: string;
  addedAt: number;
}

export interface Settings {
  version: 1;
  default?: string;
  connections: Connection[];
}

const EMPTY: Settings = { version: 1, connections: [] };
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export const settingsPath = (home: string) => join(home, "config.json");

export function loadSettings(home: string): Settings {
  const p = settingsPath(home);
  if (!existsSync(p)) return structuredClone(EMPTY);
  try {
    const s = JSON.parse(readFileSync(p, "utf8")) as Settings;
    return { version: 1, connections: Array.isArray(s.connections) ? s.connections : [], default: s.default };
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
    provider === "ollama" || provider === "lmstudio" ? "local" : provider === "anthropic" ? "claude" : provider;
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
  if (a.provider !== "custom" && !presetById(a.provider))
    throw new ModelConfigError(`Unknown provider "${a.provider}".`);
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
  if (!conn) return modelConfig(use ? { ...env, COVO_MODEL: use } : env);
  const cfg: Resolved = {
    ...modelConfig({
      COVO_PROVIDER: conn.provider === "custom" ? undefined : conn.provider,
      COVO_MODEL_BASE_URL: conn.baseUrl,
      COVO_MODEL: use && !byName ? use : conn.model,
      COVO_MODEL_CONTEXT: env.COVO_MODEL_CONTEXT,
      COVO_MODEL_THINK: env.COVO_MODEL_THINK,
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
