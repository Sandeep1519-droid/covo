import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { covoPaths } from "@covo/core";
import { initHome, openDb, verifyAudit } from "@covo/db";
import { MockProvider } from "@covo/models";
import { macSandbox } from "@covo/platform";
import {
  CLAUDE_CODE_TOOLS,
  ClaudeCodeEngine,
  claudeCodeArgs,
  claudeCodeOutcome,
  type Engine,
  type EngineResult,
  type EngineTask,
  engineErrorKind,
  parseClaudeResult,
} from "./engines.ts";
import { type RunEvent, startRun } from "./run.ts";

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "covo-engines-")));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("Claude Code command line", () => {
  test("is locked down: file tools only, no MCP, no workspace settings, nothing saved", () => {
    const a = claudeCodeArgs({ maxTurns: 12, instructions: "Be careful", model: "sonnet" });
    const after = (f: string) => a[a.indexOf(f) + 1];
    expect(a[0]).toBe("-p");
    expect(after("--output-format")).toBe("json");
    expect(after("--tools")).toBe(CLAUDE_CODE_TOOLS);
    expect(CLAUDE_CODE_TOOLS).not.toMatch(/Bash|Web/);
    expect(after("--permission-mode")).toBe("acceptEdits");
    expect(after("--setting-sources")).toBe("user");
    expect(after("--disallowedTools")).toBe("mcp__*");
    expect(after("--max-turns")).toBe("12");
    expect(after("--append-system-prompt")).toBe("Be careful");
    expect(after("--model")).toBe("sonnet");
    expect(a).toContain("--strict-mcp-config");
    expect(a).toContain("--disable-slash-commands");
    expect(a).toContain("--no-session-persistence");
    expect(a).not.toContain("--dangerously-skip-permissions");
    expect(claudeCodeArgs({ maxTurns: 1, instructions: "" })).not.toContain("--model");
  });

  test.each([
    ["Claude AI usage limit reached|1763500000", "quota"],
    ["You've hit your limit · resets 3pm", "quota"],
    ["Invalid API key · Please run /login", "auth"],
    ["Not logged in · Please run /login", "auth"],
    ["API Error: 529 Overloaded", "unavailable"],
    ["API Error: 429 rate limit exceeded", "rate_limit"],
    ["model: claude-x not found", "not_found"],
    ["Something odd happened", "other"],
  ])("sorts %p as %p", (text, kind) => {
    expect(engineErrorKind(text)).toBe(kind as ReturnType<typeof engineErrorKind>);
  });

  const json = (o: Record<string, unknown>) =>
    JSON.stringify({
      type: "result",
      num_turns: 3,
      total_cost_usd: 0.42,
      usage: { input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 50 },
      modelUsage: { "claude-sonnet-5-5": {} },
      ...o,
    });

  test("reads a successful run, counting cached input as input", () => {
    expect(parseClaudeResult(`warning: something\n${json({ subtype: "success", result: "x" })}`)?.result).toBe("x");
    const r = claudeCodeOutcome(
      {
        code: 0,
        stdout: json({ subtype: "success", is_error: false, result: " Added a Setup section. " }),
        stderr: "",
        timedOut: false,
      },
      { timeoutMs: 60_000, maxTurns: 40 },
    );
    expect(r).toMatchObject({
      ok: true,
      summary: "Added a Setup section.",
      tokensIn: 1000,
      tokensOut: 50,
      turns: 3,
      apiEquivalentUsd: 0.42,
      model: "claude-sonnet-5-5",
    });
  });

  test("a usage cap can fall back; turn and time limits stop instead", () => {
    const o = { timeoutMs: 120_000, maxTurns: 40 };
    const capped = claudeCodeOutcome(
      {
        code: 1,
        stdout: json({ subtype: "success", is_error: true, result: "Claude AI usage limit reached|1763500000" }),
        stderr: "",
        timedOut: false,
      },
      o,
    );
    expect(capped).toMatchObject({ ok: false, errorKind: "quota" });
    const turns = claudeCodeOutcome(
      { code: 1, stdout: json({ subtype: "error_max_turns", is_error: true }), stderr: "", timedOut: false },
      o,
    );
    expect(turns).toMatchObject({ ok: false, stopped: true, error: "Claude Code stopped after 40 turns" });
    const slow = claudeCodeOutcome({ code: -1, stdout: "", stderr: "", timedOut: true }, o);
    expect(slow).toMatchObject({ ok: false, stopped: true });
    const noJson = claudeCodeOutcome(
      { code: 1, stdout: "", stderr: "Error: Not logged in · Please run /login\n", timedOut: false },
      o,
    );
    expect(noJson).toMatchObject({ ok: false, errorKind: "auth", error: "Error: Not logged in · Please run /login" });
  });
});

