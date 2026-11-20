import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { covoPaths } from "@covo/core";
import { initHome, openDb } from "@covo/db";
import type { PhoneConfig } from "./config.ts";
import { FakeTelegram } from "./fake.ts";
import { approvalText } from "./format.ts";
import { PhoneLink } from "./link.ts";
import { newPairingCode, waitForPairing } from "./pairing.ts";
import { Telegram, TelegramError } from "./telegram.ts";

// Phase 3 M5: your phone. Cards for spending pauses, taps that answer them, and nobody else.

const ME = { id: 777, first_name: "Sandeep" };
const STRANGER = { id: 999, first_name: "Mallory" };
const CHAT = 555;

let home: string;
let t = 1_700_000_000_000;
const now = () => t;
let tg: FakeTelegram;

const config = (over: Partial<PhoneConfig> = {}): PhoneConfig => ({
  botId: 4242,
  botUsername: "CovoTestBot",
  chatId: CHAT,
  userId: ME.id,
  name: "Sandeep",
  pairedAt: t - 60_000,
  approvalsAfter: 0,
  notify: "summaries",
  tasks: false,
  ...over,
});

function db() {
  return openDb(covoPaths(home).db);
}

function addRun(id: string, state: string, extra: { summary?: string; error?: string; finishedAt?: number } = {}) {
  const d = db();
  d.query(
    `INSERT INTO runs (id, agent_id, department_id, trigger, goal, state, summary, error, created_at, finished_at)
     VALUES (?, 'bot_assistant', 'dept_default', 'chat', 'tidy the invoices folder', ?, ?, ?, ?, ?)`,
  ).run(id, state, extra.summary ?? null, extra.error ?? null, t - 120_000, extra.finishedAt ?? null);
  d.close();
}

function addApproval(id: string, runId: string, expiresAt = t + 86_400_000) {
  const d = db();
  d.query(
    `INSERT INTO approvals (id, run_id, kind, summary, payload_json, payload_hash, expires_at)
     VALUES (?, ?, 'spend', 'Assistant has spent $0.25 of its $0.25 limit for this task.', '{"grantUsd":0.5}', 'abcdef0123456789abcdef', ?)`,
  ).run(id, runId, expiresAt);
  d.close();
}

const approval = (id: string) => {
  const d = db();
  const a = d
    .query<{ status: string; by: string | null }, [string]>(
      "SELECT status, decided_by AS by FROM approvals WHERE id = ?",
    )
    .get(id);
  d.close();
  return a;
};

