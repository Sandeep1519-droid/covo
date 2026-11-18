import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { covoPaths } from "@covo/core";
import { appendAudit, migrate, openDb } from "@covo/db";
import { cloner, type WorkspaceCloner } from "@covo/platform";
import {
  type Change,
  type Conflict,
  CowWorkspaces,
  type Hunk,
  pruneUndo,
  type UndoConflict,
  UndoError,
  unifiedDiff,
} from "@covo/sandbox";
import { RunError } from "./run.ts";
import { type RunState, recordState } from "./state.ts";

// Reviewing a run's changes: see them, keep them (copy into the real workspace), or discard them.
// Only a run in REVIEWING has changes waiting; keeping or discarding ends the review for good.

export interface FileReview {
  path: string;
  kind: Change["kind"];
  /** Text diff, when both sides are text. */
  hunks?: Hunk[];
  /** Why no text diff is shown: "binary", "too large", "folder", "symlink". */
  note?: string;
  /** The real workspace file was changed after the run started; keep will refuse it. */
  workspaceChanged: boolean;
}

export interface Review {
  runId: string;
  state: RunState;
  goal: string;
  summary: string | null;
  files: FileReview[];
  added: number;
  modified: number;
  deleted: number;
}

export interface KeepOutcome {
  runId: string;
  kept: string[];
  /** Changes left out by `only`; they are thrown away with the copy. */
  dropped: string[];
  conflicts: Conflict[];
}

const MAX_DIFF_BYTES = 1_000_000;

interface RunRow {
  id: string;
  state: RunState;
  goal: string;
  summary: string | null;
}

function withRun<T>(
  home: string,
  runId: string,
  now: () => number,
  fn: (db: Database, run: RunRow, cow: CowWorkspaces) => T,
  clone?: WorkspaceCloner,
): T {
  const paths = covoPaths(home);
  if (!existsSync(paths.db)) throw new RunError("Covo isn't set up yet. Run: covo init");
  const db = openDb(paths.db);
  try {
    migrate(db, now);
    const run = db.query<RunRow, [string]>("SELECT id, state, goal, summary FROM runs WHERE id = ?").get(runId);
    if (!run) throw new RunError(`No run ${runId}.`);
    return fn(db, run, new CowWorkspaces(paths.runs, clone ?? cloner()));
  } finally {
    db.close();
  }
}

function requireReviewing(run: RunRow, cow: CowWorkspaces): void {
  if (run.state !== "REVIEWING") {
    const why: Partial<Record<RunState, string>> = {
      KEPT: `its changes were already kept (undo them with: covo undo ${run.id.slice(-6)})`,
      ROLLED_BACK: "its changes were kept and then undone",
      DISCARDED: "its changes were already thrown away",
      SUCCEEDED: "it didn't change any files",
      STOPPED: "it was stopped, so its copy was thrown away",
      FAILED: "it failed, so its copy was thrown away",
    };
    throw new RunError(`Run ${run.id} has nothing to review: ${why[run.state] ?? `it is ${run.state}`}.`);
  }
  if (!existsSync(cow.wsPath(run.id))) throw new RunError(`The copy for run ${run.id} is missing.`);
}

const isText = (b: Buffer) => !b.includes(0);

/** What a run changed, with text diffs against the current workspace. */
export function reviewRun(home: string, runId: string, now: () => number = Date.now): Review {
  return withRun(home, runId, now, (_db, run, cow) => {
    requireReviewing(run, cow);
    const d = cow.diff(runId);
    const files: FileReview[] = [];
    for (const c of d.changes) {
      if (c.entry === "dir") continue;
      const v = cow.versions(runId, c.path);
      const f: FileReview = { path: c.path, kind: c.kind, workspaceChanged: v.workspaceChanged };
      if (c.entry === "symlink") f.note = "symlink";
      else if ((v.before?.length ?? 0) > MAX_DIFF_BYTES || (v.after?.length ?? 0) > MAX_DIFF_BYTES)
        f.note = "too large";
      else if ((v.before && !isText(v.before)) || (v.after && !isText(v.after))) f.note = "binary";
      else {
        const before = c.kind === "added" ? "" : (v.before?.toString("utf8") ?? "");
        const after = c.kind === "deleted" ? "" : (v.after?.toString("utf8") ?? "");
        f.hunks = unifiedDiff(before, after);
      }
      files.push(f);
    }
    return { runId, state: run.state, goal: run.goal, summary: run.summary, files, ...counts(d) };
  });
}

const counts = (d: { added: number; modified: number; deleted: number }) => ({
  added: d.added,
  modified: d.modified,
  deleted: d.deleted,
});

/**
 * Copies the run's changes into the real workspace and ends the review (KEPT). With `only`, keeps
 * just those files and throws the rest away. If any file was also changed in the workspace since the
 * run started, nothing is copied, the run stays in REVIEWING and the conflicts are returned.
 */
export function keepRun(
  home: string,
  runId: string,
  opts: { only?: string[]; now?: () => number; cloner?: WorkspaceCloner } = {},
): KeepOutcome {
  const now = opts.now ?? Date.now;
  return withRun(
    home,
    runId,
    now,
    (db, run, cow) => {
      requireReviewing(run, cow);
      return keepChanges(db, runId, cow, now, { only: opts.only, actor: "user" });
    },
    opts.cloner,
  );
}

