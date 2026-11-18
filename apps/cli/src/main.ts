import { covoHome, VERSION } from "@covo/core";
import type { Detected, ModelConfig, ModelProvider } from "@covo/models";
import type { SecretStore } from "@covo/platform";
import { auditCommand } from "./commands/audit.ts";
import { botsCommand } from "./commands/bots.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { initCommand } from "./commands/init.ts";
import { modelsCommand } from "./commands/models.ts";
import { diffCommand, discardCommand, keepCommand } from "./commands/review.ts";
import { logCommand, runCommand, statusCommand } from "./commands/runs.ts";
import { decideCommand, limitsCommand, pricesCommand, usageCommand } from "./commands/spend.ts";
import type { Prompter } from "./prompt.ts";

const HELP = `covo ${VERSION}: Covo command line

Usage:
  covo <command> [options]

Commands (Phase 1):
  init                Create ~/Covo and the default workspace
  audit verify        Check the activity log for tampering
  doctor [check]      Check instant copies, the sandbox and the model
  models              Connect the AI you use (Claude, GPT, Gemini, local…); "covo models add"
  bots                Your bots, each with its own models and level; "covo bots create"
  run "<task>"        Give a bot a task on a safe copy  [--bot <name>] [--model <saved model>]
  status              Show recent runs
  approve [run]       Let a paused task spend more ("covo deny" stops it instead)
  usage               What your bots spent, by model, bot and day  [--days N]
  limits              Spending limits per task and per day  [--task <amount>] [--day <amount>]
  prices              Model prices Covo uses  [set <model> <in> <out>]
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
  /** Asks questions; set by the entry point when running in a terminal. */
  prompt?: Prompter;
  /** Tests replace these. */
  secrets?: SecretStore;
  listModels?: (c: ModelConfig, signal?: AbortSignal) => Promise<string[]>;
  detect?: (env: Record<string, string | undefined>) => Promise<Detected>;
  readStdin?: () => Promise<string>;
}

export async function main(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
  extra: Partial<
    Pick<Ctx, "print" | "provider" | "now" | "color" | "prompt" | "secrets" | "listModels" | "detect" | "readStdin">
  > = {},
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
  if (cmd === "models") return modelsCommand(ctx, rest);
  if (cmd === "bots") return botsCommand(ctx, rest);
  if (cmd === "approve") return decideCommand(ctx, rest, true);
  if (cmd === "deny") return decideCommand(ctx, rest, false);
  if (cmd === "usage") return usageCommand(ctx, rest);
  if (cmd === "limits") return limitsCommand(ctx, rest);
  if (cmd === "prices") return pricesCommand(ctx, rest);
  if (cmd === "diff") return diffCommand(ctx, rest);
  if (cmd === "keep") return keepCommand(ctx, rest);
  if (cmd === "discard") return discardCommand(ctx, rest);
  return { code: 2, out: `covo: unknown command "${cmd}". Run "covo --help" to see the commands.\n` };
}
