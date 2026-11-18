import { covoHome, VERSION } from "@covo/core";
import type { ModelProvider } from "@covo/models";
import { auditCommand } from "./commands/audit.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { initCommand } from "./commands/init.ts";
import { diffCommand, discardCommand, keepCommand } from "./commands/review.ts";
import { logCommand, runCommand, statusCommand } from "./commands/runs.ts";

const HELP = `covo ${VERSION}: Covo command line

Usage:
  covo <command> [options]

Commands (Phase 1):
  init                Create ~/Covo and the default workspace
  audit verify        Check the activity log for tampering
  doctor [check]      Check instant copies, the sandbox and the model
  run "<task>"        Give the main bot a task on a safe copy  [--model <name>]
  status              Show recent runs
  log <run>           Show a run's steps ("last" for the latest)
  diff <run>          Show what a run changed  [--stat for a summary]
  keep <run> [file…]  Copy a run's changes into your workspace (all, or just these files)
  discard <run>       Throw a run's changes away

  <run> is a run id, its last 4+ characters, or "last".

Options:
  -h, --help      Show this help
  -v, --version   Show the version

Environment:
  COVO_HOME             Use another data folder instead of ~/Covo
  COVO_PROVIDER         anthropic, openai, gemini, xai, deepseek, mistral, groq,
                        openrouter, ollama (default) or lmstudio
  COVO_MODEL            Model name (default: the provider's suggestion; qwen3.5:4b for Ollama)
  COVO_MODEL_API_KEY    API key (or the provider's usual variable, e.g. ANTHROPIC_API_KEY)
  COVO_MODEL_BASE_URL   Any other OpenAI-compatible service, or a proxy
  COVO_MODEL_CONTEXT    Ollama context window in tokens (default 8192)
  COVO_MODEL_THINK      "on" lets local thinking models think first (slower; default off)

  Example: COVO_PROVIDER=anthropic ANTHROPIC_API_KEY=… covo run "tidy the docs"
`;

export interface CliResult {
  code: number;
  out: string;
}

export interface Ctx {
  home: string;
  now: () => number;
  env: Record<string, string | undefined>;
  /** Live progress output (covo run). */
  print: (s: string) => void;
  /** Tests inject a scripted model here. */
  provider?: ModelProvider;
  /** Colour diffs (set by the entry point when writing to a terminal). */
  color?: boolean;
}

export async function main(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
  extra: Partial<Pick<Ctx, "print" | "provider" | "now" | "color">> = {},
): Promise<CliResult> {
  const [cmd, ...rest] = argv;
  const ctx: Ctx = { home: covoHome(env), now: Date.now, env, print: (t) => process.stdout.write(t), ...extra };
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") return { code: 0, out: HELP };
  if (cmd === "-v" || cmd === "--version") return { code: 0, out: `${VERSION}\n` };
  if (cmd === "init") return initCommand(ctx);
  if (cmd === "audit") return auditCommand(ctx, rest);
  if (cmd === "doctor") return doctorCommand(ctx, rest);
  if (cmd === "run") return runCommand(ctx, rest);
  if (cmd === "status") return statusCommand(ctx);
  if (cmd === "log") return logCommand(ctx, rest);
  if (cmd === "diff") return diffCommand(ctx, rest);
  if (cmd === "keep") return keepCommand(ctx, rest);
  if (cmd === "discard") return discardCommand(ctx, rest);
  return { code: 2, out: `covo: unknown command "${cmd}". Run "covo --help" to see the commands.\n` };
}
