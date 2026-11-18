import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine, EngineResult, EngineTask } from "@covo/engine";
import { type Detected, MockProvider } from "@covo/models";
import { memorySecrets } from "@covo/platform";
import { main } from "../main.ts";
import { scriptedPrompter } from "../prompt.ts";

// covo models add claude-code, and runs through a subscription engine (Phase 2 M6).

let home: string;
let printed = "";
const env = () => ({ COVO_HOME: home, HOME: join(home, "..") });
const detect = async (): Promise<Detected> => ({
  ollama: null,
  envKeys: [],
  clis: [{ name: "claude", path: "/opt/bin/claude" }],
});

class FakeEngine implements Engine {
  readonly id = "claude-code";
  readonly label = "Claude Code";
  readonly model = undefined;
  constructor(private readonly act: (t: EngineTask) => EngineResult) {}
  async run(t: EngineTask) {
    return this.act(t);
  }
}
const usage = { tokensIn: 800, tokensOut: 200, apiEquivalentUsd: 0.02, turns: 3, denied: 0 };
const writes = new FakeEngine((t) => {
  writeFileSync(join(t.ws, "README.md"), "# Demo\n\n## Setup\n");
  return { ...usage, ok: true, summary: "Added a Setup section." };
});
const base = (engine: Engine = writes) => ({
  print: (s: string) => {
    printed += s;
  },
  detect,
  secrets: memorySecrets(),
  which: (cmd: string) => (cmd === "claude" ? "/opt/bin/claude" : null),
  engine,
});

beforeEach(async () => {
  home = join(realpathSync(mkdtempSync(join(tmpdir(), "covo-engcli-"))), "Covo");
  printed = "";
  await main(["init"], env());
  writeFileSync(join(home, "workspaces/default/README.md"), "# Demo\n");
});
afterEach(() => rmSync(join(home, ".."), { recursive: true, force: true }));

test("adding Claude Code explains what happens, asks first and stores no key", async () => {
  const prompt = scriptedPrompter([
    "y", // use it with the subscription
    "sonnet", // model
    "", // name: claude-sub
  ]);
  const r = await main(["models", "add", "claude-code"], env(), { ...base(), prompt });
  expect(r.code).toBe(0);
  expect(printed).toContain("Covo never sees, copies or stores your sign-in");
  expect(printed).toContain("docs/SUBSCRIPTIONS.md");
  expect(r.out).toContain('Saved "claude-sub": Claude Code, sonnet. No key is stored.');
  const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  expect(cfg.connections[0]).toMatchObject({ name: "claude-sub", provider: "claude-code", model: "sonnet" });
  expect(cfg.connections[0].keyId).toBeUndefined();

  const list = await main(["models"], env(), base());
  expect(list.out).toMatch(/★ claude-sub +Claude Code +sonnet +your subscription/);
  expect(list.out).toContain("use your Claude Pro, Max or Ultra subscription with: covo models add claude-code");
});

test("saying no saves nothing; a missing program says how to install it", async () => {
  const no = await main(["models", "add", "claude-code"], env(), { ...base(), prompt: scriptedPrompter(["n"]) });
  expect(no).toEqual({ code: 1, out: "Nothing was saved.\n" });
  const missing = await main(["models", "add", "claude-code"], env(), { ...base(), which: () => null });
  expect(missing.code).toBe(1);
  expect(missing.out).toContain("https://code.claude.com/docs/en/setup");
  const cfg = join(home, "config.json");
  expect(existsSync(cfg) && readFileSync(cfg, "utf8").includes("claude-code")).toBe(false);
});

test("a run through the engine keeps its work and shows the subscription usage", async () => {
  await main(["models", "add", "claude-code"], env(), base());
  const r = await main(["run", "add a Setup section"], env(), base());
  expect(r.code).toBe(0);
  expect(printed).toContain("Working with Claude Code (your Claude Pro, Max or Ultra subscription)");
  expect(printed).toContain("Claude Code is working in Covo's sandbox (file tools only)");
  expect(printed).toContain("Claude Code finished: 3 turns, 1,000 tokens");
  expect(r.out).toContain("Kept in your workspace");
  expect(readFileSync(join(home, "workspaces/default/README.md"), "utf8")).toContain("## Setup");

  const u = await main(["usage"], env(), base());
  expect(u.out).toContain("claude-code");
});

test("at the plan's cap, the bot's next model takes over", async () => {
  const capped = new FakeEngine(() => ({ ...usage, ok: false, error: "usage limit reached", errorKind: "quota" }));
  await main(["models", "add", "claude-code"], env(), base(capped));
  await main(["bots", "create", "Docs helper", "--model", "claude-sub", "--fallback", "local"], env(), base(capped));
  const r = await main(["run", "--bot", "Docs helper", "add a Setup section"], env(), {
    ...base(capped),
    provider: new MockProvider([
      MockProvider.tool("edit_file", { path: "README.md", old_text: "# Demo\n", new_text: "# Demo\n\n## Setup\n" }),
      MockProvider.tool("finish", { summary: "Added it" }),
    ]),
  });
  expect(r.out).toContain("Kept in your workspace");
  expect(printed).toContain("Claude Code stopped: usage limit reached");
  expect(printed).toContain("(claude-sub failed: quota. Switching to local.)");
  expect(readFileSync(join(home, "workspaces/default/README.md"), "utf8")).toContain("## Setup");
});
