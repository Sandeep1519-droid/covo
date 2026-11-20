// Subscription engines Covo may run (Phase 2 M6, docs/SUBSCRIPTIONS.md). Only those the terms
// allow are listed. Each is an official command-line program the user installs and signs into.

export interface EngineInfo {
  id: string;
  label: string;
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
  /** The official install command, shown in the app. */
  install: string;
  /** How to sign in from a terminal. */
  signIn: string;
}

export const ENGINES: EngineInfo[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    command: "claude",
    plan: "your Claude Pro, Max or Ultra subscription",
    installUrl: "https://code.claude.com/docs/en/setup",
    models: ["default", "sonnet", "opus", "haiku", "fable"],
    suggestedName: "claude-sub",
    knownPaths: ["~/.local/bin/claude", "/opt/homebrew/bin/claude", "/usr/local/bin/claude", "~/.claude/local/claude"],
    install: "curl -fsSL https://claude.ai/install.sh | bash",
    signIn: "claude auth login",
  },
];

export const engineById = (id: string): EngineInfo | undefined => ENGINES.find((e) => e.id === id);
