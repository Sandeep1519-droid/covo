import { existsSync } from "node:fs";
import { cwPaths, tildify } from "@cw/core";
import { openDb } from "@cw/db";
import { discardRun, keepRun, RunError, reviewRun } from "@cw/engine";
import type { CliResult, Ctx } from "../main.ts";
import { findRun } from "./runs.ts";

// cw diff / keep / discard: the review step. Nothing reaches your workspace until you keep it.

const REASON = {
  "changed-in-workspace": "you changed it after the run started",
  "deleted-in-workspace": "you deleted it after the run started",
  "created-in-workspace": "you created a file with the same name after the run started",
} as const;

function resolveRun(ctx: Ctx, arg: string | undefined): string | CliResult {
  const { db: path } = cwPaths(ctx.home);
  if (!existsSync(path)) return { code: 1, out: `Coworker isn't set up in ${tildify(ctx.home)} yet. Run: cw init\n` };
  const db = openDb(path);
  try {
    const id = findRun(db, arg);
    return typeof id === "string" ? id : { code: 1, out: `${id.error}\n` };
  } finally {
    db.close();
  }
}

function guard(fn: () => CliResult): CliResult {
  try {
    return fn();
  } catch (e) {
    if (e instanceof RunError) return { code: 1, out: `${e.message}\n` };
    throw e;
  }
}

const paint = (ctx: Ctx, code: string, s: string) => (ctx.color ? `\x1b[${code}m${s}\x1b[0m` : s);

export function diffCommand(ctx: Ctx, args: string[]): CliResult {
  const stat = args.includes("--stat");
  const id = resolveRun(
    ctx,
    args.find((a) => !a.startsWith("--")),
  );
  if (typeof id !== "string") return id;
  return guard(() => {
    const r = reviewRun(ctx.home, id, ctx.now);
    const out = [
      `Run ${id}: ${r.goal}`,
      r.summary ? `Bot's summary: ${r.summary}` : "",
      `${r.modified} modified, ${r.added} added, ${r.deleted} deleted`,
      "",
    ].filter((l, i) => l !== "" || i === 3);
    for (const f of r.files) {
      const plus = f.hunks?.reduce((n, h) => n + h.lines.filter((l) => l.startsWith("+")).length, 0) ?? 0;
      const minus = f.hunks?.reduce((n, h) => n + h.lines.filter((l) => l.startsWith("-")).length, 0) ?? 0;
      const counts = f.note ?? `+${plus} -${minus}`;
      const warn = f.workspaceChanged ? paint(ctx, "33", `  ! ${REASON["changed-in-workspace"]}`) : "";
      if (stat) {
        out.push(`  ${f.kind.padEnd(8)} ${f.path}  ${counts}${warn}`);
        continue;
      }
      out.push(paint(ctx, "1", `${f.kind} ${f.path}`) + (f.note ? ` (${f.note}, no text diff)` : "") + warn);
      for (const h of f.hunks ?? []) {
        out.push(paint(ctx, "36", h.header));
        for (const l of h.lines) {
          out.push(l.startsWith("+") ? paint(ctx, "32", l) : l.startsWith("-") ? paint(ctx, "31", l) : l);
        }
      }
      out.push("");
    }
    if (stat) out.push("");
    out.push(`Keep all: cw keep ${id}   Keep some: cw keep ${id} <file>…   Throw away: cw discard ${id}`, "");
    return { code: 0, out: out.join("\n") };
  });
}

export function keepCommand(ctx: Ctx, args: string[]): CliResult {
  const [arg, ...only] = args;
  const id = resolveRun(ctx, arg);
  if (typeof id !== "string") return id;
  return guard(() => {
    const k = keepRun(ctx.home, id, { only, now: ctx.now });
    const ws = tildify(`${ctx.home}/workspaces/default`);
    if (k.conflicts.length) {
      const lines = [
        "Nothing was kept. These files changed in your workspace while the bot worked on its copy:",
        ...k.conflicts.map((c) => `  ${c.path}  (${REASON[c.reason]})`),
        "",
        "Your version is untouched. You can:",
        `  - keep only the other files:  cw keep ${id} <file>…`,
        `  - throw the bot's changes away:  cw discard ${id}`,
        "  - run the task again on the current files",
        "",
      ];
      return { code: 1, out: lines.join("\n") };
    }
    const lines = [`Kept ${k.kept.length} file${k.kept.length === 1 ? "" : "s"} in ${ws}:`];
    for (const p of k.kept) lines.push(`  ${p}`);
    if (k.dropped.length) {
      lines.push("", `Threw away ${k.dropped.length} other change${k.dropped.length === 1 ? "" : "s"}:`);
      for (const p of k.dropped) lines.push(`  ${p}`);
    }
    lines.push("", "Recorded in the activity log.", "");
    return { code: 0, out: lines.join("\n") };
  });
}

export function discardCommand(ctx: Ctx, args: string[]): CliResult {
  const id = resolveRun(ctx, args[0]);
  if (typeof id !== "string") return id;
  return guard(() => {
    const d = discardRun(ctx.home, id, ctx.now);
    return {
      code: 0,
      out: `Threw away ${d.files} change${d.files === 1 ? "" : "s"} from run ${id}. Your workspace was not touched.\n`,
    };
  });
}
