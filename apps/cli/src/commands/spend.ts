import type { Database } from "bun:sqlite";
import { existsSync, writeFileSync } from "node:fs";
import { covoPaths, tildify } from "@covo/core";
import { openDb } from "@covo/db";
import { decide, startOfLocalDay, usd } from "@covo/engine";
import {
  getLimits,
  loadUserPrices,
  ModelConfigError,
  PRICES_AS_OF,
  priceFor,
  pricesPath,
  setLimits,
} from "@covo/models";
import type { CliResult, Ctx } from "../main.ts";
import { findRun } from "./runs.ts";

// Spending: covo approve / deny, covo usage, covo limits, covo prices.

function withDb(ctx: Ctx, fn: (db: Database) => CliResult): CliResult {
  const p = covoPaths(ctx.home).db;
  if (!existsSync(p)) return { code: 1, out: `Covo isn't set up in ${tildify(ctx.home)} yet. Run: covo init\n` };
  const db = openDb(p);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

const limitText = (v: number | null) => (v === null ? "no limit" : usd(v));

// ---------------------------------------------------------------- approve / deny

export function decideCommand(ctx: Ctx, args: string[], approve: boolean): CliResult {
  return withDb(ctx, (db) => {
    let id: string | undefined;
    if (!args[0] || args[0] === "last") {
      id = db
        .query<{ id: string }, []>("SELECT id FROM approvals WHERE status = 'pending' ORDER BY rowid DESC LIMIT 1")
        .get()?.id;
      if (!id) return { code: 1, out: "Nothing is waiting for your OK.\n" };
    } else {
      const run = findRun(db, args[0]);
      if (typeof run !== "string") return { code: 1, out: `${run.error}\n` };
      id = db
        .query<{ id: string }, [string]>("SELECT id FROM approvals WHERE run_id = ? AND status = 'pending'")
        .get(run)?.id;
      if (!id) return { code: 1, out: `Run ${run} isn't waiting for your OK.\n` };
    }
    const summary = db
      .query<{ summary: string }, [string]>("SELECT summary FROM approvals WHERE id = ?")
      .get(id)?.summary;
    const ok = decide(
      db,
      id,
      approve ? "approved" : "denied",
      approve ? "you (covo approve)" : "you (covo deny)",
      ctx.now,
    );
    if (!ok) return { code: 1, out: "That request was already answered.\n" };
    return {
      code: 0,
      out: `${approve ? "Approved" : "Declined"}: ${summary}\n${approve ? "The bot carries on." : "The bot stops; its copy is thrown away."}\n`,
    };
  });
}

// ---------------------------------------------------------------- usage

export function usageCommand(ctx: Ctx, args: string[]): CliResult {
  const i = args.indexOf("--days");
  const days = i >= 0 ? Number(args[i + 1]) : 7;
  if (!Number.isInteger(days) || days < 1 || days > 366) return { code: 2, out: "Usage: covo usage [--days N]\n" };
  return withDb(ctx, (db) => {
    const today = startOfLocalDay(ctx.now());
    const since = today - (days - 1) * 86_400_000;
    type Row = { label: string; calls: number; tin: number; tout: number; cost: number; est: number };
    const by = (expr: string) =>
      db
        .query<Row, [number]>(
          `SELECT ${expr} AS label, COUNT(*) AS calls, SUM(tokens_in) AS tin, SUM(tokens_out) AS tout,
             SUM(usd) AS cost, MAX(estimated) AS est
           FROM budget_ledger l LEFT JOIN agents a ON a.id = l.agent_id
           WHERE l.ts >= ? GROUP BY label ORDER BY cost DESC, calls DESC`,
        )
        .all(since);
    const total =
      db.query<{ cost: number | null }, [number]>("SELECT SUM(usd) AS cost FROM budget_ledger WHERE ts >= ?").get(since)
        ?.cost ?? 0;
    const todaySpent =
      db.query<{ cost: number | null }, [number]>("SELECT SUM(usd) AS cost FROM budget_ledger WHERE ts >= ?").get(today)
        ?.cost ?? 0;
    const limits = getLimits(ctx.home);
    const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));
    const k = (n: number) =>
      n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
    const table = (title: string, rows: Row[]) => [
      title,
      ...rows.map(
        (r) =>
          `  ${pad(r.label ?? "?", 34)} ${String(r.calls).padStart(5)} calls  ${k(r.tin).padStart(7)} in  ${k(r.tout).padStart(7)} out  ${usd(r.cost).padStart(8)}${r.est ? " *" : ""}`,
      ),
    ];
    const lines = [
      `Spending, last ${days} day${days === 1 ? "" : "s"}: ${usd(total)}`,
      `Today: ${usd(todaySpent)} of ${limitText(limits.dayUsd)} daily limit. Each task: ${limitText(limits.runUsd)}.`,
      "",
    ];
    const models = by("l.model");
    if (!models.length) lines.push("No model calls yet.");
    else {
      lines.push(...table("By model", models), "", ...table("By bot", by("COALESCE(a.name, 'other')")));
      lines.push("", ...table("By day", by("strftime('%Y-%m-%d', l.ts / 1000, 'unixepoch', 'localtime')")));
      if (models.some((m) => m.est)) {
        lines.push(
          "",
          "* includes an estimate: Covo doesn't know this model's price. Set it with: covo prices set <model> <in> <out>",
        );
      }
    }
    const age = (ctx.now() - Date.parse(PRICES_AS_OF)) / 86_400_000;
    if (age > 90) lines.push("", `Built-in prices were checked on ${PRICES_AS_OF}; they may have changed.`);
    lines.push("");
    return { code: 0, out: lines.join("\n") };
  });
}

