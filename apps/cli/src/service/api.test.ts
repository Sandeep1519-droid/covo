import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiBot, ApiChanges, ApiChatMessage, ApiModel, ApiRun, ApiRunDetail } from "@covo/api";
import { covoPaths } from "@covo/core";
import { openDb } from "@covo/db";
import { MockProvider } from "@covo/models";
import { memorySecrets, type SystemInfo } from "@covo/platform";
import { type Ctx, main } from "../main.ts";
import { socketPath } from "./client.ts";
import { apiToken, tokenPath } from "./gate.ts";
import { type Running, serve } from "./server.ts";

// Phase 3 M1: the local API, and who may use it.

let root: string;
let provider: MockProvider;
let home: string;
let running: Running;
let base: string;
let token: string;
const secrets = memorySecrets();
let uiDir: string;
const env = () => ({ COVO_HOME: home, HOME: root, COVO_PORT: "0", COVO_UI_DIR: uiDir });
const mac8: () => SystemInfo = () => ({
  memoryGB: 8,
  chip: "Apple M3",
  performanceCores: 4,
  cores: 8,
  memoryPressure: "normal",
  power: { source: "ac", percent: 100 },
  thermal: "normal",
});

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "covo-api-")));
  home = join(root, "Covo");
  uiDir = join(root, "ui");
  mkdirSync(uiDir);
  writeFileSync(join(uiDir, "index.html"), "<!doctype html><title>Covo</title>");
  writeFileSync(join(uiDir, "chunk-abcd1234.js"), "console.log(1)");
  writeFileSync(join(root, "secret.txt"), "not for the web");
  await main(["init"], env());
  writeFileSync(join(home, "workspaces/default/README.md"), "# Demo\n");
  provider = new MockProvider([
    MockProvider.tool("write_file", { path: "NOTES.md", content: "hi\n" }),
    MockProvider.tool("finish", { summary: "Wrote notes" }),
    MockProvider.tool("finish", { summary: "Nothing else to do" }),
  ]);
  const ctx: Ctx = {
    home,
    now: Date.now,
    env: env(),
    print: () => {},
    system: mac8,
    secrets,
    provider,
    listModels: async () => ["claude-opus-5-5"],
  };
  running = await serve(ctx);
  base = `http://127.0.0.1:${running.port}`;
  token = apiToken(home);
});
afterEach(async () => {
  await running.close();
  rmSync(root, { recursive: true, force: true });
});

const auth = () => ({ authorization: `Bearer ${token}` });
const api = (path: string, init: RequestInit = {}) =>
  fetch(`${base}/api${path}`, { ...init, headers: { ...auth(), "content-type": "application/json", ...init.headers } });

/** Sends a request byte for byte, so tests can forge headers browsers and fetch won't. */
function raw(lines: string[]): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    void Bun.connect({
      hostname: "127.0.0.1",
      port: running.port as number,
      socket: {
        open(s) {
          s.write(`${[...lines, "Connection: close", "", ""].join("\r\n")}`);
        },
        data(_s, d) {
          out += d.toString();
        },
        close() {
          resolve(out.split("\r\n")[0] ?? "");
        },
        error() {
          resolve(out.split("\r\n")[0] ?? "");
        },
      },
    });
  });
}

async function pairCode(): Promise<string> {
  const r = await fetch("http://covod/pair-code", { unix: socketPath(home), method: "POST" });
  return ((await r.json()) as { code: string }).code;
}

