// Subscription engines Covo may run (Phase 2 M6, Phase 4 M1; docs/SUBSCRIPTIONS.md). Only those
// the terms allow are listed. Each is an official command-line program from its maker. You get it
// with the maker's own installer (from the app: Get) and sign in with the program's own sign-in.

export interface EngineInfo {
  id: string;
  label: string;
  /** Who makes it, for messages ("Anthropic"). */
  maker: string;
  /** The program's name on the PATH. */
  command: string;
  /** Whose subscription it uses, for messages. */
  plan: string;
  installUrl: string;
  /** Model aliases the program accepts; "default" leaves it to the program's own setting. */
  models: string[];
  /** Name suggested for the saved connection. */
  suggestedName: string;
  /** Where its installers put it, for a service whose PATH is short ("~" is your home folder). */
  knownPaths: string[];
  /** The official install command, shown in the app and the command line. */
  install: string;
  /** The maker's installer script, which Covo runs when you press Get, and how. */
  installer: { url: string; shell: string; env?: Record<string, string> };
  /** About how much it downloads, for the app. */
  downloadMb: number;
  /** How to sign in from a terminal. */
  signIn: string;
  /** The program's own sign-in, which Covo starts when you press Sign in. */
  signInArgs: string[];
  /** Its sign-in draws a screen, so Covo gives it a terminal of its own. */
  signInNeedsTerminal: boolean;
  /**
   * A folder of its own inside Covo's data, set through this variable, so Covo's copy never sees
   * your own settings, sign-in or history for the program.
   */
  ownHome?: { env: string; dir: string };
  /** Settings passed on every start (`-c key=value`). */
  configArgs?: string[];
}

export const ENGINES: EngineInfo[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    maker: "Anthropic",
    command: "claude",
    plan: "your Claude Pro, Max or Ultra subscription",
    installUrl: "https://code.claude.com/docs/en/setup",
    models: ["default", "sonnet", "opus", "haiku", "fable"],
    suggestedName: "claude-sub",
    knownPaths: ["~/.local/bin/claude", "/opt/homebrew/bin/claude", "/usr/local/bin/claude", "~/.claude/local/claude"],
    install: "curl -fsSL https://claude.ai/install.sh | bash",
    installer: { url: "https://claude.ai/install.sh", shell: "/bin/bash" },
    downloadMb: 360,
    signIn: "claude auth login",
    // Your Claude account (a subscription), not a Console API key.
    signInArgs: ["auth", "login", "--claudeai"],
    signInNeedsTerminal: true,
  },
  {
    id: "codex",
    label: "Codex",
    maker: "OpenAI",
    command: "codex",
    plan: "your ChatGPT plan",
    installUrl: "https://learn.chatgpt.com/docs/cli",
    models: ["default"],
    suggestedName: "codex",
    knownPaths: ["~/.local/bin/codex", "/opt/homebrew/bin/codex", "/usr/local/bin/codex"],
    install: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
    installer: {
      url: "https://chatgpt.com/codex/install.sh",
      shell: "/bin/sh",
      // No questions: there's nobody at a terminal to answer them.
      env: { CODEX_NON_INTERACTIVE: "1" },
    },
    downloadMb: 180,
    signIn: "covo models sign-in codex",
    signInArgs: ["login"],
    signInNeedsTerminal: false,
    ownHome: { env: "CODEX_HOME", dir: "engines/codex" },
    // Keep its sign-in in its own folder (auth.json), never the Keychain, and don't look for updates.
    configArgs: ["-c", 'cli_auth_credentials_store="file"', "-c", "check_for_update_on_startup=false"],
  },
];

export const engineById = (id: string): EngineInfo | undefined => ENGINES.find((e) => e.id === id);

/** What connecting means, in plain words. The app and `covo models add` both show it. */
export function engineNotice(info: EngineInfo): string[] {
  return [
    `You sign in with ${info.label} itself, on ${info.maker}'s own page. Covo never sees, copies or stores your sign-in.`,
    "Tasks count toward your plan's usage limits. When you hit one, the bot's next model takes over.",
    info.id === "codex"
      ? "Codex works on Covo's copy of your files. It can run commands there, but its network reaches only OpenAI's servers."
      : `${info.label} works on Covo's copy of your files, with file tools only (no shell, no web).`,
    "Covo's spending limits don't apply: a subscription is a flat fee.",
  ];
}
