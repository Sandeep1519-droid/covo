import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { covoPaths, newId } from "@covo/core";
import { appendAudit, DEFAULT_AGENT_ID, DEFAULT_DEPT_ID, migrate, openDb } from "@covo/db";
import { RunError } from "./run.ts";

// Bots: a name, a purpose, the models it uses in order, and how independently it works (ADR-010).
// Removing a bot archives it, so its runs and activity log stay readable.

export type Level = "supervised" | "automatic" | "full";
export const LEVELS: readonly Level[] = ["supervised", "automatic", "full"];

export interface Bot {
  id: string;
  name: string;
  purpose: string;
  department: string;
  /** Saved model names (or model names) in order; empty means "the default model". */
  models: string[];
  level: Level;
  /** This bot's own spending limit per task, in dollars; null = the general one. */
  taskLimitUsd: number | null;
  status: "active" | "paused" | "archived";
  shape: string;
  color: string;
  runs: number;
  lastRunAt: number | null;
}

const SHAPES = ["Blob", "Pebble", "Cloud", "Bean", "Drop", "Gem", "Leaf", "Shell", "Bubble", "Spark", "Moon", "Star"];
const COLORS = ["sky", "mint", "coral", "lavender", "sun", "rose", "teal", "peach", "lime", "violet"];

interface Row {
  id: string;
  name: string;
  purpose: string;
  department: string;
  model_chain: string;
  level: Level;
  run_limit_usd: number | null;
  status: Bot["status"];
  avatar_shape: string;
  avatar_color: string;
  runs: number;
  last_run: number | null;
}

const SELECT = `SELECT a.id, a.name, a.purpose, d.name AS department, a.model_chain, a.level, a.run_limit_usd, a.status,
    a.avatar_shape, a.avatar_color,
    (SELECT COUNT(*) FROM runs r WHERE r.agent_id = a.id) AS runs,
    (SELECT MAX(created_at) FROM runs r WHERE r.agent_id = a.id) AS last_run
  FROM agents a JOIN departments d ON d.id = a.department_id`;

const toBot = (r: Row): Bot => ({
  id: r.id,
  name: r.name,
  purpose: r.purpose,
  department: r.department,
  models: JSON.parse(r.model_chain) as string[],
  level: r.level,
  taskLimitUsd: r.run_limit_usd,
  status: r.status,
  shape: r.avatar_shape,
  color: r.avatar_color,
  runs: r.runs,
  lastRunAt: r.last_run,
});

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

function checkName(name: string): string {
  const n = name.trim().replace(/\s+/g, " ");
  if (!n || n.length > 40) throw new RunError("A bot's name must be 1–40 characters.");
  return n;
}

function checkLimit(v: number | null): number | null {
  if (v !== null && (!Number.isFinite(v) || v < 0)) throw new RunError("A limit must be a dollar amount of 0 or more.");
  return v;
}

function checkModels(models: string[]): string[] {
  const m = models.map((x) => x.trim()).filter(Boolean);
  if (new Set(m).size !== m.length) throw new RunError("The same model is listed twice.");
  if (m.length > 5) throw new RunError("Up to 5 models per bot.");
  return m;
}

function find(db: Database, nameOrId: string, includeArchived = false): Row {
  const rows = db
    .query<Row, [string, string]>(`${SELECT} WHERE (a.id = ? OR lower(a.name) = lower(?)) ORDER BY a.created_at`)
    .all(nameOrId, nameOrId)
    .filter((r) => includeArchived || r.status !== "archived");
  const r = rows[0];
  if (!r) throw new RunError(`No bot called "${nameOrId}". See them with: covo bots`);
  return r;
}

export function listBots(home: string, o: { includeArchived?: boolean; now?: () => number } = {}): Bot[] {
  return withDb(home, o.now ?? Date.now, (db) =>
    db
      .query<Row, []>(`${SELECT} ORDER BY a.created_at, a.name`)
      .all()
      .filter((r) => o.includeArchived || r.status !== "archived")
      .map(toBot),
  );
}

export function findBot(home: string, nameOrId: string, now: () => number = Date.now): Bot {
  return withDb(home, now, (db) => toBot(find(db, nameOrId)));
}

export interface NewBot {
  name: string;
  purpose?: string;
  models?: string[];
  level?: Level;
  taskLimitUsd?: number | null;
  departmentId?: string;
}

