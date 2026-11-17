import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { covoPaths } from "@covo/core";
import { initHome, openDb, verifyAudit } from "@covo/db";
import { MockProvider } from "@covo/models";
import { discardRun, keepRun, reviewRun } from "./review.ts";
import { startRun } from "./run.ts";

let home: string;
let wsDir: string;
beforeEach(() => {
  home = join(realpathSync(mkdtempSync(join(tmpdir(), "covo-review-"))), "Covo");
  initHome(home);
  wsDir = join(home, "workspaces/default");
  writeFileSync(join(wsDir, "README.md"), "# Project\n\nHello.\n");
  writeFileSync(join(wsDir, "old.txt"), "bye\n");
});
afterEach(() => rmSync(join(home, ".."), { recursive: true, force: true }));

const run = () =>
  startRun({
    home,
    goal: "tidy up",
    provider: new MockProvider([
      MockProvider.tool("edit_file", { path: "README.md", old_text: "Hello.\n", new_text: "Hello.\n\n## Setup\n" }),
      MockProvider.tool("write_file", { path: "docs/new.md", content: "new\n" }),
      MockProvider.tool("run_command", { command: "rm old.txt" }),
      MockProvider.tool("finish", { summary: "Tidied" }),
    ]),
  });

const stateOf = (id: string) => {
  const db = openDb(covoPaths(home).db);
  const s = db.query<{ state: string }, [string]>("SELECT state FROM runs WHERE id = ?").get(id)?.state;
  db.close();
  return s;
};

test("review shows each changed file with a text diff", async () => {
  const r = await run();
  expect(r.state).toBe("REVIEWING");
  const v = reviewRun(home, r.runId);
  expect({ added: v.added, modified: v.modified, deleted: v.deleted }).toEqual({ added: 1, modified: 1, deleted: 1 });
  expect(v.files.map((f) => `${f.kind} ${f.path}`)).toEqual([
    "modified README.md",
    "added docs/new.md",
    "deleted old.txt",
  ]);
  expect(v.files[0]?.hunks?.[0]?.lines).toEqual([" # Project", " ", " Hello.", "+", "+## Setup"]);
  expect(v.files[2]?.hunks?.[0]?.lines).toEqual(["-bye"]);
});

test("keep copies every change into the workspace and records it", async () => {
  const r = await run();
  const k = keepRun(home, r.runId);
  expect(k).toEqual({ runId: r.runId, kept: ["README.md", "docs/new.md", "old.txt"], dropped: [], conflicts: [] });
  expect(readFileSync(join(wsDir, "README.md"), "utf8")).toContain("## Setup");
  expect(readFileSync(join(wsDir, "docs/new.md"), "utf8")).toBe("new\n");
  expect(existsSync(join(wsDir, "old.txt"))).toBe(false);
  expect(stateOf(r.runId)).toBe("KEPT");
  expect(existsSync(join(covoPaths(home).runs, r.runId, "ws"))).toBe(false);
  expect(existsSync(join(covoPaths(home).runs, r.runId, "transcript.jsonl"))).toBe(true);

  const db = openDb(covoPaths(home).db);
  const keep = db
    .query<{ detail_json: string }, [string]>(
      "SELECT detail_json FROM audit_log WHERE run_id = ? AND action = 'run.keep'",
    )
    .get(r.runId);
  const detail = JSON.parse(keep?.detail_json ?? "{}");
  expect(detail.kept[0]).toEqual({
    path: "README.md",
    kind: "modified",
    sha256: new Bun.CryptoHasher("sha256").update(readFileSync(join(wsDir, "README.md"))).digest("hex"),
  });
  expect(verifyAudit(db).ok).toBe(true);
  db.close();
  expect(() => keepRun(home, r.runId)).toThrow("already kept");
});

test("keep with a list keeps only those files and throws the rest away", async () => {
  const r = await run();
  const k = keepRun(home, r.runId, { only: ["docs/new.md"] });
  expect(k.kept).toEqual(["docs/new.md"]);
  expect(k.dropped).toEqual(["README.md", "old.txt"]);
  expect(readFileSync(join(wsDir, "README.md"), "utf8")).toBe("# Project\n\nHello.\n");
  expect(existsSync(join(wsDir, "old.txt"))).toBe(true);
});

test("keep refuses unknown paths before touching anything", async () => {
  const r = await run();
  expect(() => keepRun(home, r.runId, { only: ["nope.md"] })).toThrow("didn't change: nope.md");
  expect(stateOf(r.runId)).toBe("REVIEWING");
});

test("keep stops if you edited the same file meanwhile, and changes nothing", async () => {
  const r = await run();
  writeFileSync(join(wsDir, "README.md"), "# Project\n\nI edited this myself, longer now.\n");
  expect(reviewRun(home, r.runId).files[0]?.workspaceChanged).toBe(true);
  const k = keepRun(home, r.runId);
  expect(k.conflicts).toEqual([{ path: "README.md", reason: "changed-in-workspace" }]);
  expect(k.kept).toEqual([]);
  expect(existsSync(join(wsDir, "docs/new.md"))).toBe(false);
  expect(stateOf(r.runId)).toBe("REVIEWING");
  // you can still keep the parts that don't clash
  expect(keepRun(home, r.runId, { only: ["docs/new.md"] }).kept).toEqual(["docs/new.md"]);
});

test("discard throws the copy away and leaves the workspace alone", async () => {
  const r = await run();
  expect(discardRun(home, r.runId)).toEqual({ runId: r.runId, files: 3 });
  expect(stateOf(r.runId)).toBe("DISCARDED");
  expect(readFileSync(join(wsDir, "README.md"), "utf8")).toBe("# Project\n\nHello.\n");
  expect(existsSync(join(covoPaths(home).runs, r.runId, "ws"))).toBe(false);
  expect(() => reviewRun(home, r.runId)).toThrow("already thrown away");
});
