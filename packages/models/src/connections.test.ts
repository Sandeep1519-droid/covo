import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memorySecrets } from "@covo/platform";
import { ModelConfigError } from "./config.ts";
import {
  addConnection,
  loadSettings,
  removeConnection,
  resolveModel,
  setDefault,
  settingsPath,
  suggestName,
} from "./connections.ts";
import { detect } from "./detect.ts";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "covo-conn-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

test("a saved connection keeps its key in the secret store, never in the config file", async () => {
  const store = memorySecrets();
  const c = await addConnection(home, store, {
    name: "claude",
    provider: "anthropic",
    model: "claude-opus-5-5",
    key: "sk-ant-secret",
  });
  const file = readFileSync(settingsPath(home), "utf8");
  expect(file).not.toContain("sk-ant-secret");
  expect(file).toContain(c.keyId as string);
  expect(statSync(settingsPath(home)).mode & 0o777).toBe(0o600);
  expect(store.items.get(c.keyId as string)).toBe("sk-ant-secret");
  expect(loadSettings(home).default).toBe("claude"); // the first one becomes the default

  const r = await resolveModel(home, store, {});
  expect(r).toMatchObject({
    connection: "claude",
    kind: "anthropic",
    model: "claude-opus-5-5",
    apiKey: "sk-ant-secret",
    keySource: "the Keychain",
  });
});

test("pick a saved connection by name, or another model for the default one", async () => {
  const store = memorySecrets();
  await addConnection(home, store, { name: "claude", provider: "anthropic", model: "claude-opus-5-5", key: "k1" });
  await addConnection(home, store, { name: "local", provider: "ollama", model: "qwen3.5:4b" });
  expect((await resolveModel(home, store, {}, "local")).model).toBe("qwen3.5:4b");
  expect(await resolveModel(home, store, {}, "claude-haiku-5-5")).toMatchObject({
    connection: "claude",
    model: "claude-haiku-5-5",
  });
  setDefault(home, "local");
  expect((await resolveModel(home, store, {})).connection).toBe("local");
  // Environment settings still win, for scripts and tests.
  expect((await resolveModel(home, store, { COVO_PROVIDER: "ollama", COVO_MODEL: "x" })).model).toBe("x");
});

test("with nothing saved, Covo uses local Ollama", async () => {
  expect(await resolveModel(home, memorySecrets(), {})).toMatchObject({ name: "ollama", model: "qwen3.5:4b" });
});

test("names are checked, unique, and suggested from the provider", async () => {
  const store = memorySecrets();
  expect(suggestName(loadSettings(home), "anthropic")).toBe("claude");
  await addConnection(home, store, { name: "claude", provider: "anthropic", model: "m", key: "k" });
  expect(suggestName(loadSettings(home), "anthropic")).toBe("claude-2");
  expect(suggestName(loadSettings(home), "ollama")).toBe("local");
  expect(addConnection(home, store, { name: "claude", provider: "anthropic", model: "m" })).rejects.toThrow("already");
  expect(addConnection(home, store, { name: "Bad Name", provider: "anthropic", model: "m" })).rejects.toThrow(
    ModelConfigError,
  );
  expect(addConnection(home, store, { name: "x", provider: "nope", model: "m" })).rejects.toThrow("Unknown provider");
});

test("removing a connection deletes its key and moves the default", async () => {
  const store = memorySecrets();
  await addConnection(home, store, { name: "claude", provider: "anthropic", model: "m", key: "k" });
  await addConnection(home, store, { name: "gemini", provider: "gemini", model: "g", key: "k2" });
  await removeConnection(home, store, "claude");
  expect(store.items.size).toBe(1);
  expect(loadSettings(home)).toMatchObject({ default: "gemini", connections: [{ name: "gemini" }] });
});

test("a key missing from the Keychain is explained", async () => {
  const store = memorySecrets();
  await addConnection(home, store, { name: "claude", provider: "anthropic", model: "m", key: "k" });
  store.items.clear();
  expect(resolveModel(home, store, {})).rejects.toThrow("missing from the Keychain");
});

test("detect reports running local models, keys in the environment and AI command-line tools", async () => {
  const d = await detect(
    { GEMINI_API_KEY: "x", PATH: "" },
    { listOllama: async () => ["qwen3.5:4b"], which: (c) => (c === "claude" ? "/usr/local/bin/claude" : null) },
  );
  expect(d).toEqual({
    ollama: ["qwen3.5:4b"],
    envKeys: [{ provider: "gemini", variable: "GEMINI_API_KEY" }],
    clis: [{ name: "claude", path: "/usr/local/bin/claude" }],
  });
  const none = await detect({}, { listOllama: () => Promise.reject(new Error("down")), which: () => null });
  expect(none).toEqual({ ollama: null, envKeys: [], clis: [] });
});

test('"local" is the free local model when nothing is saved under that name', async () => {
  const store = memorySecrets();
  expect(await resolveModel(home, store, {}, "local")).toMatchObject({ kind: "ollama", model: "qwen3.5:4b" });
  await addConnection(home, store, { name: "claude", provider: "anthropic", model: "claude-opus-5-5", key: "k1" });
  expect(await resolveModel(home, store, {}, "local")).toMatchObject({ kind: "ollama", model: "qwen3.5:4b" });
});
