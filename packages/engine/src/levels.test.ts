import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { covoPaths } from "@covo/core";
import { initHome, openDb, verifyAudit } from "@covo/db";
import { MockProvider, type ModelEvent, type ModelProvider } from "@covo/models";
import { createBot } from "./bots.ts";
import { undoRun } from "./review.ts";
import { type RunEvent, startRun } from "./run.ts";

let home: string;
let wsDir: string;
beforeEach(() => {
  home = join(realpathSync(mkdtempSync(join(tmpdir(), "covo-levels-"))), "Covo");
  initHome(home);
  wsDir = join(home, "workspaces/default");
  writeFileSync(join(wsDir, "README.md"), "# Project\n\nHello.\n");
  writeFileSync(join(wsDir, "old.txt"), "bye\n");
});
afterEach(() => rmSync(join(home, ".."), { recursive: true, force: true }));

const tidy = () =>
  new MockProvider([
    MockProvider.tool("edit_file", { path: "README.md", old_text: "Hello.\n", new_text: "Hello.\n\n## Setup\n" }),
    MockProvider.tool("write_file", { path: "docs/new.md", content: "new\n" }),
    MockProvider.tool("run_command", { command: "rm old.txt" }),
    MockProvider.tool("finish", { summary: "Tidied" }),
  ]);
const read = (p: string) => readFileSync(join(wsDir, p), "utf8");
const stateOf = (id: string) => {
  const db = openDb(covoPaths(home).db);
  const s = db.query<{ state: string }, [string]>("SELECT state FROM runs WHERE id = ?").get(id)?.state;
  db.close();
  return s;
};

test("an automatic bot keeps its own undoable work, and undo puts it all back", async () => {
  const states: string[] = [];
  const r = await startRun({
    home,
    goal: "tidy",
    provider: tidy(),
    onEvent: (e: RunEvent) => e.type === "state" && states.push(e.state),
  });
  expect(r.state).toBe("KEPT");
  expect(states).toEqual(["PREPARING", "RUNNING", "REVIEWING", "KEPT"]);
  expect(r.autoKeep?.kept).toEqual(["README.md", "docs/new.md", "old.txt"]);
  expect(read("README.md")).toContain("## Setup");
  expect(existsSync(join(wsDir, "old.txt"))).toBe(false);

  const u = undoRun(home, r.runId);
  expect(u.restored.sort()).toEqual(["README.md", "docs/new.md", "old.txt"]);
  expect(read("README.md")).toBe("# Project\n\nHello.\n");
  expect(read("old.txt")).toBe("bye\n");
  expect(existsSync(join(wsDir, "docs"))).toBe(false);
  expect(stateOf(r.runId)).toBe("ROLLED_BACK");
  expect(() => undoRun(home, r.runId)).toThrow("already undone");

  const db = openDb(covoPaths(home).db);
  const keep = db
    .query<{ actor: string; detail_json: string }, [string]>(
      "SELECT actor, detail_json FROM audit_log WHERE run_id = ? AND action = 'run.keep'",
    )
    .get(r.runId);
  expect(keep?.actor).toBe("system");
  expect(JSON.parse(keep?.detail_json ?? "{}").automatic).toBe(true);
  expect(verifyAudit(db).ok).toBe(true);
  db.close();
});

test("undo refuses if you've changed a file since, and the run stays kept", async () => {
  const r = await startRun({ home, goal: "tidy", provider: tidy() });
  writeFileSync(join(wsDir, "README.md"), "# My own edit after the bot\n");
  const u = undoRun(home, r.runId);
  expect(u.conflicts).toEqual([{ path: "README.md", reason: "changed-since-keep" }]);
  expect(read("README.md")).toBe("# My own edit after the bot\n");
  expect(existsSync(join(wsDir, "docs/new.md"))).toBe(true);
  expect(stateOf(r.runId)).toBe("KEPT");
});

test("a supervised bot leaves its work for review; nothing is undoable before a keep", async () => {
  const bot = createBot(home, { name: "Careful", level: "supervised" });
  const r = await startRun({ home, goal: "tidy", agentId: bot.id, provider: tidy() });
  expect(r.state).toBe("REVIEWING");
  expect(read("README.md")).toBe("# Project\n\nHello.\n");
  expect(() => undoRun(home, r.runId)).toThrow("never kept");
});

test("if you edited the same file while it worked, an automatic bot leaves the run for review", async () => {
  const provider: ModelProvider = {
    id: "mock:clash",
    async *chat(req) {
      // You edit README.md while the bot is working on its copy.
      if (req.messages.length > 2) writeFileSync(join(wsDir, "README.md"), "# Edited by you meanwhile\n");
      yield* (await inner.next()).value as ModelEvent[];
    },
  };
  const script = [
    MockProvider.tool("edit_file", { path: "README.md", old_text: "Hello.\n", new_text: "Hi.\n" }),
    MockProvider.tool("finish", { summary: "Changed greeting" }),
  ];
  const inner = script[Symbol.iterator]();
  const r = await startRun({ home, goal: "x", provider });
  expect(r.state).toBe("REVIEWING");
  expect(r.autoKeep?.conflicts).toEqual([{ path: "README.md", reason: "changed-in-workspace" }]);
  expect(read("README.md")).toBe("# Edited by you meanwhile\n");
});

test("a fully automatic bot stops at its limit instead of asking", async () => {
  const bot = createBot(home, { name: "Night shift", level: "full", taskLimitUsd: 0.5 });
  const m = new MockProvider(
    [MockProvider.tool("list_files", {}), MockProvider.tool("finish", { summary: "x" })].map((t) => [
      { type: "usage", tokensIn: 100_000, tokensOut: 10_000 } as ModelEvent,
      ...t,
    ]),
  );
  let asked = 0;
  const r = await startRun({
    home,
    goal: "x",
    agentId: bot.id,
    provider: { id: "anthropic:claude-opus-5-5", chat: (req) => m.chat(req) },
    askApproval: async () => {
      asked++;
      return true;
    },
  });
  expect(asked).toBe(0);
  expect(r.state).toBe("STOPPED");
  expect(r.error).toContain("Fully automatic bots stop instead of asking");
});
