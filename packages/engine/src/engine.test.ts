import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { covoPaths } from "@covo/core";
import { initHome, openDb, verifyAudit } from "@covo/db";
import { MockProvider, type ModelEvent } from "@covo/models";
import { macSandbox } from "@covo/platform";
import { NUDGE, runLoop } from "./loop.ts";
import { startRun } from "./run.ts";
import { insideWorkspace, PathError, runTool, TOOL_SPECS } from "./tools.ts";

let root: string;
let ws: string;
let tmp: string;
const ctx = () => ({ ws, tmp, sandbox: macSandbox, commandTimeoutMs: 10_000 });

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "covo-engine-")));
  ws = join(root, "ws");
  tmp = join(root, "tmp");
  mkdirSync(ws);
  mkdirSync(tmp);
  writeFileSync(join(ws, "README.md"), "# Demo\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("insideWorkspace", () => {
  test("accepts paths inside, including new ones", () => {
    expect(insideWorkspace(ws, "README.md")).toBe(join(ws, "README.md"));
    expect(insideWorkspace(ws, "docs/new/file.md")).toBe(join(ws, "docs/new/file.md"));
  });

  test.each(["~/.ssh/id_ed25519", "../outside.txt", "/etc/passwd", "a/../../x", ""])("refuses %p", (p) => {
    expect(() => insideWorkspace(ws, p)).toThrow(PathError);
  });

  test("refuses symlinks that lead outside", () => {
    symlinkSync(root, join(ws, "escape"));
    expect(() => insideWorkspace(ws, "escape/tmp/x")).toThrow("leads outside");
  });
});

describe("runTool", () => {
  test("list, read, write and finish", async () => {
    expect((await runTool("list_files", {}, ctx())).output).toBe("README.md");
    expect(await runTool("read_file", { path: "README.md" }, ctx())).toMatchObject({
      ok: true,
      output: "# Demo\n",
      label: "1 lines",
    });
    const w = await runTool("write_file", { path: "docs/a.md", content: "a\nb\n" }, ctx());
    expect(w).toMatchObject({ ok: true, mutating: true, label: "new, 2 lines" });
    expect(readFileSync(join(ws, "docs/a.md"), "utf8")).toBe("a\nb\n");
    expect(await runTool("finish", { summary: "All set" }, ctx())).toMatchObject({ finished: "All set" });
  });

  test("edit_file changes only the matching text", async () => {
    writeFileSync(join(ws, "notes.md"), "# Notes\n\nOne\nTwo\n");
    const r = await runTool(
      "edit_file",
      { path: "notes.md", old_text: "One\n", new_text: "One\nOne and a half\n" },
      ctx(),
    );
    expect(r).toMatchObject({ ok: true, mutating: true, label: "+1 lines" });
    expect(readFileSync(join(ws, "notes.md"), "utf8")).toBe("# Notes\n\nOne\nOne and a half\nTwo\n");
  });

  test("edit_file explains a missing or repeated match and changes nothing", async () => {
    writeFileSync(join(ws, "a.txt"), "x\nx\n");
    const missing = await runTool("edit_file", { path: "a.txt", old_text: "y", new_text: "z" }, ctx());
    expect(missing).toMatchObject({ ok: false, label: "text not found", mutating: false });
    expect(missing.output).toContain("copy the exact text");
    const twice = await runTool("edit_file", { path: "a.txt", old_text: "x", new_text: "z" }, ctx());
    expect(twice).toMatchObject({ ok: false, label: "matches 2 times" });
    expect((await runTool("edit_file", { path: "new.txt", old_text: "a", new_text: "b" }, ctx())).output).toContain(
      "Use write_file",
    );
    expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("x\nx\n");
  });

  test("edit_file keeps $ patterns literal", async () => {
    writeFileSync(join(ws, "p.sh"), "echo A\n");
    await runTool("edit_file", { path: "p.sh", old_text: "A", new_text: "$& $1 $$" }, ctx());
    expect(readFileSync(join(ws, "p.sh"), "utf8")).toBe("echo $& $1 $$\n");
  });

  test("edit_file refuses paths outside the workspace", async () => {
    const r = await runTool("edit_file", { path: "../x", old_text: "a", new_text: "b" }, ctx());
    expect(r).toMatchObject({ ok: false, blocked: "path" });
  });

  test("refuses files outside the workspace and says so", async () => {
    const r = await runTool("read_file", { path: "~/.ssh/id_ed25519" }, ctx());
    expect(r).toMatchObject({ ok: false, blocked: "path" });
    expect(r.output).toContain("outside the workspace");
  });

  test("won't read binary files", async () => {
    writeFileSync(join(ws, "img.bin"), Buffer.from([0, 1, 2]));
    expect((await runTool("read_file", { path: "img.bin" }, ctx())).label).toBe("binary");
  });

  test("runs commands in the sandbox", async () => {
    const ok = await runTool("run_command", { command: "echo hi > out.txt && cat out.txt" }, ctx());
    expect(ok).toMatchObject({ ok: true, label: "exit 0" });
    writeFileSync(join(root, "secret.txt"), "s3cret");
    const blocked = await runTool("run_command", { command: `cat ${join(root, "secret.txt")}` }, ctx());
    expect(blocked).toMatchObject({ ok: false, blocked: "sandbox" });
    expect(blocked.output).not.toContain("s3cret");
  });

  test("unknown tools get a helpful error", async () => {
    expect((await runTool("delete_everything", {}, ctx())).output).toContain("Available: list_files");
  });
});

