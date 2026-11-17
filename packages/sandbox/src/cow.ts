import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { canonicalJson, sha256Hex } from "@cw/core";
import { type CloneMethod, cloner, type WorkspaceCloner } from "@cw/platform";
import { buildManifest, type Entry, type EntryKind, entryAt, type Manifest, sameMeta } from "./manifest.ts";

// Copy-on-write workspaces.
//
//   snapshot  clone the department workspace into runs/<id>/ws and record a base manifest
//   diff      what the run changed, compared with the base manifest
//   keep      copy the run's changes back, refusing files someone else changed in the meantime
//   discard   delete the run's copy
//
// The real workspace is never touched until keep().

export interface Snapshot {
  runDir: string;
  wsPath: string;
  manifestHash: string;
  method: CloneMethod;
  entries: number;
}

export type ChangeKind = "added" | "modified" | "deleted";

export interface Change {
  path: string;
  kind: ChangeKind;
  entry: EntryKind;
  bytes: number;
}

export interface DiffSummary {
  changes: Change[];
  added: number;
  modified: number;
  deleted: number;
}

export interface Conflict {
  path: string;
  reason: "changed-in-workspace" | "deleted-in-workspace" | "created-in-workspace";
}

export interface KeepResult {
  applied: Change[];
  conflicts: Conflict[];
}

interface BaseFile {
  workspace: string;
  manifest: Manifest;
}

const BASE_MANIFEST = "base.manifest.json";

function fileHash(path: string): string {
  return new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");
}

export class CowWorkspaces {
  constructor(
    private readonly runsDir: string,
    private readonly clone: WorkspaceCloner = cloner(),
  ) {}

  runDir(runId: string): string {
    return join(this.runsDir, runId);
  }

  wsPath(runId: string): string {
    return join(this.runDir(runId), "ws");
  }

  snapshot(runId: string, workspace: string): Snapshot {
    const runDir = this.runDir(runId);
    if (existsSync(runDir)) throw new Error(`Run folder already exists: ${runDir}`);
    mkdirSync(runDir, { recursive: true });
    const manifest = buildManifest(workspace);
    const method = this.clone.cloneTree(workspace, this.wsPath(runId));
    const body = canonicalJson({ workspace, manifest } satisfies BaseFile);
    writeFileSync(join(runDir, BASE_MANIFEST), body);
    return {
      runDir,
      wsPath: this.wsPath(runId),
      manifestHash: sha256Hex(body),
      method,
      entries: Object.keys(manifest).length,
    };
  }

  private base(runId: string): BaseFile {
    return JSON.parse(readFileSync(join(this.runDir(runId), BASE_MANIFEST), "utf8")) as BaseFile;
  }

  diff(runId: string): DiffSummary {
    const { workspace, manifest: base } = this.base(runId);
    const ws = this.wsPath(runId);
    const now = buildManifest(ws);
    const changes: Change[] = [];
    for (const [path, e] of Object.entries(now)) {
      const b = base[path];
      if (!b) changes.push({ path, kind: "added", entry: e.kind, bytes: e.size });
      else if (!sameMeta(b, e) && !sameContent(b, e, join(ws, path), join(workspace, path))) {
        changes.push({ path, kind: "modified", entry: e.kind, bytes: e.size });
      }
    }
    for (const [path, b] of Object.entries(base)) {
      if (!now[path]) changes.push({ path, kind: "deleted", entry: b.kind, bytes: b.size });
    }
    changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)); // stable, locale-independent order
    // Folders are listed (keep() needs them) but not counted: "3 files changed" is what people expect.
    const count = (k: ChangeKind) => changes.filter((c) => c.kind === k && c.entry !== "dir").length;
    return { changes, added: count("added"), modified: count("modified"), deleted: count("deleted") };
  }

  /**
   * Copies the run's changes into the real workspace. If any of them was also changed in the
   * workspace since the snapshot, nothing at all is applied and the conflicts are returned.
   * Pass `only` to keep a subset of paths.
   */
  keep(runId: string, only?: string[]): KeepResult {
    const { workspace, manifest: base } = this.base(runId);
    const ws = this.wsPath(runId);
    let changes = this.diff(runId).changes;
    if (only) {
      const pick = new Set(only);
      changes = changes.filter((c) => pick.has(c.path));
    }

    const conflicts: Conflict[] = [];
    for (const c of changes) {
      const before = base[c.path];
      const current = entryAt(join(workspace, c.path));
      if (before && !current) conflicts.push({ path: c.path, reason: "deleted-in-workspace" });
      else if (!before && current) conflicts.push({ path: c.path, reason: "created-in-workspace" });
      else if (before && current && !sameMeta(before, current))
        conflicts.push({ path: c.path, reason: "changed-in-workspace" });
    }
    if (conflicts.length) return { applied: [], conflicts };

    // Create and update parents before children; delete children before parents.
    const writes = changes.filter((c) => c.kind !== "deleted").sort((a, b) => a.path.length - b.path.length);
    const deletes = changes.filter((c) => c.kind === "deleted").sort((a, b) => b.path.length - a.path.length);
    for (const c of writes) {
      const src = join(ws, c.path);
      const dst = join(workspace, c.path);
      const e = entryAt(src) as Entry;
      if (e.kind === "dir") {
        mkdirSync(dst, { recursive: true });
        continue;
      }
      mkdirSync(dirname(dst), { recursive: true });
      const tmp = `${dst}.cw-tmp-${process.pid}`;
      if (e.kind === "symlink") symlinkSync(e.link as string, tmp);
      else this.clone.cloneFile(src, tmp);
      renameSync(tmp, dst); // atomic replace: readers see the old file or the new one, never half
    }
    for (const c of deletes) {
      const p = join(workspace, c.path);
      if (c.entry === "dir") rmdirSync(p);
      else unlinkSync(p);
    }
    return { applied: changes, conflicts: [] };
  }

  /**
   * The two versions of a changed path, for showing a diff: the real workspace file and the run's
   * copy (null when missing or not a regular file). `workspaceChanged` is true when someone changed
   * the workspace file after the run started; keep() would refuse it.
   */
  versions(runId: string, path: string): { before: Buffer | null; after: Buffer | null; workspaceChanged: boolean } {
    const { workspace, manifest: base } = this.base(runId);
    const read = (p: string) => (entryAt(p)?.kind === "file" ? readFileSync(p) : null);
    const wsFile = join(workspace, path);
    const current = entryAt(wsFile);
    const b = base[path];
    const workspaceChanged = b ? !current || !sameMeta(b, current) : Boolean(current);
    return { before: read(wsFile), after: read(join(this.wsPath(runId), path)), workspaceChanged };
  }

  /** Deletes only the workspace copy, keeping the run's records (transcript, manifest). */
  dropCopy(runId: string): void {
    rmSync(this.wsPath(runId), { recursive: true, force: true });
  }

  discard(runId: string): void {
    rmSync(this.runDir(runId), { recursive: true, force: true });
  }
}

/** A file rewritten with identical bytes (new time, same content) is not a change. */
function sameContent(base: Entry, now: Entry, runFile: string, wsFile: string): boolean {
  if (base.kind !== "file" || now.kind !== "file" || base.size !== now.size || base.mode !== now.mode) return false;
  // Compare with the real workspace file, but only if it still matches the base; otherwise we can't tell.
  const ws = entryAt(wsFile);
  if (!ws || !sameMeta(base, ws)) return false;
  return fileHash(runFile) === fileHash(wsFile);
}
