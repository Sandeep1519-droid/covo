import { expect, test } from "bun:test";
import { macSystemInfo, parseBattery, parsePressure, parseThermal } from "./system.ts";

test("reads this Mac", () => {
  const s = macSystemInfo();
  expect(s.memoryGB).toBeGreaterThanOrEqual(4);
  expect(s.cores).toBeGreaterThan(0);
  expect(s.performanceCores).toBeGreaterThan(0);
  expect(["normal", "warn", "critical", "unknown"]).toContain(s.memoryPressure);
});

test("understands pmset and sysctl output", () => {
  expect(parsePressure("1")).toBe("normal");
  expect(parsePressure("2")).toBe("warn");
  expect(parsePressure("4")).toBe("critical");
  expect(parseBattery("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t55%; discharging")).toEqual({
    source: "battery",
    percent: 55,
  });
  expect(parseBattery("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged")).toEqual({
    source: "ac",
    percent: 100,
  });
  expect(parseBattery("Now drawing from 'AC Power'\n")).toEqual({ source: "ac", percent: null }); // a desktop Mac
  expect(
    parseThermal(
      "Note: No thermal warning level has been recorded\nNote: No performance warning level has been recorded\n",
    ),
  ).toBe("normal");
  expect(parseThermal("Thermal warning level set to 1.\n")).toBe("warm");
  expect(parseThermal("CPU_Scheduler_Limit = 100\nCPU_Speed_Limit = 70\n")).toBe("warm");
  expect(parseThermal("")).toBe("unknown");
});
