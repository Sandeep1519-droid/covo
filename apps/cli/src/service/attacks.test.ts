import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { covoPaths } from "@covo/core";
import { openDb, verifyAudit } from "@covo/db";
import { MockProvider } from "@covo/models";
import { type PhoneConfig, PhoneLink } from "@covo/phone";
import { FakeTelegram } from "@covo/phone/fake";
import { memorySecrets, type SystemInfo } from "@covo/platform";
import { type Ctx, main } from "../main.ts";
import { socketPath } from "./client.ts";
import { apiToken, tokenPath } from "./gate.ts";
import { type Running, serve } from "./server.ts";

// Phase 3 M7: the attack tests. Every attack is refused, nothing changes, and the refusal is in the
// tamper-evident activity log.

let root: string;
let home: string;
let running: Running | undefined;
let base: string;
let token: string;
let clock = Date.now();
const secrets = memorySecrets();
const env = () => ({ COVO_HOME: home, HOME: root, COVO_PORT: "0", COVO_UI_DIR: join(root, "ui") });
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
  clock = Date.now();
  root = realpathSync(mkdtempSync(join(tmpdir(), "covo-attack-")));
  home = join(root, "Covo");
  mkdirSync(join(root, "ui"));
  writeFileSync(join(root, "ui", "index.html"), "<!doctype html><title>Covo</title>");
  await main(["init"], env());
  writeFileSync(join(home, "workspaces/default/README.md"), "# Demo\n");
});
afterEach(async () => {
  await running?.close();
  running = undefined;
  rmSync(root, { recursive: true, force: true });
});

async function start(provider = new MockProvider([MockProvider.tool("finish", { summary: "Done." })])) {
  const ctx: Ctx = {
    home,
    now: () => clock,
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
}

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${base}/api${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
  });

/** Sends a request byte for byte, so a test can forge the headers browsers won't. */
function raw(lines: string[]): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    void Bun.connect({
      hostname: "127.0.0.1",
      port: running?.port as number,
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

function audits(action: string) {
  const db = openDb(covoPaths(home).db);
  const rows = db
    .query<{ detail: string; decision: string | null; target: string | null; run: string | null }, [string]>(
      "SELECT detail_json AS detail, decision, target, run_id AS run FROM audit_log WHERE action = ? ORDER BY seq",
    )
    .all(action)
    .map((r) => ({ ...r, detail: JSON.parse(r.detail) as Record<string, unknown> }));
  db.close();
  return rows;
}

/** Every byte Covo wrote: the database, settings, logs, run records. */
function everything(dir = root): string {
  let out = "";
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) out += everything(p);
    else if (s.isFile() && s.size < 50_000_000) out += readFileSync(p).toString("latin1");
  }
  return out;
}

function waitingApproval(id: string, hash: string, expiresAt: number) {
  const db = openDb(covoPaths(home).db);
  db.query(
    `INSERT INTO runs (id, agent_id, department_id, trigger, goal, state, created_at, pid)
     VALUES (?, 'bot_assistant', 'dept_default', 'cli', 'summarise the invoices', 'AWAITING_APPROVAL', 1, ?)`,
  ).run(`run_${id}`, process.pid);
  db.query(
    `INSERT INTO approvals (id, run_id, kind, summary, payload_json, payload_hash, expires_at)
     VALUES (?, ?, 'spend', 'Spend $0.05 more?', '{"grantUsd":0.05}', ?, ?)`,
  ).run(id, `run_${id}`, hash, expiresAt);
  db.close();
}

const status = (id: string) => {
  const db = openDb(covoPaths(home).db);
  const s = db.query<{ s: string }, [string]>("SELECT status AS s FROM approvals WHERE id = ?").get(id)?.s;
  db.close();
  return s;
};

