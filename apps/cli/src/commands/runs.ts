import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { covoPaths, tildify } from "@covo/core";
import { auditForRun, openDb } from "@covo/db";
import {
  approvalStreak,
  decide,
  RunError,
  type RunEvent,
  type RunSummary,
  startRun,
  updateBot,
  usd,
} from "@covo/engine";
import { getLimits } from "@covo/models";
import type { CliResult, Ctx } from "../main.ts";
import {
  eventPrinter,
  headerLines,
  type Prepared,
  PrepareError,
  prepareRun,
  type RunHeader,
  type RunRequest,
  succeeded,
  summaryLines,
} from "../runner.ts";
import { runViaService, ServiceRefused, serviceHealth, stopViaService } from "../service/client.ts";

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));
const ago = (ms: number) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

function withDb<T>(ctx: Ctx, fn: (db: Database) => T): T | CliResult {
  const { db: path } = covoPaths(ctx.home);
  if (!existsSync(path)) return { code: 1, out: `Covo isn't set up in ${tildify(ctx.home)} yet. Run: covo init\n` };
  const db = openDb(path);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** Accepts a full run id, "last", or a unique ending of at least 4 characters. */
export function findRun(db: Database, arg: string | undefined): string | { error: string } {
  if (!arg) return { error: "Which run? Give its id, or use: last" };
  if (arg === "last") {
    const r = db.query<{ id: string }, []>("SELECT id FROM runs ORDER BY created_at DESC, id DESC LIMIT 1").get();
    return r?.id ?? { error: "There are no runs yet." };
  }
  const exact = db.query<{ id: string }, [string]>("SELECT id FROM runs WHERE id = ?").get(arg);
  if (exact) return exact.id;
  if (arg.length < 4) return { error: `No run "${arg}". Use at least 4 characters of its id.` };
  const hits = db.query<{ id: string }, [string]>("SELECT id FROM runs WHERE id LIKE ?").all(`%${arg}`);
  if (hits.length === 1 && hits[0]) return hits[0].id;
  return { error: hits.length ? `"${arg}" matches ${hits.length} runs; use more of the id.` : `No run "${arg}".` };
}

// ---------------------------------------------------------------- covo run

export async function runCommand(ctx: Ctx, args: string[]): Promise<CliResult> {
  const words: string[] = [];
  let model: string | undefined;
  let botName: string | undefined;
  let here = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--model") model = args[++i];
    else if (args[i] === "--bot") botName = args[++i];
    else if (args[i] === "--here") here = true;
    else words.push(args[i] as string);
  }
  const goal = words.join(" ").trim();
  if (!goal)
    return { code: 2, out: 'Usage: covo run "<task>" [--bot <name>] [--model <saved model or name>] [--here]\n' };
  const req: RunRequest = { goal, ...(botName ? { bot: botName } : {}), ...(model ? { model } : {}) };

  // With the service running, it does the work, so the task carries on if this terminal closes.
  // Tests inject models, and --here runs in this process instead.
  const useService = !here && !ctx.provider && !ctx.engine && ctx.env.COVO_SERVICE !== "off";
  if (useService && (await serviceHealth(ctx.home))) return runWithService(ctx, req);
  return runHere(ctx, req);
}

const askToContinue = async (ctx: Ctx) =>
  /^y/i.test(await (ctx.prompt as NonNullable<Ctx["prompt"]>).ask("Let it continue? (y/N)", "n"));

async function finishLines(ctx: Ctx, r: RunSummary, header: RunHeader): Promise<CliResult> {
  const lines = [""];
  // Asked about spending often? Offer a higher limit for this bot, so it asks less (ADR-010).
  const limitTip = await suggestHigherLimit(ctx, r.runId);
  if (limitTip) lines.push(limitTip, "");
  lines.push(...summaryLines(r, header), "");
  return { code: succeeded(r) ? 0 : 1, out: lines.join("\n") };
}

