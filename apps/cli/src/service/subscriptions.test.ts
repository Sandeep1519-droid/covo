import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiModel, ApiSubscriptions } from "@covo/api";
import { covoPaths } from "@covo/core";
import { openDb } from "@covo/db";
import { browse, fakeClock, fakeOpenAI } from "@covo/models/fake-openai";
import { memorySecrets, type SystemInfo } from "@covo/platform";
import { type Ctx, main } from "../main.ts";
import { apiToken } from "./gate.ts";
import { type Running, serve } from "./server.ts";

// Phase 4 M1: your own AI plans, from the app. ChatGPT through Sign in with ChatGPT (against a
// stand-in for OpenAI), and Claude through the Claude Code program (with a stand-in for its answers).

let root: string;
let home: string;
let running: Running | undefined;
let base: string;
let token: string;
let fake: Awaited<ReturnType<typeof fakeOpenAI>> | undefined;
const secrets = memorySecrets();
const env = (extra: Record<string, string> = {}) => ({ COVO_HOME: home, HOME: root, COVO_PORT: "0", ...extra });
const mac8 = (): SystemInfo => ({
  memoryGB: 8,
  chip: "Apple M3",
  performanceCores: 4,
  cores: 8,
  memoryPressure: "normal",
  power: { source: "ac", percent: 100 },
  thermal: "normal",
});

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "covo-subs-")));
  home = join(root, "Covo");
  await main(["init"], env());
  writeFileSync(join(home, "workspaces/default/README.md"), "# Demo\n");
  for (const k of [...secrets.items.keys()]) secrets.items.delete(k);
  fakeClock(Date.now);
});
afterEach(async () => {
  await running?.close();
  running = undefined;
  fake?.stop();
  fake = undefined;
  rmSync(root, { recursive: true, force: true });
});

async function start(extra: Partial<Ctx> = {}, envExtra: Record<string, string> = {}) {
  const ctx: Ctx = { home, now: Date.now, env: env(envExtra), print: () => {}, system: mac8, secrets, ...extra };
  running = await serve(ctx);
  base = `http://127.0.0.1:${running.port}`;
  token = apiToken(home);
}
const api = (path: string, init: RequestInit = {}) =>
  fetch(`${base}/api${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
  });
const status = async () => (await (await api("/subscriptions")).json()) as ApiSubscriptions;
async function until<T>(get: () => Promise<T | false | undefined> | T | false | undefined, what: string): Promise<T> {
  for (let i = 0; i < 250; i++) {
    const v = await get();
    if (v) return v;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for ${what}`);
}
const db = () => openDb(covoPaths(home).db);
const runs = () => {
  const d = db();
  const r = d
    .query<{ id: string; state: string; cost: number }, []>("SELECT id, state, cost_usd AS cost FROM runs")
    .all();
  d.close();
  return r;
};
const actions = () => {
  const d = db();
  const a = d.query<{ a: string }, []>("SELECT action AS a FROM audit_log").all();
  d.close();
  return a.map((x) => x.a);
};