describe("runLoop", () => {
  const exec = (name: string, args: Record<string, unknown>) => runTool(name, args, ctx());
  const loop = (script: ModelEvent[][], limits = {}) =>
    runLoop({
      provider: new MockProvider(script),
      messages: [{ role: "user", content: "go" }],
      tools: TOOL_SPECS,
      exec,
      limits,
    });

  test("ends when the bot calls finish", async () => {
    const r = await loop([
      MockProvider.tool("read_file", { path: "README.md" }),
      MockProvider.tool("finish", { summary: "Read it" }),
    ]);
    expect(r.outcome).toEqual({ kind: "finished", summary: "Read it", via: "finish" });
    expect(r.steps).toBe(2);
    expect(r.messages.filter((m) => m.role === "tool")).toHaveLength(2);
  });

  test("reminds a bot that answers in words once, then accepts its words", async () => {
    const provider = new MockProvider([MockProvider.text("I think it's done"), MockProvider.text("It is done.")]);
    const r = await runLoop({ provider, messages: [], tools: TOOL_SPECS, exec });
    expect(r.outcome).toEqual({ kind: "finished", summary: "It is done.", via: "text" });
    expect(provider.requests[1]?.messages.at(-1)).toEqual({ role: "user", content: NUDGE });
  });

  test("recovers a tool call the model typed as JSON text", async () => {
    const typed = `I'll update it now:\n\n\`\`\`json\n${JSON.stringify({
      command: "write_file",
      arguments: { path: "README.md", content: '# Demo {x}\n\\"quoted\\"\n' },
    })}\n\`\`\``;
    const recovered: number[] = [];
    const r = await runLoop({
      provider: new MockProvider([MockProvider.text(typed), MockProvider.tool("finish", { summary: "ok" })]),
      messages: [],
      tools: TOOL_SPECS,
      exec,
      hooks: { onRecovered: (n) => void recovered.push(n) },
    });
    expect(recovered).toEqual([1]);
    expect(r.outcome).toEqual({ kind: "finished", summary: "ok", via: "finish" });
    expect(readFileSync(join(ws, "README.md"), "utf8")).toBe('# Demo {x}\n\\"quoted\\"\n');
  });

  test("ignores JSON in text that isn't a known tool", async () => {
    const r = await runLoop({
      provider: new MockProvider([
        MockProvider.text('{"name": "delete_everything", "arguments": {}}'),
        MockProvider.text('Done. Config: {"a": 1}'),
      ]),
      messages: [],
      tools: TOOL_SPECS,
      exec,
    });
    expect(r.outcome).toEqual({ kind: "finished", summary: 'Done. Config: {"a": 1}', via: "text" });
  });

  test("stops a bot that repeats itself", async () => {
    const same = MockProvider.tool("read_file", { path: "README.md" });
    const r = await loop([same, same, same, same]);
    expect(r.outcome.kind).toBe("stopped");
    expect(r.steps).toBe(3);
  });

  test("stops at the step limit", async () => {
    const script = [1, 2, 3].map((i) => MockProvider.tool("write_file", { path: `f${i}.txt`, content: String(i) }));
    const r = await loop(script, { maxSteps: 2 });
    expect(r.outcome).toEqual({ kind: "stopped", reason: "Step limit reached (2)." });
  });

  test("fails when the model errors", async () => {
    const r = await loop([[{ type: "done", stop: "error", error: "model crashed" }]]);
    expect(r.outcome).toEqual({ kind: "failed", error: "model crashed" });
  });

  test("tells the model when its arguments were broken", async () => {
    const bad: ModelEvent[] = [
      {
        type: "tool_call",
        call: { id: "x", name: "write_file", arguments: "{oops" },
        argsError: "Arguments are not valid JSON",
      },
      { type: "done", stop: "tool" },
    ];
    const r = await loop([bad, MockProvider.tool("finish", { summary: "ok" })]);
    expect(r.messages.find((m) => m.role === "tool")?.content).toContain("not valid JSON");
    expect(r.outcome.kind).toBe("finished");
  });
});

