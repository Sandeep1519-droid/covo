import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { covoPaths } from "@covo/core";
import { openDb } from "@covo/db";
import { addRoutine, type Engine, type EngineResult, getRoutine, listMessages, setPaused } from "@covo/engine";
import { MockProvider, setRoutineSettings } from "@covo/models";
import { memorySecrets, type SystemInfo } from "@covo/platform";
import { type Ctx, main } from "../main.ts";
import { type Running, serve } from "./server.ts";

// Phase 3 M6: routines start on time, missed ones run once (or not), and the daily summary.

let root: string;
let home: string;
let running: Running;
// Thursday 19 Nov 2026, 10:00 local; tests move the clock.
let clock = new Date(2026, 10, 19, 10, 0).getTime();
const env = () => ({ COVO_HOME: home, HOME: root, COVO_PORT: "0" });
const mac8 = (): SystemInfo => ({
  memoryGB: 8,
  chip: "Apple M3",
  performanceCores: 4,
  cores: 8,
  memoryPressure: "normal",
  power: { source: "ac", percent: 100 },
  thermal: "normal",
});
let engineCalls = 0;
const engine: Engine = {
  id: "claude-code",
  label: "Claude Code",
  model: undefined,
  async run(): Promise<EngineResult> {
    engineCalls++;
    return {
      ok: true,
      summary: "Done by the subscription.",
      tokensIn: 1,
      tokensOut: 1,
      apiEquivalentUsd: 0,
      turns: 1,
      denied: 0,
    };
  },
} as unknown as Engine;

function turns(n: number) {
  const t = [];
  for (let i = 0; i < n; i++) t.push(MockProvider.tool("finish", { summary: `Checked the inbox (${i}).` }));
  return new MockProvider(t);
}

async function start(extra: Partial<Ctx> = {}) {
  const ctx: Ctx = {
    home,
    now: () => clock,
    env: env(),
    print: () => {},
    system: mac8,
    secrets: memorySecrets(),
    provider: turns(20),
    ...extra,
  };
  running = await serve(ctx);
  return running.service.scheduler as NonNullable<typeof running.service.scheduler>;
}

const runs = () => {
  const db = openDb(covoPaths(home).db);
  const r = db
    .query<{ id: string; state: string; trigger: string; routine_id: string | null }, []>(
      "SELECT id, state, trigger, routine_id FROM runs ORDER BY created_at, id",
    )
    .all();
  db.close();
  return r;
};
const audits = (action: string) => {
  const db = openDb(covoPaths(home).db);
  const rows = db
    .query<{ detail: string }, [string]>("SELECT detail_json AS detail FROM audit_log WHERE action = ? ORDER BY seq")
    .all(action)
    .map((x) => JSON.parse(x.detail) as Record<string, unknown>);
  db.close();
  return rows;
};
const settled = async (n: number) => {
  for (let i = 0; i < 300; i++) {
    if (runs().filter((r) => ["SUCCEEDED", "KEPT", "FAILED", "REVIEWING"].includes(r.state)).length >= n) return;
    await Bun.sleep(10);
  }
};

beforeEach(async () => {
  clock = new Date(2026, 10, 19, 10, 0).getTime();
  engineCalls = 0;
  root = realpathSync(mkdtempSync(join(tmpdir(), "covo-sched-")));
  home = join(root, "Covo");
  await main(["init"], env());
  writeFileSync(join(home, "workspaces/default/README.md"), "# Demo\n");
});
afterEach(async () => {
  await running?.close();
  rmSync(root, { recursive: true, force: true });
});