describe("a web page or another program can't use the service", () => {
  test("another website, or another name for this Mac (DNS rebinding): refused and logged, a flood once an hour", async () => {
    await start();
    const port = running?.port as number;
    // A page on another website, even one that somehow learned the token.
    const page = await fetch(`${base}/api/bots`, {
      headers: { origin: "https://evil.example", authorization: `Bearer ${token}` },
    });
    expect(page.status).toBe(403);
    expect(page.headers.get("access-control-allow-origin")).toBeNull();
    // DNS rebinding: evil.example now points at 127.0.0.1, so the browser sends Host: evil.example.
    expect(await raw([`GET /api/bots HTTP/1.1`, `Host: evil.example:${port}`])).toContain("403");
    expect(await raw([`GET /ui/ HTTP/1.1`, `Host: evil.example:${port}`])).toContain("403");
    // The page keeps trying.
    for (let i = 0; i < 20; i++)
      expect(
        (await fetch(`${base}/api/runs`, { method: "POST", headers: { origin: "https://evil.example" } })).status,
      ).toBe(403);
    let refused = audits("api.refused");
    expect(refused.map((r) => r.detail.reason)).toEqual(["website", "address"]);
    expect(refused[0]).toMatchObject({
      decision: "deny",
      detail: { origin: "https://evil.example", status: 403, path: "/api/bots", method: "GET" },
    });
    expect(refused[1]?.detail).toMatchObject({ host: `evil.example:${port}` });

    // An hour later the next one is logged, with how many came in between.
    clock += 3_600_001;
    await fetch(`${base}/api/runs`, { method: "POST", headers: { origin: "https://evil.example" } });
    refused = audits("api.refused");
    expect(refused).toHaveLength(3);
    expect(refused[2]?.detail).toMatchObject({ reason: "website", notLogged: 20 });
    expect(JSON.stringify(refused)).not.toContain(token);
    expect(((await (await api("/runs")).json()) as unknown[]).length).toBe(0); // nothing started
  });

  test("no token, or a wrong one: refused and logged; a guessed token never reaches the log", async () => {
    await start();
    const guess = "a".repeat(64);
    expect((await fetch(`${base}/api/bots`)).status).toBe(401);
    expect(
      (await fetch(`${base}/api/runs`, { method: "POST", headers: { authorization: `Bearer ${guess}` } })).status,
    ).toBe(401);
    const refused = audits("api.refused");
    expect(refused).toHaveLength(1); // the same place twice in an hour: one entry
    expect(refused[0]?.detail).toMatchObject({ reason: "token", status: 401, path: "/api/bots" });
    const log = JSON.stringify(audits("api.refused"));
    expect(log).not.toContain(guess);
    expect(log).not.toContain(token);
    // The token file is yours alone.
    expect(statSync(tokenPath(home)).mode & 0o777).toBe(0o600);
  });

  test("the app's session can't be used by another page, and sign-in codes can't be guessed or reused", async () => {
    await start();
    const code = (
      (await (await fetch("http://covod/pair-code", { unix: socketPath(home), method: "POST" })).json()) as {
        code: string;
      }
    ).code;
    const pair = (c: string) =>
      fetch(`${base}/api/pair`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base },
        body: JSON.stringify({ code: c }),
      });
    const ok = await pair(code);
    expect(ok.status).toBe(200);
    const cookie = (ok.headers.get("set-cookie") ?? "").split(";")[0] as string;
    expect((await pair(code)).status).toBe(401); // a code works once
    expect((await pair("guessed-code")).status).toBe(401);
    // A change carried only by the cookie, without the app's own origin (cross-site request forgery).
    const forged = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ goal: "delete everything" }),
    });
    expect(forged.status).toBe(403);
    // The same cookie from the app itself works.
    expect((await fetch(`${base}/api/bots`, { headers: { cookie } })).status).toBe(200);
    expect(audits("api.refused").map((r) => r.detail.reason)).toEqual(["code", "origin"]);
    expect(JSON.stringify(audits("api.refused"))).not.toContain(code);
    expect(JSON.stringify(audits("api.refused"))).not.toContain(cookie.split("=")[1] as string);
  });
});

describe("approvals can't be edited or replayed", () => {
  test("in the app: an answer for a different request, a second answer and a late one change nothing, and are logged", async () => {
    await start();
    waitingApproval("apr_1", "hash-of-the-request", clock + 60_000);
    const answer = (id: string, hash: string, decision = "approve") =>
      api(`/approvals/${id}`, { method: "POST", body: JSON.stringify({ decision, payloadHash: hash }) });
    expect((await answer("apr_1", "hash-of-another-request")).status).toBe(409); // edited
    expect(status("apr_1")).toBe("pending");
    expect((await answer("apr_1", "hash-of-the-request")).status).toBe(200);
    expect((await answer("apr_1", "hash-of-the-request", "deny")).status).toBe(409); // replayed
    expect(status("apr_1")).toBe("approved");

    waitingApproval("apr_2", "h2", clock - 1); // nobody answered in time
    expect((await answer("apr_2", "h2")).status).toBe(409);
    expect(status("apr_2")).toBe("expired");

    expect(audits("approval.refused").map((r) => [r.target, r.detail.reason, r.detail.by])).toEqual([
      ["apr_1", "changed", "you (API)"],
      ["apr_1", "already answered", "you (API)"],
      ["apr_2", "expired", "you (API)"],
    ]);
    expect(audits("approval.decided").map((r) => [r.target, r.detail.status])).toEqual([
      ["apr_1", "approved"],
      ["apr_2", "expired"],
    ]);
  });

  test("on the phone: a stranger is ignored; an edited button and a second tap change nothing; all logged", async () => {
    const me = { id: 777, first_name: "You" };
    const stranger = { id: 999, first_name: "Mallory" };
    const config: PhoneConfig = {
      botId: 4242,
      botUsername: "CovoTestBot",
      chatId: 555,
      userId: me.id,
      name: "You",
      pairedAt: clock - 60_000,
      approvalsAfter: 0,
      notify: "summaries",
      tasks: true,
    };
    waitingApproval("apr_p", "abcdef0123456789abcdef", clock + 60_000);
    const tg = new FakeTelegram();
    const link = new PhoneLink({ home, telegram: tg, config, now: () => clock });
    await link.scan();
    const card = tg.sent[0];
    expect(card?.buttons?.[0]?.[0]?.data).toBe("ap:apr_p:abcdef012345:y");
    const tap = (from: typeof me, data: string, chat = 555) =>
      link.handle({
        update_id: 1,
        callback_query: {
          id: `q${Math.random()}`,
          from,
          data,
          message: { message_id: card?.messageId ?? 0, chat: { id: chat, type: "private" }, date: 0 },
        },
      });

    // A stranger who got hold of the bot: their message starts nothing, their tap answers nothing.
    await link.handle({
      update_id: 2,
      message: { message_id: 9, chat: { id: 888, type: "private" }, from: stranger, text: "delete my files", date: 0 },
    });
    await tap(stranger, "ap:apr_p:abcdef012345:y", 888);
    expect(status("apr_p")).toBe("pending");
    expect(audits("phone.ignored").length).toBeGreaterThan(0);
    expect(tg.sent.filter((m) => m.chatId === 888)).toHaveLength(0); // no reply to the stranger

    await tap(me, "ap:apr_p:000000000000:y"); // edited: for a different version of the request
    expect(status("apr_p")).toBe("pending");
    await tap(me, "ap:apr_p:abcdef012345:y");
    expect(status("apr_p")).toBe("approved");
    await tap(me, "ap:apr_p:abcdef012345:n"); // a second tap
    expect(status("apr_p")).toBe("approved");
    expect(audits("approval.refused").map((r) => [r.detail.reason, r.detail.by])).toEqual([
      ["changed", "you (phone)"],
      ["already answered", "you (phone)"],
    ]);
  });
});

