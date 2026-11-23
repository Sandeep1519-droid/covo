import { expect, test } from "bun:test";
import { main } from "../main.ts";

// covo demo: Covo in a minute for anyone, with no account, in a throwaway folder.

test("covo demo: a kept task, Undo, a planted attack stopped, a spending pause, a verified log", async () => {
  let out = "";
  const r = await main(
    ["demo"],
    { HOME: process.env.HOME, PATH: process.env.PATH },
    {
      print: (s: string) => {
        out += s;
      },
    },
  );
  expect(r.code).toBe(0);
  expect(out).toContain("Working with the demo's stand-in model");
  expect(out).toContain("added    README.md");
  expect(out).toContain("README.md is gone again");
  // Every attack step is stopped, by the path check or the sandbox.
  expect(out.match(/⛔/g)?.length).toBe(4);
  expect(out).toContain("cat …/you/.ssh/id_ed25519");
  expect(out).toContain("Result: 4 attempts stopped");
  expect(out).toContain("still $1 a task");
  expect(out).not.toContain("DEMO-KEY");
  // The pause asks, and the demo answers.
  expect(out).toContain("Let it continue? (y/N) y");
  expect(out).toContain("added    RELEASE-NOTES.md");
  expect(out).toMatch(/Log verified: \d+ entries, no gaps or changes/);
});

test("covo demo files: adds the sample files to your workspace, never over yours", async () => {
  const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "covo-demofiles-"));
  const env = { COVO_HOME: join(root, "Covo") };
  try {
    await main(["init"], env);
    const ws = join(root, "Covo", "workspaces", "default");
    writeFileSync(join(ws, "notes.md"), "mine\n");
    const r = await main(["demo", "files"], env);
    expect(r.out).toContain("Added to your workspace: inbox/vendor-email.txt");
    expect(readFileSync(join(ws, "notes.md"), "utf8")).toBe("mine\n");
    expect(readFileSync(join(ws, "inbox", "vendor-email.txt"), "utf8")).toContain("Invoice #4821");
    expect((await main(["demo", "files"], env)).out).toContain("already has the demo files");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
