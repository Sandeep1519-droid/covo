import type { Database } from "bun:sqlite";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { ApiActivity, ApiActivityEntry, ApiFile } from "@covo/api";
import { verifyAudit } from "@covo/db";
import { engineById } from "@covo/models";

// The Library: the activity log in plain words, with its tamper check, and the files
// in your workspaces. The log is append-only and hash-chained (packages/db/src/audit.ts), so the
// app can show that nothing was changed or removed.

interface Row {
  seq: number;
  ts: number;
  run_id: string | null;
  actor: string;
  action: string;
  target: string | null;
  decision: string | null;
  detail_json: string;
}

const VERB: Record<string, string> = {
  list_files: "listed the files in",
  read_file: "read",
  edit_file: "edited",
  write_file: "wrote",
  run_command: "ran",
};

const TRIED: Record<string, string> = {
  list_files: "list the files in",
  read_file: "read",
  edit_file: "edit",
  write_file: "write",
  run_command: "run",
};

const STATE: Record<string, string> = {
  QUEUED: "is waiting its turn",
  PREPARING: "is getting ready",
  RUNNING: "started working",
  AWAITING_APPROVAL: "paused for your OK",
  REVIEWING: "is ready for your review",
  SUCCEEDED: "finished",
  FAILED: "failed",
  STOPPED: "was stopped",
  KEPT: "was kept",
  DISCARDED: "was discarded",
  ROLLED_BACK: "was undone",
};

const short = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** One entry as a sentence, and whether it's something Covo stopped. */
export function describe(
  r: Row,
  names: Map<string, string>,
): Pick<ApiActivityEntry, "text" | "who" | "blocked" | "kind"> {
  let d: Record<string, unknown> = {};
  try {
    d = JSON.parse(r.detail_json) as Record<string, unknown>;
  } catch {}
  const who = r.actor.startsWith("agent:")
    ? (names.get(r.actor.slice(6)) ?? "A bot")
    : r.actor === "user"
      ? "You"
      : r.actor.startsWith("tool:")
        ? r.actor.slice(5)
        : "Covo";
  const t = r.target ?? "";
  const denied = r.decision === "deny";
  const a = r.action;

  if (a.startsWith("tool.")) {
    const tool = a.slice(5);
    if (tool === "finish") return { who, kind: "tool", blocked: false, text: `${who} said it was done` };
    const verb = VERB[tool] ?? `used ${tool.replace(/_/g, " ")} on`;
    const what = tool === "run_command" ? `\`${short(t, 70)}\`` : t || "the workspace";
    if (denied) {
      const why = d.blockedBy === "path" ? "it's outside the workspace" : "the sandbox doesn't allow it";
      const tried = TRIED[tool] ?? `use ${tool.replace(/_/g, " ")} on`;
      return { who, kind: "blocked", blocked: true, text: `Blocked: ${who} tried to ${tried} ${what}, but ${why}` };
    }
    return { who, kind: "tool", blocked: false, text: `${who} ${verb} ${what}` };
  }
  switch (a) {
    case "system.init":
      return { who, kind: "system", blocked: false, text: "Covo was set up on this Mac" };
    case "run.created":
      return {
        who,
        kind: "task",
        blocked: false,
        text: `New task for ${names.get(String(d.agent)) ?? "a bot"}: “${short(t)}”`,
      };
    case "run.state": {
      const to = String(d.to ?? t);
      const err = typeof d.error === "string" ? ` (${short(d.error, 80)})` : "";
      return { who, kind: "task", blocked: false, text: `The task ${STATE[to] ?? to.toLowerCase()}${err}` };
    }
    case "engine.run": {
      const label = engineById(String(d.engine))?.label ?? String(d.engine);
      const hosts = Array.isArray(d.blockedHosts) ? (d.blockedHosts as string[]) : [];
      const tokens = (Number(d.tokensIn ?? 0) + Number(d.tokensOut ?? 0)).toLocaleString("en-US");
      const base = `${label} ${d.ok ? "did the task" : "stopped"}: ${plural(Number(d.turns ?? 0), "step")}, ${tokens} tokens on your plan`;
      if (hosts.length)
        return {
          who,
          kind: "blocked",
          blocked: true,
          text: `${base}. Covo's network filter refused ${hosts.slice(0, 3).join(", ")}`,
        };
      return { who, kind: "engine", blocked: false, text: base };
    }
    case "engine.installed":
      return {
        who,
        kind: "system",
        blocked: false,
        text: `${engineById(String(d.engine))?.label ?? "A program"} was installed with its maker's installer`,
      };
    case "engine.signed-in":
      return {
        who,
        kind: "system",
        blocked: false,
        text: `Signed in to ${engineById(String(d.engine))?.label ?? "a program"} (Covo never sees the sign-in)`,
      };
    case "subscription.connected":
    case "subscription.removed": {
      const p = String(d.provider);
      const label = p === "chatgpt" ? "ChatGPT plan" : `${engineById(p)?.label ?? p}`;
      return {
        who,
        kind: "system",
        blocked: false,
        text: a.endsWith("connected") ? `Connected ${label}` : `Removed ${label}`,
      };
    }
    case "model.fallback":
      return {
        who,
        kind: "task",
        blocked: false,
        text: `Switched from ${d.from} to ${d.to} (${String(d.kind ?? "").replace(/_/g, " ")})`,
      };
    case "spend.limit":
      return { who, kind: "money", blocked: true, text: "Paused: the next step would go over a spending limit" };
    case "approval.requested":
      return {
        who,
        kind: "money",
        blocked: false,
        text: `Asked for your OK: ${short(String(d.summary ?? "a spending pause"))}`,
      };
    case "approval.decided":
      return {
        who,
        kind: "money",
        blocked: d.status !== "approved",
        text: `${d.status === "approved" ? "Allowed" : "Denied"} the spending pause${d.by ? ` (${String(d.by).replace(/^you \((.*)\)$/, "you, $1")})` : ""}`,
      };
    case "approval.refused":
      return {
        who,
        kind: "blocked",
        blocked: true,
        text: `Ignored an answer to a spending pause (${d.reason ?? "not valid"})`,
      };
    case "run.keep":
      return {
        who,
        kind: "files",
        blocked: false,
        text: `Kept the changes${Array.isArray(d.files) ? ` (${plural(d.files.length, "file")})` : ""}`,
      };
    case "run.undo":
      return {
        who,
        kind: "files",
        blocked: false,
        text:
          d.reason === "conflict"
            ? "Undo stopped: you've changed those files since"
            : "Undid the changes, exactly as before",
      };
    case "routine.created":
    case "routine.changed":
    case "routine.removed":
      return {
        who,
        kind: "routine",
        blocked: false,
        text: `Routine ${a.split(".")[1]}: ${short(String(d.name ?? t), 60)}${typeof d.schedule === "string" ? ` (${d.schedule})` : ""}`,
      };
    case "routine.skipped":
      return {
        who,
        kind: "routine",
        blocked: false,
        text: `A routine was skipped (${short(String(r.detail_json).replace(/"/g, ""), 60)})`,
      };
    case "bot.created":
    case "bot.updated":
    case "bot.archived":
      return {
        who,
        kind: "bot",
        blocked: false,
        text: `Bot ${a.split(".")[1]}: ${String(d.name ?? names.get(t) ?? t)}`,
      };
    case "phone.connected":
      return { who, kind: "phone", blocked: false, text: "Your phone was linked (Telegram)" };
    case "phone.ignored":
      return { who, kind: "blocked", blocked: true, text: "Ignored a Telegram message from someone who isn't you" };
    case "api.refused":
      return {
        who,
        kind: "blocked",
        blocked: true,
        text: `Refused a request to Covo's local API (${d.reason === "token" ? "no valid sign-in" : String(d.reason ?? "not allowed")})${Number(d.notLogged) ? `, and ${d.notLogged} more like it` : ""}`,
      };
    default:
      return { who, kind: "other", blocked: denied, text: `${a.replace(/[._]/g, " ")}${t ? `: ${short(t, 70)}` : ""}` };
  }
}

