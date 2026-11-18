import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Detected, MockProvider } from "@covo/models";
import { memorySecrets } from "@covo/platform";
import { main } from "../main.ts";
import { scriptedPrompter } from "../prompt.ts";

let home: string;
let printed = "";
const env = () => ({ COVO_HOME: home });
const nothingFound = async (): Promise<Detected> => ({ ollama: null, envKeys: [], clis: [] });
const base = () => ({
  print: (s: string) => {
    printed += s;
  },
  detect: nothingFound,
  listModels: async () => ["claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5"],
});

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "covo-models-"));
  printed = "";
  await main(["init"], env());
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

test("covo models add asks the questions, hides the key and saves it to the Keychain", async () => {
  const secrets = memorySecrets();
  const prompt = scriptedPrompter([
    "1", // Anthropic
    "sk-ant-api-test", // the key
    "", // model: default is the first suggestion
    "", // name: default "claude"
    "n", // no test request
  ]);
  const r = await main(["models", "add"], env(), { ...base(), prompt, secrets });
  expect(r.code).toBe(0);
  expect(r.out).toContain('Saved "claude": Anthropic (Claude), claude-opus-5-5. The key is in your Keychain');
  expect(r.out).toContain("Bots use it by default.");
  expect([...secrets.items.values()]).toEqual(["sk-ant-api-test"]);
  expect(readFileSync(join(home, "config.json"), "utf8")).not.toContain("sk-ant-api-test");
  expect(printed).not.toContain("sk-ant-api-test");
  expect(prompt.asked.some((q) => q.includes("won't be shown"))).toBe(true);

  const list = await main(["models"], env(), { ...base(), secrets });
  expect(list.out).toMatch(/★ claude +Anthropic \(Claude\) +claude-opus-5-5 +key in Keychain/);
});

test("a key that doesn't work is not saved", async () => {
  const secrets = memorySecrets();
  const r = await main(["models", "add", "gemini"], env(), {
    ...base(),
    secrets,
    prompt: scriptedPrompter(["bad-key"]),
    listModels: () => Promise.reject(new Error("401 API key not valid")),
  });
  expect(r.code).toBe(1);
  expect(r.out).toContain("Nothing was saved");
  expect(secrets.items.size).toBe(0);
});

test("non-interactive: key from stdin, model and name from flags", async () => {
  const secrets = memorySecrets();
  const r = await main(
    ["models", "add", "anthropic", "--name", "fast", "--model", "claude-haiku-5-5", "--key-stdin"],
    env(),
    { ...base(), secrets, readStdin: async () => "sk-ant-from-stdin\n" },
  );
  expect(r.out).toContain('Saved "fast": Anthropic (Claude), claude-haiku-5-5');
  expect([...secrets.items.values()]).toEqual(["sk-ant-from-stdin"]);
});

test("offers a key already in the environment", async () => {
  const secrets = memorySecrets();
  const r = await main(
    ["models", "add", "anthropic"],
    { ...env(), ANTHROPIC_API_KEY: "sk-ant-env" },
    {
      ...base(),
      secrets,
      prompt: scriptedPrompter(["y", "", "", "n"]),
    },
  );
  expect(r.code).toBe(0);
  expect([...secrets.items.values()]).toEqual(["sk-ant-env"]);
});

test("local models need no key; test, default and remove work", async () => {
  const secrets = memorySecrets();
  await main(["models", "add", "anthropic", "--model", "claude-opus-5-5", "--key-stdin"], env(), {
    ...base(),
    secrets,
    readStdin: async () => "sk-ant-k",
  });
  const local = await main(["models", "add", "ollama", "--model", "qwen3.5:4b"], env(), {
    ...base(),
    secrets,
    listModels: async () => ["qwen3.5:4b"],
  });
  expect(local.out).toContain('Saved "local"');
  expect(secrets.items.size).toBe(1);

  const t = await main(["models", "test", "local"], env(), {
    ...base(),
    secrets,
    listModels: async () => ["qwen3.5:4b"],
    provider: new MockProvider([MockProvider.tool("finish", { summary: "ok" })]),
  });
  expect(t.code).toBe(0);
  expect(t.out).toContain("✓ Model can use tools");

  expect((await main(["models", "default", "local"], env(), { secrets })).out).toContain('Bots now use "local"');
  const removed = await main(["models", "remove", "claude"], env(), { secrets });
  expect(removed.out).toContain("deleted its key from the Keychain");
  expect(secrets.items.size).toBe(0);
  expect((await main(["models", "remove", "nope"], env(), { secrets })).out).toContain('No saved model called "nope"');
});

test("covo run uses the saved default model", async () => {
  const secrets = memorySecrets();
  await main(["models", "add", "anthropic", "--model", "claude-sonnet-5-5", "--key-stdin"], env(), {
    ...base(),
    secrets,
    readStdin: async () => "sk-ant-k",
  });
  const r = await main(["run", "say hi"], env(), {
    ...base(),
    secrets,
    provider: new MockProvider([MockProvider.tool("finish", { summary: "hi" })]),
  });
  expect(r.code).toBe(0);
  expect(printed).toContain("Working with claude-sonnet-5-5 via Anthropic (Claude).");
});

test("lists what it found on this Mac", async () => {
  const r = await main(["models"], env(), {
    ...base(),
    secrets: memorySecrets(),
    detect: async () => ({
      ollama: ["qwen3.5:4b"],
      envKeys: [{ provider: "gemini", variable: "GEMINI_API_KEY" }],
      clis: [{ name: "claude", path: "/opt/bin/claude" }],
    }),
  });
  expect(r.out).toContain("No saved models yet");
  expect(r.out).toContain("Ollama is running with 1 model: qwen3.5:4b");
  expect(r.out).toContain("A Google Gemini key in GEMINI_API_KEY: covo models add gemini");
  expect(r.out).toContain(
    "Claude Code (/opt/bin/claude): use your Claude Pro, Max or Ultra subscription with: covo models add claude-code",
  );
});
