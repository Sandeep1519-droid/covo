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
  },
];

export const engineById = (id: string): EngineInfo | undefined => ENGINES.find((e) => e.id === id);
