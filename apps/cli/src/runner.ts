import { homedir } from "node:os";
import {
  type Bot,
  type Engine,
  findBot,
  type RunChainEntry,
  RunError,
  type RunEvent,
  type RunSummary,
  type StartRunOptions,
  usd,
} from "@covo/engine";
import {
  getLimits,
  getRoutineSettings,
  loadUserPrices,
  type ModelConfig,
  ModelConfigError,
  type ModelProvider,
  providerFromConfig,
  resolveModel,
} from "@covo/models";
import { SecretError, secrets } from "@covo/platform";
import { makeEngine } from "./commands/engines.ts";
import { currentCapacity } from "./commands/profile.ts";
import type { Ctx } from "./main.ts";

// A run, in parts that both `covo run` and the service (covod) use: prepare it (which bot and
// models, sized to this Mac), show its progress, and describe how it ended.

export interface RunRequest {
  goal: string;
  /** Earlier chat turns, sent as background (the app's chat). */
  context?: string;
  /** A routine's run (M6): nobody is watching, so subscription engines are left out unless allowed. */
  routineId?: string;
  unattended?: boolean;
  /** The routine's own spending limit per run. */
  runLimitUsd?: number | null;
  bot?: string;
  model?: string;
  trigger?: string;
}

/** What's printed before and during a run; plain data, so the service can send it. */
export interface RunHeader {
  bot?: { name: string; level: Bot["level"] };
  /** "qwen3.5:4b via Ollama (…)" or "Claude Code (…)". */
  using: string;
  /** The fallback models, in order. */
  fallbacks: string[];
  local: boolean;
  skipped: string[];
  notes: string[];
}

export interface Prepared {
  header: RunHeader;
  /** Everything startRun needs except the per-run hooks. */
  options: Omit<StartRunOptions, "onEvent" | "signal" | "askApproval">;
}

export class PrepareError extends Error {}

/** Picks the bot and its models and sizes the run to this Mac. Throws PrepareError with a message for people. */
export async function prepareRun(ctx: Ctx, req: RunRequest): Promise<Prepared> {
  const cap = currentCapacity(ctx);
  if (!cap.canStart) throw new PrepareError(`Not starting: ${cap.notes.join(" ")}`);
  const env = {
    ...ctx.env,
    COVO_MODEL_CONTEXT: ctx.env.COVO_MODEL_CONTEXT ?? String(cap.profile.contextTokens),
    COVO_MODEL_KEEP_ALIVE: ctx.env.COVO_MODEL_KEEP_ALIVE ?? cap.profile.keepAlive,
  };

  // Which models: the one asked for, else the bot's own list, else the default.
  let bot: Bot | undefined;
  const entries: { label: string; cfg: ModelConfig; provider?: ModelProvider; engine?: Engine }[] = [];
  const skipped: string[] = [];
  let unattendedSkips = 0;
  try {
    if (req.bot) bot = findBot(ctx.home, req.bot, ctx.now);
    const names: (string | undefined)[] = req.model ? [req.model] : bot?.models.length ? bot.models : [undefined];
    for (const n of names) {
      try {
        const cfg = await resolveModel(ctx.home, ctx.secrets ?? secrets(), env, n);
        const label = n ?? cfg.connection ?? cfg.model;
        if (cfg.subscription && req.unattended && !getRoutineSettings(ctx.home).subscriptions) {
          // Routines run with nobody watching; subscriptions are for you at the keyboard unless you
          // allow it (Settings, or: covo routines subscriptions on). Check your provider's terms first.
          skipped.push(`${label}: routines don't use subscriptions unless you allow it`);
          unattendedSkips++;
          continue;
        }
        if (cfg.engine) {
          // A subscription engine (docs/SUBSCRIPTIONS.md): it runs first and does the whole task.
          const engine = makeEngine(ctx, cfg.engine, cfg.model);
          if ("missing" in engine) throw new ModelConfigError(engine.missing);
          if (entries.some((e) => e.provider))
            skipped.push(`${label}: a subscription engine must come first in a bot's model list`);
          else entries.push({ label, cfg, engine });
          continue;
        }
        const provider = ctx.provider ?? providerFromConfig(cfg);
        entries.push({ label, cfg, provider });
      } catch (e) {
        if (names.length > 1 && (e instanceof ModelConfigError || e instanceof SecretError)) {
          skipped.push(`${n}: ${e.message}`);
        } else throw e;
      }
      if (ctx.provider) break; // tests inject one model
    }
  } catch (e) {
    if (e instanceof ModelConfigError || e instanceof SecretError || e instanceof RunError) {
      throw new PrepareError(e.message);
    }
    throw e;
  }
  // A routine whose only models are subscriptions falls back to the free local model.
  if (!entries.length && unattendedSkips > 0) {
    try {
      const cfg = await resolveModel(ctx.home, ctx.secrets ?? secrets(), env, "local");
      entries.push({ label: "local", cfg, provider: ctx.provider ?? providerFromConfig(cfg) });
    } catch (e) {
      skipped.push(`local: ${(e as Error).message}`);
    }
  }
  if (!entries.length) {
    throw new PrepareError(`None of ${bot?.name ?? "the bot"}'s models can be used:\n  ${skipped.join("\n  ")}`);
  }
  const first = entries[0] as (typeof entries)[number];
  const chain: RunChainEntry[] | undefined =
    entries.length > 1 || first.engine
      ? entries.map((e) =>
          e.engine ? { label: e.label, engine: e.engine } : { label: e.label, provider: e.provider as ModelProvider },
        )
      : undefined;
  return {
    header: {
      ...(bot ? { bot: { name: bot.name, level: bot.level } } : {}),
      using: first.engine ? first.cfg.label : `${first.cfg.model} via ${first.cfg.label}`,
      fallbacks: entries.slice(1).map((e) => e.label),
      local: first.cfg.local,
      skipped,
      notes: cap.notes,
    },
    options: {
      home: ctx.home,
      goal: req.goal,
      ...(req.context ? { context: req.context } : {}),
      ...(req.routineId ? { routineId: req.routineId } : {}),
      ...(req.runLimitUsd !== undefined && req.runLimitUsd !== null ? { runLimitUsd: req.runLimitUsd } : {}),
      ...(req.trigger ? { trigger: req.trigger } : {}),
      ...(bot ? { agentId: bot.id } : {}),
      ...(chain ? { chain } : { provider: first.provider as ModelProvider }),
      userHome: ctx.env.HOME ?? homedir(),
      now: ctx.now,
      maxConcurrent: cap.maxRuns,
      spend: getLimits(ctx.home),
      prices: loadUserPrices(ctx.home),
    },
  };
}

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));

