import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { covoPaths } from "@covo/core";
import { appendAudit, migrate, openDb } from "@covo/db";

// "Pause all bots" (Phase 3 M4): while paused, no new task starts. Tasks already running finish
// their work; new ones wait in the service's queue and start when you resume. The switch is a file,
// so it survives restarts and the command line and the service see the same thing.

export interface PauseState {
  paused: boolean;
  /** When it was paused, and by whom ("you (app)", "you (terminal)"…). */
  since: number | null;
  by: string | null;
}

const file = (home: string) => join(covoPaths(home).state, "paused.json");

export function pauseState(home: string): PauseState {
  const p = file(home);
  if (!existsSync(p)) return { paused: false, since: null, by: null };
  try {
    const s = JSON.parse(readFileSync(p, "utf8")) as { since?: number; by?: string };
    return { paused: true, since: typeof s.since === "number" ? s.since : null, by: s.by ?? null };
  } catch {
    return { paused: true, since: null, by: null }; // a damaged file still means paused: the safe side
  }
}

export const isPaused = (home: string) => pauseState(home).paused;

/** Pauses or resumes all bots, and records it in the activity log. Returns the new state. */
export function setPaused(home: string, paused: boolean, by: string, now: () => number = Date.now): PauseState {
  const before = pauseState(home);
  if (before.paused === paused) return before;
  const p = file(home);
  if (paused) {
    mkdirSync(covoPaths(home).state, { recursive: true });
    writeFileSync(p, JSON.stringify({ since: now(), by }));
  } else rmSync(p, { force: true });
  const db = openDb(covoPaths(home).db);
  try {
    migrate(db, now);
    appendAudit(db, { actor: "user", action: paused ? "bots.paused" : "bots.resumed", detail: { by } }, now);
  } finally {
    db.close();
  }
  return pauseState(home);
}
