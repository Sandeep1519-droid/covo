import { existsSync } from "node:fs";
import { covoPaths } from "@covo/core";
import { migrate, openDb } from "@covo/db";
import { CowWorkspaces } from "@covo/sandbox";
import { decide } from "./budget.ts";
import { type RunState, recordState } from "./state.ts";

// Runs left behind when the process running them died (a crash, a closed terminal, a restart).
// The service checks for them when it starts: each becomes FAILED, any pending approval expires,
// and its workspace copy is thrown away, so the real workspace is never touched.

const ACTIVE: RunState[] = ["QUEUED", "PREPARING", "RUNNING", "AWAITING_APPROVAL"];

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists, but belongs to someone else
  }
}

export function recoverStaleRuns(
  home: string,
  o: { now?: () => number; alive?: (pid: number) => boolean } = {},
): string[] {
  const now = o.now ?? Date.now;
  const alive = o.alive ?? processAlive;
  const paths = covoPaths(home);
  if (!existsSync(paths.db)) return [];
  const db = openDb(paths.db);
  try {
    migrate(db, now);
    const rows = db
      .query<{ id: string; state: RunState; pid: number | null }, []>(
        `SELECT id, state, pid FROM runs WHERE state IN (${ACTIVE.map((s) => `'${s}'`).join(",")})`,
      )
      .all()
      .filter((r) => r.pid === null || (r.pid !== process.pid && !alive(r.pid)));
    const cow = new CowWorkspaces(paths.runs);
    for (const r of rows) {
      for (const a of db
        .query<{ id: string }, [string]>("SELECT id FROM approvals WHERE run_id = ? AND status = 'pending'")
        .all(r.id))
        decide(db, a.id, "expired", "system (run ended)", now);
      recordState(
        db,
        r.id,
        r.state,
        "FAILED",
        { error: "Covo stopped while this task ran. Your files are untouched.", actor: "system" },
        now,
      );
      cow.dropCopy(r.id);
    }
    return rows.map((r) => r.id);
  } finally {
    db.close();
  }
}