/** Lines printed before the run starts. */
export function headerLines(h: RunHeader): string[] {
  return [...h.skipped.map((w) => `Skipping ${w}`), ...h.notes.map((n) => `Note: ${n}`)];
}

/** Turns run events into the progress lines `covo run` prints. */
export function eventPrinter(
  print: (s: string) => void,
  h: RunHeader,
  o: { interactive: boolean },
): (e: RunEvent) => void {
  let announced = false;
  return (e) => {
    if (e.type === "state") {
      if (e.state === "PREPARING") print(`Run ${e.runId}\nMaking a safe copy of the workspace…\n`);
      if (e.state === "RUNNING" && !announced) {
        announced = true; // RUNNING comes again after a spending pause
        print(
          `${h.bot ? `${h.bot.name} is working` : "Working"} with ${h.using}${
            h.fallbacks.length ? ` (then ${h.fallbacks.join(", then ")} if it fails)` : ""
          }.${h.local ? " Each model step can take 10–30 s on this Mac." : ""}\n\n`,
        );
      }
    } else if (e.type === "tool") {
      const mark = e.blocked ? "⛔" : e.ok ? " " : "✗";
      print(
        `  ${String(e.seq).padStart(2)} ${mark} ${pad(e.name, 12)} ${pad(e.target || "", 40)} ${e.blocked ? `blocked (${e.blocked === "path" ? "outside the workspace" : "by the sandbox"})` : e.label}\n`,
      );
    } else if (e.type === "approval") {
      print(`\n  ⏸ ${e.summary}\n`);
      if (!o.interactive)
        print(`    Approve with: covo approve ${e.runId.slice(-6)}    Stop it with: covo deny ${e.runId.slice(-6)}\n`);
    } else if (e.type === "engine") {
      if (e.phase === "start") print(`  ${e.label} is working in Covo's sandbox (file tools only)…\n`);
      else if (e.ok)
        print(
          `  ${e.label} finished: ${e.turns} turn${e.turns === 1 ? "" : "s"}, ${(e.tokensIn + e.tokensOut).toLocaleString("en-US")} tokens, ${e.secs.toFixed(0)} s (on your subscription)\n`,
        );
      else print(`  ${e.label} stopped: ${e.error}\n`);
    } else if (e.type === "fallback") {
      print(`     (${e.from} failed: ${e.kind.replace("_", " ")}. Switching to ${e.to}.)\n`);
    } else if (e.type === "recovered") {
      print(`     (the bot typed its tool call as text; Covo understood it)\n`);
    } else if (e.type === "model" && e.toolCalls === 0 && e.text.trim()) {
      print(`     (the bot answered in words: "${pad(e.text.trim().replace(/\s+/g, " "), 60)}")\n`);
    }
  };
}

/** How a run ended, as the lines `covo run` prints last. */
export function summaryLines(r: RunSummary, h: RunHeader): string[] {
  const lines: string[] = [];
  const cost = r.costUsd > 0 ? `, ${usd(r.costUsd)}` : "";
  const time = `${r.secs.toFixed(0)} s, ${r.steps} step${r.steps === 1 ? "" : "s"}, ${r.tokensIn + r.tokensOut} tokens${cost}`;
  const short = r.runId.slice(-6);
  if (r.state === "KEPT" && r.autoKeep) {
    lines.push(`Done in ${time}.`, `Bot's summary: ${r.summary}`, "");
    lines.push(`Kept in your workspace (${h.bot?.level === "full" ? "fully automatic" : "automatic"} bot):`);
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
  lines.push(`Details: covo log ${r.runId}`);
  return lines;
}

export const succeeded = (r: RunSummary) => ["REVIEWING", "SUCCEEDED", "KEPT"].includes(r.state);
