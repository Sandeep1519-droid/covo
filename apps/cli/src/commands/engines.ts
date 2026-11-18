import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { covoPaths } from "@covo/core";
import { ClaudeCodeEngine, type Engine } from "@covo/engine";
import { engineById } from "@covo/models";
import { sandbox } from "@covo/platform";
import type { Ctx } from "../main.ts";

// Subscription engines in the command line (Phase 2 M6, docs/SUBSCRIPTIONS.md).

export function findProgram(ctx: Ctx, command: string): string | null {
  if (ctx.which) return ctx.which(command);
  return Bun.which(command, { PATH: ctx.env.PATH ?? process.env.PATH ?? "" });
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
  const binary = findProgram(ctx, info.command);
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
