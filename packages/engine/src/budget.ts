import type { Database } from "bun:sqlite";
import { canonicalJson, newId, sha256Hex } from "@covo/core";
import { appendAudit } from "@covo/db";
import { type ChatMessage, costOf, type Price, priceFor } from "@covo/models";

// Spending limits (ADR-010): before each model call, Covo estimates what the call will cost. If
// that would take the task past its limit, or all bots past today's limit, the run pauses
// (AWAITING_APPROVAL) and asks you. Approving lets it carry on for the next step plus one more
// task-limit's worth (or about four more steps, if that's more); declining stops it. Free local
// models never pause.

export interface SpendLimits {
  /** Most this task may spend, US dollars; null = no limit. */
  runUsd: number | null;
  /** Most all bots may spend today; null = no limit. */
  dayUsd: number | null;
}

export interface SpendRequest {
  approvalId: string;
  runId: string;
  summary: string;
  spentUsd: number;
  estimateUsd: number;
  /** What approving allows, in dollars. */
  grantUsd: number;
}

/** Answers a spending request in the terminal (or, later, from your phone). */
export type AskApproval = (req: SpendRequest) => Promise<boolean>;

const DAY_MS = 86_400_000;
/** If no limit is set, approving a day-limit pause allows this much more. */
const FALLBACK_GRANT = 1;
/** Expected reply length when there's no history yet. */
const FIRST_REPLY_TOKENS = 1_000;

