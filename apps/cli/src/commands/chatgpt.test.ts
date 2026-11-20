import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browse, fakeClock, fakeOpenAI } from "@covo/models/fake-openai";
import { memorySecrets } from "@covo/platform";
import { main } from "../main.ts";

// Phase 4 M1: covo models add chatgpt (Sign in with ChatGPT), against a stand-in for OpenAI.

let home: string;
let fake: Awaited<ReturnType<typeof fakeOpenAI>>;
const secrets = memorySecrets();

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "covo-gptcli-"));
  fakeClock(Date.now);
  fake = await fakeOpenAI();
  await main(["init"], env());
});
afterEach(() => {
  fake.stop();
  rmSync(home, { recursive: true, force: true });
});
const env = () => ({
  COVO_HOME: home,
  COVO_SERVICE: "off",
  COVO_CHATGPT_AUTH: fake.base,
  COVO_CHATGPT_API: fake.api,
});

test("covo models add chatgpt: sign in in your browser, saved with the welcome once; remove signs out", async () => {
  let printed = "";
  const r = await main(["models", "add", "chatgpt"], env(), {
    secrets,
    print: (s: string) => {
      printed += s;
    },
    // Your browser opens OpenAI's page; you sign in and get sent back.
    openUrl: (u: string) => {
      void browse(u);
      return true;
    },
  });
  expect(printed).toContain("You sign in on OpenAI's own page");
  expect(printed).toContain("never uses the Codex program's sign-in");
  expect(r.code).toBe(0);
  expect(r.out).toContain('Connected as me@example.com. Bots can use "chatgpt" (gpt-6.1-sol) on your ChatGPT plan.');
  expect(r.out).toContain("You're using your ChatGPT plan");

  const list = await main(["models"], env(), {
    secrets,
    detect: async () => ({ ollama: null, envKeys: [], clis: [] }),
  });
  expect(list.out).toContain("ChatGPT (Sign in with ChatGPT)");
  expect(list.out).toContain("your ChatGPT plan");

  const rm = await main(["models", "remove", "chatgpt"], env(), { secrets });
  expect(rm.out).toContain('Signed out of ChatGPT and removed "chatgpt".');
  expect(fake.s.revoked).toEqual(["rt1"]);
  expect(secrets.items.size).toBe(0);
});
