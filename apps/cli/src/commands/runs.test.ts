import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider } from "@cw/models";
import { main } from "../main.ts";

let home: string;
let printed = "";
const env = () => ({ CW_HOME: home });
const print = (s: string) => {
  printed += s;
};

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "cw-runs-"));
  printed = "";
  await main(["init"], env());
  writeFileSync(join(home, "workspaces/default/README.md"), "# Project\n");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const provider = () =>
  new MockProvider([
    MockProvider.tool("read_file", { path: "README.md" }),
    MockProvider.tool("write_file", { path: "README.md", content: "# Project\n\n## Setup\n" }),
    MockProvider.tool("finish", { summary: "Added Setup" }),
  ]);

test("cw run shows progress and what's waiting for review", async () => {
  const r = await main(["run", "add", "a", "Setup", "section"], env(), { print, provider: provider() });
  expect(r.code).toBe(0);
  expect(printed).toContain("Making a safe copy");
  expect(printed).toMatch(/2 +write_file +README\.md/);
  expect(r.out).toContain("Changes waiting for you: 1 modified, 0 added, 0 deleted.");
  expect(r.out).toContain("modified README.md");
});

test("cw run needs a task", async () => {
  expect((await main(["run"], env(), { print })).code).toBe(2);
});

test("cw status and cw log show the run", async () => {
  await main(["run", "add Setup"], env(), { print, provider: provider() });
  const s = await main(["status"], env());
  expect(s.out).toContain("REVIEWING");
  expect(s.out).toContain("add Setup");
  const l = await main(["log", "last"], env());
  expect(l.out).toContain("Summary  Added Setup");
  expect(l.out).toMatch(/write_file +README\.md/);
  expect(l.out).toContain("Activity log: 7 entries");
});

test("cw log explains unknown runs", async () => {
  expect((await main(["log", "zzzz"], env())).out).toContain('No run "zzzz"');
  expect((await main(["log", "last"], env())).out).toContain("no runs yet");
});
