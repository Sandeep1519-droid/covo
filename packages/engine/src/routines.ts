import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { covoPaths, newId } from "@covo/core";
import { appendAudit, migrate, openDb } from "@covo/db";
import { RunError } from "./run.ts";
import { describeSchedule, nextRun, parseSchedule, ScheduleError } from "./schedule.ts";

// Routines (Phase 3 M6): a bot does a task on a schedule. Covo's service starts them on time (see
// apps/cli/src/service/routines.ts); everything here is the record of them, in the database.

export interface Routine {
  id: string;
  name: string;
  botId: string;
  botName: string;
  task: string;
  /** As you wrote it ("weekdays 9:00"), and in words ("Weekdays at 09:00"). */
  schedule: string;
  scheduleText: string;
  status: "active" | "paused";
  model: string | null;
  runLimitUsd: number | null;
  /** Message your phone only if something needs you. */
  quiet: boolean;
  nextAt: number | null;
  lastAt: number | null;
  lastError: string | null;
  /** Its latest run, if any. */
  lastRun: { id: string; state: string; costUsd: number; finishedAt: number | null } | null;
  createdAt: number;
}

interface Row {
  id: string;
  name: string;
  agent_id: string;
  bot_name: string | null;
  task: string;
  schedule: string;
  model: string | null;
  run_limit_usd: number | null;
  quiet: number;
  status: "active" | "paused";
  next_at: number | null;
  last_at: number | null;
  last_error: string | null;
  created_at: number;
  run_id: string | null;
  run_state: string | null;
  run_cost: number | null;
  run_finished: number | null;
}

const SELECT = `SELECT t.id, t.name, t.agent_id, a.name AS bot_name, t.task, t.schedule, t.model, t.run_limit_usd, t.quiet,
    t.status, t.next_at, t.last_at, t.last_error, t.created_at,
    r.id AS run_id, r.state AS run_state, r.cost_usd AS run_cost, r.finished_at AS run_finished
  FROM routines t LEFT JOIN agents a ON a.id = t.agent_id
  LEFT JOIN runs r ON r.id = (SELECT id FROM runs WHERE routine_id = t.id ORDER BY created_at DESC, id DESC LIMIT 1)`;