async function runHere(ctx: Ctx, req: RunRequest): Promise<CliResult> {
  let prepared: Prepared;
  try {
    prepared = await prepareRun(ctx, req);
  } catch (e) {
    if (e instanceof PrepareError) return { code: 1, out: `${e.message}\n` };
    throw e;
  }
  const print = ctx.print;
  const controller = new AbortController();
  const onInt = () => {
    print("\nStopping after the current step…\n");
    controller.abort();
  };
  process.once("SIGINT", onInt);
  try {
    for (const l of headerLines(prepared.header)) print(`${l}\n`);
    const r = await startRun({
      ...prepared.options,
      signal: controller.signal,
      onEvent: eventPrinter(print, prepared.header, { interactive: ctx.prompt !== undefined }),
      ...(ctx.prompt ? { askApproval: () => askToContinue(ctx) } : {}),
    });
    return await finishLines(ctx, r, prepared.header);
  } catch (e) {
    if (e instanceof RunError) return { code: 1, out: `${e.message}\n` };
    throw e;
  } finally {
    process.off("SIGINT", onInt);
  }
}

/** Answers a spending pause from this terminal, for a run the service is doing. */
function answerHere(ctx: Ctx, runId: string, yes: boolean): void {
  withDb(ctx, (db) => {
    const id = db
      .query<{ id: string }, [string]>("SELECT id FROM approvals WHERE run_id = ? AND status = 'pending'")
      .get(runId)?.id;
    if (id) decide(db, id, yes ? "approved" : "denied", yes ? "you (terminal)" : "you (terminal)", ctx.now);
  });
}

async function runWithService(ctx: Ctx, req: RunRequest): Promise<CliResult> {
  const print = ctx.print;
  let header: RunHeader | undefined;
  let printer: ((e: RunEvent) => void) | undefined;
  let job: string | undefined;
  let runId: string | undefined;
  const onInt = () => {
    print("\nStopping after the current step…\n");
    const id = runId ?? job;
    if (id) void stopViaService(ctx.home, id);
  };
  process.once("SIGINT", onInt);
  try {
    const last = await runViaService(ctx.home, req, (m) => {
      if (m.type === "queued") {
        job = m.job;
        if (m.position > 0) print(`Waiting: ${m.position} task${m.position === 1 ? "" : "s"} ahead of this one.\n`);
      } else if (m.type === "waiting") print(`Waiting: ${m.reason}\n`);
      else if (m.type === "header") {
        header = m.header;
        for (const l of headerLines(m.header)) print(`${l}\n`);
        printer = eventPrinter(print, m.header, { interactive: ctx.prompt !== undefined });
      } else if (m.type === "event") {
        if (m.event.type === "state") runId = m.event.runId;
        printer?.(m.event);
        if (m.event.type === "approval" && ctx.prompt) {
          const rid = m.event.runId;
          void askToContinue(ctx).then((yes) => answerHere(ctx, rid, yes));
        }
      }
    });
    if (!last) {
      return {
        code: 1,
        out: `\nLost contact with Covo's service. ${runId ? `Check the task with: covo log ${runId}` : "See: covo status"}\n`,
      };
    }
    if (last.type === "error") return { code: 1, out: `${last.message}\n` };
    if (last.type !== "done") return { code: 1, out: "The service ended the task without a result.\n" };
    return await finishLines(ctx, last.summary, header as RunHeader);
  } catch (e) {
    if (e instanceof ServiceRefused) return { code: 1, out: `${e.message}\n` };
    throw e;
  } finally {
    process.off("SIGINT", onInt);
  }
}

const STREAK = 3;
const WEEK_MS = 7 * 86_400_000;

async function suggestHigherLimit(ctx: Ctx, runId: string): Promise<string | undefined> {
  const s = approvalStreak(ctx.home, runId, ctx.now() - WEEK_MS, ctx.now);
  if (s.approved < STREAK) return undefined;
  const current = s.taskLimitUsd ?? getLimits(ctx.home).runUsd;
  if (current === null) return undefined;
  const raised = Math.max(0.01, Math.ceil(current * 2 * 100) / 100);
  const question = `You've approved ${s.botName}'s spending ${s.approved} times this week. Raise its task limit from ${usd(current)} to ${usd(raised)}, so it asks less?`;
  if (!ctx.prompt) return `Tip: ${question} Run: covo bots set "${s.botName}" --task-limit ${raised}`;
  if (!/^y/i.test(await ctx.prompt.ask(`${question} (y/N)`, "n"))) return undefined;
  updateBot(ctx.home, s.botName, { taskLimitUsd: raised }, ctx.now);
  return `${s.botName} may now spend up to ${usd(raised)} per task. Change it any time: covo bots set "${s.botName}" --task-limit <amount>`;
}

