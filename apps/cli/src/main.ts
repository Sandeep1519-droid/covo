import { covoHome, VERSION } from "@covo/core";
import { type Engine, isPaused } from "@covo/engine";
import type { Detected, ModelConfig, ModelProvider } from "@covo/models";
import type { TelegramApi } from "@covo/phone";
import type { SecretStore, SystemInfo } from "@covo/platform";
import { auditCommand } from "./commands/audit.ts";
import { botsCommand } from "./commands/bots.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { initCommand } from "./commands/init.ts";
import { modelsCommand } from "./commands/models.ts";
import { pauseCommand } from "./commands/pause.ts";
import { phoneCommand } from "./commands/phone.ts";
import { profileCommand } from "./commands/profile.ts";
import { diffCommand, discardCommand, keepCommand, undoCommand } from "./commands/review.ts";
import { routinesCommand, summaryCommand } from "./commands/routines.ts";
import { logCommand, runCommand, statusCommand } from "./commands/runs.ts";
import { appCommand, type Launchctl, serviceCommand, stopCommand } from "./commands/service.ts";
import { decideCommand, limitsCommand, pricesCommand, usageCommand } from "./commands/spend.ts";
import type { Prompter } from "./prompt.ts";
import { serviceHealth } from "./service/client.ts";
import type { Running } from "./service/server.ts";

const HELP = `covo ${VERSION}: Covo command line

Usage:
  covo <command> [options]

Commands (Phase 1):
  init                Create ~/Covo and the default workspace
  audit verify        Check the activity log for tampering
  doctor [check]      Check instant copies, the sandbox and the model
  models              Connect the AI you use (Claude, GPT, Gemini, local…); "covo models add"
  bots                Your bots, each with its own models and level; "covo bots create"
  run "<task>"        Give a bot a task on a safe copy  [--bot <name>] [--model <saved model>] [--here]
  stop <run>          Stop a task Covo's service is running
  phone [connect|status|test|disconnect]
                      Your phone (Telegram): answer spending pauses, see finished tasks
  routines            Tasks on a schedule ("weekdays 9:00"): add, list, pause, run, remove
  summary [at HH:MM|off|now]
                      The daily summary: what ran, what changed, what was spent, what waits
  pause               Pause all bots: no new task starts until you resume
  resume              Let paused bots start tasks again
  service             Covo's background service: status, install, uninstall
  app                 Open Covo in your browser, signed in
  status              Show recent runs
  approve [run]       Let a paused task spend more ("covo deny" stops it instead)
  usage               What your bots spent, by model, bot and day  [--days N]
  profile             How Covo sizes itself to this Mac  [set <8gb|16gb|32gb|48gb|64gb|auto>]
  limits              Spending limits per task and per day  [--task <amount>] [--day <amount>]
  prices              Model prices Covo uses  [set <model> <in> <out>]
  log <run>           Show a run's steps ("last" for the latest)
  diff <run>          Show what a run changed  [--stat for a summary]
  keep <run> [file…]  Copy a run's changes into your workspace (all, or just these files)
  discard <run>       Throw a run's changes away
  undo <run>          Put back what a kept run changed (refuses files you've changed since)

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
  system?: () => SystemInfo;
  ollamaModels?: () => Promise<{ name: string; parameterSize?: string }[]>;
  /** Finds a program on the PATH (subscription engines). */
  which?: (cmd: string) => string | null;
  /** Tests inject a scripted subscription engine here. */
  engine?: Engine;
  /** Tests replace launchctl (covo service install/uninstall). */
  launchctl?: Launchctl;
  /** Tests replace opening the browser (covo app). */
  openUrl?: (url: string) => boolean;
  /** Tests stand in for `claude auth status`. */
  engineSignIn?: (id: string) => Promise<{ signedIn: boolean | null; method: string | null }>;
  /** Tests learn when `covo service run` is up. */
  serviceStarted?: (r: Running) => void;
  /** Tests replace Telegram (covo phone, and the service's phone link). */
  telegram?: (token: string) => TelegramApi;
}

export async function main(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
  extra: Partial<
    Pick<
      Ctx,
      | "print"
      | "provider"
      | "now"
      | "color"
      | "prompt"
      | "secrets"
      | "listModels"
      | "detect"
      | "readStdin"
      | "system"
      | "ollamaModels"
      | "which"
      | "engine"
      | "launchctl"
      | "serviceStarted"
      | "openUrl"
      | "engineSignIn"
      | "telegram"
    >
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
  if (cmd === "status") {
    const r = statusCommand(ctx);
    if (r.code !== 0) return r;
    const h = await serviceHealth(ctx.home);
    const line = h
      ? `Covo's service: running, ${h.running} task${h.running === 1 ? "" : "s"} now, ${h.queued} waiting.`
      : "Covo's service: not running (tasks run in your terminal; covo service install starts it).";
    const paused = isPaused(ctx.home) ? "All bots are paused. Resume them with: covo resume\n" : "";
    return { code: 0, out: `${r.out}${r.out.endsWith("\n\n") ? "" : "\n"}${line}\n${paused}` };
  }
  if (cmd === "service") return serviceCommand(ctx, rest);
  if (cmd === "stop") return stopCommand(ctx, rest);
  if (cmd === "pause" || cmd === "resume") return pauseCommand(ctx, cmd === "pause");
  if (cmd === "phone") return phoneCommand(ctx, rest);
  if (cmd === "routines" || cmd === "routine") return routinesCommand(ctx, rest);
  if (cmd === "summary") return summaryCommand(ctx, rest);
  if (cmd === "app") return appCommand(ctx);
  if (cmd === "log") return logCommand(ctx, rest);
  if (cmd === "models") return modelsCommand(ctx, rest);
  if (cmd === "bots") return botsCommand(ctx, rest);
  if (cmd === "profile") return profileCommand(ctx, rest);
  if (cmd === "approve") return decideCommand(ctx, rest, true);
  if (cmd === "deny") return decideCommand(ctx, rest, false);
  if (cmd === "usage") return usageCommand(ctx, rest);
  if (cmd === "limits") return limitsCommand(ctx, rest);
  if (cmd === "prices") return pricesCommand(ctx, rest);
  if (cmd === "diff") return diffCommand(ctx, rest);
  if (cmd === "keep") return keepCommand(ctx, rest);
  if (cmd === "discard") return discardCommand(ctx, rest);
  if (cmd === "undo") return undoCommand(ctx, rest);
  return { code: 2, out: `covo: unknown command "${cmd}". Run "covo --help" to see the commands.\n` };
}