function toRoutine(r: Row): Routine {
  let scheduleText = r.schedule;
  try {
    scheduleText = describeSchedule(parseSchedule(r.schedule));
  } catch {}
  return {
    id: r.id,
    name: r.name,
    botId: r.agent_id,
    botName: r.bot_name ?? "",
    task: r.task,
    schedule: r.schedule,
    scheduleText,
    status: r.status,
    model: r.model,
    runLimitUsd: r.run_limit_usd,
    quiet: r.quiet === 1,
    nextAt: r.next_at,
    lastAt: r.last_at,
    lastError: r.last_error,
    lastRun: r.run_id
      ? { id: r.run_id, state: r.run_state ?? "", costUsd: r.run_cost ?? 0, finishedAt: r.run_finished }
      : null,
    createdAt: r.created_at,
  };
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

function findBotId(db: Database, nameOrId: string): string {
  const b = db
    .query<{ id: string }, [string, string]>(
      "SELECT id FROM agents WHERE (id = ? OR lower(name) = lower(?)) AND status != 'archived'",
    )
    .get(nameOrId, nameOrId);
  if (!b) throw new RunError(`No bot called "${nameOrId}".`);
  return b.id;
}

function find(db: Database, nameOrId: string): Row {
  const r = db
    .query<Row, [string, string]>(
      `${SELECT} WHERE (t.id = ? OR lower(t.name) = lower(?)) AND t.status != 'removed' ORDER BY t.created_at DESC`,
    )
    .get(nameOrId, nameOrId);
  if (!r) throw new RunError(`No routine called "${nameOrId}". See them with: covo routines`);
  return r;
}

function checkName(db: Database, name: string, except?: string): string {
  const n = name.trim().replace(/\s+/g, " ");
  if (!n || n.length > 60) throw new RunError("A routine's name must be 1–60 characters.");
  const clash = db
    .query<{ id: string }, [string, string]>(
      "SELECT id FROM routines WHERE lower(name) = lower(?) AND status != 'removed' AND id != ?",
    )
    .get(n, except ?? "");
  if (clash) throw new RunError(`There's already a routine called "${n}".`);
  return n;
}

function checkTask(task: string): string {
  const t = task.trim();
  if (!t) throw new RunError("What should the routine do? Give it a task.");
  if (t.length > 4_000) throw new RunError("A routine's task can be at most 4,000 characters.");
  return t;
}

function checkLimit(v: number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  if (!Number.isFinite(v) || v < 0) throw new RunError("A spending limit is a dollar amount of 0 or more.");
  return v;
}

/** Reads the schedule, or explains why it can't. */
function schedule(every: string) {
  try {
    return parseSchedule(every);
  } catch (e) {
    if (e instanceof ScheduleError) throw new RunError(e.message);
    throw e;
  }
}

export interface NewRoutine {
  name: string;
  bot: string;
  task: string;
  every: string;
  model?: string | null;
  runLimitUsd?: number | null;
  quiet?: boolean;
}

export function addRoutine(home: string, r: NewRoutine, now: () => number = Date.now): Routine {
  return withDb(home, now, (db) => {
    const name = checkName(db, r.name);
    const task = checkTask(r.task);
    const s = schedule(r.every);
    const botId = findBotId(db, r.bot);
    const id = newId("rtn", now());
    const t = now();
    db.transaction(() => {
      db.query(
        `INSERT INTO routines (id, agent_id, name, task, schedule, model, run_limit_usd, quiet, next_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        botId,
        name,
        task,
        r.every.trim(),
        r.model ?? null,
        checkLimit(r.runLimitUsd),
        r.quiet ? 1 : 0,
        nextRun(s, t),
        t,
        t,
      );
      appendAudit(
        db,
        {
          actor: "user",
          action: "routine.created",
          target: id,
          detail: { name, bot: botId, schedule: r.every.trim() },
        },
        now,
      );
    })();
    return toRoutine(find(db, id));
  });
}

export function listRoutines(home: string, o: { bot?: string; now?: () => number } = {}): Routine[] {
  return withDb(home, o.now ?? Date.now, (db) => {
    const botId = o.bot ? findBotId(db, o.bot) : null;
    return db
      .query<Row, []>(`${SELECT} WHERE t.status != 'removed' ORDER BY t.created_at`)
      .all()
      .filter((r) => !botId || r.agent_id === botId)
      .map(toRoutine);
  });
}

export function getRoutine(home: string, nameOrId: string, now: () => number = Date.now): Routine {
  return withDb(home, now, (db) => toRoutine(find(db, nameOrId)));
}

export interface RoutineChanges {
  name?: string;
  task?: string;
  every?: string;
  status?: "active" | "paused";
  model?: string | null;
  runLimitUsd?: number | null;
  quiet?: boolean;
}

export function updateRoutine(
  home: string,
  nameOrId: string,
  c: RoutineChanges,
  now: () => number = Date.now,
): Routine {
  return withDb(home, now, (db) => {
    const r = find(db, nameOrId);
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    const changed: Record<string, unknown> = {};
    const set = (col: string, v: string | number | null, key: string, shown: unknown = v) => {
      sets.push(`${col} = ?`);
      vals.push(v);
      changed[key] = shown;
    };
    if (c.name !== undefined) set("name", checkName(db, c.name, r.id), "name");
    if (c.task !== undefined) set("task", checkTask(c.task), "task");
    let every = r.schedule;
    if (c.every !== undefined) {
      schedule(c.every);
      every = c.every.trim();
      set("schedule", every, "schedule");
    }
    if (c.model !== undefined) set("model", c.model, "model");
    if (c.runLimitUsd !== undefined) set("run_limit_usd", checkLimit(c.runLimitUsd), "runLimitUsd");
    if (c.quiet !== undefined) set("quiet", c.quiet ? 1 : 0, "quiet", c.quiet);
    if (c.status !== undefined) {
      if (c.status !== "active" && c.status !== "paused") throw new RunError('Status must be "active" or "paused".');
      set("status", c.status, "status");
    }
    // A new schedule, or waking from a pause, starts counting from now (no burst of missed runs).
    if (c.every !== undefined || (c.status === "active" && r.status === "paused")) {
      set("next_at", nextRun(schedule(every), now()), "nextAt");
    }
    if (!sets.length) return toRoutine(r);
    db.transaction(() => {
      db.query(`UPDATE routines SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).run(...vals, now(), r.id);
      appendAudit(db, { actor: "user", action: "routine.changed", target: r.id, detail: changed }, now);
    })();
    return toRoutine(find(db, r.id));
  });
}

/** Removes a routine. Its runs and their records stay. */
export function removeRoutine(home: string, nameOrId: string, now: () => number = Date.now): Routine {
  return withDb(home, now, (db) => {
    const r = find(db, nameOrId);
    db.transaction(() => {
      db.query("UPDATE routines SET status = 'removed', next_at = NULL, updated_at = ? WHERE id = ?").run(now(), r.id);
      appendAudit(db, { actor: "user", action: "routine.removed", target: r.id, detail: { name: r.name } }, now);
    })();
    return toRoutine(r);
  });
}

/** A routine's latest runs, newest first. */
export function routineRuns(
  home: string,
  nameOrId: string,
  limit = 10,
  now: () => number = Date.now,
): {
  id: string;
  state: string;
  costUsd: number;
  createdAt: number;
  finishedAt: number | null;
  error: string | null;
  summary: string | null;
}[] {
  return withDb(home, now, (db) => {
    const r = find(db, nameOrId);
    return db
      .query<
        {
          id: string;
          state: string;
          cost: number;
          created: number;
          finished: number | null;
          error: string | null;
          summary: string | null;
        },
        [string, number]
      >(
        `SELECT id, state, cost_usd AS cost, created_at AS created, finished_at AS finished, error, summary
         FROM runs WHERE routine_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(r.id, limit)
      .map((x) => ({
        id: x.id,
        state: x.state,
        costUsd: x.cost,
        createdAt: x.created,
        finishedAt: x.finished,
        error: x.error,
        summary: x.summary,
      }));
  });
}

/** For the scheduler: active routines due by `t`, oldest first. */
export function dueRoutines(home: string, t: number, now: () => number = Date.now): Routine[] {
  return withDb(home, now, (db) =>
    db
      .query<Row, [number]>(
        `${SELECT} WHERE t.status = 'active' AND t.next_at IS NOT NULL AND t.next_at <= ? ORDER BY t.next_at`,
      )
      .all(t)
      .map(toRoutine),
  );
}

/**
 * For the scheduler: this occurrence is dealt with. `started` records a start; `error` why it couldn't;
 * `note` goes in the activity log (a missed or skipped run). The next time is counted from `t`.
 */
export function settleRoutine(
  home: string,
  id: string,
  o: { t: number; started?: boolean; error?: string | null; note?: Record<string, unknown> },
  now: () => number = Date.now,
): void {
  withDb(home, now, (db) => {
    const r = db.query<{ schedule: string }, [string]>("SELECT schedule FROM routines WHERE id = ?").get(id);
    if (!r) return;
    let next: number | null = null;
    try {
      next = nextRun(parseSchedule(r.schedule), o.t);
    } catch {}
    db.transaction(() => {
      db.query(
        `UPDATE routines SET next_at = ?, last_at = CASE WHEN ? THEN ? ELSE last_at END,
           last_error = ?, updated_at = ? WHERE id = ?`,
      ).run(next, o.started ? 1 : 0, o.t, o.error ?? null, now(), id);
      if (o.note) appendAudit(db, { actor: "system", action: "routine.skipped", target: id, detail: o.note }, now);
    })();
  });
}

/** Does a routine have a task that hasn't finished yet? (It doesn't start twice at once.) */
export function routineBusy(home: string, id: string, now: () => number = Date.now): boolean {
  return withDb(home, now, (db) =>
    Boolean(
      db
        .query<{ id: string }, [string]>(
          "SELECT id FROM runs WHERE routine_id = ? AND state IN ('QUEUED','PREPARING','RUNNING','AWAITING_APPROVAL') LIMIT 1",
        )
        .get(id),
    ),
  );
}