// ---------------------------------------------------------------- covo status

export function statusCommand(ctx: Ctx): CliResult {
  const r = withDb(ctx, (db) => {
    const rows = db
      .query<{ id: string; state: string; goal: string; created_at: number; steps: number }, []>(
        `SELECT r.id, r.state, r.goal, r.created_at,
           (SELECT COUNT(*) FROM run_steps s WHERE s.run_id = r.id AND s.kind = 'tool') AS steps
         FROM runs r ORDER BY r.created_at DESC, r.id DESC LIMIT 15`,
      )
      .all();
    if (!rows.length) return { code: 0, out: 'No runs yet. Try: covo run "add a Setup section to README.md"\n' };
    const now = ctx.now();
    const lines = [`${pad("RUN", 31)} ${pad("STATE", 17)} ${pad("STEPS", 5)} ${pad("STARTED", 9)} TASK`];
    for (const x of rows)
      lines.push(
        `${pad(x.id, 31)} ${pad(x.state, 17)} ${pad(String(x.steps), 5)} ${pad(ago(now - x.created_at), 9)} ${pad(x.goal, 50)}`,
      );
    return { code: 0, out: `${lines.join("\n")}\n` };
  });
  return r;
}

// ---------------------------------------------------------------- covo log

export function logCommand(ctx: Ctx, args: string[]): CliResult {
  return withDb(ctx, (db) => {
    const id = findRun(db, args[0]);
    if (typeof id !== "string") return { code: 1, out: `${id.error}\n` };
    const run = db
      .query<
        {
          goal: string;
          state: string;
          model: string | null;
          summary: string | null;
          error: string | null;
          created_at: number;
          finished_at: number | null;
          tokens_in: number;
          tokens_out: number;
        },
        [string]
      >(
        "SELECT goal, state, model, summary, error, created_at, finished_at, tokens_in, tokens_out FROM runs WHERE id = ?",
      )
      .get(id);
    if (!run) return { code: 1, out: `No run ${id}\n` };
    const steps = db
      .query<
        {
          seq: number;
          kind: string;
          tool_name: string | null;
          args_json: string | null;
          result_preview: string | null;
          decision: string | null;
        },
        [string]
      >("SELECT seq, kind, tool_name, args_json, result_preview, decision FROM run_steps WHERE run_id = ? ORDER BY seq")
      .all(id);
    const secs = run.finished_at ? ((run.finished_at - run.created_at) / 1000).toFixed(0) : "?";
    const lines = [
      `Run ${id}`,
      `  Task     ${run.goal}`,
      `  State    ${run.state}${run.error ? ` (${run.error})` : ""}`,
      `  Model    ${run.model ?? "?"}, ${run.tokens_in + run.tokens_out} tokens, ${secs} s`,
    ];
    if (run.summary) lines.push(`  Summary  ${run.summary}`);
    lines.push("", "Steps");
    for (const s of steps) {
      if (s.kind === "model") {
        const m = JSON.parse(s.args_json ?? "{}") as { tokensOut?: number; secs?: number };
        lines.push(
          `  ${String(s.seq).padStart(3)}  model      thought for ${(m.secs ?? 0).toFixed(1)} s, ${m.tokensOut ?? 0} tokens`,
        );
        continue;
      }
      const a = JSON.parse(s.args_json ?? "{}") as Record<string, unknown>;
      const what = String(a.path ?? a.command ?? a.summary ?? "");
      const first = (s.result_preview ?? "").split("\n")[0] ?? "";
      const flag = s.decision === "deny" ? "  ⛔ blocked" : "";
      lines.push(
        `  ${String(s.seq).padStart(3)}  ${pad(s.tool_name ?? "?", 10)} ${pad(what, 36)} ${pad(first, 50)}${flag}`,
      );
    }
    const audit = auditForRun(db, id);
    lines.push("", `Activity log: ${audit.length} entries for this run (check them all with: covo audit verify)`, "");
    return { code: 0, out: lines.join("\n") };
  }) as CliResult;
}
