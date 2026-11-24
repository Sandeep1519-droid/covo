import { existsSync, mkdirSync, realpathSync } from "node:fs";
import type { Sandbox, SandboxOptions } from "@covo/platform";
import { openAiOnly, proxyEnv, startEgressFilter } from "./egress.ts";
import { type Engine, type EngineResult, type EngineTask, engineErrorKind, programFolders } from "./engines.ts";

// Codex, OpenAI's coding agent, on your ChatGPT plan (Phase 4 M1; docs/SUBSCRIPTIONS.md, update of
// 22 Nov 2026). OpenAI's Codex SDK docs describe running Codex inside your own app; Covo runs the
// official program, unmodified, the same way the SDK does (`codex exec --json`, the task on
// standard input).
//
// - Its own Codex folder (CODEX_HOME = ~/Covo/engines/codex): Covo's Codex never sees your own
//   Codex settings, sign-in or history, and your own `codex` isn't affected. Codex keeps its
//   sign-in there; Covo never reads it.
// - Covo's sandbox, on the run's workspace copy. Codex's own sandbox is off, because macOS can't put
//   one sandbox inside another.
// - Codex reads files by running commands, so it has a shell. Its network goes only through Covo's
//   filter to OpenAI's servers (egress.ts); the sandbox blocks everything else, DNS included.

const SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin", "/opt/homebrew/bin", "/usr/local/bin"];

/** The command line for one task. The task itself goes to standard input. */
export function codexArgs(o: { ws: string; model?: string; config?: string[] }): string[] {
  return [
    "exec",
    "--json",
    // Nothing saved between tasks, and no settings, rules or project trust from anywhere but here.
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    // Covo's sandbox does the confining (macOS can't nest sandboxes).
    "--sandbox",
    "danger-full-access",
    "--cd",
    o.ws,
    ...(o.config ?? []),
    "-c",
    'approval_policy="never"',
    // Web search runs on OpenAI's servers (Codex's own tool), so the network filter is unchanged.
    "-c",
    'web_search="live"',
    // No ChatGPT apps or plugins (their tools reach other services), and no analytics.
    "-c",
    "features.apps=false",
    "-c",
    "features.plugins=false",
    "-c",
    "analytics.enabled=false",
    ...(o.model ? ["--model", o.model] : []),
  ];
}

/**
 * The Mac's own list of trusted certificate authorities, as a file. Codex otherwise reads them
 * through the Keychain services, which its sandbox doesn't allow.
 */
export const CA_BUNDLE = "/etc/ssl/cert.pem";

interface CodexItem {
  type?: string;
  text?: string;
  status?: string;
  message?: string;
}

interface CodexEvent {
  type?: string;
  item?: CodexItem;
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
  message?: string;
}

/** Reads `codex exec --json` output: one event per line. */
export function parseCodexEvents(stdout: string): {
  summary: string | null;
  tokensIn: number;
  tokensOut: number;
  steps: number;
  failedCommands: number;
  completed: boolean;
  error: string | null;
} {
  let summary: string | null = null;
  let tokensIn = 0;
  let tokensOut = 0;
  let steps = 0;
  let failedCommands = 0;
  let completed = false;
  let error: string | null = null;
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let e: CodexEvent;
    try {
      e = JSON.parse(t) as CodexEvent;
    } catch {
      continue;
    }
    if (e.type === "item.completed" && e.item) {
      const it = e.item;
      if (it.type === "agent_message" && typeof it.text === "string") summary = it.text;
      else if (it.type === "command_execution" || it.type === "file_change" || it.type === "mcp_tool_call") {
        steps++;
        if (it.type === "command_execution" && it.status === "failed") failedCommands++;
      } else if (it.type === "error" && typeof it.message === "string") error = it.message;
    } else if (e.type === "turn.completed") {
      completed = true;
      tokensIn += e.usage?.input_tokens ?? 0;
      tokensOut += e.usage?.output_tokens ?? 0;
    } else if (e.type === "turn.failed") {
      error = e.error?.message ?? "the turn failed";
    } else if (e.type === "error" && typeof e.message === "string") {
      error = e.message;
    }
  }
  return { summary, tokensIn, tokensOut, steps, failedCommands, completed, error };
}