describe("startRun", () => {
  let home: string;
  beforeEach(() => {
    home = join(root, "Covo");
    initHome(home);
    writeFileSync(join(home, "workspaces/default/README.md"), "# Project\n");
  });

  const happy = () =>
    new MockProvider([
      MockProvider.tool("list_files", {}),
      MockProvider.tool("read_file", { path: "README.md" }),
      MockProvider.tool("write_file", { path: "README.md", content: "# Project\n\n## Setup\n\nRun bun install.\n" }),
      MockProvider.tool("finish", { summary: "Added a Setup section to README.md" }),
    ]);

  test("works on a copy, records every step and leaves changes for review", async () => {
    const states: string[] = [];
    const r = await startRun({
      home,
      goal: "add a Setup section",
      provider: happy(),
      onEvent: (e) => e.type === "state" && states.push(e.state),
    });
    expect(states).toEqual(["PREPARING", "RUNNING", "REVIEWING"]);
    expect(r).toMatchObject({ state: "REVIEWING", steps: 4, summary: "Added a Setup section to README.md" });
    expect(r.diff?.changes.map((c) => `${c.kind} ${c.path}`)).toEqual(["modified README.md"]);
    // the real workspace is untouched; the copy has the change
    expect(readFileSync(join(home, "workspaces/default/README.md"), "utf8")).toBe("# Project\n");
    expect(readFileSync(join(covoPaths(home).runs, r.runId, "ws/README.md"), "utf8")).toContain("## Setup");

    const db = openDb(covoPaths(home).db);
    expect(db.query("SELECT state, summary FROM runs WHERE id = ?").get(r.runId)).toEqual({
      state: "REVIEWING",
      summary: "Added a Setup section to README.md",
    });
    expect(db.query("SELECT COUNT(*) AS n FROM run_steps WHERE run_id = ? AND kind = 'tool'").get(r.runId)).toEqual({
      n: 4,
    });
    const actions = db
      .query<{ action: string }, [string]>("SELECT action FROM audit_log WHERE run_id = ? ORDER BY seq")
      .all(r.runId)
      .map((a) => a.action);
    expect(actions).toEqual([
      "run.created",
      "run.state",
      "run.state",
      "tool.list_files",
      "tool.read_file",
      "tool.write_file",
      "tool.finish",
      "run.state",
    ]);
    expect(verifyAudit(db).ok).toBe(true);
    expect(db.query("SELECT COUNT(*) AS n FROM budget_ledger WHERE run_id = ?").get(r.runId)).toEqual({ n: 4 });
    db.close();
    expect(existsSync(join(covoPaths(home).runs, r.runId, "transcript.jsonl"))).toBe(true);
  });

  test("records a blocked attempt to read your SSH keys", async () => {
    const provider = new MockProvider([
      MockProvider.tool("read_file", { path: "~/.ssh/id_ed25519" }),
      MockProvider.tool("finish", { summary: "Couldn't read the key" }),
    ]);
    const r = await startRun({ home, goal: "read my ssh key", provider });
    expect(r.state).toBe("SUCCEEDED"); // nothing changed, so nothing to review
    const db = openDb(covoPaths(home).db);
    expect(db.query("SELECT decision, target FROM audit_log WHERE action = 'tool.read_file'").get()).toEqual({
      decision: "deny",
      target: "~/.ssh/id_ed25519",
    });
    db.close();
    expect(existsSync(join(covoPaths(home).runs, r.runId, "ws"))).toBe(false);
  });

  test("a failed run throws its copy away", async () => {
    const r = await startRun({
      home,
      goal: "x",
      provider: new MockProvider([[{ type: "done", stop: "error", error: "Ollama is not running" }]]),
    });
    expect(r).toMatchObject({ state: "FAILED", error: "Ollama is not running" });
    expect(existsSync(join(covoPaths(home).runs, r.runId, "ws"))).toBe(false);
  });

  test("only one task runs at a time", async () => {
    const db = openDb(covoPaths(home).db);
    db.exec(
      "INSERT INTO runs (id, agent_id, department_id, trigger, goal, state, created_at) VALUES ('run_busy', 'bot_assistant', 'dept_default', 'cli', 'x', 'RUNNING', 1)",
    );
    db.close();
    expect(startRun({ home, goal: "y", provider: happy() })).rejects.toThrow("one task at a time");
  });
});
