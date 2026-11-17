import type { Database } from "bun:sqlite";
import { canonicalJson, sha256Hex } from "@cw/core";

// Tamper-evident activity log.
//
// Rows can't be updated or deleted through SQLite (triggers in 0001_init.sql). Someone with
// direct file access could still drop the triggers, so each row also carries a hash:
//
//   hash = sha256( prev_hash + "\n" + canonicalJson(row fields) )
//
// Changing, removing or reordering any row breaks every hash after it, and verifyAudit() reports
// the first broken entry. Cutting entries off the END of the log is only caught once the chain head
// is signed and stored elsewhere; that arrives with the Touch ID vault in Phase 2.

export const GENESIS_HASH = "0".repeat(64);

export interface AuditInput {
  actor: string;
  action: string;
  runId?: string | null;
  target?: string | null;
  decision?: "allow" | "deny" | "ask" | null;
  detail?: unknown;
}

export type AuditEntry = {
  seq: number;
  ts: number;
  run_id: string | null;
  actor: string;
  action: string;
  target: string | null;
  decision: string | null;
  detail_json: string;
  prev_hash: string;
  hash: string;
};

type HashedFields = Omit<AuditEntry, "prev_hash" | "hash">;

export function entryHash(prevHash: string, f: HashedFields): string {
  const body = canonicalJson({
    seq: f.seq,
    ts: f.ts,
    run_id: f.run_id,
    actor: f.actor,
    action: f.action,
    target: f.target,
    decision: f.decision,
    detail_json: f.detail_json,
  });
  return sha256Hex(`${prevHash}\n${body}`);
}

/** Appends one entry and returns it. Safe to call from several connections: the read-then-insert is one transaction. */
export function appendAudit(db: Database, input: AuditInput, now: () => number = Date.now): AuditEntry {
  return db
    .transaction((): AuditEntry => {
      const last = db
        .query<{ seq: number; hash: string }, []>("SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1")
        .get();
      const fields: HashedFields = {
        seq: (last?.seq ?? 0) + 1,
        ts: now(),
        run_id: input.runId ?? null,
        actor: input.actor,
        action: input.action,
        target: input.target ?? null,
        decision: input.decision ?? null,
        detail_json: canonicalJson(input.detail ?? {}),
      };
      const prev_hash = last?.hash ?? GENESIS_HASH;
      const entry: AuditEntry = { ...fields, prev_hash, hash: entryHash(prev_hash, fields) };
      db.query<unknown, [Record<string, string | number | null>]>(
        `INSERT INTO audit_log (seq, ts, run_id, actor, action, target, decision, detail_json, prev_hash, hash)
         VALUES ($seq, $ts, $run_id, $actor, $action, $target, $decision, $detail_json, $prev_hash, $hash)`,
      ).run(entry);
      return entry;
    })
    .immediate();
}

export type AuditProblem =
  | { seq: number; kind: "gap"; expected: number }
  | { seq: number; kind: "broken-link" }
  | { seq: number; kind: "changed" };

export interface AuditReport {
  ok: boolean;
  count: number;
  head: { seq: number; ts: number; hash: string } | null;
  problem?: AuditProblem;
}

/** Walks the whole log in order and stops at the first problem. */
export function verifyAudit(db: Database): AuditReport {
  let expected = 1;
  let prev = GENESIS_HASH;
  let head: AuditReport["head"] = null;
  let count = 0;
  for (const row of db.query<AuditEntry, []>("SELECT * FROM audit_log ORDER BY seq").iterate()) {
    if (row.seq !== expected) return { ok: false, count, head, problem: { seq: row.seq, kind: "gap", expected } };
    if (row.prev_hash !== prev) return { ok: false, count, head, problem: { seq: row.seq, kind: "broken-link" } };
    if (entryHash(prev, row) !== row.hash)
      return { ok: false, count, head, problem: { seq: row.seq, kind: "changed" } };
    prev = row.hash;
    head = { seq: row.seq, ts: row.ts, hash: row.hash };
    expected++;
    count++;
  }
  return { ok: true, count, head };
}

export function auditForRun(db: Database, runId: string): AuditEntry[] {
  return db.query<AuditEntry, [string]>("SELECT * FROM audit_log WHERE run_id = ? ORDER BY seq").all(runId);
}
