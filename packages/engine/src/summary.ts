import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { covoPaths } from "@covo/core";
import { DEFAULT_AGENT_ID, migrate, openDb } from "@covo/db";
import { addBotMessage } from "./chat.ts";
import { changesOf } from "./review.ts";
import { RunError } from "./run.ts";

// The daily summary (Phase 3 M6): at a time you pick, what ran since the last one, what changed
// (the app offers Undo), what was spent and what's waiting. It goes to your main bot's chat and, if
// your phone gets summaries, to your phone: short, never the contents of your files.

export interface SummaryRun {
  runId: string;
  botId: string;
  botName: string;
  goal: string;
  state: string;
  costUsd: number;
  summary: string | null;
  error: string | null;
  /** The routine it ran for, if any. */
  routine: string | null;
  files: { added: number; modified: number; deleted: number } | null;
  /** Its changes are in your files and can still be undone. */
  undoable: boolean;
}

export interface DailySummary {
  kind: "summary";
  since: number;
  until: number;
  ran: SummaryRun[];
  done: number;
  failed: number;
  spentUsd: number;
  dayLimitUsd: number | null;
  waiting: { approvals: number; reviews: number };
}

function withDb<T>(home: string, now: () => number, fn: (db: Database) => T): T {
  const p = covoPaths(home).db;
  if (!existsSync(p)) throw new RunError("Covo isn't set up yet. Run: covo init");
  const db = openDb(p);
  try {
    migrate(db, now);
    return fn(db);
  } finally {
    db.close();
  }
}

export function composeSummary(
  home: string,
  since: number,
  until: number,
  o: { dayLimitUsd?: number | null; now?: () => number } = {},
): DailySummary {
  const now = o.now ?? Date.now;
  const base = withDb(home, now, (db) => {
    const rows = db
      .query<
        {
          id: string;
          agent_id: string;
          bot: string | null;
          goal: string;
          state: string;
          cost: number;
          summary: string | null;
          error: string | null;
          routine: string | null;
        },
        [number, number]
      >(
        `SELECT r.id, r.agent_id, a.name AS bot, r.goal, r.state, r.cost_usd AS cost, r.summary, r.error, t.name AS routine
         FROM runs r LEFT JOIN agents a ON a.id = r.agent_id LEFT JOIN routines t ON t.id = r.routine_id
         WHERE r.finished_at > ? AND r.finished_at <= ?
           AND r.state IN ('KEPT','SUCCEEDED','REVIEWING','FAILED','ROLLED_BACK','DISCARDED')
         ORDER BY r.finished_at`,
      )
      .all(since, until);
    const spent =
      db
        .query<{ c: number | null }, [number, number]>(
          "SELECT SUM(usd) AS c FROM budget_ledger WHERE ts > ? AND ts <= ?",
        )
        .get(since, until)?.c ?? 0;
    const count = (sql: string) => db.query<{ n: number }, []>(sql).get()?.n ?? 0;
    return {
      rows,
      spent,
      approvals: count("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'"),
      reviews: count("SELECT COUNT(*) AS n FROM runs WHERE state = 'REVIEWING'"),
    };
  });
  const ran: SummaryRun[] = base.rows.map((r) => {
    let files: SummaryRun["files"] = null;
    if (r.state === "KEPT" || r.state === "REVIEWING" || r.state === "ROLLED_BACK") {
      try {
        const c = changesOf(home, r.id, now);
        if (c.added + c.modified + c.deleted > 0) files = { added: c.added, modified: c.modified, deleted: c.deleted };
      } catch {}
    }
    return {
      runId: r.id,
      botId: r.agent_id,
      botName: r.bot ?? "A bot",
      goal: r.goal,
      state: r.state,
      costUsd: r.cost,
      summary: r.summary,
      error: r.error,
      routine: r.routine,
      files,
      undoable: r.state === "KEPT" && files !== null,
    };
  });
  return {
    kind: "summary",
    since,
    until,
    ran,
    done: ran.filter((r) => r.state !== "FAILED").length,
    failed: ran.filter((r) => r.state === "FAILED").length,
    spentUsd: base.spent,
    dayLimitUsd: o.dayLimitUsd ?? null,
    waiting: { approvals: base.approvals, reviews: base.reviews },
  };
}

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};
const money = (n: number) => (n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The summary as plain text (the chat and your phone), or null when there's nothing to tell. */
export function summaryText(s: DailySummary): string | null {
  if (!s.ran.length && !s.waiting.approvals && !s.waiting.reviews) return null;
  const head = [
    `${plural(s.done, "task")} done`,
    s.failed ? `${s.failed} didn't finish` : "",
    `${money(s.spentUsd)} spent${s.dayLimitUsd !== null ? ` (daily limit ${money(s.dayLimitUsd)})` : ""}`,
  ].filter(Boolean);
  const lines = [`Your day: ${head.join(", ")}.`];
  for (const r of s.ran.slice(0, 8)) {
    const what = r.state === "FAILED" ? `didn't finish: ${clip(r.goal, 70)}` : clip(r.summary ?? r.goal, 80);
    const files = r.files ? ` (${plural(r.files.added + r.files.modified + r.files.deleted, "file")} changed)` : "";
    lines.push(`• ${r.botName}${r.routine ? `, ${r.routine}` : ""}: ${what}${files}`);
  }
  if (s.ran.length > 8) lines.push(`• and ${s.ran.length - 8} more`);
  const waiting = [
    s.waiting.approvals ? plural(s.waiting.approvals, "spending pause") : "",
    s.waiting.reviews ? plural(s.waiting.reviews, "change to review", "changes to review") : "",
  ].filter(Boolean);
  if (waiting.length) lines.push(`Waiting for you: ${waiting.join(", ")}.`);
  return lines.join("\n");
}

/**
 * Makes the daily summary now: everything since the last one (or since the start of today), into your
 * main bot's chat. Your phone gets it from there (packages/phone). Returns null text on a quiet day.
 */
export function postSummary(
  home: string,
  o: { now?: () => number; dayLimitUsd?: number | null } = {},
): { text: string | null; summary: DailySummary } {
  const now = o.now ?? Date.now;
  const t = now();
  const d = new Date(t);
  const since = lastSummaryAt(home) ?? new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const summary = composeSummary(home, since, t, { dayLimitUsd: o.dayLimitUsd ?? null, now });
  setLastSummaryAt(home, t);
  const text = summaryText(summary);
  if (text) addBotMessage(home, DEFAULT_AGENT_ID, text, summary as unknown as Record<string, unknown>, now);
  return { text, summary };
}

const lastFile = (home: string) => join(covoPaths(home).state, "last-summary");

/** When the last daily summary was made, if ever. */
export function lastSummaryAt(home: string): number | null {
  try {
    const n = Number(readFileSync(lastFile(home), "utf8").trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function setLastSummaryAt(home: string, t: number): void {
  writeFileSync(lastFile(home), `${t}\n`, { mode: 0o600 });
}
