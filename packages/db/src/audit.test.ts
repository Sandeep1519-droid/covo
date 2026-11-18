import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { appendAudit, GENESIS_HASH, verifyAudit } from "./audit.ts";
import { migrate, openDb, schemaVersion } from "./db.ts";

let db: Database;
let clock = 1_700_000_000_000;
const now = () => clock++;

beforeEach(() => {
  db = openDb(":memory:");
  migrate(db, now);
});

const seed = (n: number) => {
  for (let i = 1; i <= n; i++) appendAudit(db, { actor: "system", action: "test.event", detail: { i } }, now);
};

// Simulates someone editing the database file directly, bypassing the append-only triggers.
const tamper = (sql: string) => {
  db.exec("DROP TRIGGER audit_no_update; DROP TRIGGER audit_no_delete;");
  db.exec(sql);
};

describe("migrations", () => {
  test("apply once and are recorded", () => {
    expect(schemaVersion(db)).toBe(5);
    expect(migrate(db, now)).toEqual([]);
  });
});

describe("appendAudit", () => {
  test("numbers entries from 1 and links each to the previous hash", () => {
    const a = appendAudit(db, { actor: "user", action: "system.init" }, now);
    const b = appendAudit(db, { actor: "agent:bot_1", action: "tool.exec", runId: "run_x", decision: "deny" }, now);
    expect(a.seq).toBe(1);
    expect(a.prev_hash).toBe(GENESIS_HASH);
    expect(b.seq).toBe(2);
    expect(b.prev_hash).toBe(a.hash);
    expect(b.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("stores detail as canonical JSON", () => {
    const e = appendAudit(db, { actor: "system", action: "x", detail: { b: 1, a: 2 } }, now);
    expect(e.detail_json).toBe('{"a":2,"b":1}');
  });
});

describe("append-only triggers", () => {
  test("block UPDATE", () => {
    seed(1);
    expect(() => db.exec("UPDATE audit_log SET actor = 'evil' WHERE seq = 1")).toThrow("append-only");
  });

  test("block DELETE", () => {
    seed(1);
    expect(() => db.exec("DELETE FROM audit_log WHERE seq = 1")).toThrow("append-only");
  });

  test("protect the budget ledger too", () => {
    db.exec("INSERT INTO budget_ledger (ts, tier, provider, model) VALUES (1, 'local', 'ollama', 'qwen3:4b')");
    expect(() => db.exec("UPDATE budget_ledger SET usd = 0")).toThrow("append-only");
  });
});

describe("verifyAudit", () => {
  test("passes on an untouched log", () => {
    seed(5);
    const r = verifyAudit(db);
    expect(r).toMatchObject({ ok: true, count: 5, head: { seq: 5 } });
  });

  test("passes on an empty log", () => {
    expect(verifyAudit(db)).toEqual({ ok: true, count: 0, head: null });
  });

  test("detects a changed entry", () => {
    seed(5);
    tamper(`UPDATE audit_log SET detail_json = '{"i":99}' WHERE seq = 3`);
    expect(verifyAudit(db)).toMatchObject({ ok: false, count: 2, problem: { seq: 3, kind: "changed" } });
  });

  test("detects a changed entry whose hash was recomputed in isolation", () => {
    seed(3);
    tamper("UPDATE audit_log SET actor = 'user', hash = 'f'||substr(hash, 2) WHERE seq = 2");
    const r = verifyAudit(db);
    expect(r.ok).toBe(false);
    expect(r.problem?.seq).toBe(2);
  });

  test("detects a deleted entry", () => {
    seed(5);
    tamper("DELETE FROM audit_log WHERE seq = 2");
    expect(verifyAudit(db)).toMatchObject({ ok: false, problem: { seq: 3, kind: "gap", expected: 2 } });
  });

  test("detects entries swapped into each other's place", () => {
    seed(4);
    tamper(`
      UPDATE audit_log SET seq = -2 WHERE seq = 2;
      UPDATE audit_log SET seq = 2 WHERE seq = 3;
      UPDATE audit_log SET seq = 3 WHERE seq = -2;`);
    expect(verifyAudit(db)).toMatchObject({ ok: false, problem: { seq: 2 } });
  });

  test("does not detect entries cut off the end (needs the signed chain head from Phase 2)", () => {
    seed(5);
    tamper("DELETE FROM audit_log WHERE seq > 3");
    expect(verifyAudit(db)).toMatchObject({ ok: true, count: 3 });
  });
});