/** What kind of failure Codex reported, so the bot knows whether to try its next model. */
export function codexErrorKind(text: string): ReturnType<typeof engineErrorKind> {
  const t = text.toLowerCase();
  if (/usage limit|hit your limit|upgrade to|purchase more credits|plan limit/.test(t)) return "quota";
  if (/not logged in|log ?in again|sign in again|codex login|401|refresh token|token (expired|revoked)/.test(t))
    return "auth";
  if (/stream disconnected|error sending request|connection (refused|reset)|proxy|tunnel/.test(t)) return "unavailable";
  return engineErrorKind(text);
}

/** Turns Codex's exit, output and events into an EngineResult. */
export function codexOutcome(
  r: { code: number; stdout: string; stderr: string; timedOut: boolean },
  o: { timeoutMs: number },
): EngineResult {
  const ev = parseCodexEvents(r.stdout);
  const base = {
    tokensIn: ev.tokensIn,
    tokensOut: ev.tokensOut,
    apiEquivalentUsd: null,
    turns: ev.steps,
    denied: 0,
  };
  if (r.timedOut) {
    return {
      ...base,
      ok: false,
      stopped: true,
      error: `Codex was still working after ${Math.round(o.timeoutMs / 60_000)} minutes, so Covo stopped it`,
    };
  }
  if (r.code === 0 && ev.completed && !ev.error) {
    return { ...base, ok: true, summary: (ev.summary ?? "").trim() || "Done." };
  }
  const message =
    ev.error ||
    r.stderr
      .trim()
      .split("\n")
      .reverse()
      .find((l) => /error|not logged|limit|failed/i.test(l)) ||
    r.stderr.trim().split("\n").find(Boolean) ||
    `Codex exited with code ${r.code}`;
  const error = message.length > 500 ? `${message.slice(0, 500)}…` : message;
  return { ...base, ok: false, error, errorKind: codexErrorKind(message) };
}

/** The folders the program needs: for OpenAI's installer, its whole release folder. */
export function codexFolders(binary: string): { read: string[]; path: string[] } {
  const prog = programFolders(binary, () => null);
  const read = new Set(prog.read);
  const real = existsSync(binary) ? realpathSync(binary) : binary;
  // ~/.codex/packages/standalone/releases/<version>/bin/codex: the release folder holds its helpers.
  // Only that layout: never a whole ~/.local or similar.
  const release = /^(.*\/packages\/standalone\/releases\/[^/]+)\/bin\/[^/]+$/.exec(real)?.[1];
  if (release) read.add(release);
  return { read: [...read], path: prog.path };
}

export class CodexEngine implements Engine {
  readonly id = "codex";
  readonly label = "Codex";

  constructor(
    private readonly o: {
      /** Path to the `codex` program. */
      binary: string;
      /** Covo's own Codex folder (CODEX_HOME). */
      codexHome: string;
      /** Settings passed on every start (`-c key=value`). */
      config?: string[];
      model?: string;
      user?: string;
      /** Tests stand in for the filter's rule. */
      allow?: (host: string, port: number) => boolean;
    },
  ) {}

  get model(): string | undefined {
    return this.o.model;
  }

  private ensureHome(): void {
    mkdirSync(this.o.codexHome, { recursive: true, mode: 0o700 });
  }

