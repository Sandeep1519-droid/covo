import {
  archiveBot,
  type Bot,
  type BotChanges,
  createBot,
  LEVELS,
  type Level,
  listBots,
  RunError,
  updateBot,
  usd,
} from "@covo/engine";
import { loadSettings } from "@covo/models";
import type { CliResult, Ctx } from "../main.ts";

// covo bots: your bots, each with its own models (in order) and automation level.

const USAGE = `Usage:
  covo bots                                 List your bots
  covo bots create "<name>" [options]       Make a new bot
  covo bots set "<name>" [options]          Change a bot
  covo bots remove "<name>"                 Remove a bot (its past runs stay)

Options:
  --model <name>        Its main model: a saved model (see covo models) or a model name. A subscription engine (claude-code) must be the main model
  --fallback <name>     A model to switch to if the one before fails (repeat for more)
  --default-model       Use the default model again
  --purpose "<text>"    One line about what it's for
  --level <level>       supervised, automatic (default) or full
  --task-limit <amount> Most it may spend on one task, in dollars (or "none" for the general limit)
  --rename "<name>"     New name (set only)

Example:
  covo bots create "Docs helper" --model claude --fallback local --purpose "Keeps the docs tidy"
`;

const LEVEL_TEXT: Record<Level, string> = {
  supervised: "you review every change",
  automatic: "undoable work by itself, asks before anything irreversible",
  full: "never asks; stops at its limits",
};

function parse(args: string[]): { name?: string; changes: BotChanges; error?: string } {
  let name: string | undefined;
  let main: string | undefined;
  const fallbacks: string[] = [];
  let resetModels = false;
  const changes: BotChanges = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    const val = () => {
      const v = args[++i];
      if (v === undefined || v.startsWith("--")) throw new RunError(`${a} needs a value.`);
      return v;
    };
    if (a === "--model") main = val();
    else if (a === "--fallback") fallbacks.push(val());
    else if (a === "--default-model") resetModels = true;
    else if (a === "--purpose") changes.purpose = val();
    else if (a === "--task-limit") {
      const v = val();
      if (/^(none|off)$/i.test(v)) changes.taskLimitUsd = null;
      else {
        const n = Number(v.replace(/^[$]/, ""));
        if (!Number.isFinite(n) || n < 0) throw new RunError(`"${v}" isn't a dollar amount.`);
        changes.taskLimitUsd = n;
      }
    } else if (a === "--rename") changes.name = val();
    else if (a === "--level") {
      const l = val().toLowerCase() as Level;
      if (!LEVELS.includes(l)) throw new RunError(`Level must be one of: ${LEVELS.join(", ")}.`);
      changes.level = l;
    } else if (a.startsWith("--")) throw new RunError(`Unknown option ${a}.`);
    else if (name === undefined) name = a;
    else name = `${name} ${a}`; // unquoted names with spaces
  }
  if (resetModels) changes.models = [];
  else if (main) changes.models = [main, ...fallbacks];
  else if (fallbacks.length) throw new RunError("Give the main model with --model before any --fallback.");
  return { name, changes };
}

const modelsText = (b: Bot) => (b.models.length ? b.models.join(" → ") : "default model");

/** Notes for model names that aren't saved models (they still work as model names). */
function unknownModels(ctx: Ctx, models: string[] | undefined): string[] {
  if (!models?.length) return [];
  const saved = new Set(loadSettings(ctx.home).connections.map((c) => c.name));
  return models
    .filter((m) => !saved.has(m))
    .map((m) => `Note: "${m}" isn't a saved model, so it's used as a model name for your default service.`);
}

export function botsCommand(ctx: Ctx, args: string[]): CliResult {
  const [sub, ...rest] = args;
  try {
    if (!sub || sub === "list") return list(ctx);
    if (sub === "create") {
      const { name, changes } = parse(rest);
      if (!name) return { code: 2, out: USAGE };
      const b = createBot(ctx.home, { name, ...changes }, ctx.now);
      const lines = [
        `Created ${b.name}.`,
        `  Models  ${modelsText(b)}`,
        `  Level   ${b.level}: ${LEVEL_TEXT[b.level]}`,
        ...(b.taskLimitUsd !== null ? [`  Limit   ${usd(b.taskLimitUsd)} per task`] : []),
        ...(b.purpose ? [`  Purpose ${b.purpose}`] : []),
        ...unknownModels(ctx, changes.models),
        "",
        `Give it a task: covo run --bot "${b.name}" "…"`,
        "",
      ];
      return { code: 0, out: lines.join("\n") };
    }
    if (sub === "set") {
      const { name, changes } = parse(rest);
      if (!name || !Object.keys(changes).length) return { code: 2, out: USAGE };
      const b = updateBot(ctx.home, name, changes, ctx.now);
      const lines = [
        `Updated ${b.name}.`,
        `  Models  ${modelsText(b)}`,
        `  Level   ${b.level}: ${LEVEL_TEXT[b.level]}`,
        `  Limit   ${b.taskLimitUsd === null ? "the general per-task limit" : `${usd(b.taskLimitUsd)} per task`}`,
        ...unknownModels(ctx, changes.models),
        "",
      ];
      return { code: 0, out: lines.join("\n") };
    }
    if (sub === "remove") {
      const { name } = parse(rest);
      if (!name) return { code: 2, out: USAGE };
      const b = archiveBot(ctx.home, name, ctx.now);
      return { code: 0, out: `Removed ${name}. Its ${b.runs} past run${b.runs === 1 ? "" : "s"} stay in the log.\n` };
    }
    return { code: 2, out: USAGE };
  } catch (e) {
    if (e instanceof RunError) return { code: 1, out: `${e.message}\n` };
    throw e;
  }
}

function list(ctx: Ctx): CliResult {
  const bots = listBots(ctx.home, { now: ctx.now });
  const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));
  const lines = [`${pad("BOT", 20)} ${pad("MODELS", 30)} ${pad("LEVEL", 11)} RUNS`];
  for (const b of bots) {
    lines.push(`${pad(b.name, 20)} ${pad(modelsText(b), 30)} ${pad(b.level, 11)} ${b.runs}`);
  }
  lines.push("", 'New bot: covo bots create "<name>" --model <saved model>', "");
  return { code: 0, out: lines.join("\n") };
}
