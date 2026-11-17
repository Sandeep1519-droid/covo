import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { cwPaths, tildify } from "@cw/core";
import { auditForRun, openDb } from "@cw/db";
import { RunError, type RunEvent, startRun } from "@cw/engine";
import { modelConfig, providerFromConfig } from "@cw/models";
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
  const { db: path } = cwPaths(ctx.home);
  if (!existsSync(path)) return { code: 1, out: `Coworker isn't set up in ${tildify(ctx.home)} yet. Run: cw init\n` };
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

// ---------------------------------------------------------------- cw run

export async function runCommand(ctx: Ctx, args: string[]): Promise<CliResult> {
  const words: string[] = [];
  let model: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--model") model = args[++i];
    else words.push(args[i] as string);
  }
  const goal = words.join(" ").trim();
  if (!goal) return { code: 2, out: 'Usage: cw run "<task>" [--model <name>]\n' };

  const cfg = modelConfig(model ? { ...ctx.env, CW_MODEL: model } : ctx.env);
  const provider = ctx.provider ?? providerFromConfig(cfg);
  const print = ctx.print;
  const controller = new AbortController();
  const onInt = () => {
    print("\nStopping after the current step…\n");
    controller.abort();
  };
  process.once("SIGINT", onInt);

  const onEvent = (e: RunEvent) => {
    if (e.type === "state") {
      if (e.state === "PREPARING") print(`Run ${e.runId}\nMaking a safe copy of the workspace…\n`);
      if (e.state === "RUNNING")
        print(`Working with ${cfg.model} via ${cfg.name}. Each model step can take 10–30 s on this Mac.\n\n`);
    } else if (e.type === "tool") {
      const mark = e.blocked ? "⛔" : e.ok ? " " : "✗";
      print(
        `  ${String(e.seq).padStart(2)} ${mark} ${pad(e.name, 12)} ${pad(e.target || "", 40)} ${e.blocked ? `blocked (${e.blocked === "path" ? "outside the workspace" : "by the sandbox"})` : e.label}\n`,
      );
    } else if (e.type === "recovered") {
      print(`     (the bot typed its tool call as text; Coworker understood it)\n`);
    } else if (e.type === "model" && e.toolCalls === 0 && e.text.trim()) {
      print(`     (the bot answered in words: "${pad(e.text.trim().replace(/\s+/g, " "), 60)}")\n`);
    }
  };

  try {
    const r = await startRun({ home: ctx.home, goal, provider, signal: controller.signal, onEvent, now: ctx.now });
    const lines = [""];
    const time = `${r.secs.toFixed(0)} s, ${r.steps} step${r.steps === 1 ? "" : "s"}, ${r.tokensIn + r.tokensOut} tokens`;
    if (r.state === "REVIEWING" && r.diff) {
      lines.push(`Done in ${time}.`, `Bot's summary: ${r.summary}`, "");
      lines.push(
        `Changes waiting for you: ${r.diff.modified} modified, ${r.diff.added} added, ${r.diff.deleted} deleted.`,
      );
      for (const c of r.diff.changes.filter((c) => c.entry !== "dir")) lines.push(`  ${c.kind.padEnd(8)} ${c.path}`);
      const short = r.runId.slice(-6);
      lines.push(
        "",
        "Nothing in your workspace has changed yet.",
        `  See the changes:  cw diff ${short}`,
        `  Keep them:        cw keep ${short}`,
        `  Throw them away:  cw discard ${short}`,
      );
    } else if (r.state === "SUCCEEDED") {
      lines.push(`Done in ${time}. No files were changed.`, `Bot's summary: ${r.summary}`);
    } else if (r.state === "STOPPED") {
      lines.push(`Stopped after ${time}: ${r.error}`, "The workspace copy was thrown away; your files are untouched.");
    } else {
      lines.push(`Failed after ${time}: ${r.error}`, "The workspace copy was thrown away; your files are untouched.");
    }
    lines.push(`Details: cw log ${r.runId}`, "");
    return { code: r.state === "REVIEWING" || r.state === "SUCCEEDED" ? 0 : 1, out: lines.join("\n") };
  } catch (e) {
    if (e instanceof RunError) return { code: 1, out: `${e.message}\n` };
    throw e;
  } finally {
    process.off("SIGINT", onInt);
  }
}

// ---------------------------------------------------------------- cw status

export function statusCommand(ctx: Ctx): CliResult {
  const r = withDb(ctx, (db) => {
    const rows = db
      .query<{ id: string; state: string; goal: string; created_at: number; steps: number }, []>(
        `SELECT r.id, r.state, r.goal, r.created_at,
           (SELECT COUNT(*) FROM run_steps s WHERE s.run_id = r.id AND s.kind = 'tool') AS steps
         FROM runs r ORDER BY r.created_at DESC, r.id DESC LIMIT 15`,
      )
      .all();
    if (!rows.length) return { code: 0, out: 'No runs yet. Try: cw run "add a Setup section to README.md"\n' };
    const now = ctx.now();
    const lines = [`${pad("RUN", 31)} ${pad("STATE", 10)} ${pad("STEPS", 5)} ${pad("STARTED", 9)} TASK`];
    for (const x of rows)
      lines.push(
        `${pad(x.id, 31)} ${pad(x.state, 10)} ${pad(String(x.steps), 5)} ${pad(ago(now - x.created_at), 9)} ${pad(x.goal, 50)}`,
      );
    return { code: 0, out: `${lines.join("\n")}\n` };
  });
  return r;
}

// ---------------------------------------------------------------- cw log

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
    lines.push("", `Activity log: ${audit.length} entries for this run (check them all with: cw audit verify)`, "");
    return { code: 0, out: lines.join("\n") };
  }) as CliResult;
}