/** How long undo data is kept, and how much at most (ADR-010; adjustable later). */
export const UNDO_MAX_AGE_MS = 30 * 86_400_000;
export const UNDO_MAX_BYTES = 2 * 1024 ** 3;

/**
 * Copies a REVIEWING run's changes into the workspace (all, or `only` these paths), saving undo
 * data first, and moves the run to KEPT. On a conflict nothing is applied and the run stays in
 * REVIEWING. Used by `covo keep` and by automatic bots.
 */
export function keepChanges(
  db: Database,
  runId: string,
  cow: CowWorkspaces,
  now: () => number,
  o: { only?: string[]; actor: "user" | "system" },
): KeepOutcome {
  const all = cow.diff(runId).changes;
  let only: string[] | undefined;
  if (o.only?.length) {
    const known = new Set(all.map((c) => c.path));
    const unknown = o.only.filter((p) => !known.has(p));
    if (unknown.length) throw new RunError(`Run ${runId} didn't change: ${unknown.join(", ")}`);
    // Keeping a file inside a new folder needs the folder too.
    const pick = new Set(o.only);
    for (const p of o.only) {
      const parts = p.split("/");
      for (let i = 1; i < parts.length; i++) {
        const parent = parts.slice(0, i).join("/");
        if (known.has(parent)) pick.add(parent);
      }
    }
    only = [...pick];
  }
  const r = cow.keep(runId, only);
  const files = (cs: Change[]) => cs.filter((c) => c.entry !== "dir").map((c) => c.path);
  const auto = o.actor === "system" ? { automatic: true } : {};
  if (r.conflicts.length) {
    appendAudit(
      db,
      {
        actor: o.actor,
        action: "run.keep",
        runId,
        decision: "deny",
        detail: {
          reason: "conflict",
          conflicts: r.conflicts.map((c) => ({ path: c.path, reason: c.reason })),
          ...auto,
        },
      },
      now,
    );
    return { runId, kept: [], dropped: [], conflicts: r.conflicts };
  }
  const kept = files(r.applied);
  const keptSet = new Set(r.applied.map((c) => c.path));
  const dropped = files(all.filter((c) => !keptSet.has(c.path)));
  const ws = cow.wsPath(runId);
  // Record what exactly was kept, so the activity log can prove which content landed.
  const hashOf = (c: Change) =>
    c.entry === "file" && c.kind !== "deleted"
      ? new Bun.CryptoHasher("sha256").update(readFileSync(join(ws, c.path))).digest("hex")
      : null;
  appendAudit(
    db,
    {
      actor: o.actor,
      action: "run.keep",
      runId,
      decision: "allow",
      detail: {
        kept: r.applied
          .filter((c) => c.entry !== "dir")
          .map((c) => ({ path: c.path, kind: c.kind, sha256: hashOf(c) })),
        dropped,
        ...auto,
      },
    },
    now,
  );
  recordState(db, runId, "REVIEWING", "KEPT", { actor: o.actor }, now);
  cow.dropCopy(runId);
  pruneUndo(cow.runsRoot, now(), UNDO_MAX_AGE_MS, UNDO_MAX_BYTES);
  return { runId, kept, dropped, conflicts: [] };
}

export interface UndoOutcome {
  runId: string;
  restored: string[];
  conflicts: UndoConflict[];
}

/** Puts back what a kept run changed (KEPT → ROLLED_BACK), unless you've changed those files since. */
export function undoRun(home: string, runId: string, now: () => number = Date.now): UndoOutcome {
  return withRun(home, runId, now, (db, run, cow) => {
    if (run.state === "ROLLED_BACK") throw new RunError(`Run ${runId} was already undone.`);
    if (run.state !== "KEPT") {
      throw new RunError(`Run ${runId} has nothing to undo: its changes were never kept (it is ${run.state}).`);
    }
    let r: ReturnType<CowWorkspaces["undo"]>;
    try {
      r = cow.undo(runId);
    } catch (e) {
      if (e instanceof UndoError) throw new RunError(e.message);
      throw e;
    }
    if (r.conflicts.length) {
      appendAudit(
        db,
        {
          actor: "user",
          action: "run.undo",
          runId,
          decision: "deny",
          detail: { reason: "conflict", conflicts: r.conflicts },
        },
        now,
      );
      return { runId, restored: [], conflicts: r.conflicts };
    }
    appendAudit(
      db,
      { actor: "user", action: "run.undo", runId, decision: "allow", detail: { restored: r.restored } },
      now,
    );
    recordState(db, runId, "KEPT", "ROLLED_BACK", { actor: "user" }, now);
    return { runId, restored: r.restored, conflicts: [] };
  });
}

/** Throws the run's changes away (DISCARDED). The run's records stay. */
export function discardRun(
  home: string,
  runId: string,
  now: () => number = Date.now,
): { runId: string; files: number } {
  return withRun(home, runId, now, (db, run, cow) => {
    requireReviewing(run, cow);
    const d = cow.diff(runId);
    recordState(
      db,
      runId,
      "REVIEWING",
      "DISCARDED",
      { actor: "user", detail: { files: d.added + d.modified + d.deleted } },
      now,
    );
    cow.dropCopy(runId);
    return { runId, files: d.added + d.modified + d.deleted };
  });
}
