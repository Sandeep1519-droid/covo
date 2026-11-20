import {
  dueRoutines,
  inQuietHours,
  isPaused,
  lastSummaryAt,
  parseTime,
  postSummary,
  type Routine,
  routineBusy,
  settleRoutine,
} from "@covo/engine";
import { getLimits, getRoutineSettings } from "@covo/models";
import { currentCapacity } from "../commands/profile.ts";
import type { Ctx } from "../main.ts";
import type { Service, ServiceMessage } from "./server.ts";

// Starts routines on time, and makes the daily summary (Phase 3 M6). Every few seconds:
//   • the daily summary, at the time you picked (or soon after, if the Mac was asleep then)
//   • routines that are due, through the same queue as everything else, unless:
//       all bots are paused, it's quiet hours, or the Mac is short of memory: they wait
//       it's still running from last time: this time is skipped (no pile-up)
//       it's late (the Mac slept, bots were paused): it runs once, or is skipped, as you chose
// Routines run unattended, so they don't use subscription engines unless you allow it (runner.ts).

const TICK_MS = 15_000;
/** A routine more than this late counts as missed. */
export const GRACE_MS = 5 * 60_000;

export class RoutineScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private readonly startedAt: number;
  /** Routines with a task that hasn't finished (queued or running in the service). */
  private readonly busy = new Set<string>();

  constructor(
    private readonly ctx: Ctx,
    private readonly service: Service,
    private readonly o: { tickMs?: number } = {},
  ) {
    this.startedAt = ctx.now();
  }

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.o.tickMs ?? TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    const { home } = this.ctx;
    try {
      const now = this.ctx.now();
      const s = getRoutineSettings(home);
      this.maybeSummary(now, s.summaryAt);
      // Due routines wait in these cases; when they can go, the missed-run rule applies.
      if (isPaused(home) || inQuietHours(now, s.quiet) || !currentCapacity(this.ctx).canStart) return;
      for (const r of dueRoutines(home, now, this.ctx.now)) {
        if (this.busy.has(r.id) || routineBusy(home, r.id, this.ctx.now)) {
          settleRoutine(
            home,
            r.id,
            { t: now, note: { reason: "still running from last time", due: r.nextAt } },
            this.ctx.now,
          );
          continue;
        }
        const late = r.nextAt !== null && now - r.nextAt > GRACE_MS;
        if (late && s.missed === "skip") {
          settleRoutine(
            home,
            r.id,
            {
              t: now,
              note: {
                reason: "missed while the Mac was asleep or Covo was paused",
                due: r.nextAt,
                decision: "skipped",
              },
            },
            this.ctx.now,
          );
          continue;
        }
        await this.launch(r, {
          ...(late
            ? {
                note: {
                  reason: "missed while the Mac was asleep or Covo was paused",
                  due: r.nextAt,
                  decision: "ran once",
                },
              }
            : {}),
        }).catch(() => {}); // the reason is kept on the routine (last_error)
      }
    } catch (e) {
      this.ctx.print(`routines: ${(e as Error).message}\n`);
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Starts a routine's task now: on schedule, or when you ask ("Test now", `covo routines run`).
   * Returns the service's job id; throws if it can't start (the reason is also kept on the routine).
   */
  async launch(r: Routine, o: { note?: Record<string, unknown>; manual?: boolean } = {}): Promise<string> {
    const now = this.ctx.now();
    this.busy.add(r.id);
    try {
      const job = await this.service.submit({
        goal: r.task,
        bot: r.botId,
        ...(r.model ? { model: r.model } : {}),
        trigger: "routine",
        routineId: r.id,
        unattended: true,
        ...(r.runLimitUsd !== null ? { runLimitUsd: r.runLimitUsd } : {}),
      });
      job.listeners.add((m: ServiceMessage) => {
        if (m.type === "done" || m.type === "error") this.busy.delete(r.id);
      });
      this.service.start(job);
      if (!o.manual)
        settleRoutine(
          this.ctx.home,
          r.id,
          { t: now, started: true, ...(o.note ? { note: o.note } : {}) },
          this.ctx.now,
        );
      this.service.announce({ type: "changed", what: "routine" });
      return job.id;
    } catch (e) {
      this.busy.delete(r.id);
      const error = (e as Error).message;
      settleRoutine(
        this.ctx.home,
        r.id,
        { t: o.manual ? (r.nextAt ?? now) - 1 : now, error, note: { reason: "couldn't start", error } },
        this.ctx.now,
      );
      throw e;
    }
  }

  /** The daily summary: once a day at the time you chose, or soon after if the Mac was asleep then. */
  private maybeSummary(now: number, at: string | null): void {
    if (!at) return;
    const minutes = parseTime(at);
    if (minutes === null) return;
    const d = new Date(now);
    let due = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, minutes).getTime();
    if (due > now) due = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, 0, minutes).getTime();
    // Never made one: start counting from when the service started, so it doesn't fire at once.
    const last = lastSummaryAt(this.ctx.home) ?? this.startedAt;
    if (last >= due) return;
    this.summaryNow(now);
  }

  /** Makes the daily summary now (also `covo summary now`). Returns its text, or null on a quiet day. */
  summaryNow(now = this.ctx.now()): string | null {
    const r = postSummary(this.ctx.home, { now: () => now, dayLimitUsd: getLimits(this.ctx.home).dayUsd });
    if (r.text) this.service.announce({ type: "changed", what: "summary" });
    return r.text;
  }
}
