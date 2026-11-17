import { existsSync } from "node:fs";
import { cwPaths, tildify } from "@cw/core";
import { type AuditProblem, openDb, verifyAudit } from "@cw/db";
import type { CliResult, Ctx } from "../main.ts";

const WHAT: Record<AuditProblem["kind"], string> = {
  changed: "its contents were changed after it was written",
  "broken-link": "it doesn't follow on from the entry before it (an entry was replaced or reordered)",
  gap: "one or more entries before it are missing",
};

export function auditCommand(ctx: Ctx, args: string[]): CliResult {
  const [sub] = args;
  if (sub !== "verify") return { code: 2, out: "Usage: cw audit verify\n" };
  const { db: dbPath } = cwPaths(ctx.home);
  if (!existsSync(dbPath)) return { code: 1, out: `Coworker isn't set up in ${tildify(ctx.home)} yet. Run: cw init\n` };

  const db = openDb(dbPath);
  try {
    const r = verifyAudit(db);
    if (r.ok) {
      if (!r.head) return { code: 0, out: "Activity log is empty.\n" };
      const when = new Date(r.head.ts).toISOString().replace("T", " ").slice(0, 16);
      return {
        code: 0,
        out: `Log verified: ${r.count} ${r.count === 1 ? "entry" : "entries"}, no gaps or changes.\nLatest entry #${r.head.seq} at ${when} UTC (hash ${r.head.hash.slice(0, 12)}…)\n`,
      };
    }
    const p = r.problem as AuditProblem;
    const okUpTo = r.head ? `Entries 1–${r.head.seq} are intact; don't trust anything from #${p.seq} on.\n` : "";
    return { code: 1, out: `Log check FAILED at entry #${p.seq}: ${WHAT[p.kind]}.\n${okUpTo}` };
  } finally {
    db.close();
  }
}
