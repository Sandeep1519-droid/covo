import { existsSync } from "node:fs";
import { cwPaths, tildify } from "@cw/core";
import { checkClone } from "@cw/sandbox";
import type { CliResult, Ctx } from "../main.ts";

const CHECKS = ["clone"] as const; // sandbox (M3) and models (M4) join here

export function doctorCommand(ctx: Ctx, args: string[]): CliResult {
  const which = args[0] ?? "all";
  if (which !== "all" && !(CHECKS as readonly string[]).includes(which)) {
    return { code: 2, out: `Usage: cw doctor [${CHECKS.join(" | ")}]\n` };
  }
  const p = cwPaths(ctx.home);
  if (!existsSync(p.runs)) return { code: 1, out: `Coworker isn't set up in ${tildify(ctx.home)} yet. Run: cw init\n` };

  const lines: string[] = [];
  let failed = 0;
  if (which === "all" || which === "clone") {
    const c = checkClone(p.runs);
    if (!c.ok) failed++;
    lines.push(
      `${c.ok ? "✓" : "✗"} Instant copies   ${c.sizeMB} MB copied in ${c.ms < 10 ? c.ms.toFixed(1) : c.ms.toFixed(0)} ms, ${c.extraMB.toFixed(1)} MB extra disk used (${c.method === "clonefile" ? "APFS clone" : "full copy"})`,
    );
    if (c.problem) lines.push(`  ${c.problem}`);
  }
  lines.push("", failed ? `${failed} check failed.` : "All checks passed.", "");
  return { code: failed ? 1 : 0, out: lines.join("\n") };
}
