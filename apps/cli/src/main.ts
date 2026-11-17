import { cwHome, VERSION } from "@cw/core";
import { auditCommand } from "./commands/audit.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { initCommand } from "./commands/init.ts";

const HELP = `cw ${VERSION}: Coworker command line

Usage:
  cw <command> [options]

Commands (Phase 1):
  init            Create ~/Coworker and the default workspace
  audit verify    Check the activity log for tampering
  doctor [check]  Check instant copies and the sandbox (models in M4)
  run "<task>"    Give a bot a task on a safe copy              (M5)
  status          Show runs                                     (M5)
  log <run>       Show a run's steps                            (M5)
  diff <run>      Show what a run changed                       (M6)
  keep <run>      Keep a run's changes                          (M6)
  discard <run>   Throw a run's changes away                    (M6)

Options:
  -h, --help      Show this help
  -v, --version   Show the version

Environment:
  CW_HOME         Use another data folder instead of ~/Coworker
`;

export interface CliResult {
  code: number;
  out: string;
}

export interface Ctx {
  home: string;
  now: () => number;
}

export async function main(argv: string[], env: Record<string, string | undefined> = process.env): Promise<CliResult> {
  const [cmd, ...rest] = argv;
  const ctx: Ctx = { home: cwHome(env), now: Date.now };
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") return { code: 0, out: HELP };
  if (cmd === "-v" || cmd === "--version") return { code: 0, out: `${VERSION}\n` };
  if (cmd === "init") return initCommand(ctx);
  if (cmd === "audit") return auditCommand(ctx, rest);
  if (cmd === "doctor") return doctorCommand(ctx, rest);
  return { code: 2, out: `cw: "${cmd}" isn't available yet. Run "cw --help" to see what's planned.\n` };
}
