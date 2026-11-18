import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { WorkspaceCloner } from "@covo/platform";
import type { Change, ChangeKind } from "./cow.ts";
import { type EntryKind, entryAt } from "./manifest.ts";

// Undo for kept changes (ADR-010). Just before a run's changes land in your workspace, the files
// they replace or delete are saved as instant APFS clones in runs/<id>/undo/, together with a
// fingerprint of what was kept. `undo` puts the old versions back, but refuses (all or nothing) if
// you changed any of those files since, so it never overwrites your own later work.

export interface UndoEntry {
  path: string;
  kind: ChangeKind;
  entry: EntryKind;
  /** The old version was saved (modified or deleted files and symlinks). */
  saved: boolean;
  /** Old symlink target. */
  oldLink?: string;
  /** Fingerprint of what was kept: file hash or symlink target; null for deletions and folders. */
  keptPrint: string | null;
}

export interface UndoRecord {
  version: 1;
  workspace: string;
  keptAt: number;
  undoneAt?: number;
  entries: UndoEntry[];
}

export interface UndoConflict {
  path: string;
  reason: "changed-since-keep" | "deleted-since-keep" | "created-since-keep";
}

export interface UndoResult {
  restored: string[];
  conflicts: UndoConflict[];
}

export class UndoError extends Error {}

const UNDO = "undo";
const RECORD = "undo.json";

function hashFile(p: string): string {
  return new Bun.CryptoHasher("sha256").update(readFileSync(p)).digest("hex");
}

/** Fingerprint of what's at a path now: file hash, symlink target, "dir", or null if nothing. */
function printOf(p: string): string | null {
  const e = entryAt(p);
  if (!e) return null;
  if (e.kind === "file") return hashFile(p);
  if (e.kind === "symlink") return `link:${e.link}`;
  return "dir";
}

/** Saves what `changes` will replace in `workspace`, before they are applied. */
export function saveUndo(
  runDir: string,
  workspace: string,
  copy: string,
  changes: Change[],
  clone: WorkspaceCloner,
  now: number,
): void {
  const base = join(runDir, UNDO);
  rmSync(base, { recursive: true, force: true }); // a fresh record per keep
  const files = join(base, "files");
  mkdirSync(files, { recursive: true });
  const entries: UndoEntry[] = [];
  for (const c of changes) {
    const old = join(workspace, c.path);
    const e: UndoEntry = { path: c.path, kind: c.kind, entry: c.entry, saved: false, keptPrint: null };
    const cur = entryAt(old);
    if (c.kind !== "added" && cur && cur.kind !== "dir") {
      const dst = join(files, c.path);
      mkdirSync(dirname(dst), { recursive: true });
      if (cur.kind === "symlink") e.oldLink = readlinkSync(old);
      else clone.cloneFile(old, dst);
      e.saved = true;
    }
    if (c.kind !== "deleted" && c.entry !== "dir") e.keptPrint = printOf(join(copy, c.path));
    entries.push(e);
  }
  const rec: UndoRecord = { version: 1, workspace, keptAt: now, entries };
  writeFileSync(join(base, RECORD), JSON.stringify(rec));
}

export function readUndo(runDir: string): UndoRecord | null {
  const p = join(runDir, UNDO, RECORD);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as UndoRecord;
}

/** Puts the old versions back. All or nothing: any file changed since the keep stops the undo. */
export function applyUndo(runDir: string, clone: WorkspaceCloner, now: number): UndoResult {
  const rec = readUndo(runDir);
  if (!rec) throw new UndoError("There's nothing to undo for this run (the undo data is missing or was cleaned up).");
  if (rec.undoneAt) throw new UndoError("This run was already undone.");
  const files = join(runDir, UNDO, "files");
  const conflicts: UndoConflict[] = [];
  for (const e of rec.entries) {
    if (e.entry === "dir") continue;
    const cur = printOf(join(rec.workspace, e.path));
    if (e.kind === "deleted") {
      if (cur !== null) conflicts.push({ path: e.path, reason: "created-since-keep" });
    } else if (cur === null) conflicts.push({ path: e.path, reason: "deleted-since-keep" });
    else if (cur !== e.keptPrint) conflicts.push({ path: e.path, reason: "changed-since-keep" });
  }
  if (conflicts.length) return { restored: [], conflicts };

  const restored: string[] = [];
  // Recreate deleted folders first (shallowest first), so files can go back into them.
  for (const e of rec.entries.filter((x) => x.entry === "dir" && x.kind === "deleted")) {
    mkdirSync(join(rec.workspace, e.path), { recursive: true });
  }
  for (const e of rec.entries) {
    if (e.entry === "dir") continue;
    const target = join(rec.workspace, e.path);
    if (e.kind === "added") {
      unlinkSync(target);
    } else {
      mkdirSync(dirname(target), { recursive: true });
      const tmp = `${target}.covo-undo-${process.pid}`;
      if (e.oldLink !== undefined) symlinkSync(e.oldLink, tmp);
      else clone.cloneFile(join(files, e.path), tmp);
      renameSync(tmp, target); // atomic: replaces what's there
    }
    restored.push(e.path);
  }
  // Remove folders the run added, deepest first, if they're empty now.
  const addedDirs = rec.entries
    .filter((x) => x.entry === "dir" && x.kind === "added")
    .sort((a, b) => b.path.length - a.path.length);
  for (const e of addedDirs) {
    const p = join(rec.workspace, e.path);
    try {
      if (readdirSync(p).length === 0) rmdirSync(p);
    } catch {}
  }
  rec.undoneAt = now;
  writeFileSync(join(runDir, UNDO, RECORD), JSON.stringify(rec));
  return { restored, conflicts: [] };
}

function sizeOf(dir: string): number {
  let n = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p, { throwIfNoEntry: false });
    if (!s) continue;
    n += s.isDirectory() ? sizeOf(p) : s.size;
  }
  return n;
}

/**
 * Keeps undo data for `maxAgeMs` and at most `maxBytes` in all (oldest removed first). Sizes are
 * counted in full even though APFS clones share disk space, so the real disk use is lower.
 * Returns the run ids whose undo data was removed.
 */
export function pruneUndo(runsDir: string, now: number, maxAgeMs: number, maxBytes: number): string[] {
  if (!existsSync(runsDir)) return [];
  const all: { id: string; keptAt: number; bytes: number }[] = [];
  for (const id of readdirSync(runsDir)) {
    const rec = readUndo(join(runsDir, id));
    if (!rec) continue;
    all.push({ id, keptAt: rec.keptAt, bytes: sizeOf(join(runsDir, id, UNDO)) });
  }
  all.sort((a, b) => a.keptAt - b.keptAt);
  const removed: string[] = [];
  let total = all.reduce((n, x) => n + x.bytes, 0);
  for (const x of all) {
    if (now - x.keptAt > maxAgeMs || total > maxBytes) {
      rmSync(join(runsDir, x.id, UNDO), { recursive: true, force: true });
      total -= x.bytes;
      removed.push(x.id);
    }
  }
  return removed;
}
