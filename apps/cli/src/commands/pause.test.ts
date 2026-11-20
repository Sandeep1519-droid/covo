import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../main.ts";

let home: string;
const env = () => ({ COVO_HOME: home, COVO_SERVICE: "off" });

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "covo-pause-"));
  await main(["init"], env());
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

test("covo pause stops new tasks, even in the terminal; covo resume lets them run", async () => {
  expect((await main(["pause"], env())).out).toContain("All bots are paused");
  expect((await main(["pause"], env())).out).toContain("already paused");
  const run = await main(["run", "--here", "anything"], env());
  expect(run.code).toBe(1);
  expect(run.out).toContain("covo resume");
  expect((await main(["status"], env())).out).toContain("All bots are paused");
  expect((await main(["resume"], env())).out).toContain("start tasks again");
  expect((await main(["status"], env())).out).not.toContain("paused");
  const log = await main(["audit", "verify"], env());
  expect(log.code).toBe(0);
});