const audits = (action: string) => {
  const d = db();
  const n = d.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM audit_log WHERE action = ?").get(action)?.n;
  d.close();
  return n ?? 0;
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "covo-phone-"));
  initHome(home);
  tg = new FakeTelegram();
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("pairing", () => {
  test("the chat that sends the code becomes yours; other messages are ignored", async () => {
    const code = newPairingCode();
    expect(code).toMatch(/^COVO-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    tg.say(STRANGER, 1, "hello?");
    tg.say(ME, CHAT, `/start ${code.toLowerCase()}`);
    const others: number[] = [];
    const p = await waitForPairing(tg, code, { deadline: Date.now() + 5_000, onOther: (f) => others.push(f?.id ?? 0) });
    expect(p).toMatchObject({ chatId: CHAT, userId: ME.id, name: "Sandeep" });
    expect(others).toEqual([STRANGER.id]);
  });

  test("gives up at the deadline", async () => {
    const p = await waitForPairing(tg, newPairingCode(), { deadline: Date.now() + 50 });
    expect(p).toBeNull();
  });
});

describe("spending pauses on your phone", () => {
  test("a card with Allow once / Deny, tied to the exact request; your tap answers it", async () => {
    addRun("run_1", "AWAITING_APPROVAL");
    addApproval("appr_1", "run_1");
    const link = new PhoneLink({ home, telegram: tg, config: config(), now });
    await link.scan();
    expect(tg.sent).toHaveLength(1);
    const card = tg.sent[0];
    expect(card?.text).toContain("Assistant\nSpend up to $0.50 more?");
    expect(card?.text).toContain("Task: tidy the invoices folder");
    expect(card?.buttons?.[0]?.map((b) => b.data)).toEqual(["ap:appr_1:abcdef012345:y", "ap:appr_1:abcdef012345:n"]);
    await link.scan();
    expect(tg.sent).toHaveLength(1); // sent once

    // Someone else taps it (say, the bot was added to a group): ignored, and logged.
    await link.handle({
      update_id: 1,
      callback_query: {
        id: "x",
        from: STRANGER,
        data: "ap:appr_1:abcdef012345:y",
        message: { message_id: 1, chat: { id: 888, type: "group" }, date: 0 },
      },
    });
    expect(approval("appr_1")?.status).toBe("pending");
    expect(audits("phone.ignored")).toBe(1);

    // A button for a different version of the request does nothing.
    await link.handle({
      update_id: 2,
      callback_query: {
        id: "y",
        from: ME,
        data: "ap:appr_1:000000000000:y",
        message: { message_id: card?.messageId ?? 0, chat: { id: CHAT, type: "private" }, date: 0 },
      },
    });
    expect(approval("appr_1")?.status).toBe("pending");
    expect(tg.answers.at(-1)?.text).toContain("changed");

    // Yours does.
    await link.handle({
      update_id: 3,
      callback_query: {
        id: "z",
        from: ME,
        data: "ap:appr_1:abcdef012345:y",
        message: { message_id: card?.messageId ?? 0, chat: { id: CHAT, type: "private" }, date: 0 },
      },
    });
    expect(approval("appr_1")).toEqual({ status: "approved", by: "you (phone)" });
    expect(tg.answers.at(-1)?.text).toContain("Allowed");
    expect(tg.edits.at(-1)?.text).toContain("✓ Allowed from your phone");
    expect(tg.edits.at(-1)?.text).not.toContain("Answer by");
    expect(audits("approval.decided")).toBe(1);

    // Tapping again changes nothing.
    await link.handle({
      update_id: 4,
      callback_query: {
        id: "w",
        from: ME,
        data: "ap:appr_1:abcdef012345:n",
        message: { message_id: card?.messageId ?? 0, chat: { id: CHAT, type: "private" }, date: 0 },
      },
    });
    expect(approval("appr_1")?.status).toBe("approved");
    expect(tg.answers.at(-1)?.text).toContain("already allowed");
  });

  test("answered on the Mac, or expired: the card shows it and loses its buttons", async () => {
    addRun("run_1", "AWAITING_APPROVAL");
    addApproval("appr_1", "run_1");
    addRun("run_2", "AWAITING_APPROVAL");
    addApproval("appr_2", "run_2", t + 1_000);
    const link = new PhoneLink({ home, telegram: tg, config: config(), now });
    await link.scan();
    expect(tg.sent).toHaveLength(2);
    const d = db();
    d.query(
      "UPDATE approvals SET status = 'approved', decided_by = 'you (app)', decided_at = ? WHERE id = 'appr_1'",
    ).run(t);
    d.close();
    t += 2_000;
    await link.scan();
    expect(tg.edits.map((e) => e.text)).toEqual([
      expect.stringContaining("✓ Allowed in the Covo app"),
      expect.stringContaining("Expired: nobody answered"),
    ]);
    await link.scan();
    expect(tg.edits).toHaveLength(2);
  });

  test("only new requests: nothing from before pairing", async () => {
    addRun("run_1", "AWAITING_APPROVAL");
    addApproval("appr_1", "run_1");
    const link = new PhoneLink({ home, telegram: tg, config: config({ approvalsAfter: 1 }), now });
    await link.scan();
    expect(tg.sent).toHaveLength(0);
  });

  test("only what needs you: the card leaves out the task", () => {
    const a = {
      bot: "Assistant",
      summary: "Spent $0.25.",
      goal: "secret plans",
      grantUsd: 0.5,
      expiresAt: t + 3_600_000,
    };
    expect(approvalText(a, "needs-you", t)).not.toContain("secret plans");
    expect(approvalText(a, "summaries", t)).toContain("Task: secret plans");
  });
});

describe("results and messages", () => {
  test("finished and failed tasks: short summaries, once each; in review: a nudge", async () => {
    addRun("run_ok", "SUCCEEDED", { summary: "Sorted 12 invoices into folders by month.", finishedAt: t - 10_000 });
    addRun("run_bad", "FAILED", { error: "The model's key stopped working.", finishedAt: t - 10_000 });
    addRun("run_review", "REVIEWING", { summary: "Renamed files.", finishedAt: t - 10_000 });
    addRun("run_old", "SUCCEEDED", { summary: "before pairing", finishedAt: t - 3_600_000 });
    addRun("run_new", "SUCCEEDED", { summary: "just now", finishedAt: t - 500 }); // still settling
    const link = new PhoneLink({ home, telegram: tg, config: config(), now });
    await link.scan();
    const texts = tg.sent.map((m) => m.text);
    expect(texts).toHaveLength(3);
    expect(texts).toContainEqual(expect.stringContaining("Done: tidy the invoices folder\nSorted 12 invoices"));
    expect(texts).toContainEqual(expect.stringContaining("Couldn't finish: tidy the invoices folder\nThe model's key"));
    expect(texts).toContainEqual(expect.stringContaining("review the changes on your Mac"));
    await link.scan();
    expect(tg.sent).toHaveLength(3);
  });

  test("only what needs you: reviews, but no summaries", async () => {
    addRun("run_ok", "SUCCEEDED", { summary: "Done.", finishedAt: t - 10_000 });
    addRun("run_review", "REVIEWING", { summary: "Renamed files.", finishedAt: t - 10_000 });
    const link = new PhoneLink({ home, telegram: tg, config: config({ notify: "needs-you" }), now });
    await link.scan();
    expect(tg.sent.map((m) => m.text)).toEqual(["Assistant\nHas changes for you to review on your Mac."]);
  });

  test("your messages: help, status, and tasks only when you turned them on", async () => {
    const started: string[] = [];
    const startTask = async (text: string) => {
      started.push(text);
      return "On it.";
    };
    let link = new PhoneLink({ home, telegram: tg, config: config(), now, startTask });
    const say = (text: string, from = ME, chat = CHAT) =>
      link.handle({
        update_id: 1,
        message: { message_id: 1, chat: { id: chat, type: "private" }, from, text, date: 0 },
      });
    await say("/start");
    expect(tg.sent.at(-1)?.text).toContain("This is Covo, on your Mac");
    await say("/status");
    expect(tg.sent.at(-1)?.text).toContain("Waiting for you: 0");
    await say("tidy my downloads");
    expect(started).toEqual([]);
    expect(tg.sent.at(-1)?.text).toContain("covo phone tasks on");

    link = new PhoneLink({ home, telegram: tg, config: config({ tasks: true }), now, startTask });
    await say("tidy my downloads");
    expect(started).toEqual(["tidy my downloads"]);
    expect(tg.sent.at(-1)?.text).toBe("On it.");

    // Someone else: ignored (no reply, no task), logged once an hour.
    const before = tg.sent.length;
    await say("tidy my downloads", STRANGER, 1);
    await say("please", STRANGER, 1);
    expect(tg.sent).toHaveLength(before);
    expect(started).toHaveLength(1);
    expect(audits("phone.ignored")).toBe(1);
  });

  test("the test card's buttons answer, and change nothing", async () => {
    const link = new PhoneLink({ home, telegram: tg, config: config(), now });
    await link.handle({
      update_id: 1,
      callback_query: {
        id: "t1",
        from: ME,
        data: "t:abc:y",
        message: { message_id: 9, chat: { id: CHAT, type: "private" }, text: "Covo\nTest", date: 0 },
      },
    });
    expect(tg.answers.at(-1)?.text).toContain("It works");
    expect(tg.edits.at(-1)?.text).toContain("You tapped Allow once");
  });

  test("the link keeps asking Telegram, and handles what arrives", async () => {
    addRun("run_1", "AWAITING_APPROVAL");
    addApproval("appr_1", "run_1");
    const link = new PhoneLink({ home, telegram: tg, config: config(), scanMs: 20, now });
    link.start();
    for (let i = 0; i < 100 && tg.sent.length === 0; i++) await Bun.sleep(10);
    const card = tg.sent[0];
    tg.tap(ME, CHAT, card?.buttons?.[0]?.[1]?.data ?? "", {
      message_id: card?.messageId ?? 0,
      chat: { id: CHAT, type: "private" },
      date: 0,
    });
    for (let i = 0; i < 100 && approval("appr_1")?.status === "pending"; i++) await Bun.sleep(10);
    await link.stop();
    expect(approval("appr_1")).toEqual({ status: "denied", by: "you (phone)" });
  });
});

describe("the Telegram client", () => {
  test("calls the Bot API, and errors never show the token", async () => {
    const token = "123456789:AAEabcdefghijklmnopqrstuvwxyz012345";
    const calls: { url: string; body: unknown }[] = [];
    const fetchOk = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: 5, chat: { id: 1, type: "private" }, date: 0 } }),
      );
    }) as unknown as typeof fetch;
    await new Telegram(token, fetchOk).sendMessage(1, "hi", [[{ text: "Allow once", data: "ap:x:y:y" }]]);
    expect(calls[0]?.url).toBe(`https://api.telegram.org/bot${token}/sendMessage`);
    expect(calls[0]?.body).toMatchObject({
      chat_id: 1,
      text: "hi",
      reply_markup: { inline_keyboard: [[{ text: "Allow once", callback_data: "ap:x:y:y" }]] },
    });

    const fetchBad = (async () =>
      new Response(JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" }), {
        status: 401,
      })) as unknown as typeof fetch;
    const e = await new Telegram(token, fetchBad).getMe().catch((x) => x);
    expect(e).toBeInstanceOf(TelegramError);
    expect(e.message).toBe("Unauthorized");
    const down = (async () => {
      throw new Error(`fetch failed: https://api.telegram.org/bot${token}/getMe`);
    }) as unknown as typeof fetch;
    const e2 = await new Telegram(token, down).getMe().catch((x) => x);
    expect(e2.message).not.toContain(token);
  });
});
