import {
  addRoutine,
  getRoutine,
  listRoutines,
  postSummary,
  type Routine,
  RunError,
  removeRoutine,
  routineRuns,
  updateRoutine,
} from "@covo/engine";
import { getLimits, getRoutineSettings, ModelConfigError, setRoutineSettings } from "@covo/models";
import type { CliResult, Ctx } from "../main.ts";
import { serviceHealth, socketPath } from "../service/client.ts";

// covo routines and covo summary (Phase 3 M6).

const USAGE = `Usage:
  covo routines                                   List your routines
  covo routines add <name> --bot <bot> --every "<when>" "<task>"
        [--model <model>] [--limit <dollars per run>] [--quiet]
        <when>: "weekdays 9:00", "every day at 18:00", "mon, wed at 8:30", "hourly", "every 30 minutes"
        --quiet: message your phone only if something needs you
  covo routines show <name>                       Its schedule and last runs
  covo routines pause|resume|remove <name>
  covo routines run <name>                        Run it now (Covo's service must be running)
  covo routines missed run-once|skip              A run missed while the Mac slept: run once, or skip
  covo routines quiet 22:00-07:00|off             No routine starts in these hours
  covo routines subscriptions on|off              Let routines use subscriptions like Claude Code (off)
`;

const SUMMARY_USAGE = `Usage:
  covo summary                Show when the daily summary is made
  covo summary at 18:00       Make it at this time every day
  covo summary off            No daily summary
  covo summary now            Make one now (since the last one)
`;

function parse(args: string[]): { positional: string[]; opts: Record<string, string | true> } {
  const positional: string[] = [];
  const opts: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (!a.startsWith("--")) positional.push(a);
    else if (["--bot", "--every", "--model", "--limit"].includes(a)) opts[a.slice(2)] = args[++i] ?? "";
    else opts[a.slice(2)] = true;
  }
  return { positional, opts };
}

const two = (n: number) => String(n).padStart(2, "0");
function when(t: number | null, now: number): string {
  if (!t) return "—";
  const d = new Date(t);
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = new Date(new Date(now).setHours(0, 0, 0, 0)).getTime();
  const which =
    day === today
      ? "today"
      : day === today + 86_400_000
        ? "tomorrow"
        : day === today - 86_400_000
          ? "yesterday"
          : d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  return `${which} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

function line(r: Routine, now: number): string {
  const status = r.status === "paused" ? "paused" : `next ${when(r.nextAt, now)}`;
  const last = r.lastRun
    ? `last run ${r.lastRun.state.toLowerCase()}`
    : r.lastError
      ? `couldn't start: ${r.lastError}`
      : "not run yet";
  return `  ${r.name}  ·  ${r.botName}  ·  ${r.scheduleText}  ·  ${status}  ·  ${last}\n`;
}

