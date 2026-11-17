import { expect, test } from "bun:test";
import { VERSION } from "@covo/core";
import { main } from "./main.ts";

test("--version prints the version", async () => {
  expect(await main(["--version"])).toEqual({ code: 0, out: `${VERSION}\n` });
});

test("no arguments prints help", async () => {
  const r = await main([]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("audit verify");
});

test("unknown command exits with code 2", async () => {
  expect((await main(["fly"])).code).toBe(2);
});

test("the covo binary runs", async () => {
  const p = Bun.spawn([process.execPath, `${import.meta.dir}/index.ts`, "--version"], { stdout: "pipe" });
  expect((await new Response(p.stdout).text()).trim()).toBe(VERSION);
  expect(await p.exited).toBe(0);
});
