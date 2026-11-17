import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type CovoPaths, covoPaths } from "@covo/core";
import { appendAudit } from "./audit.ts";
import { migrate, openDb } from "./db.ts";

export const DEFAULT_DEPT_ID = "dept_default";
export const DEFAULT_AGENT_ID = "bot_assistant";

export interface InitResult {
  /** false when Covo was already set up here (nothing was changed). */
  created: boolean;
  paths: CovoPaths;
  migrationsApplied: number[];
  workspace: string;
}

/** Creates the Covo folder, database, default department and main bot. Safe to run twice. */
export function initHome(home: string, now: () => number = Date.now): InitResult {
  const paths = covoPaths(home);
  for (const dir of [paths.state, paths.workspaces, paths.runs, paths.logs]) mkdirSync(dir, { recursive: true });
  const workspace = join(paths.workspaces, "default");
  mkdirSync(workspace, { recursive: true });

  const db = openDb(paths.db);
  try {
    const migrationsApplied = migrate(db, now);
    const exists = db.query("SELECT 1 FROM departments WHERE id = ?").get(DEFAULT_DEPT_ID);
    if (exists) return { created: false, paths, migrationsApplied, workspace };

    db.transaction(() => {
      const t = now();
      db.query(
        "INSERT INTO departments (id, name, workspace_path, max_concurrency, created_at) VALUES (?, 'Personal', ?, 1, ?)",
      ).run(DEFAULT_DEPT_ID, workspace, t);
      db.query(
        `INSERT INTO agents (id, department_id, name, avatar_shape, avatar_color, purpose, created_at)
         VALUES (?, ?, 'Assistant', 'Blob', 'sky', 'Your main bot', ?)`,
      ).run(DEFAULT_AGENT_ID, DEFAULT_DEPT_ID, t);
      appendAudit(
        db,
        {
          actor: "user",
          action: "system.init",
          target: home,
          detail: { department: DEFAULT_DEPT_ID, agent: DEFAULT_AGENT_ID },
        },
        now,
      );
    })();
    return { created: true, paths, migrationsApplied, workspace };
  } finally {
    db.close();
  }
}
