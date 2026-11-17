import { describe, expect, test } from "bun:test";
import { idTime, isId, newId } from "./ids.ts";

describe("newId", () => {
  test("has the prefix and a 26-character body", () => {
    const id = newId("run");
    expect(isId(id, "run")).toBe(true);
    expect(id).toHaveLength(4 + 26);
  });

  test("encodes the creation time", () => {
    const now = Date.UTC(2026, 10, 17, 9, 30);
    expect(idTime(newId("step", now))).toBe(now);
  });

  test("sorts by creation time", () => {
    const a = newId("run", 1_000);
    const b = newId("run", 2_000);
    expect(a < b).toBe(true);
  });

  test("is unique within the same millisecond", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId("evt", 5)));
    expect(ids.size).toBe(1000);
  });

  test("rejects malformed IDs", () => {
    expect(isId("run_123")).toBe(false);
    expect(isId(newId("run"), "bot")).toBe(false);
  });
});
