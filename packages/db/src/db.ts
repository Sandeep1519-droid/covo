import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import m0001 from "../migrations/0001_init.sql" with { type: "text" };
import m0002 from "../migrations/0002_run_summary.sql" with { type: "text" };

/** Ordered list of migrations. Append only; never edit a shipped one. */
export const MIGRATIONS: ReadonlyArray<{ version: number; name: string; sql: string }> = [
  { version: 1, name: "0001_init", sql: m0001 },
  { version: 2, name: "0002_run_summary", sql: m0002 },
];

export function openDb(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  return db;
}

/** Applies any migrations not yet recorded. Returns the versions it applied. */
export function migrate(db: Database, now: () => number = Date.now): number[] {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)",
  );
  const done = new Set(
    db
      .query<{ version: number }, []>("SELECT version FROM schema_migrations")
      .all()
      .map((r) => r.version),
  );
  const applied: number[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.query("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        m.version,
        m.name,
        now(),
      );
    }).immediate();
    applied.push(m.version);
  }
  return applied;
}

export function schemaVersion(db: Database): number {
  const row = db.query<{ v: number | null }, []>("SELECT MAX(version) AS v FROM schema_migrations").get();
  return row?.v ?? 0;
}
