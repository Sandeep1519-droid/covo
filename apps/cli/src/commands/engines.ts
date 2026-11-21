import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { covoPaths } from "@covo/core";
import { ClaudeCodeEngine, CodexEngine, type Engine } from "@covo/engine";
import { type EngineInfo, engineById } from "@covo/models";
import { sandbox } from "@covo/platform";
import type { Ctx } from "../main.ts";

// Subscription engines (Phase 2 M6, Phase 4 M1; docs/SUBSCRIPTIONS.md): finding them, getting them
// with their maker's own installer, starting their own sign-in, and asking whether you're signed in.

/**
 * Where a program is: on the PATH, or where its installers put it ("~" is your home folder). Covo's
 * service starts with a short PATH, so ~/.local/bin isn't always on it.
 */
export function findProgram(ctx: Ctx, command: string, known: string[] = []): string | null {
  if (ctx.which) return ctx.which(command);
  const onPath = Bun.which(command, { PATH: ctx.env.PATH ?? process.env.PATH ?? "" });
  if (onPath) return onPath;
  const home = ctx.env.HOME ?? homedir();
  for (const k of known) {
    const p = k.startsWith("~/") ? join(home, k.slice(2)) : k;
    if (existsSync(p)) return p;
  }
  return null;
}

const userName = () => {
  try {
    return userInfo().username;
  } catch {
    return undefined;
  }
};

/** The program's own folder inside Covo's data (Codex: ~/Covo/engines/codex), if it has one. */
export function engineHome(ctx: Ctx, info: EngineInfo): string | null {
  return info.ownHome ? join(ctx.home, info.ownHome.dir) : null;
}

/** The engine for a saved connection, or why it can't run. */
export function makeEngine(ctx: Ctx, id: string, model: string): Engine | { missing: string } {
  if (ctx.engine) return ctx.engine;
  const info = engineById(id);
  if (!info) return { missing: `Covo doesn't know the engine "${id}".` };
  const binary = findProgram(ctx, info.command, info.knownPaths);
  if (!binary) {
    return {
      missing: `${info.label} isn't on this Mac. Get it in the app (Settings → AI models → Get ${info.label}) or with: covo models install ${info.id}`,
    };
  }
  const m = model && model !== "default" ? { model } : {};
  if (info.id === "codex") {
    return new CodexEngine({
      binary,
      codexHome: engineHome(ctx, info) as string,
      config: info.configArgs,
      user: userName(),
      ...m,
    });
  }
  return new ClaudeCodeEngine({ binary, user: userName(), ...m });
}

