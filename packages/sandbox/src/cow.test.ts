import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
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
import { checkClone } from "./doctor.ts";
import { buildManifest } from "./manifest.ts";

let root: string;
let ws: string;
let cow: CowWorkspaces;
let n = 0;
const runId = () => `run_test${++n}`;
const put = (dir: string, rel: string, text: string) => {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), text);
};
const read = (dir: string, rel: string) => readFileSync(join(dir, rel), "utf8");
// Moves a file's time forward so a change is visible even within the same millisecond.
const touch = (path: string) => utimesSync(path, new Date(), new Date(Date.now() + 5_000));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cw-cow-"));
  ws = join(root, "workspace");
  put(ws, "README.md", "# Hello\n");
  put(ws, "src/app.ts", "export const a = 1;\n");
  put(ws, "notes/old.txt", "old\n");
  cow = new CowWorkspaces(join(root, "runs"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("snapshot", () => {
  test("makes a full, independent copy with clonefile", () => {
    const id = runId();
    const s = cow.snapshot(id, ws);
    expect(s.method).toBe("clonefile");
    expect(read(s.wsPath, "src/app.ts")).toBe("export const a = 1;\n");
    put(s.wsPath, "src/app.ts", "changed\n");
    expect(read(ws, "src/app.ts")).toBe("export const a = 1;\n");
  });

  test("refuses to reuse a run folder", () => {
    const id = runId();
    cow.snapshot(id, ws);
    expect(() => cow.snapshot(id, ws)).toThrow("already exists");
  });
});

describe("diff", () => {
  test("is empty when nothing changed", () => {
    const id = runId();
    cow.snapshot(id, ws);
    expect(cow.diff(id)).toMatchObject({ added: 0, modified: 0, deleted: 0, changes: [] });
  });

  test("finds added, modified and deleted files", () => {
    const id = runId();
    const { wsPath } = cow.snapshot(id, ws);
    put(wsPath, "src/new.ts", "new\n");
    put(wsPath, "README.md", "# Hello\n\n## Setup\n");
    unlinkSync(join(wsPath, "notes/old.txt"));
    const d = cow.diff(id);
    expect(d.changes.map((c) => `${c.kind} ${c.path}`)).toEqual([
      "modified README.md",
      "deleted notes/old.txt",
      "added src/new.ts",
    ]);
    expect(d).toMatchObject({ added: 1, modified: 1, deleted: 1 });
  });

  test("ignores a file rewritten with the same content", () => {
    const id = runId();
    const { wsPath } = cow.snapshot(id, ws);
    put(wsPath, "README.md", "# Hello\n");
    touch(join(wsPath, "README.md"));
    expect(cow.diff(id).changes).toEqual([]);
  });

  test("notices a permission change", () => {
    const id = runId();
    const { wsPath } = cow.snapshot(id, ws);
    chmodSync(join(wsPath, "src/app.ts"), 0o755);
    expect(cow.diff(id).changes.map((c) => c.path)).toEqual(["src/app.ts"]);
  });

  test("tracks symlinks without following them", () => {
    const id = runId();
    const { wsPath } = cow.snapshot(id, ws);
    symlinkSync("/etc/passwd", join(wsPath, "link"));
    expect(cow.diff(id).changes).toEqual([{ path: "link", kind: "added", entry: "symlink", bytes: 0 }]);
  });
});

describe("keep", () => {
  test("applies all changes to the real workspace", () => {
    const id = runId();
    const { wsPath } = cow.snapshot(id, ws);
    put(wsPath, "README.md", "# Hello\n\n## Setup\n");
    put(wsPath, "docs/guide/intro.md", "intro\n");
    rmSync(join(wsPath, "notes"), { recursive: true });
    const r = cow.keep(id);
    expect(r.conflicts).toEqual([]);
    expect(read(ws, "README.md")).toContain("## Setup");
    expect(read(ws, "docs/guide/intro.md")).toBe("intro\n");
    expect(existsSync(join(ws, "notes"))).toBe(false);
    expect(Object.keys(buildManifest(ws)).sort()).toEqual(Object.keys(buildManifest(wsPath)).sort());
  });

  test("keeps only the chosen paths", () => {
    const id = runId();
    const { wsPath } = cow.snapshot(id, ws);
    put(wsPath, "README.md", "edited\n");
    put(wsPath, "src/app.ts", "edited\n");
    cow.keep(id, ["README.md"]);
    expect(read(ws, "README.md")).toBe("edited\n");
    expect(read(ws, "src/app.ts")).toBe("export const a = 1;\n");
  });

  test("copies symlinks as links", () => {
    const id = runId();
    const { wsPath } = cow.snapshot(id, ws);
    symlinkSync("src/app.ts", join(wsPath, "app-link"));
    cow.keep(id);
    expect(readlinkSync(join(ws, "app-link"))).toBe("src/app.ts");
  });

  test("refuses everything if a changed file was also changed in the workspace", () => {
    const id = runId();
    const { wsPath } = cow.snapshot(id, ws);
    put(wsPath, "README.md", "bot version\n");
    put(wsPath, "src/app.ts", "bot version\n");
    put(ws, "README.md", "your version\n");
    touch(join(ws, "README.md"));
    const r = cow.keep(id);
    expect(r.applied).toEqual([]);
    expect(r.conflicts).toEqual([{ path: "README.md", reason: "changed-in-workspace" }]);
    expect(read(ws, "README.md")).toBe("your version\n");
    expect(read(ws, "src/app.ts")).toBe("export const a = 1;\n");
  });

  test("reports files created or deleted in the workspace meanwhile", () => {
    const id = runId();
    const { wsPath } = cow.snapshot(id, ws);
    put(wsPath, "new.txt", "bot\n");
    put(wsPath, "notes/old.txt", "bot edit\n");
    put(ws, "new.txt", "you\n");
    unlinkSync(join(ws, "notes/old.txt"));
    const reasons = cow
      .keep(id)
      .conflicts.map((c) => c.reason)
      .sort();
    expect(reasons).toEqual(["created-in-workspace", "deleted-in-workspace"]);
  });
});

test("discard removes the run's copy and leaves the workspace alone", () => {
  const id = runId();
  const s = cow.snapshot(id, ws);
  put(s.wsPath, "README.md", "edited\n");
  cow.discard(id);
  expect(existsSync(s.runDir)).toBe(false);
  expect(read(ws, "README.md")).toBe("# Hello\n");
});

test("checkClone copies 50 MB instantly without using disk space", () => {
  const c = checkClone(root, 50);
  expect(c.method).toBe("clonefile");
  expect(c.ok).toBe(true);
  expect(c.ms).toBeLessThan(1000);
});