// ---------------------------------------------------------------- limits

function parseUsd(v: string | undefined): number | null {
  if (v === undefined) throw new ModelConfigError("Give an amount in dollars, or none.");
  if (/^(none|off|no)$/i.test(v)) return null;
  const n = Number(v.replace(/^\$/, ""));
  if (!Number.isFinite(n) || n < 0) throw new ModelConfigError(`"${v}" isn't a dollar amount.`);
  return n;
}

export function limitsCommand(ctx: Ctx, args: string[]): CliResult {
  try {
    const changes: { runUsd?: number | null; dayUsd?: number | null } = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--task" || args[i] === "--run") changes.runUsd = parseUsd(args[++i]);
      else if (args[i] === "--day") changes.dayUsd = parseUsd(args[++i]);
      else return { code: 2, out: "Usage: covo limits [--task <$ or none>] [--day <$ or none>]\n" };
    }
    const l = Object.keys(changes).length ? setLimits(ctx.home, changes) : getLimits(ctx.home);
    return {
      code: 0,
      out: [
        `${Object.keys(changes).length ? "Limits updated." : "Spending limits"}`,
        `  Each task  ${limitText(l.runUsd)}   (a bot can have its own: covo bots set "<name>" --task-limit 0.25)`,
        `  Each day   ${limitText(l.dayUsd)}   (all bots together, midnight to midnight)`,
        "",
        "A task that's about to go over pauses and asks you first. Free local models never count.",
        "",
      ].join("\n"),
    };
  } catch (e) {
    if (e instanceof ModelConfigError) return { code: 1, out: `${e.message}\n` };
    throw e;
  }
}

// ---------------------------------------------------------------- prices

export function pricesCommand(ctx: Ctx, args: string[]): CliResult {
  const [sub, model, inp, out] = args;
  const mine = loadUserPrices(ctx.home);
  if (sub === "set" && model && inp !== undefined && out !== undefined) {
    const p = { in: Number(inp), out: Number(out) };
    if (![p.in, p.out].every((n) => Number.isFinite(n) && n >= 0)) {
      return {
        code: 2,
        out: "Usage: covo prices set <model> <$ per million input tokens> <$ per million output tokens>\n",
      };
    }
    mine[model] = p;
    writeFileSync(pricesPath(ctx.home), `${JSON.stringify(mine, null, 2)}\n`);
    return {
      code: 0,
      out: `Saved: ${model} costs $${p.in} per million input tokens and $${p.out} per million output tokens.\n`,
    };
  }
  if (sub === "remove" && model) {
    delete mine[model];
    writeFileSync(pricesPath(ctx.home), `${JSON.stringify(mine, null, 2)}\n`);
    return { code: 0, out: `Removed your price for ${model}.\n` };
  }
  if (sub) return { code: 2, out: "Usage: covo prices [set <model> <in> <out> | remove <model>]\n" };
  const lines = [
    `Prices in US dollars per million tokens (input / output). Built-in prices checked ${PRICES_AS_OF}.`,
    "",
  ];
  for (const m of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-2"]) {
    const p = priceFor(`anthropic:${m}`, mine);
    lines.push(`  ${m.padEnd(28)} $${p.in} / $${p.out}${p.source === "yours" ? "  (yours)" : ""}`);
  }
  for (const [m, p] of Object.entries(mine))
    if (!m.startsWith("claude-")) lines.push(`  ${m.padEnd(28)} $${p.in} / $${p.out}  (yours)`);
  lines.push(
    "",
    "Local models are free. Other cloud models without a price are counted at a cautious $5 / $25 until you set one:",
    "  covo prices set <model> <in> <out>",
    "",
  );
  return { code: 0, out: lines.join("\n") };
}