/** Runs `use` with a throwaway workspace and temp folder for checks that need the sandbox. */
async function withScratch<T>(ctx: Ctx, use: (t: { ws: string; tmp: string; home: string }) => Promise<T>) {
  const runs = covoPaths(ctx.home).runs;
  mkdirSync(runs, { recursive: true });
  const root = mkdtempSync(join(runs, "engine-check-"));
  try {
    const ws = join(root, "ws");
    const tmp = join(root, "tmp");
    mkdirSync(ws);
    mkdirSync(tmp);
    return await use({ ws, tmp, home: ctx.env.HOME ?? homedir() });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Starts the engine in its sandbox and reads its version, without using the subscription. */
export async function checkEngine(ctx: Ctx, id: string, model: string): Promise<{ ok: boolean; detail: string }> {
  const e = makeEngine(ctx, id, model);
  if ("missing" in e) return { ok: false, detail: e.missing };
  if (!(e instanceof ClaudeCodeEngine) && !(e instanceof CodexEngine)) return { ok: true, detail: "test engine" };
  const v = await withScratch(ctx, (t) => e.version(sandbox(), t));
  return v.ok
    ? { ok: true, detail: `${v.text}; it starts in Covo's sandbox` }
    : { ok: false, detail: `It didn't start in Covo's sandbox: ${v.text}` };
}

/**
 * Whether you're signed in to the engine, by asking it (`claude auth status`, `codex login status`),
 * in its sandbox. It reports how: "claude.ai" or "chatgpt" is your plan; "api_key" bills a key.
 */
export async function engineSignIn(
  ctx: Ctx,
  id: string,
): Promise<{ path: string | null; signedIn: boolean | null; method: string | null; detail?: string }> {
  const info = engineById(id);
  const path = info ? findProgram(ctx, info.command, info.knownPaths) : null;
  if (!info || !path) return { path: null, signedIn: null, method: null };
  if (ctx.engineSignIn) return { path, ...(await ctx.engineSignIn(id)) };
  const e = makeEngine(ctx, id, "default");
  if ("missing" in e || !(e instanceof ClaudeCodeEngine || e instanceof CodexEngine))
    return { path, signedIn: null, method: null };
  const r = await withScratch(ctx, (t) => e.authStatus(sandbox(), t));
  return { path, ...r };
}

// Getting a program and signing in, outside the sandbox: both are things you asked for, done by the
// maker's own installer and the program's own sign-in, exactly as in Terminal.

export interface SetupJob {
  /** The latest line the installer or the program printed. */
  step: () => string | null;
  /** The sign-in page the program printed (for when your browser doesn't open). */
  url: () => string | null;
  done: Promise<void>;
  cancel: () => void;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape codes are control characters
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
/** Text without terminal colours and cursor moves. */
export const plain = (s: string) => s.replace(ANSI, "").replace(/\r(?!\n)/g, "\n");

const SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin", "/opt/homebrew/bin", "/usr/local/bin"];
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;

/** Where the maker's installer is (tests use a local stand-in: COVO_INSTALLER_<ID>). */
export function installerUrl(ctx: Ctx, info: EngineInfo): string {
  return ctx.env[`COVO_INSTALLER_${info.id.toUpperCase().replace(/-/g, "_")}`] ?? info.installer.url;
}

/** Keeps the last lines a program printed, and the latest one worth showing. */
function lineKeeper(onLine?: (line: string) => void) {
  const lines: string[] = [];
  let partial = "";
  return {
    lines,
    push(text: string) {
      const parts = plain(partial + text).split("\n");
      partial = parts.pop() ?? "";
      for (const p of parts) {
        const l = p.trim();
        if (!l) continue;
        lines.push(l.length > 300 ? `${l.slice(0, 300)}…` : l);
        if (lines.length > 60) lines.shift();
        onLine?.(l);
      }
    },
    flush() {
      if (partial.trim()) this.push("\n");
    },
  };
}

async function pump(stream: ReadableStream<Uint8Array>, push: (s: string) => void) {
  const dec = new TextDecoder();
  for await (const chunk of stream) push(dec.decode(chunk, { stream: true }));
}

/** Runs the maker's official installer (docs/SUBSCRIPTIONS.md rule 7). */
export function startInstall(ctx: Ctx, info: EngineInfo, onLine?: (line: string) => void): SetupJob {
  const url = installerUrl(ctx, info);
  let step: string | null = `Downloading ${info.maker}'s installer`;
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let cancelled = false;
  const keep = lineKeeper((l) => {
    step = l;
    onLine?.(l);
  });
  const done = (async () => {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: "follow" });
    if (!res.ok) throw new Error(`${info.maker}'s installer didn't download (HTTP ${res.status}).`);
    const script = await res.text();
    if (!script.startsWith("#!")) throw new Error(`What came back from ${info.maker} didn't look like an installer.`);
    if (cancelled) throw new Error("Cancelled.");
    const dir = mkdtempSync(join(tmpdir(), "covo-install-"));
    const file = join(dir, "install.sh");
    writeFileSync(file, script, { mode: 0o700 });
    const home = ctx.env.HOME ?? homedir();
    try {
      step = `Running ${info.maker}'s installer`;
      proc = Bun.spawn([info.installer.shell, file], {
        cwd: dir,
        env: {
          HOME: home,
          USER: userName() ?? "",
          LOGNAME: userName() ?? "",
          SHELL: ctx.env.SHELL ?? process.env.SHELL ?? "/bin/zsh",
          // ~/.local/bin first: it's where these installers put the program, so they don't need
          // to add it to your shell's startup file on Covo's behalf.
          PATH: [join(home, ".local", "bin"), ...SYSTEM_PATH].join(":"),
          LANG: "en_US.UTF-8",
          TMPDIR: `${tmpdir()}/`,
          TERM: "dumb",
          NO_COLOR: "1",
          ...info.installer.env,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const p = proc;
      const timer = setTimeout(() => p.kill("SIGKILL"), INSTALL_TIMEOUT_MS);
      const [code] = await Promise.all([
        p.exited,
        pump(p.stdout as ReadableStream<Uint8Array>, (s) => keep.push(s)),
        pump(p.stderr as ReadableStream<Uint8Array>, (s) => keep.push(s)),
      ]);
      clearTimeout(timer);
      keep.flush();
      if (cancelled) throw new Error("Cancelled.");
      if (code !== 0) {
        const why = [...keep.lines].reverse().find((l) => /error|fail|denied|not |unable|could/i.test(l));
        throw new Error(`${info.maker}'s installer stopped (code ${code})${why ? `: ${why}` : "."}`);
      }
      if (!findProgram({ ...ctx, which: undefined }, info.command, info.knownPaths))
        throw new Error(`The installer finished, but ${info.label} isn't where Covo looks for it.`);
      step = `${info.label} is installed`;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  })();
  return {
    step: () => step,
    url: () => null,
    done,
    cancel: () => {
      cancelled = true;
      proc?.kill();
    },
  };
}

/** The sign-in page in what a program printed: https, on its maker's own sites only. */
export function signInLink(text: string, info: EngineInfo): string | null {
  const hosts =
    info.maker === "Anthropic" ? /(^|\.)(claude\.ai|claude\.com|anthropic\.com)$/ : /(^|\.)(openai\.com|chatgpt\.com)$/;
  // A terminal link keeps its address inside an escape code, so look before and after removing them.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: an address ends at a terminal escape
  const found = [...text.matchAll(/https:\/\/[^\s"'<>\x07\x1b]+/g), ...plain(text).matchAll(/https:\/\/[^\s"'<>]+/g)];
  for (const m of found) {
    try {
      const u = new URL(m[0]);
      if (hosts.test(u.hostname)) return u.toString();
    } catch {}
  }
  return null;
}

/** The program's environment for its sign-in: your home, and its own folder inside Covo's data. */
export function signInEnv(ctx: Ctx, info: EngineInfo, binary: string): Record<string, string> {
  const own = engineHome(ctx, info);
  if (own) mkdirSync(own, { recursive: true, mode: 0o700 });
  return {
    HOME: ctx.env.HOME ?? homedir(),
    USER: userName() ?? "",
    LOGNAME: userName() ?? "",
    PATH: [dirname(binary), ...SYSTEM_PATH].join(":"),
    LANG: "en_US.UTF-8",
    TMPDIR: `${tmpdir()}/`,
    TERM: info.signInNeedsTerminal ? "xterm-256color" : "dumb",
    ...(info.ownHome && own ? { [info.ownHome.env]: own } : {}),
  };
}

export const signInArgv = (info: EngineInfo, binary: string) => [
  binary,
  ...info.signInArgs,
  ...(info.configArgs ?? []),
];

/**
 * Starts the program's own sign-in (docs/SUBSCRIPTIONS.md rule 8). The program opens your browser
 * on its maker's page and keeps the sign-in itself; Covo only shows the link it printed.
 */
export function startSignIn(ctx: Ctx, info: EngineInfo, binary: string): SetupJob {
  let step: string | null = `Starting ${info.label}'s sign-in`;
  let link: string | null = null;
  let pressed = false;
  let seen = "";
  const keep = lineKeeper((l) => {
    step = l;
  });
  const argv = signInArgv(info, binary);
  const env = signInEnv(ctx, info, binary);
  const onText = (s: string, answer?: (k: string) => void) => {
    seen = (seen + s).slice(-20_000);
    keep.push(s);
    link ??= signInLink(seen, info);
    // Some sign-ins wait for Enter before opening the browser.
    if (!pressed && answer && /press enter/i.test(plain(seen))) {
      pressed = true;
      answer("\r");
    }
  };
  let proc: ReturnType<typeof Bun.spawn>;
  let pumps: Promise<unknown> = Promise.resolve();
  if (info.signInNeedsTerminal) {
    const dec = new TextDecoder();
    proc = Bun.spawn(argv, {
      env,
      // Wide, so a long link isn't broken across lines.
      terminal: { cols: 4000, rows: 50, data: (t, d) => onText(dec.decode(d, { stream: true }), (k) => t.write(k)) },
    });
  } else {
    proc = Bun.spawn(argv, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    pumps = Promise.all([
      pump(proc.stdout as ReadableStream<Uint8Array>, (s) => onText(s)),
      pump(proc.stderr as ReadableStream<Uint8Array>, (s) => onText(s)),
    ]);
  }
  let cancelled = false;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, SIGN_IN_TIMEOUT_MS);
  const done = (async () => {
    const code = await proc.exited;
    await pumps;
    proc.terminal?.close();
    clearTimeout(timer);
    keep.flush();
    if (cancelled) throw new Error("Cancelled.");
    if (timedOut) throw new Error("The sign-in wasn't finished within 10 minutes.");
    if (code !== 0) {
      const why = [...keep.lines].reverse().find((l) => /error|fail|denied|not |unable|cancel/i.test(l));
      throw new Error(`${info.label}'s sign-in didn't finish${why ? `: ${why}` : ` (code ${code}).`}`);
    }
    step = "Signed in";
  })();
  return {
    step: () => step,
    url: () => link,
    done,
    cancel: () => {
      cancelled = true;
      proc.kill();
    },
  };
}

/**
 * Signs Covo's own copy of a program out (Codex: `codex logout`, which also revokes the sign-in at
 * OpenAI). Only for programs with their own folder inside Covo's data; your own sign-ins are yours.
 */
export async function signOutEngine(ctx: Ctx, info: EngineInfo): Promise<void> {
  if (!info.ownHome) return;
  const binary = findProgram(ctx, info.command, info.knownPaths);
  if (!binary) return;
  const p = Bun.spawn([binary, "logout", ...(info.configArgs ?? [])], {
    env: signInEnv(ctx, info, binary),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const timer = setTimeout(() => p.kill(), 30_000);
  await p.exited;
  clearTimeout(timer);
}
