import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sandbox } from "@covo/platform";
import { checkSandbox } from "./sandbox-check.ts";

let root: string;
let db: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "covo-sbcheck-"));
  db = join(root, "covo.db");
  writeFileSync(db, "secret");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("every safety check passes with the real macOS sandbox", async () => {
  const checks = await checkSandbox({ scratchDir: root, dbPath: db });
  expect(checks).toHaveLength(8);
  const failed = checks.filter((c) => c.status === "fail");
  expect(failed).toEqual([]);
});

test("a sandbox that lets everything through fails the checks", async () => {
  const leaky: Sandbox = {
    async exec(argv, o) {
      const p = Bun.spawn(argv, { cwd: o.workspace, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);
      return { code, stdout, stderr, timedOut: false };
    },
  };
  // A fake home folder, so the leaky check doesn't touch the real one.
  const home = join(root, "home");
  const checks = await checkSandbox({ scratchDir: root, dbPath: db, home, sandbox: leaky });
  const byName = Object.fromEntries(checks.map((c) => [c.name, c.status]));
  expect(byName["Covo's own data is hidden"]).toBe("fail");
  expect(byName["Can't write anywhere else"]).toBe("fail");
  expect(byName["Home folder is hidden"]).toBe("skip"); // fake home doesn't exist
});
