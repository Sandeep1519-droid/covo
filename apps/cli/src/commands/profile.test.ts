import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatRequest, ModelProvider } from "@covo/models";
import { memorySecrets, type SystemInfo } from "@covo/platform";
import { main } from "../main.ts";

let home: string;
let printed = "";
const env = () => ({ COVO_HOME: home });
const mac =
  (gb: number, over: Partial<SystemInfo> = {}) =>
  (): SystemInfo => ({
    memoryGB: gb,
    chip: "Apple M3 Max",
    performanceCores: 12,
    cores: 16,
    memoryPressure: "normal",
    power: { source: "ac", percent: 100 },
    thermal: "normal",
    ...over,
  });
const ollamaModels = async () => [
  { name: "qwen3.5:4b" },
  { name: "qwen3:4b", parameterSize: "4.0B" },
  { name: "big:32b", parameterSize: "32B" },
];

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "covo-profcli-"));
  printed = "";
  await main(["init"], env());
  writeFileSync(join(home, "workspaces/default/README.md"), "# P\n");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

test("covo profile describes the Mac and what it can run", async () => {
  const r = await main(["profile"], env(), { system: mac(48), ollamaModels });
  expect(r.out).toContain("Mac        Apple M3 Max, 48 GB memory, 12 performance cores of 16");
  expect(r.out).toContain("Profile    48 GB (detected)");
  expect(r.out).toContain("Tasks      4 at a time");
  expect(r.out).toContain("Best fit   big:32b (32B)");
  // a 32 GB Mac tops out around 30B, so the same model is too big there
  expect((await main(["profile"], env(), { system: mac(36), ollamaModels })).out).toContain("Too big    big:32b");
  const small = await main(["profile"], env(), { system: mac(8), ollamaModels });
  expect(small.out).toContain("Too big    big:32b (32B)");
  expect(small.out).toContain("Best fit   qwen3.5:4b (4B)");
});

test("choose a profile, or go back to detecting it", async () => {
  const set = await main(["profile", "set", "16gb"], env(), { system: mac(8), ollamaModels });
  expect(set.out).toContain("Profile    16 GB (chosen by you)");
  expect(set.out).toContain("Tasks      2 at a time");
  const auto = await main(["profile", "set", "auto"], env(), { system: mac(8), ollamaModels });
  expect(auto.out).toContain("Profile    8 GB (detected)");
  expect((await main(["profile", "set", "huge"], env())).code).toBe(2);
});

test("covo run uses the profile's context size and won't start when memory is critical", async () => {
  const seen: ChatRequest[] = [];
  const provider: ModelProvider = {
    id: "mock:x",
    async *chat(req) {
      seen.push(req);
      yield { type: "tool_call", call: { id: "f", name: "finish", arguments: "{}" }, args: { summary: "ok" } };
      yield { type: "done", stop: "tool" };
    },
  };
  const blocked = await main(["run", "x"], env(), {
    print: (s) => {
      printed += s;
    },
    provider,
    secrets: memorySecrets(),
    system: mac(8, { memoryPressure: "critical" }),
  });
  expect(blocked.code).toBe(1);
  expect(blocked.out).toContain("Not starting: macOS reports memory is critically low");
  expect(seen).toHaveLength(0);

  const slow = await main(["run", "x"], env(), {
    print: (s) => {
      printed += s;
    },
    provider,
    secrets: memorySecrets(),
    system: mac(32, { thermal: "warm" }),
  });
  expect(slow.code).toBe(0);
  expect(printed).toContain("Note: The Mac is running hot");
});

test("covo doctor shows the Mac first", async () => {
  const r = await main(["doctor", "mac"], env(), { system: mac(8), ollamaModels });
  expect(r.out).toContain("This Mac (8 GB profile)");
  expect(r.out).toContain("All checks passed.");
});