export function startOfLocalDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export const usd = (n: number) => (n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

export interface BudgetOptions {
  db: Database;
  runId: string;
  botName: string;
  limits: SpendLimits;
  prices: Record<string, Price>;
  now: () => number;
  setState(state: "AWAITING_APPROVAL" | "RUNNING"): void;
  onRequest?(req: SpendRequest): void;
  ask?: AskApproval;
  /** Stop at the limit instead of asking (fully automatic bots). */
  neverAsk?: boolean;
  pollMs?: number;
  signal?: AbortSignal;
}

export class Budget {
  runSpent = 0;
  private runLimit: number | null;
  private dayAllowance: number | null;
  private outputs: number[] = [];
  private lastIn = 0;

  constructor(private readonly o: BudgetOptions) {
    this.runLimit = o.limits.runUsd;
    this.dayAllowance = o.limits.dayUsd;
  }

  /** Records one model call's cost; returns it and whether the price was an estimate. */
  record(providerId: string, tokensIn: number, tokensOut: number): { usd: number; estimated: boolean } {
    const p = priceFor(providerId, this.o.prices);
    const cost = costOf(p, tokensIn, tokensOut);
    this.runSpent += cost;
    this.outputs.push(tokensOut);
    this.lastIn = tokensIn;
    return { usd: cost, estimated: p.source === "estimate" };
  }

  daySpent(): number {
    const since = startOfLocalDay(this.o.now());
    const r = this.o.db
      .query<{ s: number | null }, [number]>("SELECT SUM(usd) AS s FROM budget_ledger WHERE ts >= ?")
      .get(since);
    return r?.s ?? 0;
  }

  /** Rough cost of the next call: the whole conversation is sent again, plus a typical reply. */
  estimate(providerId: string, messages: ChatMessage[]): number {
    const p = priceFor(providerId, this.o.prices);
    if (p.in === 0 && p.out === 0) return 0;
    const chars = messages.reduce(
      (n, m) => n + m.content.length + (m.role === "assistant" ? JSON.stringify(m.toolCalls ?? []).length : 0),
      0,
    );
    // The conversation only grows, so the last call's real size is a floor for the next one.
    const tokensIn = Math.max(Math.ceil(chars / 3.5) + 1_000, this.lastIn);
    const recent = this.outputs.slice(-3);
    const tokensOut = recent.length ? Math.max(...recent) : FIRST_REPLY_TOKENS;
    return costOf(p, tokensIn, tokensOut);
  }

  /** Before a model call: returns a reason to stop, or undefined to go ahead. */
  async check(providerId: string, messages: ChatMessage[]): Promise<string | undefined> {
    const est = this.estimate(providerId, messages);
    if (est === 0) return undefined;
    const day = this.daySpent();
    const overRun = this.runLimit !== null && this.runSpent + est > this.runLimit;
    const overDay = this.dayAllowance !== null && day + est > this.dayAllowance;
    if (!overRun && !overDay) return undefined;
    if (this.o.neverAsk) {
      appendAudit(
        this.o.db,
        {
          actor: "system",
          action: "spend.limit",
          runId: this.o.runId,
          decision: "deny",
          detail: { spentUsd: this.runSpent, estimateUsd: est, overRun, overDay },
        },
        this.o.now,
      );
      return `Spending limit reached (${usd(this.runSpent)} spent on this task). Fully automatic bots stop instead of asking.`;
    }

    // Approving covers the next step plus one more limit's worth, or about four more steps if a step
    // costs more than the limit, so a small limit doesn't turn into a question before every step.
    const grant = est + Math.max(this.o.limits.runUsd ?? FALLBACK_GRANT, 4 * est);
    const which = overRun
      ? `has spent ${usd(this.runSpent)} of its ${usd(this.runLimit as number)} limit for this task`
      : `would take today's spending past your ${usd(this.dayAllowance as number)} daily limit (${usd(day)} so far)`;
    const summary = `${this.o.botName} ${which}. The next step may cost about ${usd(est)}. Approve to let it spend up to ${usd(grant)} more.`;
    const approved = await this.ask(summary, est, grant, { overRun, overDay, day });
    if (!approved) {
      return `Spending limit reached (${usd(this.runSpent)} spent on this task). It stopped because you said no.`;
    }
    if (overRun) this.runLimit = this.runSpent + grant;
    if (overDay) this.dayAllowance = day + grant;
    return undefined;
  }

  private async ask(
    summary: string,
    estimateUsd: number,
    grantUsd: number,
    detail: Record<string, unknown>,
  ): Promise<boolean> {
    const { db, runId, now } = this.o;
    const id = newId("appr", now());
    const payload = canonicalJson({ runId, spentUsd: this.runSpent, estimateUsd, grantUsd, ...detail });
    db.query(
      `INSERT INTO approvals (id, run_id, kind, summary, payload_json, payload_hash, status, expires_at)
       VALUES (?, ?, 'spend', ?, ?, ?, 'pending', ?)`,
    ).run(id, runId, summary, payload, sha256Hex(payload), now() + DAY_MS);
    appendAudit(
      db,
      { actor: "system", action: "approval.requested", runId, target: id, detail: { kind: "spend", summary } },
      now,
    );
    this.o.setState("AWAITING_APPROVAL");
    const req: SpendRequest = { approvalId: id, runId, summary, spentUsd: this.runSpent, estimateUsd, grantUsd };
    this.o.onRequest?.(req);

    let approved: boolean;
    if (this.o.ask) {
      approved = await this.o.ask(req);
      decide(db, id, approved ? "approved" : "denied", "you (in the terminal)", now);
    } else {
      approved = await this.waitForDecision(id);
    }
    this.o.setState("RUNNING");
    return approved;
  }

  /** Waits for `covo approve` / `covo deny` (or, later, your phone). */
  private async waitForDecision(id: string): Promise<boolean> {
    const { db, now, signal } = this.o;
    for (;;) {
      const row = db
        .query<{ status: string; expires_at: number }, [string]>(
          "SELECT status, expires_at FROM approvals WHERE id = ?",
        )
        .get(id);
      if (row?.status === "approved") return true;
      if (row && row.status !== "pending") return false;
      if (signal?.aborted) {
        decide(db, id, "denied", "stopped", now);
        return false;
      }
      if (row && now() > row.expires_at) {
        decide(db, id, "expired", "nobody answered in 24 hours", now);
        return false;
      }
      await Bun.sleep(this.o.pollMs ?? 1_000);
    }
  }
}

/**
 * An answer that was refused, so nothing changed (Phase 3 M7): it was for a different version of the
 * request, it came after another answer (a replay) or too late, or the request isn't there.
 */
export type RefusedAnswer = "changed" | "already answered" | "expired" | "unknown";

/** Logs a refused answer to an approval. */
export function refuseAnswer(db: Database, id: string, reason: RefusedAnswer, by: string, now: () => number): void {
  const run = db.query<{ run_id: string }, [string]>("SELECT run_id FROM approvals WHERE id = ?").get(id);
  appendAudit(
    db,
    {
      actor: by.startsWith("you") ? "user" : "system",
      action: "approval.refused",
      runId: run?.run_id,
      target: id,
      decision: "deny",
      detail: { reason, by },
    },
    now,
  );
}

/** Records a decision on a pending approval. Returns false if it wasn't pending any more. */
export function decide(
  db: Database,
  id: string,
  status: "approved" | "denied" | "expired",
  by: string,
  now: () => number,
): boolean {
  const res = db
    .query("UPDATE approvals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'")
    .run(status, by, now(), id);
  if (res.changes === 0) return false;
  const run = db.query<{ run_id: string }, [string]>("SELECT run_id FROM approvals WHERE id = ?").get(id);
  appendAudit(
    db,
    {
      actor: by.startsWith("you") ? "user" : "system",
      action: "approval.decided",
      runId: run?.run_id,
      target: id,
      decision: status === "approved" ? "allow" : "deny",
      detail: { status, by },
    },
    now,
  );
  return true;
}
