import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CowWorkspaces } from "./cow.ts";
import { buildManifest } from "./manifest.ts";
import { pruneUndo, readUndo, UndoError } from "./undo.ts";

let root: string;
let ws: string;
let cow: CowWorkspaces;
const put = (dir: string, rel: string, text: string) => {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), text);
  utimesSync(join(dir, rel), new Date(), new Date(Date.now() + Math.random() * 10_000));
};
const read = (rel: string) => readFileSync(join(ws, rel), "utf8");
const contents = () => {
  const m = buildManifest(ws);
  return Object.fromEntries(
    Object.entries(m).map(([p, e]) => [p, e.kind === "file" ? read(p) : e.kind === "symlink" ? `-> ${e.link}` : "dir"]),
  );
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "covo-undo-"));
  ws = join(root, "workspace");
  put(ws, "README.md", "# Hello\n");
  put(ws, "src/app.ts", "export const a = 1;\n");
  put(ws, "notes/old.txt", "old\n");
  symlinkSync("README.md", join(ws, "link"));
  cow = new CowWorkspaces(join(root, "runs"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A run that edits, adds (in a new folder), deletes a file and a whole folder, and repoints a link. */
function keepARun(id: string) {
  const s = cow.snapshot(id, ws);
  put(s.wsPath, "README.md", "# Hello\n\n## Setup\n");
  put(s.wsPath, "docs/new/guide.md", "guide\n");
  unlinkSync(join(s.wsPath, "src/app.ts"));
  rmSync(join(s.wsPath, "notes"), { recursive: true });
  unlinkSync(join(s.wsPath, "link"));
  symlinkSync("docs/new/guide.md", join(s.wsPath, "link"));
  const k = cow.keep(id);
  expect(k.conflicts).toEqual([]);
}

test("undo puts the workspace back exactly as it was", () => {
  const before = contents();
  keepARun("run_a");
  expect(read("README.md")).toContain("## Setup");
  expect(existsSync(join(ws, "notes"))).toBe(false);

  const r = cow.undo("run_a");
  expect(r.conflicts).toEqual([]);
  expect(r.restored.sort()).toEqual(["README.md", "docs/new/guide.md", "link", "notes/old.txt", "src/app.ts"]);
  expect(contents()).toEqual(before);
  expect(readlinkSync(join(ws, "link"))).toBe("README.md");
  expect(existsSync(join(ws, "docs"))).toBe(false); // folders the run added are gone again
  expect(() => cow.undo("run_a")).toThrow("already undone");
});

test("undo refuses, and changes nothing, if you changed a kept file since", () => {
  keepARun("run_b");
  put(ws, "README.md", "# My own later edit\n");
  const r = cow.undo("run_b");
  expect(r).toEqual({ restored: [], conflicts: [{ path: "README.md", reason: "changed-since-keep" }] });
  expect(read("README.md")).toBe("# My own later edit\n");
  expect(existsSync(join(ws, "src/app.ts"))).toBe(false); // nothing else was touched either
  expect(cow.hasUndo("run_b")).toBe(true);
});

test("undo also refuses a recreated or deleted file", () => {
  keepARun("run_c");
  put(ws, "src/app.ts", "I put it back myself\n");
  unlinkSync(join(ws, "docs/new/guide.md"));
  const r = cow.undo("run_c");
  expect(r.conflicts.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
    { path: "docs/new/guide.md", reason: "deleted-since-keep" },
    { path: "src/app.ts", reason: "created-since-keep" },
  ]);
});

test("a run with no undo data says so", () => {
  expect(() => cow.undo("run_none")).toThrow(UndoError);
});

test("old undo data is cleaned up by age and by total size, oldest first", () => {
  keepARun("run_old");
  const runs = join(root, "runs");
  const rec = readUndo(join(runs, "run_old"));
  expect(rec).not.toBeNull();
  const now = (rec?.keptAt ?? 0) + 31 * 86_400_000;
  expect(pruneUndo(runs, now, 30 * 86_400_000, 2e9)).toEqual(["run_old"]);
  expect(readUndo(join(runs, "run_old"))).toBeNull();
  expect(() => cow.undo("run_old")).toThrow("missing or was cleaned up");

  put(ws, "big.bin", "x".repeat(10_000));
  const s = cow.snapshot("run_big", ws);
  put(s.wsPath, "big.bin", "y");
  cow.keep("run_big");
  expect(pruneUndo(runs, Date.now(), 30 * 86_400_000, 1_000)).toEqual(["run_big"]);
});
