import { existsSync } from "node:fs";
import { covoPaths, tildify } from "@covo/core";
import { openDb } from "@covo/db";
import { discardRun, keepRun, RunError, reviewRun, undoRun } from "@covo/engine";
import type { CliResult, Ctx } from "../main.ts";
import { findRun } from "./runs.ts";

// covo diff / keep / discard: the review step. Nothing reaches your workspace until you keep it.

const REASON = {
  "changed-in-workspace": "you changed it after the run started",
  "deleted-in-workspace": "you deleted it after the run started",
  "created-in-workspace": "you created a file with the same name after the run started",
} as const;

function resolveRun(ctx: Ctx, arg: string | undefined): string | CliResult {
  const { db: path } = covoPaths(ctx.home);
  if (!existsSync(path)) return { code: 1, out: `Covo isn't set up in ${tildify(ctx.home)} yet. Run: covo init\n` };
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
    out.push(`Keep all: covo keep ${id}   Keep some: covo keep ${id} <file>…   Throw away: covo discard ${id}`, "");
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
        `  - keep only the other files:  covo keep ${id} <file>…`,
        `  - throw the bot's changes away:  covo discard ${id}`,
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

export function undoCommand(ctx: Ctx, args: string[]): CliResult {
  const id = resolveRun(ctx, args[0]);
  if (typeof id !== "string") return id;
  return guard(() => {
    const u = undoRun(ctx.home, id, ctx.now);
    if (u.conflicts.length) {
      const why = {
        "changed-since-keep": "you changed it after the bot's change was kept",
        "deleted-since-keep": "you deleted it after the bot's change was kept",
        "created-since-keep": "a file with this name was created after the bot deleted it",
      } as const;
      return {
        code: 1,
        out: [
          "Nothing was undone, so your later work is safe. These files changed after the bot's work was kept:",
          ...u.conflicts.map((c) => `  ${c.path}  (${why[c.reason]})`),
          "",
        ].join("\n"),
      };
    }
    return {
      code: 0,
      out: [
        `Undone. Put back ${u.restored.length} file${u.restored.length === 1 ? "" : "s"} exactly as ${u.restored.length === 1 ? "it was" : "they were"}:`,
        ...u.restored.map((p) => `  ${p}`),
        "",
      ].join("\n"),
    };
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