describe("routines in the service", () => {
  test("a routine runs on time, by itself, as a routine; next time is set", async () => {
    const r = addRoutine(
      home,
      { name: "Check", bot: "Assistant", task: "check the inbox", every: "every 30 minutes" },
      () => clock,
    );
    const s = await start();
    await s.tick();
    expect(runs()).toHaveLength(0); // not due yet
    clock = new Date(2026, 10, 19, 10, 30).getTime();
    await s.tick();
    await settled(1);
    expect(runs()).toEqual([expect.objectContaining({ trigger: "routine", routine_id: r.id, state: "SUCCEEDED" })]);
    const after = getRoutine(home, r.id, () => clock);
    expect(after.lastAt).toBe(clock);
    expect(after.nextAt).toBe(new Date(2026, 10, 19, 11, 0).getTime());
    await s.tick();
    expect(runs()).toHaveLength(1); // not again until 11:00
  });

  test("missed while the Mac slept: runs once, not once per missed time; or skipped, if you chose", async () => {
    const r = addRoutine(
      home,
      { name: "Check", bot: "Assistant", task: "check", every: "every 30 minutes" },
      () => clock,
    );
    const s = await start();
    clock = new Date(2026, 10, 19, 13, 5).getTime(); // asleep through 10:30 … 13:00
    await s.tick();
    await settled(1);
    await s.tick();
    expect(runs()).toHaveLength(1);
    expect(audits("routine.skipped")).toEqual([expect.objectContaining({ decision: "ran once" })]);
    expect(getRoutine(home, r.id, () => clock).nextAt).toBe(new Date(2026, 10, 19, 13, 30).getTime());

    setRoutineSettings(home, { missed: "skip" });
    clock = new Date(2026, 10, 19, 16, 10).getTime();
    await s.tick();
    expect(runs()).toHaveLength(1);
    expect(audits("routine.skipped").at(-1)).toMatchObject({ decision: "skipped" });
  });

  test("while all bots are paused, or in quiet hours, a due routine waits", async () => {
    addRoutine(home, { name: "Check", bot: "Assistant", task: "check", every: "every 30 minutes" }, () => clock);
    const s = await start();
    setPaused(home, true, "you (test)", () => clock);
    clock = new Date(2026, 10, 19, 10, 31).getTime();
    await s.tick();
    expect(runs()).toHaveLength(0);
    setPaused(home, false, "you (test)", () => clock);
    setRoutineSettings(home, { quiet: { from: "10:00", to: "12:00" } });
    await s.tick();
    expect(runs()).toHaveLength(0);
    setRoutineSettings(home, { quiet: null });
    await s.tick();
    await settled(1);
    expect(runs()).toHaveLength(1);
  });

  test("routines don't use subscriptions unless you allow it", async () => {
    await main(["models", "add", "claude-code"], env(), {
      secrets: memorySecrets(),
      which: (c: string) => (c === "claude" ? "/opt/bin/claude" : null),
      engine,
    });
    const r = addRoutine(
      home,
      { name: "Sub", bot: "Assistant", task: "check", every: "every 30 minutes", model: "claude-sub" },
      () => clock,
    );
    const s = await start({ engine, which: (c: string) => (c === "claude" ? "/opt/bin/claude" : null) });
    await s.launch(
      getRoutine(home, r.id, () => clock),
      { manual: true },
    );
    await settled(1);
    expect(engineCalls).toBe(0); // the free local model did it instead
    setRoutineSettings(home, { subscriptions: true });
    await s.launch(
      getRoutine(home, r.id, () => clock),
      { manual: true },
    );
    await settled(2);
    expect(engineCalls).toBe(1);
  });
});

describe("the daily summary", () => {
  test("made at its time, once, in your main bot's chat", async () => {
    addRoutine(
      home,
      { name: "Check", bot: "Assistant", task: "check the inbox", every: "every 30 minutes" },
      () => clock,
    );
    setRoutineSettings(home, { summaryAt: "18:00" });
    const s = await start();
    clock = new Date(2026, 10, 19, 10, 30).getTime();
    await s.tick();
    await settled(1);
    clock = new Date(2026, 10, 19, 17, 59).getTime();
    setRoutineSettings(home, { missed: "skip" }); // keep the afternoon quiet
    await s.tick();
    const bot = () => listMessages(home, "Assistant", { now: () => clock }).filter((m) => m.role === "bot");
    expect(bot()).toHaveLength(0);
    clock = new Date(2026, 10, 19, 18, 0, 30).getTime();
    await s.tick();
    expect(bot()).toHaveLength(1);
    expect(bot()[0]?.text).toContain("Your day: 1 task done");
    expect(bot()[0]?.text).toContain("Assistant, Check: Checked the inbox");
    await s.tick();
    expect(bot()).toHaveLength(1);
  });
});