describe("who may use the API", () => {
  test("the token file is private; no token or a wrong one is refused", async () => {
    expect(statSync(tokenPath(home)).mode & 0o777).toBe(0o600);
    expect((await fetch(`${base}/api/bots`)).status).toBe(401);
    expect((await fetch(`${base}/api/bots`, { headers: { authorization: "Bearer nope" } })).status).toBe(401);
    expect((await api("/bots")).status).toBe(200);
  });

  test("another website can't use it, even with a valid token (DNS rebinding, cross-site)", async () => {
    const port = running.port as number;
    expect(
      await raw([`GET /api/bots HTTP/1.1`, `Host: evil.example:${port}`, `Authorization: Bearer ${token}`]),
    ).toContain("403");
    expect(
      await raw([`GET /api/bots HTTP/1.1`, `Host: 127.0.0.1:${port}`, `Authorization: Bearer ${token}`]),
    ).toContain("200");
    const r = await api("/bots", { headers: { origin: "https://evil.example" } });
    expect(r.status).toBe(403);
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("pairing gives the app a session; a code works once", async () => {
    const code = await pairCode();
    const pair = (c: string, origin = base) =>
      fetch(`${base}/api/pair`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ code: c }),
      });
    const ok = await pair(code);
    expect(ok.status).toBe(200);
    const cookie = (ok.headers.get("set-cookie") ?? "").split(";")[0] as string;
    expect(ok.headers.get("set-cookie")).toContain("HttpOnly");
    expect(ok.headers.get("set-cookie")).toContain("SameSite=Strict");
    expect((await pair(code)).status).toBe(401); // used
    expect((await pair("guess")).status).toBe(401);

    const asApp = (path: string, init: RequestInit = {}) =>
      fetch(`${base}/api${path}`, {
        ...init,
        headers: { cookie, "content-type": "application/json", ...init.headers },
      });
    expect((await asApp("/bots")).status).toBe(200);
    // Changes signed only by the cookie must come from Covo's own page.
    const create = { method: "POST", body: JSON.stringify({ name: "Helper" }) };
    expect((await asApp("/bots", create)).status).toBe(403);
    expect((await asApp("/bots", { ...create, headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await asApp("/bots", { ...create, headers: { origin: base } })).status).toBe(201);
  });

  test("bodies must be JSON (so no plain web form can post here)", async () => {
    const r = await fetch(`${base}/api/bots`, {
      method: "POST",
      headers: { ...auth(), "content-type": "text/plain" },
      body: '{"name":"x"}',
    });
    expect(r.status).toBe(415);
  });

  test("covo app opens a one-time sign-in link", async () => {
    let opened = "";
    const r = await main(["app"], env(), {
      openUrl: (u) => {
        opened = u;
        return true;
      },
    });
    expect(r.code).toBe(0);
    expect(opened).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${running.port}/ui/#code=[\\w-]{20,}$`));
    const page = await fetch(`${base}/ui/`);
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });
});

describe("the app at /ui", () => {
  test("serves the built app with a strict policy; screens get the app, missing files a 404", async () => {
    const page = await fetch(`${base}/ui/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<title>Covo</title>");
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(page.headers.get("cache-control")).toBe("no-store");
    const js = await fetch(`${base}/ui/chunk-abcd1234.js`);
    expect(js.headers.get("cache-control")).toContain("immutable");
    expect(js.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await (await fetch(`${base}/ui/settings`)).text()).toContain("<title>Covo</title>");
    expect((await fetch(`${base}/ui/nope.js`)).status).toBe(404);
    expect((await fetch(`${base}/`, { redirect: "manual" })).headers.get("location")).toBe("/ui/");
  });

  test("nothing outside the app's folder can be read", async () => {
    const port = running.port as number;
    for (const p of ["/ui/../secret.txt", "/ui/%2e%2e/secret.txt", "/ui/..%2fsecret.txt", "/ui/%2e%2e%2fsecret.txt"]) {
      const line = await raw([`GET ${p} HTTP/1.1`, `Host: 127.0.0.1:${port}`]);
      expect(line).not.toContain("200 OK");
    }
    const r = await fetch(`${base}/ui/..%2fsecret.txt`);
    expect(await r.text()).not.toContain("not for the web");
  });

  test("before the app is built, the page says how to build it", async () => {
    rmSync(join(uiDir, "index.html"));
    const page = await fetch(`${base}/ui/`);
    expect(await page.text()).toContain("bun run app:build");
  });
});

/** Waits until the service reports `n` finished jobs. */
async function finished(n: number, start: () => Promise<unknown>): Promise<void> {
  const events = await fetch(`${base}/api/events`, { headers: auth() });
  const reader = (events.body as ReadableStream<Uint8Array>).getReader();
  await start();
  let seen = "";
  while ((seen.match(/"type":"(done|error)"/g) ?? []).length < n) {
    const c = await reader.read();
    if (c.done) break;
    seen += new TextDecoder().decode(c.value);
  }
  await reader.cancel();
}

describe("chat (M3)", () => {
  test("a message starts a task; the next one carries the chat so far as context", async () => {
    const say = (text: string) =>
      api("/bots/bot_assistant/messages", { method: "POST", body: JSON.stringify({ text }) });
    await finished(1, async () => expect((await say("write NOTES.md")).status).toBe(201));
    await finished(1, async () => expect((await say("anything else?")).status).toBe(201));

    const msgs = (await (await api("/bots/bot_assistant/messages")).json()) as ApiChatMessage[];
    expect(msgs.map((m) => m.text)).toEqual(["write NOTES.md", "anything else?"]);
    expect(msgs.every((m) => m.runId !== null && m.error === null)).toBe(true);
    const runs = (await (await api("/runs")).json()) as ApiRun[];
    expect(runs[0]).toMatchObject({ goal: "anything else?", trigger: "api" });

    const last = provider.requests.at(-1);
    const task = JSON.stringify(last?.messages);
    expect(task).toContain("Earlier in this chat");
    expect(task).toContain("You: write NOTES.md");
    expect(task).toContain("Assistant: Wrote notes");
    expect(task).toContain("Task: anything else?");

    // What the first task changed, with a diff, for the file-changes card.
    const changes = (await (await api(`/runs/${msgs[0]?.runId}/changes`)).json()) as ApiChanges;
    expect(changes.files).toEqual([expect.objectContaining({ path: "NOTES.md", kind: "added" })]);
    expect(changes.files[0]?.hunks?.[0]?.lines).toContain("+hi");
  });

  test("messages need a real bot and some text", async () => {
    expect((await api("/bots/nobody/messages")).status).toBe(409);
    expect((await api("/bots/bot_assistant/messages", { method: "POST", body: "{}" })).status).toBe(400);
  });

  test("bots get the avatar you pick, and only real ones", async () => {
    const ok = await api("/bots", {
      method: "POST",
      body: JSON.stringify({ name: "Pal", shape: "Gem", color: "rose" }),
    });
    expect(await ok.json()).toMatchObject({ shape: "Gem", color: "rose" });
    const bad = await api("/bots", { method: "POST", body: JSON.stringify({ name: "Pal2", shape: "Star" }) });
    expect(bad.status).toBe(409);
    const providers = (await (await api("/providers")).json()) as { id: string; needsKey: boolean }[];
    expect(providers).toContainEqual(expect.objectContaining({ id: "ollama", needsKey: false }));
  });
});

describe("what the API does", () => {
  test("me: your name for the sidebar", async () => {
    const me = (await (await api("/me")).json()) as { name: string };
    expect(me.name.length).toBeGreaterThan(0);
  });

  test("bots: create, change, list, archive", async () => {
    const made = (await (
      await api("/bots", { method: "POST", body: JSON.stringify({ name: "Docs helper", level: "supervised" }) })
    ).json()) as ApiBot;
    expect(made).toMatchObject({ name: "Docs helper", level: "supervised" });
    const changed = (await (
      await api(`/bots/${made.id}`, { method: "PATCH", body: JSON.stringify({ taskLimitUsd: 0.5 }) })
    ).json()) as ApiBot;
    expect(changed.taskLimitUsd).toBe(0.5);
    const list = (await (await api("/bots")).json()) as ApiBot[];
    expect(list.map((b) => b.name)).toContain("Docs helper");
    expect((await api(`/bots/${made.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await api("/bots", { method: "POST", body: JSON.stringify({ name: "" }) })).status).toBe(409);
  });

  test("models: a key goes to the Keychain and never comes back out", async () => {
    const r = await api("/models", {
      method: "POST",
      body: JSON.stringify({ provider: "anthropic", model: "claude-opus-5-5", key: "sk-ant-secret-123" }),
    });
    expect(r.status).toBe(201);
    const text = await r.text();
    expect(text).not.toContain("sk-ant-secret-123");
    expect(JSON.parse(text)).toMatchObject({ name: "claude", hasKey: true, isDefault: true });
    const list = await (await api("/models")).text();
    expect(list).not.toContain("sk-ant-secret-123");
    expect(readFileSync(join(home, "config.json"), "utf8")).not.toContain("sk-ant-secret-123");
    expect([...secrets.items.values()]).toContain("sk-ant-secret-123");
    expect(
      (await api("/models", { method: "POST", body: JSON.stringify({ provider: "anthropic", model: "x" }) })).status,
    ).toBe(400);
    const left = (await (await api("/models/claude", { method: "DELETE" })).json()) as ApiModel[];
    expect(left).toEqual([]);
  });

  test("runs: start, follow live events, inspect, undo", async () => {
    const events = await fetch(`${base}/api/events`, { headers: auth() });
    const reader = (events.body as ReadableStream<Uint8Array>).getReader();
    const start = await api("/runs", { method: "POST", body: JSON.stringify({ goal: "write NOTES.md" }) });
    expect(start.status).toBe(202);
    let seen = "";
    while (!seen.includes('"type":"done"')) {
      const c = await reader.read();
      if (c.done) break;
      seen += new TextDecoder().decode(c.value);
    }
    await reader.cancel();
    expect(seen).toContain('"state":"RUNNING"');

    const runs = (await (await api("/runs")).json()) as ApiRun[];
    expect(runs[0]).toMatchObject({ goal: "write NOTES.md", state: "KEPT", trigger: "api" });
    const id = (runs[0] as ApiRun).id;
    const detail = (await (await api(`/runs/${id.slice(-6)}`)).json()) as ApiRunDetail;
    expect(detail.steps.some((s) => s.tool === "write_file")).toBe(true);
    expect((await api(`/runs/${id}/undo`, { method: "POST", body: "{}" })).status).toBe(200);
    expect((await api(`/runs/${id}/undo`, { method: "POST", body: "{}" })).status).toBe(409);
    expect((await api("/runs/nope")).status).toBe(404);
  });

  test("approvals: an answer applies only to the exact request shown", async () => {
    const db = openDb(covoPaths(home).db);
    db.query(
      `INSERT INTO runs (id, agent_id, department_id, trigger, goal, state, created_at, pid)
       VALUES ('run_wait', 'bot_assistant', 'dept_default', 'cli', 'x', 'AWAITING_APPROVAL', 1, ?)`,
    ).run(process.pid);
    db.query(
      `INSERT INTO approvals (id, run_id, kind, summary, payload_json, payload_hash, expires_at)
       VALUES ('apr_1', 'run_wait', 'spend', 'Spend $0.05 more?', '{}', 'hash-of-request', ?)`,
    ).run(Date.now() + 60_000);
    db.close();
    const pending = (await (await api("/approvals")).json()) as { id: string; payloadHash: string }[];
    expect(pending).toEqual([expect.objectContaining({ id: "apr_1", payloadHash: "hash-of-request" })]);
    const answer = (hash: string) =>
      api("/approvals/apr_1", { method: "POST", body: JSON.stringify({ decision: "approve", payloadHash: hash }) });
    expect((await answer("something-else")).status).toBe(409);
    expect((await answer("hash-of-request")).status).toBe(200);
    expect((await answer("hash-of-request")).status).toBe(409);
    const db2 = openDb(covoPaths(home).db);
    expect(db2.query<{ by: string }, []>("SELECT decided_by AS by FROM approvals WHERE id = 'apr_1'").get()?.by).toBe(
      "you (API)",
    );
    db2.close();
  });

  test("limits, usage, profile and the activity log", async () => {
    expect((await api("/limits", { method: "PUT", body: JSON.stringify({ runUsd: -1 }) })).status).toBe(400);
    expect(
      await (await api("/limits", { method: "PUT", body: JSON.stringify({ runUsd: 2, dayUsd: null }) })).json(),
    ).toEqual({
      runUsd: 2,
      dayUsd: null,
    });
    expect(await (await api("/usage?days=7")).json()).toMatchObject({ days: 7, totalUsd: 0, limits: { runUsd: 2 } });
    expect(await (await api("/profile")).json()).toMatchObject({
      profile: { name: "8gb" },
      maxRuns: 1,
      canStart: true,
    });
    expect(await (await api("/audit/verify")).json()).toMatchObject({ ok: true });
  });
});
