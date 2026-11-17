import type { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, cwPaths, newId, sha256Hex } from "@cw/core";
import { appendAudit, DEFAULT_AGENT_ID, migrate, openDb } from "@cw/db";
import type { ChatMessage, ModelProvider } from "@cw/models";
import { cloner, sandbox as defaultSandbox, type Sandbox, type WorkspaceCloner } from "@cw/platform";
import { CowWorkspaces, type DiffSummary } from "@cw/sandbox";
import { type LoopLimits, type ModelTurn, runLoop } from "./loop.ts";
import { systemPrompt, taskMessage } from "./prompt.ts";
import { type RunState, recordState } from "./state.ts";
import { runTool, TOOL_SPECS } from "./tools.ts";

// One run, start to finish:
//
//   QUEUED → PREPARING (instant copy) → RUNNING (tool loop) → REVIEWING   changes wait for you
//                                                            → SUCCEEDED   nothing changed
//                                                            → STOPPED     a guard or you stopped it; copy deleted
//                                                            → FAILED      model or system error; copy deleted
//   REVIEWING → KEPT (your workspace gets the changes) or DISCARDED (copy deleted); see review.ts
//
// Each state change is written to the database and the activity log before anything else happens.

export type RunEvent =
  | { type: "state"; runId: string; state: RunState }
  | ({ type: "model" } & ModelTurn)
  | { type: "recovered"; count: number }
  | {
      type: "tool";
      seq: number;
      name: string;
      target: string;
      label: string;
      ok: boolean;
      blocked?: "path" | "sandbox";
    };

export interface StartRunOptions {
  home: string;
  goal: string;
  provider: ModelProvider;
  agentId?: string;
  trigger?: string;
  sandbox?: Sandbox;
  cloner?: WorkspaceCloner;
  limits?: Partial<LoopLimits>;
  commandTimeoutMs?: number;
  signal?: AbortSignal;
  now?: () => number;
  onEvent?(e: RunEvent): void;
}

export interface RunSummary {
  runId: string;
  state: RunState;
  summary?: string;
  error?: string;
  steps: number;
  tokensIn: number;
  tokensOut: number;
  secs: number;
  diff?: DiffSummary;
}

export class RunError extends Error {}

const ACTIVE: RunState[] = ["QUEUED", "PREPARING", "RUNNING"];

/** What the tool acted on, for logs: the path or command. */
function targetOf(args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  const v = args.path ?? args.command ?? args.summary ?? "";
  return String(v).slice(0, 200);
}

function listing(ws: string): string {
  const out: string[] = [];
  const walk = (d: string, rel: string, depth: number) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= 50 || e.name === ".git" || e.name === ".DS_Store") continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      out.push(e.isDirectory() ? `${r}/` : r);
      if (e.isDirectory() && depth < 1) walk(join(d, e.name), r, depth + 1);
    }
  };
  walk(ws, "", 0);
  return out.length ? out.join("\n") : "(empty)";
}

export async function startRun(o: StartRunOptions): Promise<RunSummary> {
  const now = o.now ?? Date.now;
  const paths = cwPaths(o.home);
  if (!existsSync(paths.db)) throw new RunError("Coworker isn't set up yet. Run: cw init");
  const db = openDb(paths.db);
  try {
    migrate(db, now);
    return await execute(db, paths.runs, o, now);
  } finally {
    db.close();
  }
}

