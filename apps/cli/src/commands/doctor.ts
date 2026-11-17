import { existsSync } from "node:fs";
import { cwPaths, tildify } from "@cw/core";
import { checkModels, modelConfig } from "@cw/models";
import { checkClone, checkSandbox } from "@cw/sandbox";
import type { CliResult, Ctx } from "../main.ts";

const CHECKS = ["clone", "sandbox", "models"] as const;
type Status = "pass" | "fail" | "warn" | "skip";
const MARK: Record<Status, string> = { pass: "✓", fail: "✗", warn: "!", skip: "–" };

export async function doctorCommand(ctx: Ctx, args: string[]): Promise<CliResult> {
  const which = args[0] ?? "all";
  if (which !== "all" && !(CHECKS as readonly string[]).includes(which)) {
    return { code: 2, out: `Usage: cw doctor [${CHECKS.join(" | ")}]\n` };
  }
  const p = cwPaths(ctx.home);
  if (!existsSync(p.runs)) return { code: 1, out: `Coworker isn't set up in ${tildify(ctx.home)} yet. Run: cw init\n` };

  const sections: string[][] = [];
  let failed = 0;
  const list = (title: string, items: { name: string; status: Status; detail: string }[]) => {
    const lines = [title];
    for (const c of items) {
      if (c.status === "fail") failed++;
      lines.push(`  ${MARK[c.status]} ${c.name.padEnd(36)} ${c.detail}`);
    }
    sections.push(lines);
  };

  if (which === "all" || which === "clone") {
    const c = checkClone(p.runs);
    const ms = c.ms < 10 ? c.ms.toFixed(1) : c.ms.toFixed(0);
    const how = c.method === "clonefile" ? "APFS clone" : "full copy";
    list("Instant copies", [
      {
        name: `${c.sizeMB} MB test folder`,
        status: c.ok ? "pass" : "fail",
        detail: c.problem ?? `copied in ${ms} ms, ${c.extraMB.toFixed(1)} MB extra disk (${how})`,
      },
    ]);
  }
  if (which === "all" || which === "sandbox") {
    const checks = await checkSandbox({ scratchDir: p.runs, dbPath: p.db });
    const safety = checks.filter((c) => c.name !== "Developer tools still work");
    list(
      `Sandbox (${safety.filter((c) => c.status === "pass").length} of ${safety.length} safety checks passed)`,
      checks,
    );
  }
  if (which === "all" || which === "models") {
    const cfg = modelConfig(ctx.env);
    list(`Models (${cfg.model} via ${cfg.name})`, await checkModels(cfg));
  }

  const out = [
    ...sections.map((s) => s.join("\n")),
    failed ? `${failed} check${failed === 1 ? "" : "s"} failed.` : "All checks passed.",
  ];
  return { code: failed ? 1 : 0, out: `${out.join("\n\n")}\n` };
}
