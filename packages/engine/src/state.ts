import type { Database } from "bun:sqlite";
import { canonicalJson } from "@covo/core";
import { appendAudit } from "@covo/db";

export type RunState =
  | "QUEUED"
  | "PREPARING"
  | "RUNNING"
  | "AWAITING_APPROVAL"
  | "REVIEWING"
  | "SUCCEEDED"
  | "STOPPED"
  | "FAILED"
  | "KEPT"
  | "DISCARDED";

const FINISHED: RunState[] = ["REVIEWING", "SUCCEEDED", "STOPPED", "FAILED"];

/**
 * Moves a run to its next state: the runs row, the activity log and the events table, in one
 * transaction, so a crash never leaves them disagreeing.
 */
export function recordState(
  db: Database,
  runId: string,
  from: RunState,
  to: RunState,
  extra: { summary?: string; error?: string; actor?: string; detail?: Record<string, unknown> } = {},
  now: () => number = Date.now,
): void {
  const t = now();
  db.transaction(() => {
    db.query(
      `UPDATE runs SET state = ?, summary = COALESCE(?, summary), error = COALESCE(?, error),
         started_at = CASE WHEN ? = 'RUNNING' THEN ? ELSE started_at END,
         finished_at = CASE WHEN ? THEN ? ELSE finished_at END
       WHERE id = ?`,
    ).run(to, extra.summary ?? null, extra.error ?? null, to, t, FINISHED.includes(to) ? 1 : 0, t, runId);
    const detail: Record<string, unknown> = { from, to, ...extra.detail };
    if (extra.summary !== undefined) detail.summary = extra.summary;
    if (extra.error !== undefined) detail.error = extra.error;
    appendAudit(db, { actor: extra.actor ?? "system", action: "run.state", runId, target: to, detail }, now);
    db.query("INSERT INTO events (run_id, ts, type, payload_json) VALUES (?, ?, 'run.state', ?)").run(
      runId,
      t,
      canonicalJson({ from, to }),
    );
  }).immediate();
}
