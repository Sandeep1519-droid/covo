import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const readme = () => readFileSync(join(home, "workspaces/default/README.md"), "utf8");

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "covo-auto-"));
  printed = "";
  await main(["init"], env());
  writeFileSync(join(home, "workspaces/default/README.md"), "# Project\n");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const addSetup = () =>
  new MockProvider([
    MockProvider.tool("edit_file", { path: "README.md", old_text: "# Project\n", new_text: "# Project\n\n## Setup\n" }),
    MockProvider.tool("write_file", { path: "docs/guide.md", content: "guide\n" }),
    MockProvider.tool("finish", { summary: "Added Setup" }),
  ]);

test("the main bot keeps undoable work by itself; covo undo puts it back", async () => {
  const r = await main(["run", "add Setup"], env(), { print, provider: addSetup(), secrets: memorySecrets() });
  expect(r.code).toBe(0);
  expect(r.out).toContain("Kept in your workspace (automatic bot):");
  expect(r.out).toMatch(/modified README\.md\n {2}added +docs\/guide\.md/);
  expect(r.out).toMatch(/Put everything back with: covo undo \w{6}/);
  expect(readme()).toContain("## Setup");
  expect((await main(["status"], env())).out).toContain("KEPT");
  expect((await main(["diff", "last"], env())).out).toContain("undo them with: covo undo");

  const u = await main(["undo", "last"], env());
  expect(u.code).toBe(0);
  expect(u.out).toContain("Undone. Put back 2 files exactly as they were");
  expect(readme()).toBe("# Project\n");
  expect(existsSync(join(home, "workspaces/default/docs"))).toBe(false);
  expect((await main(["status"], env())).out).toContain("ROLLED_BACK");
  expect((await main(["undo", "last"], env())).out).toContain("already undone");
  expect((await main(["audit", "verify"], env())).code).toBe(0);
});

test("covo undo keeps your later edits safe", async () => {
  await main(["run", "add Setup"], env(), { print, provider: addSetup(), secrets: memorySecrets() });
  writeFileSync(join(home, "workspaces/default/README.md"), "# Mine now\n");
  const u = await main(["undo", "last"], env());
  expect(u.code).toBe(1);
  expect(u.out).toContain("Nothing was undone, so your later work is safe");
  expect(u.out).toContain("README.md  (you changed it after the bot's change was kept)");
  expect(readme()).toBe("# Mine now\n");
});

test("after three approvals in a week, Covo offers to raise that bot's limit", async () => {
  await main(["limits", "--task", "0.5"], env());
  await main(["bots", "create", "Researcher", "--level", "supervised"], env());
  const paid = (): ModelProvider => {
    const m = new MockProvider(
      [MockProvider.tool("list_files", {}), MockProvider.tool("finish", { summary: "ok" })].map((t) => [
        { type: "usage", tokensIn: 100_000, tokensOut: 10_000 } as ModelEvent,
        ...t,
      ]),
    );
    return { id: "anthropic:claude-opus-5-5", chat: (req) => m.chat(req) };
  };
  const run = (answers: string[]) =>
    main(["run", "--bot", "Researcher", "look"], env(), {
      print,
      provider: paid(),
      secrets: memorySecrets(),
      prompt: scriptedPrompter(answers),
    });
  await run(["y"]);
  await run(["y"]);
  const third = await run(["y", "y"]); // approve the spend, then accept the higher limit
  expect(third.out).toContain("Researcher may now spend up to $1.00 per task");
  expect((await main(["bots"], env())).out).toMatch(/Researcher/);
  const shown = await main(["bots", "set", "Researcher", "--purpose", "Finds things"], env());
  expect(shown.out).toContain("Limit   $1.00 per task");
});