describe("your ChatGPT plan, from the app", () => {
  test("Continue with ChatGPT → you sign in → a task with a tool call runs on your plan → Sign out revokes it", async () => {
    fake = await fakeOpenAI();
    await start({}, { COVO_CHATGPT_AUTH: fake.base, COVO_CHATGPT_API: fake.api });
    const started = await api("/subscriptions/chatgpt", { method: "POST", body: "{}" });
    expect(started.status).toBe(200);
    const { url } = (await started.json()) as { url: string };
    expect((await status()).chatgpt.signingIn).toBe(true);

    // In your browser: OpenAI's page, then back to Covo's one-time page.
    expect(await browse(url)).toContain("You're signed in");
    const s = await until(async () => {
      const x = await status();
      return x.chatgpt.connected && x;
    }, "the sign-in to finish");
    expect(s.chatgpt).toMatchObject({
      connected: true,
      email: "me@example.com",
      connection: "chatgpt",
      model: "gpt-6.1-sol",
      models: [{ slug: "gpt-6.1-sol", name: "GPT-6.1 Sol" }],
      welcomed: false,
      signingIn: false,
      error: null,
      manageUsageUrl: "https://chatgpt.com/settings/usage",
    });
    const models = (await (await api("/models")).json()) as ApiModel[];
    expect(models).toEqual([expect.objectContaining({ name: "chatgpt", subscription: "chatgpt", isDefault: true })]);
    // The app shows the one-time welcome, then says it did.
    const after = (await (
      await api("/subscriptions/chatgpt/welcomed", { method: "POST", body: "{}" })
    ).json()) as ApiSubscriptions;
    expect(after.chatgpt.welcomed).toBe(true);

    // A task on your plan: the model asks for write_file, then finishes.
    expect((await api("/runs", { method: "POST", body: JSON.stringify({ goal: "write the plan" }) })).status).toBe(202);
    const run = await until(() => runs().find((r) => ["SUCCEEDED", "KEPT", "FAILED"].includes(r.state)), "the task");
    expect(run.state).toBe("KEPT");
    expect(run.cost).toBe(0); // your plan is a flat fee: nothing counts against Covo's limits
    expect(readFileSync(join(home, "workspaces/default/PLAN.md"), "utf8")).toContain("ChatGPT plan");
    const sent = fake.s.responses;
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(sent.every((x) => x.auth === "Bearer at1" && x.body.store === false && x.body.stream === true)).toBe(true);
    expect(sent.some((x) => "temperature" in x.body || "max_output_tokens" in x.body)).toBe(false);

    // Tokens never come back out, and aren't in Covo's files.
    expect(JSON.stringify(s)).not.toMatch(/\bat1\b|\brt1\b/);
    expect(readFileSync(join(home, "config.json"), "utf8")).not.toMatch(/\bat1\b|\brt1\b/);
    expect(readFileSync(join(home, "state/chatgpt.json"), "utf8")).not.toMatch(/\bat1\b|\brt1\b/);

    // Sign out: OpenAI revokes it, and the model is gone.
    const out = (await (await api("/subscriptions/chatgpt", { method: "DELETE" })).json()) as ApiSubscriptions;
    expect(out.chatgpt).toMatchObject({ connected: false, connection: null });
    expect(fake.s.revoked).toEqual(["rt1"]);
    expect(await (await api("/models")).json()).toEqual([]);
    expect(actions()).toEqual(expect.arrayContaining(["subscription.connected", "subscription.removed"]));
  });

  test("a sign-in without permission to use the plan saves nothing, and says why", async () => {
    fake = await fakeOpenAI({ scope: "openid profile email offline_access" });
    await start({}, { COVO_CHATGPT_AUTH: fake.base, COVO_CHATGPT_API: fake.api });
    const { url } = (await (await api("/subscriptions/chatgpt", { method: "POST", body: "{}" })).json()) as {
      url: string;
    };
    await browse(url);
    const s = await until(async () => {
      const x = await status();
      return !x.chatgpt.signingIn && x;
    }, "the sign-in to end");
    expect(s.chatgpt.connected).toBe(false);
    expect(s.chatgpt.error).toContain("needs an active ChatGPT Plus or Pro plan");
    expect(secrets.items.size).toBe(0);
    expect(await (await api("/models")).json()).toEqual([]);
  });
});

describe("your Claude plan, through Claude Code", () => {
  test("not installed: how to install; signed in with your account: connect once you agree; an API key: refused", async () => {
    let path: string | null = null;
    let signIn: { signedIn: boolean | null; method: string | null } = { signedIn: false, method: "none" };
    await start({
      which: (c: string) => (c === "claude" ? path : null),
      engineSignIn: async () => signIn,
    });
    let s = await status();
    expect(s.claudeCode).toMatchObject({
      path: null,
      install: "curl -fsSL https://claude.ai/install.sh | bash",
      signIn: "claude auth login",
      connected: false,
    });

    path = "/Users/me/.local/bin/claude";
    s = (await (
      await api("/subscriptions/claude-code/check", { method: "POST", body: "{}" })
    ).json()) as ApiSubscriptions;
    expect(s.claudeCode).toMatchObject({ path, signedIn: false });

    // Signed in with an API key: tasks would bill that key, not your plan.
    signIn = { signedIn: true, method: "api_key" };
    const refused = await api("/subscriptions/claude-code", { method: "POST", body: JSON.stringify({ accept: true }) });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toContain("API key");

    signIn = { signedIn: true, method: "claude.ai" };
    expect((await api("/subscriptions/claude-code", { method: "POST", body: "{}" })).status).toBe(400); // agree first
    s = (await (
      await api("/subscriptions/claude-code", { method: "POST", body: JSON.stringify({ accept: true }) })
    ).json()) as ApiSubscriptions;
    expect(s.claudeCode).toMatchObject({
      connected: true,
      connection: "claude-sub",
      signedIn: true,
      method: "claude.ai",
    });
    expect(await (await api("/models")).json()).toEqual([
      expect.objectContaining({ name: "claude-sub", subscription: "claude-code", engine: true }),
    ]);
    s = (await (await api("/subscriptions/claude-code", { method: "DELETE" })).json()) as ApiSubscriptions;
    expect(s.claudeCode.connected).toBe(false);
  });
});
