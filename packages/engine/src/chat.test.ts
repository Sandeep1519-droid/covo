import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { covoPaths } from "@covo/core";
import { initHome, openDb } from "@covo/db";
import { addMessage, CONTEXT_TURNS, failMessage, linkRun, listMessages } from "./chat.ts";

let home: string;
let t = 1_000;
const now = () => ++t;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "covo-chat-"));
  initHome(home);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function finishRun(runId: string, state: string, summary: string | null, error: string | null = null) {
  const db = openDb(covoPaths(home).db);
  db.query(
    `INSERT INTO runs (id, agent_id, department_id, trigger, goal, state, summary, error, created_at)
     VALUES (?, 'bot_assistant', 'dept_default', 'chat', 'x', ?, ?, ?, ?)`,
  ).run(runId, state, summary, error, now());
  db.close();
}

describe("chat", () => {
  test("the first message has no context; later ones carry the earlier turns, newest kept", () => {
    const a = addMessage(home, "Assistant", "  tidy the README ", { now });
    expect(a.context).toBe("");
    expect(a.message).toMatchObject({ role: "you", text: "tidy the README", runId: null });
    finishRun("run_1", "KEPT", "Tidied the README.");
    linkRun(home, a.message.id, "run_1", now);

    const b = addMessage(home, "bot_assistant", "now the CHANGELOG", { now });
    expect(b.context).toBe("You: tidy the README\nAssistant: Tidied the README.");

    failMessage(home, b.message.id, "No model is set up.", now);
    const c = addMessage(home, "Assistant", "try again", { now });
    expect(c.context).toContain("Assistant: (couldn't start: No model is set up.)");

    for (let i = 0; i < CONTEXT_TURNS + 3; i++) addMessage(home, "Assistant", `m${i}`, { now });
    const d = addMessage(home, "Assistant", "last", { now });
    expect(d.context.split("\n").filter((l) => l.startsWith("You:"))).toHaveLength(CONTEXT_TURNS);
    expect(d.context).toContain(`You: m${CONTEXT_TURNS + 2}`);
    expect(d.context).not.toContain("tidy the README");
  });

  test("messages are listed oldest first; a linked run isn't replaced", () => {
    const a = addMessage(home, "Assistant", "one", { now });
    addMessage(home, "Assistant", "two", { now });
    finishRun("run_a", "RUNNING", null);
    finishRun("run_b", "RUNNING", null);
    linkRun(home, a.message.id, "run_a", now);
    linkRun(home, a.message.id, "run_b", now);
    failMessage(home, a.message.id, "too late", now);
    const list = listMessages(home, "Assistant", { now });
    expect(list.map((m) => m.text)).toEqual(["one", "two"]);
    expect(list[0]).toMatchObject({ runId: "run_a", error: null });
  });

  test("empty, huge or bot-less messages are refused", () => {
    expect(() => addMessage(home, "Assistant", "  ", { now })).toThrow("Write a message first");
    expect(() => addMessage(home, "Assistant", "x".repeat(20_001), { now })).toThrow("at most");
    expect(() => addMessage(home, "Nobody", "hi", { now })).toThrow('No bot called "Nobody"');
  });
});