/** GET /api/activity: the latest entries (or only what Covo stopped), with the tamper check. */
export function activity(db: Database, o: { limit: number; blocked: boolean }): ApiActivity {
  const names = new Map(
    db
      .query<{ id: string; name: string }, []>("SELECT id, name FROM agents")
      .all()
      .map((x) => [x.id, x.name.replace(/ \(archived.*\)$/, "")]),
  );
  const rows = db
    .query<Row, [number]>(
      "SELECT seq, ts, run_id, actor, action, target, decision, detail_json FROM audit_log ORDER BY seq DESC LIMIT ?",
    )
    .all(o.blocked ? 5000 : o.limit);
  const entries: ApiActivityEntry[] = [];
  let blockedCount = 0;
  for (const r of rows) {
    // In-between task states are in the log, but they'd only crowd this view.
    if (r.action === "run.state" && ["QUEUED", "PREPARING", "RUNNING"].includes(String(r.target))) continue;
    const e = describe(r, names);
    if (e.blocked) blockedCount++;
    if (o.blocked && !e.blocked) continue;
    if (entries.length < o.limit) entries.push({ seq: r.seq, ts: r.ts, runId: r.run_id, action: r.action, ...e });
  }
  const v = verifyAudit(db);
  const total = db.query<{ n: number }, []>("SELECT count(*) AS n FROM audit_log").get()?.n ?? 0;
  return {
    verified: v.ok,
    count: total,
    head: v.head ? { seq: v.head.seq, hash: v.head.hash.slice(0, 12) } : null,
    problemAt: v.ok ? null : (v.problem?.seq ?? null),
    blockedRecent: blockedCount,
    entries,
  };
}

const SKIP = new Set([".git", "node_modules", ".DS_Store", ".covo"]);

/** GET /api/files: what's in each workspace (a few levels down), newest first. */
export function workspaceFiles(workspacesDir: string, max = 400): ApiFile[] {
  const out: ApiFile[] = [];
  const walk = (root: string, dir: string, depth: number) => {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (SKIP.has(n) || out.length >= max) continue;
      const p = join(dir, n);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (depth < 4) walk(root, p, depth + 1);
      } else if (st.isFile()) {
        out.push({
          workspace: root.split("/").pop() ?? "",
          path: relative(root, p),
          bytes: st.size,
          modifiedAt: st.mtimeMs,
        });
      }
    }
  };
  let spaces: string[] = [];
  try {
    spaces = readdirSync(workspacesDir);
  } catch {}
  for (const w of spaces) {
    const root = join(workspacesDir, w);
    try {
      if (statSync(root).isDirectory()) walk(root, root, 0);
    } catch {}
  }
  return out.sort((x, y) => y.modifiedAt - x.modifiedAt);
}