describe("ClaudeCodeEngine in the real sandbox", () => {
  // A stand-in for the claude program: reads the task from stdin, edits the workspace, tries to
  // write outside it, writes to its own settings folder, and prints Claude Code's JSON result.
  const fake = (outside: string) => `#!/bin/sh
task=$(cat)
echo "$task" > from-engine.txt
echo "$@" > args.txt
echo escape > "${outside}" 2>/dev/null && echo "ESCAPED" >&2
mkdir -p "$HOME/.claude" && echo state > "$HOME/.claude/state.txt"
echo '{"type":"result","subtype":"success","is_error":false,"result":"Wrote the file.","num_turns":2,"usage":{"input_tokens":10,"output_tokens":5}}'
`;

  test("works on the copy, keeps to its own folders, and never gets your other files", async () => {
    const bin = join(root, "bin");
    const ws = join(root, "ws");
    const tmp = join(root, "tmp");
    const home = join(root, "home");
    for (const d of [bin, ws, tmp, join(home, ".claude"), join(home, "Documents")]) mkdirSync(d, { recursive: true });
    writeFileSync(join(home, "Documents", "secret.txt"), "private");
    const outside = join(home, "Documents", "escape.txt");
    const claude = join(bin, "claude");
    writeFileSync(claude, fake(outside));
    chmodSync(claude, 0o755);

    const engine = new ClaudeCodeEngine({ binary: claude, model: "sonnet", findNode: () => null });
    const r = await engine.run({
      ws,
      tmp,
      goal: "add a Setup section",
      instructions: "You are Docs helper",
      sandbox: macSandbox,
      home,
      timeoutMs: 20_000,
      maxTurns: 5,
    });
    expect(r).toMatchObject({ ok: true, summary: "Wrote the file.", turns: 2, tokensIn: 10, tokensOut: 5 });
    expect(readFileSync(join(ws, "from-engine.txt"), "utf8")).toBe("add a Setup section\n");
    expect(readFileSync(join(ws, "args.txt"), "utf8")).toContain("--tools Read,Edit,Write,Glob,Grep");
    expect(readFileSync(join(home, ".claude", "state.txt"), "utf8")).toBe("state\n");
    expect(existsSync(outside)).toBe(false);

    const v = await engine.version(macSandbox, { ws, tmp, home });
    expect(v.ok).toBe(true);
  });

  test("a missing program is a reason to try the next model", async () => {
    const engine = new ClaudeCodeEngine({ binary: join(root, "nope", "claude") });
    const r = await engine.run({
      ws: root,
      tmp: root,
      goal: "x",
      instructions: "",
      sandbox: macSandbox,
      home: root,
      timeoutMs: 1000,
      maxTurns: 1,
    });
    expect(r).toMatchObject({ ok: false, errorKind: "not_found" });
  });
});

