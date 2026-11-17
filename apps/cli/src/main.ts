import { VERSION } from "@cw/core";

const HELP = `cw ${VERSION}: Coworker command line

Usage:
  cw <command> [options]

Commands (Phase 1):
  init            Create ~/Coworker and the default workspace   (M1)
  doctor          Check clones, sandbox and models              (M2–M4)
  run "<task>"    Give a bot a task on a safe copy              (M5)
  status          Show runs                                     (M5)
  diff <run>      Show what a run changed                       (M6)
  keep <run>      Keep a run's changes                          (M6)
  discard <run>   Throw a run's changes away                    (M6)
  log <run>       Show a run's steps                            (M5)
  audit verify    Check the activity log for tampering          (M1)

Options:
  -h, --help      Show this help
  -v, --version   Show the version
`;

export interface CliResult {
  code: number;
  out: string;
}

export function main(argv: string[]): CliResult {
  const [cmd] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") return { code: 0, out: HELP };
  if (cmd === "-v" || cmd === "--version") return { code: 0, out: `${VERSION}\n` };
  return { code: 2, out: `cw: "${cmd}" isn't available yet. Run "cw --help" to see what's planned.\n` };
}
