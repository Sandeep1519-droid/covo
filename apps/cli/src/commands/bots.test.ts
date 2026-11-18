import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider } from "@covo/models";
import { memorySecrets } from "@covo/platform";
import { main } from "../main.ts";

let home: string;
let printed = "";
const env = () => ({ COVO_HOME: home });
const print = (s: string) => {
  printed += s;
};

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "covo-botscli-"));
  printed = "";
  await main(["init"], env());
  writeFileSync(join(home, "workspaces/default/README.md"), "# Project\n");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

test("create, list, change and remove a bot", async () => {
  const c = await main(
    ["bots", "create", "Docs helper", "--model", "claude", "--fallback", "local", "--purpose", "Keeps docs tidy"],
    env(),
  );
  expect(c.code).toBe(0);
  expect(c.out).toContain("Models  claude → local");
  expect(c.out).toContain("Level   automatic: undoable work by itself");
  expect(c.out).toContain('Note: "claude" isn\'t a saved model');

  const l = await main(["bots"], env());
  expect(l.out).toMatch(/Assistant +default model +automatic +0/);
  expect(l.out).toMatch(/Docs helper +claude → local +automatic +0/);

  const s = await main(["bots", "set", "Docs helper", "--level", "supervised", "--default-model"], env());
  expect(s.out).toContain("Models  default model");
  expect(s.out).toContain("Level   supervised");

  expect((await main(["bots", "remove", "Docs helper"], env())).out).toContain("Removed Docs helper");
  expect((await main(["bots", "remove", "Assistant"], env())).out).toContain("main bot");
});

test("explains mistakes", async () => {
  expect((await main(["bots", "create", "X", "--fallback", "local"], env())).out).toContain("--model before");
  expect((await main(["bots", "create", "X", "--level", "wild"], env())).out).toContain("Level must be");
  expect((await main(["bots", "set", "Nobody", "--level", "full"], env())).out).toContain('No bot called "Nobody"');
  expect((await main(["bots", "create"], env())).code).toBe(2);
});

test("covo run --bot uses that bot and its models", async () => {
  const secrets = memorySecrets();
  await main(["models", "add", "ollama", "--model", "qwen3.5:4b"], env(), {
    print,
    secrets,
    listModels: async () => ["qwen3.5:4b"],
  });
  await main(["bots", "create", "Helper", "--model", "local"], env());
  const r = await main(["run", "--bot", "Helper", "say", "hi"], env(), {
    print,
    secrets,
    provider: new MockProvider([MockProvider.tool("finish", { summary: "hi" })]),
  });
  expect(r.code).toBe(0);
  expect(printed).toContain("Helper is working with qwen3.5:4b via Ollama");
  expect((await main(["bots"], env())).out).toMatch(/Helper +local +automatic +1/);
  expect((await main(["run", "--bot", "Ghost", "x"], env(), { print, secrets })).out).toContain(
    'No bot called "Ghost"',
  );
});
