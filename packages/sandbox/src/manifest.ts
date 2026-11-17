import { lstatSync, readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";

// A manifest is a cheap snapshot of a folder: for every entry, its type, size, modified time and
// permissions. No file contents are read, so it's fast even for big workspaces. Contents are only
// compared (by hash) when size and time alone can't settle whether a file changed.

export type EntryKind = "file" | "dir" | "symlink";

export interface Entry {
  kind: EntryKind;
  size: number;
  mtimeMs: number;
  mode: number;
  /** Symlink target. */
  link?: string;
}

export type Manifest = Record<string, Entry>; // key: path relative to the root, with "/" separators

const IGNORED = new Set([".DS_Store"]);

/** The manifest entry for one path, or undefined if nothing is there (or it's a socket/device). */
export function entryAt(path: string): Entry | undefined {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch {
    return undefined;
  }
  if (st.isSymbolicLink()) return { kind: "symlink", size: 0, mtimeMs: 0, mode: 0, link: readlinkSync(path) };
  if (st.isDirectory()) return { kind: "dir", size: 0, mtimeMs: 0, mode: st.mode & 0o7777 };
  if (st.isFile()) return { kind: "file", size: st.size, mtimeMs: Math.trunc(st.mtimeMs), mode: st.mode & 0o7777 };
  return undefined; // sockets, devices and pipes can't be meaningfully copied
}

export function buildManifest(root: string): Manifest {
  const out: Manifest = {};
  const walk = (rel: string) => {
    for (const name of readdirSync(join(root, rel))) {
      if (IGNORED.has(name)) continue;
      const r = rel ? `${rel}/${name}` : name;
      const e = entryAt(join(root, r));
      if (!e) continue;
      out[r] = e;
      if (e.kind === "dir") walk(r);
    }
  };
  walk("");
  return out;
}

/** True when two entries look identical without reading file contents. */
export function sameMeta(a: Entry | undefined, b: Entry | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === "symlink") return a.link === b.link;
  if (a.kind === "dir") return a.mode === b.mode;
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.mode === b.mode;
}
