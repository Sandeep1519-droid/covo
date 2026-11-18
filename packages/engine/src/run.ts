import type { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, covoPaths, newId, sha256Hex } from "@covo/core";
import { appendAudit, DEFAULT_AGENT_ID, migrate, openDb } from "@covo/db";
import { type ChainEntry, type ChatMessage, FallbackProvider, type ModelProvider, type Price } from "@covo/models";
import { cloner, sandbox as defaultSandbox, type Sandbox, type WorkspaceCloner } from "@covo/platform";
import { CowWorkspaces, type DiffSummary } from "@covo/sandbox";
import { type AskApproval, Budget, type SpendLimits, type SpendRequest } from "./budget.ts";
import { type LoopLimits, type ModelTurn, runLoop } from "./loop.ts";
import { systemPrompt, taskMessage } from "./prompt.ts";
import { type KeepOutcome, keepChanges } from "./review.ts";
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
  | { type: "fallback"; from: string; to: string; kind: string; error: string }
  | ({ type: "approval" } & SpendRequest)
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
  /** One model… */
  provider?: ModelProvider;
  /** …or the bot's models in order; the next takes over when one fails (Phase 2, M2). */
  chain?: ChainEntry[];
  agentId?: string;
  trigger?: string;
  sandbox?: Sandbox;
  cloner?: WorkspaceCloner;
  limits?: Partial<LoopLimits>;
  commandTimeoutMs?: number;
  signal?: AbortSignal;
  now?: () => number;
  onEvent?(e: RunEvent): void;
  /** Spending limits; the bot's own task limit, if set, replaces `runUsd`. Default: none. */
  spend?: SpendLimits;
  /** Your own model prices (~/Covo/prices.json). */
  prices?: Record<string, Price>;
  /** Answers a spending pause directly; without it the run waits for `covo approve`. */
  askApproval?: AskApproval;
  approvalPollMs?: number;
  /** Tasks allowed at once (from the power profile); defaults to the department's setting. */
  maxConcurrent?: number;
}

export interface RunSummary {
  runId: string;
  state: RunState;
  summary?: string;
  error?: string;
  steps: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  secs: number;
  /** Set when an automatic bot kept its changes itself (or tried to, and hit a conflict). */
  autoKeep?: KeepOutcome;
  diff?: DiffSummary;
}

export class RunError extends Error {}

