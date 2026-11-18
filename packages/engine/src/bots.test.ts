import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { covoPaths } from "@covo/core";
import { initHome, openDb, verifyAudit } from "@covo/db";
import { type ChainEntry, type ErrorKind, MockProvider, type ModelProvider } from "@covo/models";
import { archiveBot, createBot, findBot, listBots, updateBot } from "./bots.ts";
import { type RunEvent, startRun } from "./run.ts";

let home: string;
beforeEach(() => {
  home = join(realpathSync(mkdtempSync(join(tmpdir(), "covo-bots-"))), "Covo");
  initHome(home);
  writeFileSync(join(home, "workspaces/default/README.md"), "# Project\n");
});
afterEach(() => rmSync(join(home, ".."), { recursive: true, force: true }));

test("create, list, find, change and archive bots", () => {
  const b = createBot(home, { name: "Docs helper", purpose: "Keeps docs tidy", models: ["claude", "local"] });
  expect(b).toMatchObject({ name: "Docs helper", models: ["claude", "local"], level: "automatic", runs: 0 });
  expect(listBots(home).map((x) => x.name)).toEqual(["Assistant", "Docs helper"]);
  expect(findBot(home, "docs HELPER").id).toBe(b.id);

  const u = updateBot(home, "Docs helper", { level: "supervised", models: ["gemini"], name: "Docs bot" });
  expect(u).toMatchObject({ name: "Docs bot", level: "supervised", models: ["gemini"] });

  archiveBot(home, "Docs bot");
  expect(listBots(home).map((x) => x.name)).toEqual(["Assistant"]);
  expect(() => findBot(home, "Docs bot")).toThrow("No bot called");
  // the name can be used again
  expect(createBot(home, { name: "Docs bot" }).name).toBe("Docs bot");

  const db = openDb(covoPaths(home).db);
  const actions = db.query<{ action: string }, []>("SELECT action FROM audit_log ORDER BY seq").all();
  expect(actions.map((a) => a.action)).toEqual([
    "system.init",
    "bot.created",
    "bot.updated",
    "bot.archived",
    "bot.created",
  ]);
  expect(verifyAudit(db).ok).toBe(true);
  db.close();
});

test("refuses bad input and protects the main bot", () => {
  expect(() => createBot(home, { name: "" })).toThrow("1–40");
  expect(() => createBot(home, { name: "assistant" })).toThrow("already a bot");
  expect(() => createBot(home, { name: "X", models: ["a", "a"] })).toThrow("twice");
  expect(() => createBot(home, { name: "X", level: "wild" as never })).toThrow("Level must be");
  expect(() => archiveBot(home, "Assistant")).toThrow("main bot");
});

const failing = (id: string, errorKind: ErrorKind): ModelProvider => ({
  id,
  async *chat() {
    yield { type: "done", stop: "error", error: `${id} said no`, errorKind };
  },
});

test("a run moves to the next model when one fails, and logs why", async () => {
  const bot = createBot(home, { name: "Helper", models: ["claude", "local"] });
  const chain: ChainEntry[] = [
    { label: "claude", provider: failing("anthropic:claude-opus-5-5", "rate_limit") },
    { label: "local", provider: new MockProvider([MockProvider.tool("finish", { summary: "done locally" })]) },
  ];
  const events: RunEvent[] = [];
  const r = await startRun({ home, goal: "x", agentId: bot.id, chain, onEvent: (e) => events.push(e) });
  expect(r).toMatchObject({ state: "SUCCEEDED", summary: "done locally" });
  expect(events.find((e) => e.type === "fallback")).toMatchObject({ from: "claude", to: "local", kind: "rate_limit" });

  const db = openDb(covoPaths(home).db);
  expect(db.query("SELECT model FROM runs WHERE id = ?").get(r.runId)).toEqual({ model: "mock:scripted" });
  expect(db.query("SELECT target, detail_json FROM audit_log WHERE action = 'model.fallback'").get()).toMatchObject({
    target: "local",
  });
  expect(db.query("SELECT tier FROM budget_ledger WHERE run_id = ?").all(r.runId)).toEqual([{ tier: "local" }]);
  db.close();
});

test("errors that another model wouldn't fix are not retried elsewhere", async () => {
  const chain: ChainEntry[] = [
    { label: "a", provider: failing("x:a", "bad_request") },
    { label: "b", provider: new MockProvider([MockProvider.tool("finish", { summary: "b" })]) },
  ];
  const r = await startRun({ home, goal: "x", chain });
  expect(r).toMatchObject({ state: "FAILED", error: "x:a said no" });
});

test("an archived or paused bot can't take tasks", async () => {
  const bot = createBot(home, { name: "Old" });
  archiveBot(home, "Old");
  expect(startRun({ home, goal: "x", agentId: bot.id, provider: new MockProvider([]) })).rejects.toThrow("archived");
});
