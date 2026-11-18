import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider, type ModelEvent, type ModelProvider } from "@covo/models";
import { memorySecrets } from "@covo/platform";
import { main } from "../main.ts";
import { scriptedPrompter } from "../prompt.ts";

let home: string;
let printed = "";
const env = () => ({ COVO_HOME: home });
const print = (s: string) => {
  printed += s;
};

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "covo-spend-"));
  printed = "";
  await main(["init"], env());
  writeFileSync(join(home, "workspaces/default/README.md"), "# Project\n");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** Billed as Claude Opus 5.5: $0.60 per call. */
function paid(): ModelProvider {
  const m = new MockProvider(
    [
      MockProvider.tool("list_files", {}),
      MockProvider.tool("read_file", { path: "README.md" }),
      MockProvider.tool("finish", { summary: "Looked" }),
    ].map((t) => [{ type: "usage", tokensIn: 100_000, tokensOut: 10_000 } as ModelEvent, ...t]),
  );
  return { id: "anthropic:claude-opus-5-5", chat: (req) => m.chat(req) };
}

test("limits: show the defaults and change them", async () => {
  const shown = await main(["limits"], env());
  expect(shown.out).toContain("Each task  $1.00");
  expect(shown.out).toContain("Each day   $5.00");
  const set = await main(["limits", "--task", "0.25", "--day", "none"], env());
  expect(set.out).toContain("Each task  $0.25");
  expect(set.out).toContain("Each day   no limit");
  expect((await main(["limits", "--day", "lots"], env())).code).toBe(1);
});

test("a run that would go over asks in the terminal; the cost shows at the end", async () => {
  await main(["limits", "--task", "1"], env());
  const prompt = scriptedPrompter(["y"]);
  const r = await main(["run", "look around"], env(), { print, provider: paid(), prompt, secrets: memorySecrets() });
  expect(printed).toContain("⏸ Assistant has spent $0.60 of its $1.00 limit for this task");
  expect(prompt.asked).toEqual(["Let it continue? (y/N)"]);
  expect(r.out).toContain("3 steps");
  expect(r.out).toContain("$1.80");
  expect(printed.split("Working with").length - 1).toBe(1); // not repeated after the pause
});

test("without a terminal it waits for covo approve, and covo deny stops it", async () => {
  await main(["limits", "--task", "1"], env());
  const run = main(["run", "look around"], env(), { print, provider: paid(), secrets: memorySecrets() });
  while (!printed.includes("⏸")) await Bun.sleep(10);
  expect(printed).toMatch(/Approve with: covo approve \w{6}/);
  const d = await main(["deny", "last"], env());
  expect(d.out).toContain("Declined: Assistant has spent $0.60");
  const r = await run;
  expect(r.code).toBe(1);
  expect(r.out).toContain("you said no");
  expect((await main(["approve"], env())).out).toContain("Nothing is waiting");
});

test("usage adds it up by model, bot and day, and marks estimates", async () => {
  await main(["limits", "--task", "none", "--day", "none"], env());
  await main(["run", "look around"], env(), { print, provider: paid(), secrets: memorySecrets() });
  const u = await main(["usage"], env());
  expect(u.out).toContain("Spending, last 7 days: $1.80");
  expect(u.out).toMatch(/anthropic:claude-opus-5-5 +3 calls +300\.0k in +30\.0k out +\$1\.80/);
  expect(u.out).toMatch(/Assistant +3 calls/);
  expect(u.out).not.toContain("* includes an estimate");
});

test("prices: built-in list, your own, and a bot's own task limit", async () => {
  expect((await main(["prices"], env())).out).toContain("claude-opus-5-5              $4 / $20");
  expect((await main(["prices", "set", "my-model", "0.5", "1.5"], env())).out).toContain("my-model costs $0.5");
  expect((await main(["prices"], env())).out).toContain("my-model                     $0.5 / $1.5  (yours)");
  const b = await main(["bots", "create", "Thrifty", "--task-limit", "0.05"], env());
  expect(b.out).toContain("Limit   $0.05 per task");
  expect((await main(["bots", "set", "Thrifty", "--task-limit", "none"], env())).out).toContain(
    "Limit   the general per-task limit",
  );
});