describe("a task can't reach the service", () => {
  test("a bot that tries to read the API token, or call the API, is stopped by the sandbox; all logged", async () => {
    const tokenFile = tokenPath(home);
    const socket = socketPath(home);
    const attacker = new MockProvider([
      MockProvider.tool("read_file", { path: tokenFile }, "c1"),
      MockProvider.tool("read_file", { path: "../../state/api-token" }, "c2"),
      MockProvider.tool("run_command", { command: `cat ${tokenFile}` }, "c3"),
      MockProvider.tool("run_command", { command: "curl -s -m 2 http://127.0.0.1:7420/api/bots" }, "c4"),
      MockProvider.tool(
        "run_command",
        { command: `curl -s -m 2 --unix-socket ${socket} http://covod/pair-code -X POST` },
        "c5",
      ),
      MockProvider.tool("finish", { summary: "Tidied up." }, "c6"),
    ]);
    await start(attacker);
    expect((await api("/runs", { method: "POST", body: JSON.stringify({ goal: "tidy the README" }) })).status).toBe(
      202,
    );
    const db = () => openDb(covoPaths(home).db);
    let run: { id: string; state: string } | null = null;
    for (let i = 0; i < 500; i++) {
      const d = db();
      run = d.query<{ id: string; state: string }, []>("SELECT id, state FROM runs").get();
      d.close();
      if (run && ["SUCCEEDED", "KEPT", "FAILED", "REVIEWING"].includes(run.state)) break;
      await Bun.sleep(20);
    }
    expect(run?.state).toBe("SUCCEEDED"); // it finished, and changed nothing
    const d = db();
    const denied = d
      .query<{ target: string }, [string]>(
        "SELECT target FROM audit_log WHERE run_id = ? AND action LIKE 'tool.%' AND decision = 'deny' ORDER BY seq",
      )
      .all(run?.id as string)
      .map((a) => a.target);
    const steps = d
      .query<{ p: string | null }, [string]>("SELECT result_preview AS p FROM run_steps WHERE run_id = ?")
      .all(run?.id as string)
      .map((s) => s.p ?? "")
      .join("\n");
    expect(verifyAudit(d).ok).toBe(true);
    d.close();
    expect(denied.length).toBeGreaterThanOrEqual(4);
    expect(denied.some((t) => t.includes("api-token"))).toBe(true);
    expect(denied.some((t) => t.includes("curl"))).toBe(true);
    // The token never reached the model, a step or the log.
    expect(JSON.stringify(attacker.requests)).not.toContain(token);
    expect(steps).not.toContain(token);
    // No sign-in code was handed out to the bot.
    expect(steps).not.toMatch(/"code"\s*:/);
  });

  test("a key typed into the app is in the Keychain, and nowhere else Covo writes", async () => {
    await start();
    const key = "sk-ant-api03-TOP-SECRET-KEY-MATERIAL";
    const r = await api("/models", {
      method: "POST",
      body: JSON.stringify({ provider: "anthropic", model: "claude-opus-5-5", key }),
    });
    expect(r.status).toBe(201);
    expect(await r.text()).not.toContain(key);
    expect(await (await api("/models")).text()).not.toContain(key);
    expect([...secrets.items.values()]).toContain(key);
    await running?.close(); // flush everything to disk
    running = undefined;
    expect(everything()).not.toContain(key);
  });
});
