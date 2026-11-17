import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../main.ts";

let home: string;
const env = () => ({ CW_HOME: home });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cw-test-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

test("cw init creates the folder layout, database and default bot", () => {
  const r = main(["init"], env());
  expect(r.code).toBe(0);
  expect(r.out).toContain("Set up Coworker");
  for (const p of ["state/cw.db", "workspaces/default", "runs", "logs"]) expect(existsSync(join(home, p))).toBe(true);
  const db = new Database(join(home, "state/cw.db"), { readonly: true });
  expect(db.query("SELECT name FROM agents").get()).toEqual({ name: "Assistant" });
  expect(db.query("SELECT action FROM audit_log").all()).toEqual([{ action: "system.init" }]);
  db.close();
});

test("cw init twice changes nothing", () => {
  main(["init"], env());
  const r = main(["init"], env());
  expect(r).toMatchObject({ code: 0 });
  expect(r.out).toContain("already set up");
  const db = new Database(join(home, "state/cw.db"), { readonly: true });
  expect(db.query("SELECT COUNT(*) AS n FROM audit_log").get()).toEqual({ n: 1 });
  db.close();
});

test("cw audit verify passes on a fresh install", () => {
  main(["init"], env());
  const r = main(["audit", "verify"], env());
  expect(r.code).toBe(0);
  expect(r.out).toContain("Log verified: 1 entry");
});

test("cw audit verify fails after the log is edited by hand", () => {
  main(["init"], env());
  const db = new Database(join(home, "state/cw.db"));
  db.exec("DROP TRIGGER audit_no_update; UPDATE audit_log SET actor = 'someone-else' WHERE seq = 1;");
  db.close();
  const r = main(["audit", "verify"], env());
  expect(r.code).toBe(1);
  expect(r.out).toContain("FAILED at entry #1");
});

test("cw audit verify explains when Coworker isn't set up", () => {
  const r = main(["audit", "verify"], env());
  expect(r.code).toBe(1);
  expect(r.out).toContain("cw init");
});