export function createBot(home: string, b: NewBot, now: () => number = Date.now): Bot {
  return withDb(home, now, (db) => {
    const name = checkName(b.name);
    const models = checkModels(b.models ?? []);
    const level = b.level ?? "automatic";
    if (!LEVELS.includes(level)) throw new RunError(`Level must be one of: ${LEVELS.join(", ")}.`);
    const dept = b.departmentId ?? DEFAULT_DEPT_ID;
    const clash = db
      .query<{ id: string }, [string, string]>(
        "SELECT id FROM agents WHERE department_id = ? AND lower(name) = lower(?) AND status != 'archived'",
      )
      .get(dept, name);
    if (clash) throw new RunError(`There's already a bot called "${name}".`);
    const id = newId("bot", now());
    const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)] as T;
    db.transaction(() => {
      db.query(
        `INSERT INTO agents (id, department_id, name, avatar_shape, avatar_color, purpose, model_chain, level, run_limit_usd, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        dept,
        name,
        pick(SHAPES),
        pick(COLORS),
        b.purpose?.trim() ?? "",
        JSON.stringify(models),
        level,
        checkLimit(b.taskLimitUsd ?? null),
        now(),
      );
      appendAudit(
        db,
        { actor: "user", action: "bot.created", target: id, detail: { name, models, level, department: dept } },
        now,
      );
    })();
    return toBot(find(db, id));
  });
}

export interface BotChanges {
  name?: string;
  purpose?: string;
  models?: string[];
  level?: Level;
  /** Dollars per task; null = use the general limit. */
  taskLimitUsd?: number | null;
}

export function updateBot(home: string, nameOrId: string, c: BotChanges, now: () => number = Date.now): Bot {
  return withDb(home, now, (db) => {
    const r = find(db, nameOrId);
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    const changed: Record<string, unknown> = {};
    if (c.name !== undefined) {
      const name = checkName(c.name);
      const clash = db
        .query<{ id: string }, [string, string]>(
          "SELECT id FROM agents WHERE lower(name) = lower(?) AND id != ? AND status != 'archived'",
        )
        .get(name, r.id);
      if (clash) throw new RunError(`There's already a bot called "${name}".`);
      sets.push("name = ?");
      vals.push(name);
      changed.name = name;
    }
    if (c.purpose !== undefined) {
      sets.push("purpose = ?");
      vals.push(c.purpose.trim());
      changed.purpose = c.purpose.trim();
    }
    if (c.models !== undefined) {
      const m = checkModels(c.models);
      sets.push("model_chain = ?");
      vals.push(JSON.stringify(m));
      changed.models = m;
    }
    if (c.level !== undefined) {
      if (!LEVELS.includes(c.level)) throw new RunError(`Level must be one of: ${LEVELS.join(", ")}.`);
      sets.push("level = ?");
      vals.push(c.level);
      changed.level = c.level;
    }
    if (c.taskLimitUsd !== undefined) {
      const v = checkLimit(c.taskLimitUsd);
      sets.push("run_limit_usd = ?");
      vals.push(v);
      changed.taskLimitUsd = v;
    }
    if (!sets.length) return toBot(r);
    db.transaction(() => {
      db.query(`UPDATE agents SET ${sets.join(", ")} WHERE id = ?`).run(...vals, r.id);
      appendAudit(db, { actor: "user", action: "bot.updated", target: r.id, detail: changed }, now);
    })();
    return toBot(find(db, r.id));
  });
}

export function archiveBot(home: string, nameOrId: string, now: () => number = Date.now): Bot {
  return withDb(home, now, (db) => {
    const r = find(db, nameOrId);
    if (r.id === DEFAULT_AGENT_ID) throw new RunError(`${r.name} is your main bot and can't be removed.`);
    const busy = db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM runs WHERE agent_id = ? AND state IN ('QUEUED','PREPARING','RUNNING')",
      )
      .get(r.id);
    if ((busy?.n ?? 0) > 0) throw new RunError(`${r.name} is working on a task right now. Try again when it's done.`);
    db.transaction(() => {
      // The name gets a suffix so a new bot can reuse it (names are unique per department).
      db.query("UPDATE agents SET status = 'archived', name = ? WHERE id = ?").run(
        `${r.name} (archived ${r.id.slice(-6)})`,
        r.id,
      );
      appendAudit(db, { actor: "user", action: "bot.archived", target: r.id, detail: { name: r.name } }, now);
    })();
    return { ...toBot(r), status: "archived" };
  });
}

export interface ApprovalStreak {
  botName: string;
  /** Spending pauses you approved for this bot in the period. */
  approved: number;
  /** The task limit it runs with now: its own, or null for the general one. */
  taskLimitUsd: number | null;
}

/** How often you've let this run's bot spend past its limit recently (to suggest a higher limit). */
export function approvalStreak(
  home: string,
  runId: string,
  sinceMs: number,
  now: () => number = Date.now,
): ApprovalStreak {
  return withDb(home, now, (db) => {
    const bot = db
      .query<{ id: string; name: string; run_limit_usd: number | null }, [string]>(
        "SELECT a.id, a.name, a.run_limit_usd FROM runs r JOIN agents a ON a.id = r.agent_id WHERE r.id = ?",
      )
      .get(runId);
    if (!bot) throw new RunError(`No run ${runId}.`);
    const n = db
      .query<{ n: number }, [string, number]>(
        `SELECT COUNT(*) AS n FROM approvals p JOIN runs r ON r.id = p.run_id
         WHERE r.agent_id = ? AND p.kind = 'spend' AND p.status = 'approved' AND p.decided_at >= ?`,
      )
      .get(bot.id, sinceMs);
    return { botName: bot.name, approved: n?.n ?? 0, taskLimitUsd: bot.run_limit_usd };
  });
}
