import { existsSync } from "node:fs";
import { cwPaths, tildify } from "@cw/core";
import { checkClone, checkSandbox, type SandboxCheck } from "@cw/sandbox";
import type { CliResult, Ctx } from "../main.ts";

const CHECKS = ["clone", "sandbox"] as const; // models (M4) joins here
const MARK: Record<SandboxCheck["status"], string> = { pass: "✓", fail: "✗", warn: "!", skip: "–" };

export async function doctorCommand(ctx: Ctx, args: string[]): Promise<CliResult> {
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
    const ms = c.ms < 10 ? c.ms.toFixed(1) : c.ms.toFixed(0);
    lines.push("Instant copies");
    lines.push(
      `  ${c.ok ? "✓" : "✗"} ${c.sizeMB} MB copied in ${ms} ms, ${c.extraMB.toFixed(1)} MB extra disk used (${c.method === "clonefile" ? "APFS clone" : "full copy"})`,
    );
    if (c.problem) lines.push(`    ${c.problem}`);
  }
  if (which === "all" || which === "sandbox") {
    const checks = await checkSandbox({ scratchDir: p.runs, dbPath: p.db });
    const safety = checks.filter((c) => c.name !== "Developer tools still work");
    const passed = safety.filter((c) => c.status === "pass").length;
    if (lines.length) lines.push("");
    lines.push(`Sandbox (${passed} of ${safety.length} safety checks passed)`);
    for (const c of checks) {
      if (c.status === "fail") failed++;
      lines.push(`  ${MARK[c.status]} ${c.name.padEnd(36)} ${c.detail}`);
    }
  }
  lines.push("", failed ? `${failed} check${failed === 1 ? "" : "s"} failed.` : "All checks passed.", "");
  return { code: failed ? 1 : 0, out: lines.join("\n") };
}
