import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { covoPaths } from "@covo/core";
import { initHome, openDb } from "@covo/db";
import { listMessages } from "./chat.ts";
import {
  addRoutine,
  dueRoutines,
  getRoutine,
  listRoutines,
  removeRoutine,
  routineBusy,
  settleRoutine,
  updateRoutine,
} from "./routines.ts";
import { composeSummary, lastSummaryAt, postSummary, summaryText } from "./summary.ts";

// Thursday 19 Nov 2026, 10:00 local.
let t = new Date(2026, 10, 19, 10, 0).getTime();
const now = () => t;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "covo-routines-"));
  initHome(home);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const audits = (action: string) => {
  const db = openDb(covoPaths(home).db);
  const n = db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM audit_log WHERE action = ?").get(action)?.n;
  db.close();
  return n ?? 0;
};

function addRun(
  id: string,
  state: string,
  o: { routine?: string; summary?: string; error?: string; finishedAt?: number; cost?: number } = {},
) {
  const db = openDb(covoPaths(home).db);
  db.query(
    `INSERT INTO runs (id, agent_id, department_id, trigger, goal, state, summary, error, cost_usd, created_at, finished_at, routine_id)
     VALUES (?, 'bot_assistant', 'dept_default', 'routine', 'tidy the inbox', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    state,
    o.summary ?? null,
    o.error ?? null,
    o.cost ?? 0,
    t - 60_000,
    o.finishedAt ?? null,
    o.routine ?? null,
  );
  db.close();
}

describe("routines", () => {
  test("add, list, change, pause, resume, remove; every change is logged", () => {
    const r = addRoutine(
      home,
      { name: "Morning brief", bot: "Assistant", task: "Summarise yesterday", every: "weekdays 8:30" },
      now,
    );
    expect(r).toMatchObject({
      name: "Morning brief",
      botName: "Assistant",
      scheduleText: "Weekdays at 08:30",
      status: "active",
    });
    expect(r.nextAt).toBe(new Date(2026, 10, 20, 8, 30).getTime()); // Thursday 10:00 → Friday 08:30
    expect(() => addRoutine(home, { name: "morning BRIEF", bot: "Assistant", task: "x", every: "9:00" }, now)).toThrow(
      "already a routine",
    );
    expect(() => addRoutine(home, { name: "Odd", bot: "Assistant", task: "x", every: "sometimes" }, now)).toThrow(
      "Try",
    );
    expect(() => addRoutine(home, { name: "Nobody", bot: "Nobody", task: "x", every: "9:00" }, now)).toThrow(
      'No bot called "Nobody"',
    );

    const changed = updateRoutine(
      home,
      "morning brief",
      { every: "every day at 18:00", runLimitUsd: 0.1, quiet: true },
      now,
    );
    expect(changed).toMatchObject({ scheduleText: "Every day at 18:00", runLimitUsd: 0.1, quiet: true });
    expect(changed.nextAt).toBe(new Date(2026, 10, 19, 18).getTime());
    expect(updateRoutine(home, r.id, { status: "paused" }, now).status).toBe("paused");
    t += 3 * 86_400_000; // three days later
    const back = updateRoutine(home, r.id, { status: "active" }, now);
    expect(back.nextAt).toBe(new Date(2026, 10, 22, 18).getTime()); // counts from now: no burst of missed runs
    expect(listRoutines(home, { now })).toHaveLength(1);
    removeRoutine(home, r.id, now);
    expect(listRoutines(home, { now })).toHaveLength(0);
    expect(() => getRoutine(home, r.id, now)).toThrow("No routine");
    expect([audits("routine.created"), audits("routine.changed"), audits("routine.removed")]).toEqual([1, 3, 1]);
    t = new Date(2026, 10, 19, 10, 0).getTime();
  });

  test("due, settled, busy", () => {
    const r = addRoutine(home, { name: "Check", bot: "Assistant", task: "check", every: "every 30 minutes" }, now);
    expect(dueRoutines(home, t, now)).toHaveLength(0);
    expect(dueRoutines(home, t + 31 * 60_000, now).map((x) => x.id)).toEqual([r.id]);
    settleRoutine(home, r.id, { t: t + 31 * 60_000, started: true }, now);
    const after = getRoutine(home, r.id, now);
    expect(after.lastAt).toBe(t + 31 * 60_000);
    expect(after.nextAt).toBe(new Date(2026, 10, 19, 11, 0).getTime());
    expect(routineBusy(home, r.id, now)).toBe(false);
    addRun("run_a", "RUNNING", { routine: r.id });
    expect(routineBusy(home, r.id, now)).toBe(true);
    settleRoutine(home, r.id, { t, note: { reason: "still running" } }, now);
    expect(audits("routine.skipped")).toBe(1);
    expect(getRoutine(home, r.id, now).lastRun?.id).toBe("run_a");
  });
});

describe("the daily summary", () => {
  test("what ran, what was spent, what's waiting; in the main bot's chat", () => {
    const r = addRoutine(home, { name: "Inbox tidy", bot: "Assistant", task: "tidy", every: "9:00" }, now);
    addRun("run_ok", "SUCCEEDED", {
      routine: r.id,
      summary: "Sorted 12 emails into folders.",
      finishedAt: t - 30_000,
      cost: 0.03,
    });
    addRun("run_bad", "FAILED", { error: "The key stopped working.", finishedAt: t - 20_000 });
    addRun("run_review", "REVIEWING", { summary: "Renamed files.", finishedAt: t - 10_000 });
    const s = composeSummary(home, t - 3_600_000, t, { dayLimitUsd: 5, now });
    expect(s).toMatchObject({ done: 2, failed: 1, waiting: { approvals: 0, reviews: 1 } });
    const text = summaryText(s) as string;
    expect(text).toStartWith("Your day: 2 tasks done, 1 didn't finish");
    expect(text).toContain("• Assistant, Inbox tidy: Sorted 12 emails into folders.");
    expect(text).toContain("didn't finish: tidy the inbox");
    expect(text).toContain("Waiting for you: 1 change to review.");

    expect(lastSummaryAt(home)).toBeNull();
    const posted = postSummary(home, { now, dayLimitUsd: 5 });
    expect(posted.text).toBe(text.replace("(daily limit $5.00)", "(daily limit $5.00)"));
    expect(lastSummaryAt(home)).toBe(t);
    const chat = listMessages(home, "Assistant", { now });
    expect(chat.at(-1)).toMatchObject({ role: "bot", data: expect.objectContaining({ kind: "summary", done: 2 }) });
    // Nothing new since: no second message.
    expect(postSummary(home, { now, dayLimitUsd: 5 }).text).toContain("Waiting for you"); // the review still waits
    const quietDay = composeSummary(home, t, t + 1, { now });
    expect(summaryText({ ...quietDay, waiting: { approvals: 0, reviews: 0 } })).toBeNull();
  });
});
