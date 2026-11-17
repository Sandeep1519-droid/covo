import { tildify } from "@cw/core";
import { initHome } from "@cw/db";
import type { CliResult, Ctx } from "../main.ts";

export function initCommand(ctx: Ctx): CliResult {
  const r = initHome(ctx.home, ctx.now);
  const where = tildify(r.paths.home);
  if (!r.created) {
    const migrated = r.migrationsApplied.length
      ? ` Updated the database (migration ${r.migrationsApplied.join(", ")}).`
      : "";
    return { code: 0, out: `Coworker is already set up in ${where}.${migrated}\n` };
  }
  return {
    code: 0,
    out: [
      `Set up Coworker in ${where}`,
      `  database    ${tildify(r.paths.db)}`,
      `  workspace   ${tildify(r.workspace)}   (department "Personal")`,
      `  main bot    Assistant`,
      "",
      `Check the activity log any time with: cw audit verify`,
      "",
    ].join("\n"),
  };
}