const ACTIVE: RunState[] = ["QUEUED", "PREPARING", "RUNNING", "AWAITING_APPROVAL"];

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
  const paths = covoPaths(o.home);
  if (!existsSync(paths.db)) throw new RunError("Covo isn't set up yet. Run: covo init");
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
    .query<
      {
        id: string;
        name: string;
        purpose: string;
        department_id: string;
        status: string;
        run_limit_usd: number | null;
        level: "supervised" | "automatic" | "full";
      },
      [string]
    >("SELECT id, name, purpose, department_id, status, run_limit_usd, level FROM agents WHERE id = ?")
    .get(o.agentId ?? DEFAULT_AGENT_ID);
  if (!agent) throw new RunError(`No bot with id ${o.agentId ?? DEFAULT_AGENT_ID}.`);
  if (agent.status !== "active") throw new RunError(`${agent.name} is ${agent.status}, so it can't take tasks.`);
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
  const allowed = o.maxConcurrent ?? dept.max_concurrency;
  if ((busy?.n ?? 0) >= allowed) {
    throw new RunError(
      allowed === 1
        ? "Another task is already running. This Mac runs one task at a time; try again when it finishes (see: covo status)."
        : `${busy?.n} tasks are already running, the most this Mac runs at once. Try again when one finishes (see: covo status).`,
    );
  }

  if (!o.chain?.length && !o.provider) throw new RunError("No model to run with.");
  const runId = newId("run");
  const started = now();
  const provider: ModelProvider = o.chain?.length
    ? new FallbackProvider(o.chain, (sw) => {
        db.query("UPDATE runs SET model = ? WHERE id = ?").run(provider.id, runId);
        appendAudit(db, { actor: "system", action: "model.fallback", runId, target: sw.to, detail: { ...sw } }, now);
        o.onEvent?.({ type: "fallback", ...sw });
      })
    : (o.provider as ModelProvider);
  const actor = `agent:${agent.id}`;
  const cow = new CowWorkspaces(runsDir, o.cloner ?? cloner());
  const runDir = cow.runDir(runId);
  let seq = 0;
  let state: RunState = "QUEUED";

  db.query(
    `INSERT INTO runs (id, agent_id, department_id, trigger, goal, state, model, created_at)
     VALUES (?, ?, ?, ?, ?, 'QUEUED', ?, ?)`,
  ).run(runId, agent.id, dept.id, o.trigger ?? "cli", o.goal, provider.id, started);
  appendAudit(
    db,
    {
      actor: "user",
      action: "run.created",
      runId,
      target: o.goal,
      detail: { agent: agent.id, model: provider.id, ...(o.chain ? { chain: o.chain.map((c) => c.label) } : {}) },
    },
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
  let budgetRef: Budget | undefined;
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
    const budget = new Budget({
      db,
      runId,
      botName: agent.name,
      limits: {
        runUsd: agent.run_limit_usd ?? o.spend?.runUsd ?? null,
        dayUsd: o.spend?.dayUsd ?? null,
      },
      prices: o.prices ?? {},
      now,
      setState: (st) => setState(st),
      onRequest: (req) => o.onEvent?.({ type: "approval", ...req }),
      ask: o.askApproval,
      // Fully automatic bots never ask: they stop at their limit (ADR-010).
      neverAsk: agent.level === "full",
      pollMs: o.approvalPollMs,
      signal: o.signal,
    });
    budgetRef = budget;

    const result = await runLoop({
      provider,
      messages: initial,
      tools: TOOL_SPECS,
      limits: o.limits,
      signal: o.signal,
      now,
      exec: (name, args) =>
        runTool(name, args, { ws, tmp, sandbox: sb, commandTimeoutMs: o.commandTimeoutMs ?? 60_000 }),
      hooks: {
        beforeModel: (messages) => budget.check(provider.id, messages),
        onRecovered: (count) => o.onEvent?.({ type: "recovered", count }),
        onModel: (t) => {
          // Read at each step: a fallback may have switched models mid-run.
          const pid = provider.id;
          const tier = /^(ollama|lmstudio|mock):/.test(pid) ? "local" : "api";
          addStep("model", {
            args_json: canonicalJson({ tokensIn: t.tokensIn, tokensOut: t.tokensOut, secs: t.secs }),
            result_preview: t.text.slice(0, 2000) || null,
          });
          const cost = budget.record(pid, t.tokensIn, t.tokensOut);
          db.query(
            "INSERT INTO budget_ledger (ts, run_id, agent_id, department_id, tier, provider, model, tokens_in, tokens_out, usd, estimated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          ).run(
            now(),
            runId,
            agent.id,
            dept.id,
            tier,
            pid.split(":")[0] ?? "unknown",
            pid,
            t.tokensIn,
            t.tokensOut,
            cost.usd,
            cost.estimated ? 1 : 0,
          );
          db.query("UPDATE runs SET cost_usd = ? WHERE id = ?").run(budget.runSpent, runId);
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
    const base = { runId, steps, tokensIn, tokensOut, costUsd: budget.runSpent, secs: (now() - started) / 1000 };
    if (out.kind === "finished") {
      const diff = cow.diff(runId);
      const changed = diff.added + diff.modified + diff.deleted > 0;
      if (!changed) cow.dropCopy(runId);
      setState(changed ? "REVIEWING" : "SUCCEEDED", { summary: out.summary });
      if (changed && agent.level !== "supervised") {
        // Automatic and fully automatic bots keep undoable work themselves (ADR-010).
        const kept = keepChanges(db, runId, cow, now, { actor: "system" });
        if (!kept.conflicts.length) {
          state = "KEPT";
          o.onEvent?.({ type: "state", runId, state });
        }
        return { ...base, state, summary: out.summary, diff, autoKeep: kept };
      }
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
    return {
      runId,
      state,
      error: msg,
      steps,
      tokensIn,
      tokensOut,
      costUsd: budgetRef?.runSpent ?? 0,
      secs: (now() - started) / 1000,
    };
  }
}