describe("runs with an engine", () => {
  let home: string;
  let wsDir: string;
  beforeEach(() => {
    home = join(root, "Covo");
    initHome(home);
    wsDir = join(home, "workspaces/default");
    writeFileSync(join(wsDir, "README.md"), "# Project\n");
  });

  class FakeEngine implements Engine {
    readonly id = "claude-code";
    readonly label = "Claude Code";
    readonly model = undefined;
    tasks: EngineTask[] = [];
    constructor(private readonly act: (t: EngineTask) => EngineResult) {}
    async run(t: EngineTask): Promise<EngineResult> {
      this.tasks.push(t);
      return this.act(t);
    }
  }
  const usage = { tokensIn: 1200, tokensOut: 300, apiEquivalentUsd: 0.05, turns: 4, denied: 0 };

  test("an engine does the task; usage is logged at $0 and the change is kept", async () => {
    const engine = new FakeEngine((t) => {
      writeFileSync(join(t.ws, "README.md"), "# Project\n\n## Setup\n");
      return { ...usage, ok: true, summary: "Added Setup." };
    });
    const events: RunEvent[] = [];
    const r = await startRun({
      home,
      goal: "add a Setup section",
      chain: [{ label: "claude-sub", engine }],
      userHome: join(root, "userhome"),
      onEvent: (e) => events.push(e),
    });
    expect(r.state).toBe("KEPT");
    expect(r.summary).toBe("Added Setup.");
    expect(r.costUsd).toBe(0);
    expect(r.tokensIn).toBe(1200);
    expect(readFileSync(join(wsDir, "README.md"), "utf8")).toContain("## Setup");
    expect(engine.tasks[0]?.home).toBe(join(root, "userhome"));
    expect(engine.tasks[0]?.instructions).toContain("Covo Bot");
    expect(events.filter((e) => e.type === "engine").map((e) => (e as { phase: string }).phase)).toEqual([
      "start",
      "end",
    ]);

    const db = openDb(covoPaths(home).db);
    const led = db
      .query<{ tier: string; provider: string; model: string; usd: number; tokens_in: number }, [string]>(
        "SELECT tier, provider, model, usd, tokens_in FROM budget_ledger WHERE run_id = ?",
      )
      .all(r.runId);
    expect(led).toEqual([
      { tier: "cli", provider: "claude-code", model: "claude-code:default", usd: 0, tokens_in: 1200 },
    ]);
    const audit = db
      .query<{ detail_json: string }, [string]>(
        "SELECT detail_json FROM audit_log WHERE run_id = ? AND action = 'engine.run'",
      )
      .get(r.runId);
    expect(JSON.parse(audit?.detail_json ?? "{}")).toMatchObject({ ok: true, turns: 4, apiEquivalentUsd: 0.05 });
    expect(verifyAudit(db).ok).toBe(true);
    db.close();
  });

  test("when the subscription hits its cap, the next model finishes in the same copy", async () => {
    const engine = new FakeEngine((t) => {
      writeFileSync(join(t.ws, "half.md"), "started\n");
      return { ...usage, ok: false, error: "Claude AI usage limit reached", errorKind: "quota" };
    });
    const model = new MockProvider([
      MockProvider.tool("write_file", { path: "half.md", content: "finished\n" }),
      MockProvider.tool("finish", { summary: "Finished it" }),
    ]);
    const events: RunEvent[] = [];
    const r = await startRun({
      home,
      goal: "write half.md",
      chain: [
        { label: "claude-sub", engine },
        { label: "local", provider: model },
      ],
      onEvent: (e) => events.push(e),
    });
    expect(r.state).toBe("KEPT");
    expect(readFileSync(join(wsDir, "half.md"), "utf8")).toBe("finished\n");
    expect(events).toContainEqual(
      expect.objectContaining({ type: "fallback", from: "claude-sub", to: "local", kind: "quota" }),
    );
    const task = model.requests[0]?.messages.find((m) => m.role === "user")?.content ?? "";
    expect(task).toContain("Claude Code started this task and stopped partway");

    const db = openDb(covoPaths(home).db);
    expect(db.query<{ model: string }, [string]>("SELECT model FROM runs WHERE id = ?").get(r.runId)?.model).toBe(
      "mock:scripted",
    );
    expect(
      db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM audit_log WHERE run_id = ? AND action = 'model.fallback'",
        )
        .get(r.runId)?.n,
    ).toBe(1);
    db.close();
  });

  test("an engine error that another model can't fix fails the run and throws the copy away", async () => {
    const engine = new FakeEngine((t) => {
      writeFileSync(join(t.ws, "junk.md"), "x");
      return { ...usage, ok: false, error: "Something odd happened", errorKind: "other" };
    });
    const r = await startRun({
      home,
      goal: "x",
      chain: [
        { label: "claude-sub", engine },
        { label: "local", provider: new MockProvider([]) },
      ],
    });
    expect(r.state).toBe("FAILED");
    expect(r.error).toBe("Claude Code: Something odd happened");
    expect(existsSync(join(wsDir, "junk.md"))).toBe(false);
  });

  test("an engine listed after a regular model is skipped and noted", async () => {
    const engine = new FakeEngine(() => ({ ...usage, ok: true }));
    const r = await startRun({
      home,
      goal: "x",
      chain: [
        { label: "local", provider: new MockProvider([MockProvider.tool("finish", { summary: "ok" })]) },
        { label: "claude-sub", engine },
      ],
    });
    expect(r.state).toBe("SUCCEEDED");
    expect(engine.tasks).toHaveLength(0);
  });
});
