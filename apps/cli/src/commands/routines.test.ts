import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../main.ts";

let home: string;
const t = new Date(2026, 10, 19, 10, 0).getTime();
const env = () => ({ COVO_HOME: home, COVO_SERVICE: "off" });
const ctx = { now: () => t };

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "covo-rtncli-"));
  await main(["init"], env());
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

test("covo routines: add, list, show, pause, resume, remove, and the settings", async () => {
  expect((await main(["routines"], env(), ctx)).out).toContain("No routines yet");
  const add = await main(
    [
      "routines",
      "add",
      "Morning brief",
      "--bot",
      "Assistant",
      "--every",
      "weekdays 8:30",
      "--limit",
      "0.10",
      "--quiet",
      "Summarise",
      "yesterday",
    ],
    env(),
    ctx,
  );
  expect(add.code).toBe(0);
  expect(add.out).toContain('Added "Morning brief": Assistant, weekdays at 08:30. First run tomorrow 08:30.');
  expect(add.out).toContain("isn't running");
  expect((await main(["routines"], env(), ctx)).out).toContain(
    "Morning brief  ·  Assistant  ·  Weekdays at 08:30  ·  next tomorrow 08:30",
  );
  const show = (await main(["routines", "show", "morning brief"], env(), ctx)).out;
  expect(show).toContain("Task:     Summarise yesterday");
  expect(show).toContain("$0.10 per run");
  expect(show).toContain("only if something needs you");
  expect((await main(["routines", "pause", "Morning brief"], env(), ctx)).out).toContain("Paused");
  expect((await main(["routines", "resume", "Morning brief"], env(), ctx)).out).toContain("on again");
  expect(
    (await main(["routines", "add", "Bad", "--bot", "Assistant", "--every", "now and then", "x"], env(), ctx)).out,
  ).toContain("Try");
  expect((await main(["routines", "missed", "skip"], env(), ctx)).out).toContain("skipped");
  expect((await main(["routines", "quiet", "22:00-7:00"], env(), ctx)).out).toContain("Quiet hours 22:00–07:00");
  expect((await main(["routines", "subscriptions", "on"], env(), ctx)).out).toContain("Check your provider's terms");
  expect((await main(["routines", "run", "Morning brief"], env(), ctx)).out).toContain("service isn't running");
  expect((await main(["routines", "remove", "Morning brief"], env(), ctx)).out).toContain("Removed");
  expect((await main(["audit", "verify"], env())).code).toBe(0);
});

test("covo summary: when, off, now", async () => {
  expect((await main(["summary"], env(), ctx)).out).toContain("made at 18:00");
  expect((await main(["summary", "at", "7:30"], env(), ctx)).out).toContain("now made at 07:30");
  expect((await main(["summary", "at", "7pm"], env(), ctx)).out).toContain("isn't a time");
  expect((await main(["summary", "now"], env(), ctx)).out).toContain("Nothing to tell yet");
  expect((await main(["summary", "off"], env(), ctx)).out).toContain("No more daily summaries");
});
