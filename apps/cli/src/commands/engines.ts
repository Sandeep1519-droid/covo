import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { covoPaths } from "@covo/core";
import { ClaudeCodeEngine, type Engine } from "@covo/engine";
import { engineById } from "@covo/models";
import { sandbox } from "@covo/platform";
import type { Ctx } from "../main.ts";

// Subscription engines in the command line (Phase 2 M6, docs/SUBSCRIPTIONS.md).

/**
 * Where a program is: on the PATH, or where its installers put it ("~" is your home folder). Covo's
 * service starts with a short PATH, so Claude Code's ~/.local/bin isn't always on it.
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

/** The engine for a saved connection, or why it can't run. */
export function makeEngine(ctx: Ctx, id: string, model: string): Engine | { missing: string } {
  if (ctx.engine) return ctx.engine;
  const info = engineById(id);
  if (!info) return { missing: `Covo doesn't know the engine "${id}".` };
  const binary = findProgram(ctx, info.command, info.knownPaths);
  if (!binary) {
    return {
      missing: `${info.label} isn't installed (no "${info.command}" on your PATH). Install it from ${info.installUrl}, then sign in by running: ${info.command}`,
    };
  }
  return new ClaudeCodeEngine({
    binary,
    ...(model && model !== "default" ? { model } : {}),
    user: userName(),
  });
}

/** Starts the engine in its sandbox and reads its version, without using the subscription. */
export async function checkEngine(ctx: Ctx, id: string, model: string): Promise<{ ok: boolean; detail: string }> {
  const e = makeEngine(ctx, id, model);
  if ("missing" in e) return { ok: false, detail: e.missing };
  if (!(e instanceof ClaudeCodeEngine)) return { ok: true, detail: "test engine" };
  const runs = covoPaths(ctx.home).runs;
  mkdirSync(runs, { recursive: true });
  const root = mkdtempSync(join(runs, "engine-check-"));
  try {
    const ws = join(root, "ws");
    const tmp = join(root, "tmp");
    mkdirSync(ws);
    mkdirSync(tmp);
    const v = await e.version(sandbox(), { ws, tmp, home: ctx.env.HOME ?? homedir() });
    return v.ok
      ? { ok: true, detail: `${v.text}; it starts in Covo's sandbox` }
      : { ok: false, detail: `It didn't start in Covo's sandbox: ${v.text}` };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Whether you're signed in to the engine, by asking it (`claude auth status`), in its sandbox. It
 * reports how you signed in: "claude.ai" is a subscription; "api_key" bills an API key instead.
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
  if ("missing" in e || !(e instanceof ClaudeCodeEngine)) return { path, signedIn: null, method: null };
  const runs = covoPaths(ctx.home).runs;
  mkdirSync(runs, { recursive: true });
  const root = mkdtempSync(join(runs, "engine-check-"));
  try {
    const ws = join(root, "ws");
    const tmp = join(root, "tmp");
    mkdirSync(ws);
    mkdirSync(tmp);
    const r = await e.authStatus(sandbox(), { ws, tmp, home: ctx.env.HOME ?? homedir() });
    return { path, ...r };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