export async function routinesCommand(ctx: Ctx, args: string[]): Promise<CliResult> {
  const [sub, ...rest] = args;
  const now = ctx.now();
  try {
    if (!sub || sub === "list") {
      const list = listRoutines(ctx.home, { now: ctx.now });
      if (!list.length)
        return {
          code: 0,
          out: `No routines yet. Add one, for example:\n  covo routines add "Morning brief" --bot Assistant --every "weekdays 8:30" "Summarise what changed in my files yesterday"\n`,
        };
      const s = getRoutineSettings(ctx.home);
      return {
        code: 0,
        out:
          `Routines:\n${list.map((r) => line(r, now)).join("")}\n` +
          `Missed runs: ${s.missed === "skip" ? "skipped" : "run once"}. Quiet hours: ${s.quiet ? `${s.quiet.from}–${s.quiet.to}` : "none"}. ` +
          `Daily summary: ${s.summaryAt ?? "off"}.\n`,
      };
    }
    if (sub === "add") {
      const { positional, opts } = parse(rest);
      const [name, ...task] = positional;
      if (!name || !task.length || typeof opts.every !== "string" || typeof opts.bot !== "string")
        return { code: 2, out: USAGE };
      const limit = typeof opts.limit === "string" ? Number(opts.limit.replace(/^\$/, "")) : undefined;
      if (limit !== undefined && !Number.isFinite(limit))
        return { code: 2, out: "--limit is dollars per run, like 0.10\n" };
      const r = addRoutine(
        ctx.home,
        {
          name,
          bot: opts.bot,
          task: task.join(" "),
          every: opts.every,
          ...(typeof opts.model === "string" ? { model: opts.model } : {}),
          ...(limit !== undefined ? { runLimitUsd: limit } : {}),
          quiet: opts.quiet === true,
        },
        ctx.now,
      );
      const s = getRoutineSettings(ctx.home);
      const notes = [
        `Added "${r.name}": ${r.botName}, ${r.scheduleText.charAt(0).toLowerCase()}${r.scheduleText.slice(1)}. First run ${when(r.nextAt, now)}.`,
        s.quiet ? `Quiet hours are ${s.quiet.from}–${s.quiet.to}: a run due then waits until they end.` : "",
        (await serviceHealth(ctx.home))
          ? "Covo's service runs it on time."
          : "Covo's service isn't running, so it won't run on its own. Start it with: covo service install",
      ].filter(Boolean);
      return { code: 0, out: `${notes.join("\n")}\n` };
    }
    if (sub === "show" && rest[0]) {
      const r = getRoutine(ctx.home, rest[0], ctx.now);
      const runs = routineRuns(ctx.home, r.id, 5, ctx.now);
      const out = [
        `${r.name} (${r.status === "paused" ? "paused" : "on"})`,
        `  Bot:      ${r.botName}`,
        `  When:     ${r.scheduleText}${r.status === "active" ? `, next ${when(r.nextAt, now)}` : ""}`,
        `  Task:     ${r.task}`,
        ...(r.model ? [`  Model:    ${r.model}`] : []),
        ...(r.runLimitUsd !== null ? [`  Limit:    $${r.runLimitUsd.toFixed(2)} per run`] : []),
        `  Phone:    ${r.quiet ? "only if something needs you" : "as set in covo phone"}`,
        ...(r.lastError ? [`  Last time it couldn't start: ${r.lastError}`] : []),
        runs.length ? "  Last runs:" : "  Not run yet.",
        ...runs.map(
          (x) =>
            `    ${when(x.createdAt, now)}  ${x.state.toLowerCase()}${x.costUsd ? `  $${x.costUsd.toFixed(2)}` : ""}${x.error ? `  ${x.error}` : ""}`,
        ),
      ];
      return { code: 0, out: `${out.join("\n")}\n` };
    }
    if ((sub === "pause" || sub === "resume") && rest[0]) {
      const r = updateRoutine(ctx.home, rest[0], { status: sub === "pause" ? "paused" : "active" }, ctx.now);
      return {
        code: 0,
        out: sub === "pause" ? `Paused "${r.name}".\n` : `"${r.name}" is on again. Next run ${when(r.nextAt, now)}.\n`,
      };
    }
    if (sub === "remove" && rest[0]) {
      const r = removeRoutine(ctx.home, rest[0], ctx.now);
      return { code: 0, out: `Removed "${r.name}". Its past runs stay in the log.\n` };
    }
    if (sub === "run" && rest[0]) {
      const r = getRoutine(ctx.home, rest[0], ctx.now);
      if (!(await serviceHealth(ctx.home)))
        return { code: 1, out: "Covo's service isn't running. Start it with: covo service install\n" };
      const res = await fetch(`http://covod/routines/${encodeURIComponent(r.id)}/run`, {
        unix: socketPath(ctx.home),
        method: "POST",
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) return { code: 1, out: `Couldn't start it: ${body.error ?? res.status}\n` };
      return { code: 0, out: `Started "${r.name}". Follow it in Covo, in ${r.botName}'s chat.\n` };
    }
    if (sub === "missed" && (rest[0] === "run-once" || rest[0] === "skip")) {
      setRoutineSettings(ctx.home, { missed: rest[0] });
      return {
        code: 0,
        out:
          rest[0] === "skip"
            ? "A routine missed while the Mac slept is now skipped.\n"
            : "A routine missed while the Mac slept now runs once, when it can.\n",
      };
    }
    if (sub === "quiet" && rest[0]) {
      if (rest[0] === "off") {
        setRoutineSettings(ctx.home, { quiet: null });
        return { code: 0, out: "No quiet hours: routines run whenever they're due.\n" };
      }
      const m = rest[0].match(/^(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})$/);
      if (!m) return { code: 2, out: "Give the hours like this: covo routines quiet 22:00-07:00\n" };
      const pad = (t: string) => t.padStart(5, "0");
      const s = setRoutineSettings(ctx.home, { quiet: { from: pad(m[1] as string), to: pad(m[2] as string) } });
      return {
        code: 0,
        out: `Quiet hours ${s.quiet?.from}–${s.quiet?.to}: no routine starts then; one that's due waits until they end.\n`,
      };
    }
    if (sub === "subscriptions" && (rest[0] === "on" || rest[0] === "off")) {
      setRoutineSettings(ctx.home, { subscriptions: rest[0] === "on" });
      return {
        code: 0,
        out:
          rest[0] === "on"
            ? "Routines may now use your subscriptions (like Claude Code). Check your provider's terms allow unattended use.\n"
            : "Routines no longer use subscriptions; they use your other models (or the free local one).\n",
      };
    }
    return { code: 2, out: USAGE };
  } catch (e) {
    if (e instanceof RunError || e instanceof ModelConfigError) return { code: 1, out: `${e.message}\n` };
    throw e;
  }
}

export async function summaryCommand(ctx: Ctx, args: string[]): Promise<CliResult> {
  const [sub, arg] = args;
  try {
    if (!sub) {
      const s = getRoutineSettings(ctx.home);
      return {
        code: 0,
        out: s.summaryAt
          ? `The daily summary is made at ${s.summaryAt}: in your main bot's chat, and on your phone if it gets summaries.\n`
          : "There's no daily summary. Turn it on with: covo summary at 18:00\n",
      };
    }
    if (sub === "off") {
      setRoutineSettings(ctx.home, { summaryAt: null });
      return { code: 0, out: "No more daily summaries.\n" };
    }
    if (sub === "at" && arg) {
      const s = setRoutineSettings(ctx.home, { summaryAt: arg.padStart(5, "0") });
      return { code: 0, out: `The daily summary is now made at ${s.summaryAt}.\n` };
    }
    if (sub === "now") {
      const r = postSummary(ctx.home, { now: ctx.now, dayLimitUsd: getLimits(ctx.home).dayUsd });
      return {
        code: 0,
        out: r.text
          ? `${r.text}\n\n(Also in your main bot's chat${(await serviceHealth(ctx.home)) ? ", and on your phone if it gets summaries" : ""}.)\n`
          : "Nothing to tell yet: no tasks finished since the last summary, and nothing is waiting.\n",
      };
    }
    return { code: 2, out: SUMMARY_USAGE };
  } catch (e) {
    if (e instanceof ModelConfigError) return { code: 1, out: `${e.message}\n` };
    throw e;
  }
}
