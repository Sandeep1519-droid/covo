import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { covoPaths } from "@covo/core";
import { initHome, openDb } from "@covo/db";
import { MockProvider } from "@covo/models";
import type { SystemInfo } from "@covo/platform";
import { capacity, paramsOf, profileForMemory, suggestLocalModel } from "./profile.ts";
import { startRun } from "./run.ts";

const mac = (gb: number, over: Partial<SystemInfo> = {}): SystemInfo => ({
  memoryGB: gb,
  chip: "Apple M3",
  performanceCores: 4,
  cores: 8,
  memoryPressure: "normal",
  power: { source: "ac", percent: 100 },
  thermal: "normal",
  ...over,
});

test("the profile follows the Mac's memory", () => {
  expect([8, 16, 18, 24, 36, 48, 64, 128].map((gb) => profileForMemory(gb).name)).toEqual([
    "8gb",
    "16gb",
    "16gb",
    "32gb",
    "32gb",
    "48gb",
    "64gb",
    "64gb",
  ]);
  expect(capacity(mac(8))).toMatchObject({ maxRuns: 1, canStart: true, notes: [] });
  expect(capacity(mac(16)).maxRuns).toBe(2);
  expect(capacity(mac(64)).maxRuns).toBe(6);
  expect(capacity(mac(8), "32gb")).toMatchObject({ chosen: true, maxRuns: 3 });
});

test("slows down for memory pressure, a low battery or heat, and pauses on critical memory", () => {
  expect(capacity(mac(32, { memoryPressure: "warn" }))).toMatchObject({ maxRuns: 1, canStart: true });
  expect(capacity(mac(32, { power: { source: "battery", percent: 15 } })).notes[0]).toContain("battery at 15%");
  expect(capacity(mac(32, { power: { source: "battery", percent: 80 } })).maxRuns).toBe(3);
  expect(capacity(mac(32, { thermal: "warm" })).maxRuns).toBe(1);
  expect(capacity(mac(8, { memoryPressure: "critical" }))).toMatchObject({ canStart: false });
});

test("sizes local models from Ollama's details or the name", () => {
  expect(paramsOf("qwen3:4b", "4.0B")).toBe(4);
  expect(paramsOf("qwen3.5:4b")).toBe(4);
  expect(paramsOf("llama3.3:70b-instruct-q4")).toBe(70);
  expect(paramsOf("mystery")).toBeNull();
  const installed = [
    { name: "qwen2.5:1.5b", paramsB: 1.5 },
    { name: "qwen3.5:4b", paramsB: 4 },
    { name: "big:32b", paramsB: 32 },
  ];
  const on8 = suggestLocalModel(profileForMemory(8), installed);
  expect(on8.best?.name).toBe("qwen3.5:4b");
  expect(on8.tooBig.map((m) => m.name)).toEqual(["big:32b"]);
  expect(suggestLocalModel(profileForMemory(48), installed).best?.name).toBe("big:32b");
  expect(suggestLocalModel(profileForMemory(16), installed).roomForBigger).toBe(true);
  const tie = [
    { name: "qwen3:4b", paramsB: 4 },
    { name: "qwen3.5:4b", paramsB: 4 },
  ];
  expect(suggestLocalModel(profileForMemory(8), tie, "qwen3.5:4b").best?.name).toBe("qwen3.5:4b");
});

let home: string;
beforeEach(() => {
  home = join(realpathSync(mkdtempSync(join(tmpdir(), "covo-profile-"))), "Covo");
  initHome(home);
  writeFileSync(join(home, "workspaces/default/README.md"), "# P\n");
});
afterEach(() => rmSync(join(home, ".."), { recursive: true, force: true }));

test("a 16 GB profile lets two tasks run at once; a third waits", async () => {
  const db = openDb(covoPaths(home).db);
  db.exec(
    "INSERT INTO runs (id, agent_id, department_id, trigger, goal, state, created_at) VALUES ('run_busy1', 'bot_assistant', 'dept_default', 'cli', 'x', 'RUNNING', 1)",
  );
  db.close();
  const ok = await startRun({
    home,
    goal: "y",
    maxConcurrent: 2,
    provider: new MockProvider([MockProvider.tool("finish", { summary: "ok" })]),
  });
  expect(ok.state).toBe("SUCCEEDED");
  const db2 = openDb(covoPaths(home).db);
  db2.exec(
    "INSERT INTO runs (id, agent_id, department_id, trigger, goal, state, created_at) VALUES ('run_busy2', 'bot_assistant', 'dept_default', 'cli', 'x', 'AWAITING_APPROVAL', 2)",
  );
  db2.close();
  expect(startRun({ home, goal: "z", maxConcurrent: 2, provider: new MockProvider([]) })).rejects.toThrow(
    "2 tasks are already running",
  );
});
