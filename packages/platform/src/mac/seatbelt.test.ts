import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { buildProfile, macSandbox } from "./seatbelt.ts";

let root: string;
let ws: string;
let tmp: string;
const opts = (extra = {}) => ({ workspace: ws, tmp, timeoutMs: 10_000, ...extra });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "covo-sb-"));
  ws = join(root, "ws");
  tmp = join(root, "tmp");
  mkdirSync(ws);
  mkdirSync(tmp);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("buildProfile", () => {
  test("denies by default and escapes paths", () => {
    const p = buildProfile({ workspace: '/a "quoted" \\path', tmp: "/t" });
    expect(p).toContain("(deny default)");
    expect(p).toContain("(deny network*)");
    expect(p).toContain('(subpath "/a \\"quoted\\" \\\\path")');
  });
});

describe("macSandbox.exec", () => {
  test("runs in the workspace with a scrubbed environment", async () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: ${…} here is shell syntax, expanded by /bin/sh
    const r = await macSandbox.exec(["/bin/sh", "-c", 'pwd; echo "$HOME"; echo "${SECRET_TOKEN:-unset}"'], opts());
    const [cwd, home, secret] = r.stdout.trim().split("\n");
    expect(r.code).toBe(0);
    expect(cwd?.endsWith("/ws")).toBe(true);
    expect(home?.endsWith("/ws")).toBe(true);
    expect(secret).toBe("unset");
  });

  test("can write inside the workspace", async () => {
    const r = await macSandbox.exec(["/bin/sh", "-c", "echo hi > out.txt"], opts());
    expect(r.code).toBe(0);
    expect(readFileSync(join(ws, "out.txt"), "utf8")).toBe("hi\n");
  });

  test("can't read the home folder or write outside the workspace", async () => {
    const read = await macSandbox.exec(["/bin/ls", homedir()], opts());
    expect(read.code).not.toBe(0);
    expect(read.stderr).toContain("Operation not permitted");
    const outside = join(root, "outside.txt");
    await macSandbox.exec(["/usr/bin/touch", outside], opts());
    expect(existsSync(outside)).toBe(false);
  });

  test("read-only folders are readable but not writable", async () => {
    const ro = join(root, "toolchain");
    mkdirSync(ro);
    writeFileSync(join(ro, "tool.txt"), "v1");
    const r = await macSandbox.exec(
      ["/bin/sh", "-c", `cat ${ro}/tool.txt; echo x > ${ro}/tool.txt`],
      opts({ readOnly: [ro] }),
    );
    expect(r.stdout).toBe("v1");
    expect(readFileSync(join(ro, "tool.txt"), "utf8")).toBe("v1");
  });

  test("kills commands that run too long", async () => {
    const r = await macSandbox.exec(["/bin/sleep", "10"], opts({ timeoutMs: 300 }));
    expect(r.timedOut).toBe(true);
    expect(r.code).not.toBe(0);
  });

  test("has no network", async () => {
    const r = await macSandbox.exec(["/usr/bin/curl", "-sS", "-m", "5", "https://example.com"], opts());
    expect(r.code).not.toBe(0);
  });
});
