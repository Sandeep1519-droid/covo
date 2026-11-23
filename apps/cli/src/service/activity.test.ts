import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { covoPaths } from "@covo/core";
import { appendAudit, initHome, openDb } from "@covo/db";
import { activity, workspaceFiles } from "./activity.ts";

// The Library: the activity log in plain words, with its tamper check, and your workspaces' files.

let home: string;
beforeEach(() => {
  home = join(mkdtempSync(join(tmpdir(), "covo-activity-")), "Covo");
  initHome(home);
});
afterEach(() => rmSync(join(home, ".."), { recursive: true, force: true }));

test("entries read as sentences; what Covo stopped is marked; the chain is checked", () => {
  const db = openDb(covoPaths(home).db);
  const now = () => 1_800_000_000_000;
  const bot = db.query<{ id: string }, []>("SELECT id FROM agents LIMIT 1").get()?.id as string;
  const a = (e: Parameters<typeof appendAudit>[1]) => appendAudit(db, e, now);
  a({ actor: `agent:${bot}`, action: "tool.read_file", runId: "r1", target: "notes.md", decision: "allow" });
  a({
    actor: `agent:${bot}`,
    action: "tool.run_command",
    runId: "r1",
    target: "cat /x/.ssh/id_ed25519",
    decision: "deny",
    detail: { blockedBy: "sandbox" },
  });
  a({
    actor: `agent:${bot}`,
    action: "tool.write_file",
    runId: "r1",
    target: "/x/Covo/config.json",
    decision: "deny",
    detail: { blockedBy: "path" },
  });
  a({
    actor: "system",
    action: "run.state",
    runId: "r1",
    target: "RUNNING",
    detail: { from: "PREPARING", to: "RUNNING" },
  });
  a({
    actor: "system",
    action: "run.state",
    runId: "r1",
    target: "REVIEWING",
    detail: { from: "RUNNING", to: "REVIEWING" },
  });
  a({
    actor: "system",
    action: "engine.run",
    runId: "r2",
    detail: {
      engine: "codex",
      ok: true,
      turns: 2,
      tokensIn: 19_000,
      tokensOut: 900,
      blockedHosts: ["example.com:443"],
    },
  });
  a({ actor: "system", action: "api.refused", decision: "deny", detail: { reason: "token", notLogged: 4 } });
  a({ actor: "user", action: "approval.decided", target: "ap_1", detail: { status: "approved", by: "you (phone)" } });

  const all = activity(db, { limit: 50, blocked: false });
  expect(all.verified).toBe(true);
  const text = all.entries.map((e) => e.text);
  expect(text).toContain("Assistant read notes.md");
  expect(text).toContain("Blocked: Assistant tried to run `cat /x/.ssh/id_ed25519`, but the sandbox doesn't allow it");
  expect(text).toContain("Blocked: Assistant tried to write /x/Covo/config.json, but it's outside the workspace");
  expect(text).toContain("The task is ready for your review");
  expect(text.some((t) => t.includes("started working"))).toBe(false); // in-between states stay out of the way
  expect(text).toContain(
    "Codex did the task: 2 steps, 19,900 tokens on your plan. Covo's network filter refused example.com:443",
  );
  expect(text).toContain("Refused a request to Covo's local API (no valid sign-in), and 4 more like it");
  expect(text).toContain("Allowed the spending pause (you, phone)");

  const stopped = activity(db, { limit: 50, blocked: true });
  expect(stopped.entries.map((e) => e.action)).toEqual([
    "api.refused",
    "engine.run",
    "tool.write_file",
    "tool.run_command",
  ]);
  expect(stopped.blockedRecent).toBe(4);

  // Someone edits an entry behind Covo's back (the triggers forbid it, so drop them first).
  db.run("DROP TRIGGER audit_no_update");
  db.run("UPDATE audit_log SET target = 'something else' WHERE seq = 3");
  const broken = activity(db, { limit: 50, blocked: false });
  expect(broken.verified).toBe(false);
  expect(broken.problemAt).toBe(3);
  db.close();
});

test("files: every workspace, newest first, without .git", () => {
  const ws = join(home, "workspaces", "default");
  mkdirSync(join(ws, "docs"));
  mkdirSync(join(ws, ".git"));
  writeFileSync(join(ws, ".git", "HEAD"), "x");
  writeFileSync(join(ws, "docs", "a.md"), "hello");
  const files = workspaceFiles(join(home, "workspaces"));
  expect(files.map((f) => f.path)).toContain("docs/a.md");
  expect(files.some((f) => f.path.startsWith(".git"))).toBe(false);
  expect(files.find((f) => f.path === "docs/a.md")).toMatchObject({ workspace: "default", bytes: 5 });
});
