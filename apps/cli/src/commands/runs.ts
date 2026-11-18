import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { covoPaths, tildify } from "@covo/core";
import { auditForRun, openDb } from "@covo/db";
import { approvalStreak, type Bot, findBot, RunError, type RunEvent, startRun, updateBot, usd } from "@covo/engine";
import {
  getLimits,
  loadUserPrices,
  type ModelConfig,
  ModelConfigError,
  type ModelProvider,
  providerFromConfig,
  resolveModel,
} from "@covo/models";
import { SecretError, secrets } from "@covo/platform";
import type { CliResult, Ctx } from "../main.ts";

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
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--model") model = args[++i];
    else if (args[i] === "--bot") botName = args[++i];
    else words.push(args[i] as string);
  }
  const goal = words.join(" ").trim();
  if (!goal) return { code: 2, out: 'Usage: covo run "<task>" [--bot <name>] [--model <saved model or name>]\n' };

  // Which models: --model, else the bot's own list, else the default.
  let bot: Bot | undefined;
  const entries: { label: string; cfg: ModelConfig; provider: ModelProvider }[] = [];
  const skipped: string[] = [];
  try {
    if (botName) bot = findBot(ctx.home, botName, ctx.now);
    const names: (string | undefined)[] = model ? [model] : bot?.models.length ? bot.models : [undefined];
    for (const n of names) {
      try {
        const cfg = await resolveModel(ctx.home, ctx.secrets ?? secrets(), ctx.env, n);
        const provider = ctx.provider ?? providerFromConfig(cfg);
        entries.push({ label: n ?? cfg.connection ?? cfg.model, cfg, provider });
      } catch (e) {
        if (names.length > 1 && (e instanceof ModelConfigError || e instanceof SecretError)) {
          skipped.push(`${n}: ${e.message}`);
        } else throw e;
      }
      if (ctx.provider) break; // tests inject one model
    }
  } catch (e) {
    if (e instanceof ModelConfigError || e instanceof SecretError || e instanceof RunError) {
      return { code: 1, out: `${e.message}\n` };
    }
    throw e;
  }
  if (!entries.length)
    return { code: 1, out: `None of ${bot?.name ?? "the bot"}'s models can be used:\n  ${skipped.join("\n  ")}\n` };
  const first = entries[0] as (typeof entries)[number];
  const cfg = first.cfg;
  const chain = entries.length > 1 ? entries.map((e) => ({ label: e.label, provider: e.provider })) : undefined;
  const print = ctx.print;
  const controller = new AbortController();
  const onInt = () => {
    print("\nStopping after the current step…\n");
    controller.abort();
  };
  process.once("SIGINT", onInt);

  let announced = false;
  const onEvent = (e: RunEvent) => {
    if (e.type === "state") {
      if (e.state === "PREPARING") print(`Run ${e.runId}\nMaking a safe copy of the workspace…\n`);
      if (e.state === "RUNNING" && !announced) {
        announced = true; // RUNNING comes again after a spending pause
        print(
          `${bot ? `${bot.name} is working` : "Working"} with ${cfg.model} via ${cfg.label}${
            chain
              ? ` (then ${chain
                  .slice(1)
                  .map((c) => c.label)
                  .join(", then ")} if it fails)`
              : ""
          }.${cfg.local ? " Each model step can take 10–30 s on this Mac." : ""}\n\n`,
        );
      }
    } else if (e.type === "tool") {
      const mark = e.blocked ? "⛔" : e.ok ? " " : "✗";
      print(
        `  ${String(e.seq).padStart(2)} ${mark} ${pad(e.name, 12)} ${pad(e.target || "", 40)} ${e.blocked ? `blocked (${e.blocked === "path" ? "outside the workspace" : "by the sandbox"})` : e.label}\n`,
      );
    } else if (e.type === "approval") {
      print(`\n  ⏸ ${e.summary}\n`);
      if (!ctx.prompt)
        print(`    Approve with: covo approve ${e.runId.slice(-6)}    Stop it with: covo deny ${e.runId.slice(-6)}\n`);
    } else if (e.type === "fallback") {
      print(`     (${e.from} failed: ${e.kind.replace("_", " ")}. Switching to ${e.to}.)\n`);
    } else if (e.type === "recovered") {
      print(`     (the bot typed its tool call as text; Covo understood it)\n`);
    } else if (e.type === "model" && e.toolCalls === 0 && e.text.trim()) {
      print(`     (the bot answered in words: "${pad(e.text.trim().replace(/\s+/g, " "), 60)}")\n`);
    }
  };

  try {
    for (const w of skipped) print(`Skipping ${w}\n`);
    const r = await startRun({
      home: ctx.home,
      goal,
      ...(bot ? { agentId: bot.id } : {}),
      ...(chain ? { chain } : { provider: first.provider }),
      signal: controller.signal,
      onEvent,
      now: ctx.now,
      spend: getLimits(ctx.home),
      prices: loadUserPrices(ctx.home),
      ...(ctx.prompt
        ? {
            askApproval: async () =>
              /^y/i.test(await (ctx.prompt as NonNullable<Ctx["prompt"]>).ask("Let it continue? (y/N)", "n")),
          }
        : {}),
    });
    const lines = [""];
    // Asked about spending often? Offer a higher limit for this bot, so it asks less (ADR-010).
    const limitTip = await suggestHigherLimit(ctx, r.runId);
    if (limitTip) lines.push(limitTip, "");
    const cost = r.costUsd > 0 ? `, ${usd(r.costUsd)}` : "";
    const time = `${r.secs.toFixed(0)} s, ${r.steps} step${r.steps === 1 ? "" : "s"}, ${r.tokensIn + r.tokensOut} tokens${cost}`;
    const short = r.runId.slice(-6);
    if (r.state === "KEPT" && r.autoKeep) {
      lines.push(`Done in ${time}.`, `Bot's summary: ${r.summary}`, "");
      lines.push(`Kept in your workspace (${bot?.level === "full" ? "fully automatic" : "automatic"} bot):`);
      for (const c of (r.diff?.changes ?? []).filter((c) => c.entry !== "dir"))
        lines.push(`  ${c.kind.padEnd(8)} ${c.path}`);
      lines.push("", `Changed your mind? Put everything back with: covo undo ${short}`);
    } else if (r.state === "REVIEWING" && r.diff) {
      lines.push(`Done in ${time}.`, `Bot's summary: ${r.summary}`, "");
      if (r.autoKeep?.conflicts.length) {
        lines.push(
          "Not kept automatically: you changed these files while the bot worked, so you decide.",
          ...r.autoKeep.conflicts.map((c) => `  ${c.path}`),
          "",
        );
      }
      lines.push(
        `Changes waiting for you: ${r.diff.modified} modified, ${r.diff.added} added, ${r.diff.deleted} deleted.`,
      );
      for (const c of r.diff.changes.filter((c) => c.entry !== "dir")) lines.push(`  ${c.kind.padEnd(8)} ${c.path}`);
      lines.push(
        "",
        "Nothing in your workspace has changed yet.",
        `  See the changes:  covo diff ${short}`,
        `  Keep them:        covo keep ${short}`,
        `  Throw them away:  covo discard ${short}`,
      );
    } else if (r.state === "SUCCEEDED") {
      lines.push(`Done in ${time}. No files were changed.`, `Bot's summary: ${r.summary}`);
    } else if (r.state === "STOPPED") {
      lines.push(`Stopped after ${time}: ${r.error}`, "The workspace copy was thrown away; your files are untouched.");
    } else {
      lines.push(`Failed after ${time}: ${r.error}`, "The workspace copy was thrown away; your files are untouched.");
    }
    lines.push(`Details: covo log ${r.runId}`, "");
    return { code: ["REVIEWING", "SUCCEEDED", "KEPT"].includes(r.state) ? 0 : 1, out: lines.join("\n") };
  } catch (e) {
    if (e instanceof RunError) return { code: 1, out: `${e.message}\n` };
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
