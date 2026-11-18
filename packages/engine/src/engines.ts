import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ErrorKind } from "@covo/models";
import type { Sandbox, SandboxOptions } from "@covo/platform";

// Subscription engines (Phase 2 M6, ADR-009, docs/SUBSCRIPTIONS.md).
//
// An engine is an official AI command-line program the user installed and signed into themselves,
// such as Claude Code. Covo runs it unmodified, headless, on the run's workspace copy, inside the
// cli-agent sandbox profile. Covo never reads, copies or stores the program's sign-in: the program
// reads its own, as it always does.
//
// Only Claude Code is built: the other subscriptions' terms don't allow it (see the doc).

export interface EngineTask {
  /** The run's workspace copy (real path). */
  ws: string;
  tmp: string;
  goal: string;
  /** Who the bot is and how to behave, added to the engine's own instructions. */
  instructions: string;
  sandbox: Sandbox;
  /** Your real home folder: the engine finds its own settings and sign-in there. */
  home: string;
  signal?: AbortSignal;
  timeoutMs: number;
  maxTurns: number;
}

export interface EngineResult {
  ok: boolean;
  /** The engine's closing message. */
  summary?: string;
  error?: string;
  /** Set when another model might succeed (a usage cap, a sign-in problem, an outage). */
  errorKind?: ErrorKind;
  /** It stopped at a limit (turns or time) rather than failing. */
  stopped?: boolean;
  tokensIn: number;
  tokensOut: number;
  /** What the run would have cost on the API, as the engine reports it. Information only. */
  apiEquivalentUsd: number | null;
  turns: number;
  /** Tool uses the engine's own permission rules refused. */
  denied: number;
  model?: string;
}

export interface Engine {
  /** "claude-code" */
  id: string;
  label: string;
  /** A model alias for the engine, or undefined for its own default. */
  model?: string;
  run(task: EngineTask): Promise<EngineResult>;
}

/** File tools only: no shell and no web, so instructions planted in a file can't run commands. */
export const CLAUDE_CODE_TOOLS = "Read,Edit,Write,Glob,Grep";

/** The command line for one headless Claude Code run. The task itself goes to standard input. */
export function claudeCodeArgs(o: { maxTurns: number; instructions: string; model?: string }): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    "--tools",
    CLAUDE_CODE_TOOLS,
    "--permission-mode",
    "acceptEdits",
    // Only your own settings: a workspace could plant hooks or MCP servers in its .claude folder.
    "--setting-sources",
    "user",
    "--strict-mcp-config",
    "--disallowedTools",
    "mcp__*",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--max-turns",
    String(o.maxTurns),
    "--append-system-prompt",
    o.instructions,
    ...(o.model ? ["--model", o.model] : []),
  ];
}

/** What kind of failure an engine's message describes, so the bot knows whether to try its next model. */
export function engineErrorKind(text: string): ErrorKind {
  const t = text.toLowerCase();
  if (
    /not logged in|please run \/login|\/login|log ?in again|invalid api key|authentication|oauth|unauthori[sz]ed/.test(
      t,
    )
  )
    return "auth";
  if (/usage limit|limit reached|hit your limit|out of (extra )?usage|credit balance|billing|quota/.test(t))
    return "quota";
  if (/rate.?limit|too many requests|\b429\b/.test(t)) return "rate_limit";
  if (
    /overloaded|\b529\b|\b50[0-4]\b|server error|service unavailable|econnrefused|enotfound|network|timed? ?out/.test(t)
  )
    return "unavailable";
  if (/model.*(not found|not available|does not exist)|model_not_found/.test(t)) return "not_found";
  return "other";
}

interface ClaudeJsonResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  num_turns?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  modelUsage?: Record<string, unknown>;
  permission_denials?: unknown[];
}

/** The final JSON object Claude Code prints with --output-format json. */
export function parseClaudeResult(stdout: string): ClaudeJsonResult | null {
  const text = stdout.trim();
  const tryParse = (s: string) => {
    try {
      const v = JSON.parse(s) as unknown;
      return v && typeof v === "object" && !Array.isArray(v) ? (v as ClaudeJsonResult) : null;
    } catch {
      return null;
    }
  };
  const whole = tryParse(text);
  if (whole) return whole;
  const lines = text.split("\n").reverse();
  for (const l of lines) {
    const v = l.trim().startsWith("{") ? tryParse(l.trim()) : null;
    if (v) return v;
  }
  return null;
}

/** Turns Claude Code's exit, output and JSON into an EngineResult. */
export function claudeCodeOutcome(
  r: { code: number; stdout: string; stderr: string; timedOut: boolean },
  o: { timeoutMs: number; maxTurns: number },
): EngineResult {
  const j = parseClaudeResult(r.stdout);
  const u = j?.usage ?? {};
  const base = {
    tokensIn: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
    tokensOut: u.output_tokens ?? 0,
    apiEquivalentUsd: typeof j?.total_cost_usd === "number" ? j.total_cost_usd : null,
    turns: j?.num_turns ?? 0,
    denied: Array.isArray(j?.permission_denials) ? j.permission_denials.length : 0,
    ...(j?.modelUsage ? { model: Object.keys(j.modelUsage)[0] } : {}),
  };
  if (r.timedOut) {
    return {
      ...base,
      ok: false,
      stopped: true,
      error: `Claude Code was still working after ${Math.round(o.timeoutMs / 60_000)} minutes, so Covo stopped it`,
    };
  }
  if (j && !j.is_error && j.subtype === "success" && r.code === 0) {
    return { ...base, ok: true, summary: (j.result ?? "").trim() || "Done." };
  }
  if (j?.subtype === "error_max_turns") {
    return { ...base, ok: false, stopped: true, error: `Claude Code stopped after ${o.maxTurns} turns` };
  }
  const message =
    (j?.result ?? "").trim() ||
    r.stderr.trim().split("\n").find(Boolean) ||
    r.stdout.trim().split("\n").find(Boolean) ||
    `Claude Code exited with code ${r.code}`;
  const error = message.length > 500 ? `${message.slice(0, 500)}…` : message;
  return { ...base, ok: false, error, errorKind: engineErrorKind(message) };
}

const SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin", "/opt/homebrew/bin", "/usr/local/bin"];

/** Folders the program and its interpreter (for npm installs) live in, which the sandbox must let it read. */
export function programFolders(binary: string, findNode: () => string | null): { read: string[]; path: string[] } {
  const read = new Set<string>([dirname(binary)]);
  const path = new Set<string>([dirname(binary)]);
  const real = existsSync(binary) ? realpathSync(binary) : binary;
  read.add(dirname(real));
  // An npm install is a JavaScript file run by node: the whole package and node's own folder.
  let head = "";
  try {
    head = readFileSync(real, { encoding: "latin1" }).slice(0, 64);
  } catch {}
  if (head.startsWith("#!") && /node/.test(head)) {
    const pkg = real.includes("/node_modules/") ? real.slice(0, real.lastIndexOf("/node_modules/")) : dirname(real);
    read.add(pkg);
    const node = findNode();
    if (node) {
      const nodeReal = realpathSync(node);
      read.add(dirname(dirname(nodeReal)));
      path.add(dirname(node));
      path.add(dirname(nodeReal));
    }
  }
  return { read: [...read], path: [...path] };
}

export class ClaudeCodeEngine implements Engine {
  readonly id = "claude-code";
  readonly label = "Claude Code";

  constructor(
    private readonly o: {
      /** Path to the `claude` program, as found on your PATH. */
      binary: string;
      model?: string;
      /** For npm installs: where node is. */
      findNode?: () => string | null;
      /** The user's name, which the Keychain lookup needs. */
      user?: string;
    },
  ) {}

  get model(): string | undefined {
    return this.o.model;
  }

  /** The cli-agent sandbox profile: Claude Code's own folders, the network and the Keychain. */
  sandboxOptions(t: { ws: string; tmp: string; home: string }): Omit<SandboxOptions, "timeoutMs"> {
    const prog = programFolders(this.o.binary, this.o.findNode ?? (() => Bun.which("node")));
    const h = t.home;
    return {
      workspace: t.ws,
      tmp: t.tmp,
      readOnly: [...prog.read, join(h, "Library", "Keychains")],
      readWrite: [join(h, ".claude"), join(h, "Library", "Caches", "claude-cli-nodejs"), join(h, ".cache", "claude")],
      readWriteFilePrefixes: [join(h, ".claude.json")],
      network: true,
      keychain: true,
      env: {
        HOME: h,
        PATH: [...prog.path, ...SYSTEM_PATH].join(":"),
        ...(this.o.user ? { USER: this.o.user, LOGNAME: this.o.user } : {}),
        // Updating itself is the user's business, not a task's.
        DISABLE_AUTOUPDATER: "1",
      },
    };
  }

  /** Starts the program in its sandbox and asks its version: no model use, nothing sent. */
  async version(
    sandbox: Sandbox,
    t: { ws: string; tmp: string; home: string },
  ): Promise<{ ok: boolean; text: string }> {
    if (!existsSync(this.o.binary)) return { ok: false, text: `not found at ${this.o.binary}` };
    const r = await sandbox.exec([this.o.binary, "--version"], { ...this.sandboxOptions(t), timeoutMs: 30_000 });
    const text = (r.stdout.trim() || r.stderr.trim()).split("\n")[0] ?? "";
    return { ok: r.code === 0 && !r.timedOut, text: text || `exited with code ${r.code}` };
  }

  async run(t: EngineTask): Promise<EngineResult> {
    if (!existsSync(t.ws)) throw new Error("The workspace copy is missing.");
    if (!existsSync(this.o.binary)) {
      return {
        ok: false,
        error: `Claude Code isn't installed at ${this.o.binary} any more`,
        errorKind: "not_found",
        tokensIn: 0,
        tokensOut: 0,
        apiEquivalentUsd: null,
        turns: 0,
        denied: 0,
      };
    }
    const r = await t.sandbox.exec(
      [this.o.binary, ...claudeCodeArgs({ maxTurns: t.maxTurns, instructions: t.instructions, model: this.o.model })],
      { ...this.sandboxOptions(t), timeoutMs: t.timeoutMs, stdin: t.goal, signal: t.signal },
    );
    return claudeCodeOutcome(r, { timeoutMs: t.timeoutMs, maxTurns: t.maxTurns });
  }
}

/** What the bot is told when it runs as an engine. */
export function engineInstructions(name: string, purpose: string): string {
  return [
    `You are ${name}, a bot in Covo Bot.${purpose ? ` ${purpose}` : ""}`,
    "You are working in a private copy of the user's folder. Your changes are reviewed and can be undone.",
    "Work only on files in the current folder. When you are done, reply with one or two sentences saying what you changed.",
  ].join("\n");
}