  /** Covo's sandbox for Codex: its own folder, no Keychain, and the network only through the filter. */
  sandboxOptions(t: { ws: string; tmp: string }, proxyPort?: number): Omit<SandboxOptions, "timeoutMs"> {
    const prog = codexFolders(this.o.binary);
    return {
      workspace: t.ws,
      tmp: t.tmp,
      readOnly: prog.read,
      readWrite: [this.o.codexHome],
      network: false,
      keychain: false,
      ...(proxyPort ? { proxyPort } : {}),
      env: {
        // Stray caches land in the run's temp folder, not in your files.
        HOME: t.tmp,
        CODEX_HOME: this.o.codexHome,
        PATH: [...prog.path, ...SYSTEM_PATH].join(":"),
        TERM: "dumb",
        NO_COLOR: "1",
        ...(existsSync(CA_BUNDLE) ? { CODEX_CA_CERTIFICATE: CA_BUNDLE } : {}),
        ...(this.o.user ? { USER: this.o.user, LOGNAME: this.o.user } : {}),
        ...(proxyPort ? proxyEnv(proxyPort) : {}),
      },
    };
  }

  /** Asks Codex whether it's signed in (`codex login status`), in its sandbox, offline. */
  async authStatus(
    sandbox: Sandbox,
    t: { ws: string; tmp: string },
  ): Promise<{ signedIn: boolean | null; method: string | null; detail?: string }> {
    if (!existsSync(this.o.binary)) return { signedIn: null, method: null, detail: `not found at ${this.o.binary}` };
    this.ensureHome();
    const r = await sandbox.exec([this.o.binary, "login", "status", ...(this.o.config ?? [])], {
      ...this.sandboxOptions(t),
      timeoutMs: 30_000,
    });
    if (r.timedOut) return { signedIn: null, method: null, detail: "it didn't answer in 30 seconds" };
    const text = `${r.stderr}\n${r.stdout}`;
    if (/logged in using chatgpt/i.test(text)) return { signedIn: true, method: "chatgpt" };
    if (/api key configured|logged in using an api key/i.test(text)) return { signedIn: true, method: "api_key" };
    if (/logged in using/i.test(text)) return { signedIn: true, method: "other" };
    if (/not logged in/i.test(text)) return { signedIn: false, method: null };
    return { signedIn: null, method: null, detail: text.trim().split("\n")[0] ?? `exited with code ${r.code}` };
  }

  /** Starts the program in its sandbox and asks its version: no model use, nothing sent. */
  async version(sandbox: Sandbox, t: { ws: string; tmp: string }): Promise<{ ok: boolean; text: string }> {
    if (!existsSync(this.o.binary)) return { ok: false, text: `not found at ${this.o.binary}` };
    this.ensureHome();
    const r = await sandbox.exec([this.o.binary, "--version"], { ...this.sandboxOptions(t), timeoutMs: 30_000 });
    const text = (r.stdout.trim() || r.stderr.trim()).split("\n")[0] ?? "";
    return { ok: r.code === 0 && !r.timedOut, text: text || `exited with code ${r.code}` };
  }

  async run(t: EngineTask): Promise<EngineResult> {
    if (!existsSync(t.ws)) throw new Error("The workspace copy is missing.");
    if (!existsSync(this.o.binary)) {
      return {
        ok: false,
        error: `Codex isn't installed at ${this.o.binary} any more`,
        errorKind: "not_found",
        tokensIn: 0,
        tokensOut: 0,
        apiEquivalentUsd: null,
        turns: 0,
        denied: 0,
      };
    }
    this.ensureHome();
    const filter = await startEgressFilter({ allow: this.o.allow ?? openAiOnly });
    try {
      const r = await t.sandbox.exec(
        [this.o.binary, ...codexArgs({ ws: t.ws, model: this.o.model, config: this.o.config })],
        {
          ...this.sandboxOptions(t, filter.port),
          timeoutMs: t.timeoutMs,
          stdin: `${t.instructions}\n\n${t.goal}`,
          signal: t.signal,
        },
      );
      const out = codexOutcome(r, { timeoutMs: t.timeoutMs });
      return filter.refused.size ? { ...out, blockedHosts: [...filter.refused].slice(0, 20) } : out;
    } finally {
      filter.stop();
    }
  }
}