async function execute(db: Database, runsDir: string, o: StartRunOptions, now: () => number): Promise<RunSummary> {
  const agent = db
    .query<{ id: string; name: string; purpose: string; department_id: string }, [string]>(
      "SELECT id, name, purpose, department_id FROM agents WHERE id = ?",
    )
    .get(o.agentId ?? DEFAULT_AGENT_ID);
  if (!agent) throw new RunError(`No bot with id ${o.agentId ?? DEFAULT_AGENT_ID}.`);
  const dept = db
    .query<{ id: string; workspace_path: string; max_concurrency: number }, [string]>(
      "SELECT id, workspace_path, max_concurrency FROM departments WHERE id = ?",
    )
    .get(agent.department_id);
  if (!dept) throw new RunError("The bot's department is missing.");
  const busy = db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM runs WHERE department_id = ? AND state IN (${ACTIVE.map((s) => `'${s}'`).join(",")})`,
    )
    .get(dept.id);
  if ((busy?.n ?? 0) >= dept.max_concurrency) {
    throw new RunError("Another task is already running here. On an 8 GB Mac, Coworker runs one task at a time.");
  }

  const runId = newId("run");
  const started = now();
  const actor = `agent:${agent.id}`;
  const cow = new CowWorkspaces(runsDir, o.cloner ?? cloner());
  const runDir = cow.runDir(runId);
  let seq = 0;
  let state: RunState = "QUEUED";

  db.query(
    `INSERT INTO runs (id, agent_id, department_id, trigger, goal, state, model, created_at)
     VALUES (?, ?, ?, ?, ?, 'QUEUED', ?, ?)`,
  ).run(runId, agent.id, dept.id, o.trigger ?? "cli", o.goal, o.provider.id, started);
  appendAudit(
    db,
    { actor: "user", action: "run.created", runId, target: o.goal, detail: { agent: agent.id, model: o.provider.id } },
    now,
  );

  const setState = (next: RunState, extra: { summary?: string; error?: string } = {}) => {
    recordState(db, runId, state, next, extra, now);
    state = next;
    o.onEvent?.({ type: "state", runId, state: next });
  };
  const addStep = (kind: "model" | "tool", f: Record<string, string | number | null>) => {
    db.query(
      `INSERT INTO run_steps (run_id, seq, kind, tool_name, args_json, result_digest, result_preview, fingerprint, mutating, decision, started_at, ended_at)
       VALUES ($run_id, $seq, $kind, $tool_name, $args_json, $result_digest, $result_preview, $fingerprint, $mutating, $decision, $started_at, $ended_at)`,
    ).run({
      run_id: runId,
      seq: ++seq,
      kind,
      tool_name: null,
      args_json: null,
      result_digest: null,
      result_preview: null,
      fingerprint: null,
      mutating: 0,
      decision: null,
      started_at: now(),
      ended_at: now(),
      ...f,
    });
    return seq;
  };
  const transcript = (m: ChatMessage) => appendFileSync(join(runDir, "transcript.jsonl"), `${JSON.stringify(m)}\n`);

  let tokensIn = 0;
  let tokensOut = 0;
  let steps = 0;
  try {
    setState("PREPARING");
    const snap = cow.snapshot(runId, dept.workspace_path);
    const tmp = join(runDir, "tmp");
    mkdirSync(tmp, { recursive: true });
    db.query("UPDATE runs SET ws_path = ?, base_manifest = ? WHERE id = ?").run(snap.wsPath, snap.manifestHash, runId);
    const ws = realpathSync(snap.wsPath);

    setState("RUNNING");
    const initial: ChatMessage[] = [
      { role: "system", content: systemPrompt(agent.name, agent.purpose) },
      { role: "user", content: taskMessage(o.goal, listing(ws)) },
    ];
    for (const m of initial) transcript(m);
    const sb = o.sandbox ?? defaultSandbox();
    const tier = o.provider.id.startsWith("ollama:") || o.provider.id.startsWith("mock:") ? "local" : "api";

    const result = await runLoop({
      provider: o.provider,
      messages: initial,
      tools: TOOL_SPECS,
      limits: o.limits,
      signal: o.signal,
      now,
      exec: (name, args) =>
        runTool(name, args, { ws, tmp, sandbox: sb, commandTimeoutMs: o.commandTimeoutMs ?? 60_000 }),
      hooks: {
        onRecovered: (count) => o.onEvent?.({ type: "recovered", count }),
        onModel: (t) => {
          addStep("model", {
            args_json: canonicalJson({ tokensIn: t.tokensIn, tokensOut: t.tokensOut, secs: t.secs }),
            result_preview: t.text.slice(0, 2000) || null,
          });
          db.query(
            "INSERT INTO budget_ledger (ts, run_id, agent_id, department_id, tier, provider, model, tokens_in, tokens_out, usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
          ).run(
            now(),
            runId,
            agent.id,
            dept.id,
            tier,
            o.provider.id.split(":")[0] ?? "unknown",
            o.provider.id,
            t.tokensIn,
            t.tokensOut,
          );
          o.onEvent?.({ type: "model", ...t });
        },
        onTool: (s) => {
          steps++;
          const target = targetOf(s.args);
          const decision = s.result.blocked ? "deny" : "allow";
          const n = addStep("tool", {
            tool_name: s.call.name,
            args_json: s.args ? canonicalJson(s.args) : s.call.arguments,
            result_digest: sha256Hex(s.result.output),
            result_preview: s.result.output.slice(0, 2000),
            fingerprint: s.fingerprint,
            mutating: s.result.mutating ? 1 : 0,
            decision,
          });
          appendAudit(
            db,
            {
              actor,
              action: `tool.${s.call.name}`,
              runId,
              target,
              decision,
              detail: {
                step: n,
                ok: s.result.ok,
                label: s.result.label,
                ...(s.result.blocked ? { blockedBy: s.result.blocked } : {}),
              },
            },
            now,
          );
          o.onEvent?.({
            type: "tool",
            seq: steps,
            name: s.call.name,
            target,
            label: s.result.label,
            ok: s.result.ok,
            blocked: s.result.blocked,
          });
        },
      },
    });
    for (const m of result.messages.slice(initial.length)) transcript(m);
    tokensIn = result.tokensIn;
    tokensOut = result.tokensOut;
    db.query("UPDATE runs SET tokens_in = ?, tokens_out = ? WHERE id = ?").run(tokensIn, tokensOut, runId);

    const out = result.outcome;
    const base = { runId, steps, tokensIn, tokensOut, secs: (now() - started) / 1000 };
    if (out.kind === "finished") {
      const diff = cow.diff(runId);
      const changed = diff.added + diff.modified + diff.deleted > 0;
      if (!changed) cow.dropCopy(runId);
      setState(changed ? "REVIEWING" : "SUCCEEDED", { summary: out.summary });
      return { ...base, state, summary: out.summary, diff };
    }
    cow.dropCopy(runId);
    if (out.kind === "stopped") {
      setState("STOPPED", { error: out.reason });
      return { ...base, state, error: out.reason };
    }
    setState("FAILED", { error: out.error });
    return { ...base, state, error: out.error };
  } catch (e) {
    const msg = (e as Error).message;
    if (existsSync(runDir)) cow.dropCopy(runId);
    setState("FAILED", { error: msg });
    return { runId, state, error: msg, steps, tokensIn, tokensOut, secs: (now() - started) / 1000 };
  }
}
