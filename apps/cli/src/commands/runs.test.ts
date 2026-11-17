import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider } from "@covo/models";
import { main } from "../main.ts";

let home: string;
let printed = "";
const env = () => ({ COVO_HOME: home });
const print = (s: string) => {
  printed += s;
};

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "covo-runs-"));
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

test("covo run shows progress and what's waiting for review", async () => {
  const r = await main(["run", "add", "a", "Setup", "section"], env(), { print, provider: provider() });
  expect(r.code).toBe(0);
  expect(printed).toContain("Making a safe copy");
  expect(printed).toMatch(/2 +write_file +README\.md/);
  expect(r.out).toContain("Changes waiting for you: 1 modified, 0 added, 0 deleted.");
  expect(r.out).toContain("modified README.md");
});

test("covo run needs a task", async () => {
  expect((await main(["run"], env(), { print })).code).toBe(2);
});

test("covo status and covo log show the run", async () => {
  await main(["run", "add Setup"], env(), { print, provider: provider() });
  const s = await main(["status"], env());
  expect(s.out).toContain("REVIEWING");
  expect(s.out).toContain("add Setup");
  const l = await main(["log", "last"], env());
  expect(l.out).toContain("Summary  Added Setup");
  expect(l.out).toMatch(/write_file +README\.md/);
  expect(l.out).toContain("Activity log: 7 entries");
});

test("covo log explains unknown runs", async () => {
  expect((await main(["log", "zzzz"], env())).out).toContain('No run "zzzz"');
  expect((await main(["log", "last"], env())).out).toContain("no runs yet");
});

// ---------------------------------------------------------------- review (M6)

const readme = () => readFileSync(join(home, "workspaces/default/README.md"), "utf8");

test("covo run points to diff, keep and discard", async () => {
  const r = await main(["run", "add Setup"], env(), { print, provider: provider() });
  expect(r.out).toMatch(/covo diff \w{6}\n {2}Keep them: {8}covo keep \w{6}/);
});

test("covo diff shows a unified diff; --stat a summary", async () => {
  await main(["run", "add Setup"], env(), { print, provider: provider() });
  const d = await main(["diff", "last"], env());
  expect(d.code).toBe(0);
  expect(d.out).toContain("1 modified, 0 added, 0 deleted");
  expect(d.out).toContain("modified README.md\n@@ -1 +1,3 @@\n # Project\n+\n+## Setup\n");
  expect(d.out).not.toContain("\x1b[");
  const s = await main(["diff", "last", "--stat"], env());
  expect(s.out).toContain("modified README.md  +2 -0");
  expect((await main(["diff", "last"], env(), { color: true })).out).toContain("\x1b[32m+## Setup\x1b[0m");
});

test("covo keep lands the change in the workspace", async () => {
  await main(["run", "add Setup"], env(), { print, provider: provider() });
  expect(readme()).toBe("# Project\n");
  const k = await main(["keep", "last"], env());
  expect(k.code).toBe(0);
  expect(k.out).toContain("Kept 1 file in");
  expect(readme()).toBe("# Project\n\n## Setup\n");
  expect((await main(["status"], env())).out).toContain("KEPT");
  expect((await main(["keep", "last"], env())).out).toContain("already kept");
  expect((await main(["audit", "verify"], env())).code).toBe(0);
});

test("covo keep explains a clash with your own edit and keeps nothing", async () => {
  await main(["run", "add Setup"], env(), { print, provider: provider() });
  writeFileSync(join(home, "workspaces/default/README.md"), "# Mine, edited meanwhile\n");
  const k = await main(["keep", "last"], env());
  expect(k.code).toBe(1);
  expect(k.out).toContain("Nothing was kept");
  expect(k.out).toContain("README.md  (you changed it after the run started)");
  expect(readme()).toBe("# Mine, edited meanwhile\n");
});

test("covo discard throws the changes away", async () => {
  await main(["run", "add Setup"], env(), { print, provider: provider() });
  const d = await main(["discard", "last"], env());
  expect(d.out).toContain("Threw away 1 change");
  expect(readme()).toBe("# Project\n");
  expect((await main(["diff", "last"], env())).out).toContain("already thrown away");
});
