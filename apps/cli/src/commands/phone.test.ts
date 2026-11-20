import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { covoPaths } from "@covo/core";
import { openDb } from "@covo/db";
import { loadPhone, phonePath, TOKEN_ID } from "@covo/phone";
import { FakeTelegram } from "@covo/phone/fake";
import { memorySecrets, type SystemInfo } from "@covo/platform";
import { type Ctx, main } from "../main.ts";
import type { Prompter } from "../prompt.ts";
import { type Running, serve } from "../service/server.ts";

// Phase 3 M5: covo phone, and the service listening to Telegram.

const TOKEN = "123456789:AAEabcdefghijklmnopqrstuvwxyz012345";
const ME = { id: 777, first_name: "Sandeep" };
const CHAT = 555;

let root: string;
let home: string;
let tg: FakeTelegram;
let printed: string;
const secrets = memorySecrets();
const env = () => ({ COVO_HOME: home, HOME: root, COVO_PORT: "0", COVO_SERVICE: "off" });
const prompt = (token: string): Prompter => ({ ask: async (_q, d) => d ?? "", secret: async () => token });
const extra = (token = TOKEN) => ({
  prompt: prompt(token),
  secrets,
  telegram: () => tg,
  print: (s: string) => {
    printed += s;
    // Like you on your phone: once Covo shows the pairing code, send it to the bot.
    const code = s.match(/COVO-[A-Z2-9]{4}-[A-Z2-9]{4}/)?.[0];
    if (code && s.includes("send this code")) tg.say(ME, CHAT, `/start ${code}`);
  },
});

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "covo-phonecli-")));
  home = join(root, "Covo");
  await main(["init"], env());
  tg = new FakeTelegram();
  printed = "";
  for (const k of [...secrets.items.keys()]) secrets.items.delete(k);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("covo phone", () => {
  test("connect: the token goes to the Keychain, the chat that sends the code is yours", async () => {
    const r = await main(["phone", "connect"], env(), extra());
    expect(r.code).toBe(0);
    expect(printed).toContain("https://t.me/CovoTestBot?start=COVO-");
    expect(r.out).toContain("Your phone is connected (Sandeep, through @CovoTestBot)");
    expect(secrets.items.get(TOKEN_ID)).toBe(TOKEN);
    expect(loadPhone(home)).toMatchObject({ chatId: CHAT, userId: ME.id, notify: "summaries", tasks: false });
    expect(statSync(phonePath(home)).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(loadPhone(home))).not.toContain(TOKEN); // never in a file
    expect(tg.sent[0]?.text).toContain("Connected to Covo on your Mac");

    expect((await main(["phone", "status"], env(), extra())).out).toContain("chatting with Sandeep");
    expect((await main(["phone", "notify", "needs-you"], env(), extra())).out).toContain("only what needs you");
    expect((await main(["phone", "tasks", "on"], env(), extra())).out).toContain("now start tasks");
    expect(loadPhone(home)).toMatchObject({ notify: "needs-you", tasks: true });

    expect((await main(["phone", "test"], env(), extra())).out).toContain("Sent a test card");
    expect(tg.sent.at(-1)?.buttons?.[0]?.[0]?.data).toMatch(/^t:[0-9a-f]+:y$/);

    expect((await main(["phone", "disconnect"], env(), extra())).out).toContain("Disconnected");
    expect(existsSync(phonePath(home))).toBe(false);
    expect(secrets.items.has(TOKEN_ID)).toBe(false);

    const db = openDb(covoPaths(home).db);
    const actions = db
      .query<{ action: string }, []>("SELECT action FROM audit_log WHERE action LIKE 'phone.%' ORDER BY seq")
      .all()
      .map((x) => x.action);
    db.close();
    expect(actions).toEqual(["phone.connected", "phone.settings", "phone.settings", "phone.disconnected"]);
    expect((await main(["audit", "verify"], env())).code).toBe(0);
  });

  test("a wrong token is refused before anything is saved", async () => {
    const r = await main(["phone", "connect"], env(), extra("not-a-token"));
    expect(r.code).toBe(1);
    expect(r.out).toContain("doesn't look like a bot token");
    tg.getMe = async () => {
      throw new Error("Unauthorized");
    };
    const r2 = await main(["phone", "connect"], env(), extra());
    expect(r2.out).toContain("Telegram didn't accept that token");
    expect(secrets.items.size).toBe(0);
    expect(loadPhone(home)).toBeNull();
    expect((await main(["phone", "connect"], env(), { secrets, telegram: () => tg })).out).toContain("in Terminal");
  });
});

describe("the service and your phone", () => {
  let running: Running | undefined;
  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  test("a spending pause reaches the phone; your tap answers it, recorded as from your phone", async () => {
    expect((await main(["phone", "connect"], env(), extra())).code).toBe(0);
    // A task paused for your OK (after pairing).
    const db = openDb(covoPaths(home).db);
    db.query(
      `INSERT INTO runs (id, agent_id, department_id, trigger, goal, state, created_at, pid)
       VALUES ('run_wait', 'bot_assistant', 'dept_default', 'chat', 'summarise the invoices', 'AWAITING_APPROVAL', 1, ?)`,
    ).run(process.pid);
    db.query(
      `INSERT INTO approvals (id, run_id, kind, summary, payload_json, payload_hash, expires_at)
       VALUES ('appr_wait', 'run_wait', 'spend', 'Assistant has spent $0.25 of its limit.', '{"grantUsd":0.29}', 'feedfacecafebeef00', ?)`,
    ).run(Date.now() + 60_000);
    db.close();

    const ctx: Ctx = {
      home,
      now: Date.now,
      env: env(),
      print: () => {},
      system: (): SystemInfo => ({
        memoryGB: 8,
        chip: "Apple M3",
        performanceCores: 4,
        cores: 8,
        memoryPressure: "normal",
        power: { source: "ac", percent: 100 },
        thermal: "normal",
      }),
      secrets,
      telegram: () => tg,
    };
    running = await serve(ctx);
    const wait = async (ok: () => boolean) => {
      for (let i = 0; i < 300 && !ok(); i++) await Bun.sleep(10);
    };
    await wait(() => tg.sent.some((m) => m.text.includes("Spend up to $0.29 more?")));
    const card = tg.sent.find((m) => m.text.includes("Spend up to $0.29 more?"));
    expect(card?.buttons?.[0]?.[0]).toEqual({ text: "Allow once", data: "ap:appr_wait:feedfacecafe:y" });

    // Someone else's tap is ignored; yours counts.
    tg.tap({ id: 999 }, 999, "ap:appr_wait:feedfacecafe:y");
    tg.tap(ME, CHAT, "ap:appr_wait:feedfacecafe:y", {
      message_id: card?.messageId ?? 0,
      chat: { id: CHAT, type: "private" },
      date: 0,
    });
    const decided = () => {
      const d = openDb(covoPaths(home).db);
      const a = d
        .query<{ s: string; by: string | null }, []>("SELECT status AS s, decided_by AS by FROM approvals")
        .get();
      d.close();
      return a;
    };
    await wait(() => decided()?.s !== "pending");
    expect(decided()).toEqual({ s: "approved", by: "you (phone)" });
    await wait(() => tg.edits.length > 0);
    expect(tg.edits.at(-1)?.text).toContain("✓ Allowed from your phone");
  });
});
