import { isPaused, setPaused } from "@covo/engine";
import type { CliResult, Ctx } from "../main.ts";

/** covo pause / covo resume: no new task starts while paused; running ones finish. */
export function pauseCommand(ctx: Ctx, pause: boolean): CliResult {
  if (isPaused(ctx.home) === pause)
    return { code: 0, out: pause ? "All bots are already paused.\n" : "Bots aren't paused.\n" };
  setPaused(ctx.home, pause, "you (terminal)", ctx.now);
  return {
    code: 0,
    out: pause
      ? "All bots are paused. Tasks already running finish; new ones wait until you run: covo resume\n"
      : "Bots can start tasks again. Anything that was waiting starts now.\n",
  };
}
