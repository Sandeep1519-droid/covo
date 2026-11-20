import { randomBytes } from "node:crypto";
import { covoPaths } from "@covo/core";
import { appendAudit, migrate, openDb } from "@covo/db";
import {
  helpText,
  loadPhone,
  newPairingCode,
  type PhoneConfig,
  pairingLink,
  removePhone,
  savePhone,
  Telegram,
  type TelegramApi,
  TOKEN_ID,
  TOKEN_PATTERN,
  waitForPairing,
  writeOffset,
} from "@covo/phone";
import { secrets } from "@covo/platform";
import type { CliResult, Ctx } from "../main.ts";
import { serviceHealth } from "../service/client.ts";

// covo phone (Phase 3 M5): your phone, through a Telegram bot you create. It gets spending pauses to
// answer (Allow once / Deny) and, if you like, short summaries of finished tasks. Covo's service asks
// Telegram for messages itself, so no server or public address is needed.

const USAGE = `Usage:
  covo phone connect            Connect your phone (Telegram); asks for your bot's token
  covo phone status             What's connected and what gets sent
  covo phone test               Send a test card to your phone
  covo phone notify summaries   Spending pauses, plus finished and failed tasks (the default)
  covo phone notify needs-you   Only what needs you: spending pauses and changes to review
  covo phone tasks on|off       Let messages to the bot start tasks (off by default)
  covo phone disconnect         Stop using the phone, and remove the bot's token
`;

const PAIRING_MS = 10 * 60_000;

function audit(ctx: Ctx, action: string, detail: Record<string, unknown>): void {
  const db = openDb(covoPaths(ctx.home).db);
  try {
    migrate(db, ctx.now);
    appendAudit(db, { actor: action === "phone.ignored" ? "system" : "user", action, detail }, ctx.now);
  } finally {
    db.close();
  }
}

const telegramFor = (ctx: Ctx, token: string): TelegramApi => ctx.telegram?.(token) ?? new Telegram(token);

export async function phoneCommand(ctx: Ctx, args: string[]): Promise<CliResult> {
  const [sub, arg] = args;
  if (sub === "connect") return connect(ctx);
  if (sub === "status" || sub === undefined) return status(ctx);
  if (sub === "test") return test(ctx);
  if (sub === "disconnect") return disconnect(ctx);
  if (sub === "notify" && (arg === "summaries" || arg === "needs-you")) return change(ctx, { notify: arg });
  if (sub === "tasks" && (arg === "on" || arg === "off")) return change(ctx, { tasks: arg === "on" });
  return { code: 2, out: USAGE };
}

async function connect(ctx: Ctx): Promise<CliResult> {
  const ask = ctx.prompt;
  if (!ask)
    return { code: 2, out: "Run covo phone connect in Terminal: it asks for your bot's token without showing it.\n" };
  const print = ctx.print;
  print(
    [
      "Covo talks to your phone through a Telegram bot of your own. It's free and takes a minute:",
      "  1. In Telegram, start a chat with @BotFather and send /newbot.",
      '  2. Give it a name (for example: Covo) and a username ending in "bot".',
      "  3. BotFather replies with a token. Paste it below: it goes straight to the Keychain.",
      "",
    ].join("\n"),
  );
  const token = (await ask.secret("Bot token:")).trim();
  if (!TOKEN_PATTERN.test(token)) {
    return {
      code: 1,
      out: "That doesn't look like a bot token from @BotFather (they look like 123456789:AAE…). Nothing was saved.\n",
    };
  }
  const tg = telegramFor(ctx, token);
  let me: { id: number; username?: string };
  try {
    me = await tg.getMe();
  } catch (e) {
    return { code: 1, out: `Telegram didn't accept that token: ${(e as Error).message} Nothing was saved.\n` };
  }
  const bot = me.username ?? "your bot";

  // A phone that was connected before stops listening (the service notices within seconds),
  // so it doesn't take the pairing message.
  if (loadPhone(ctx.home)) {
    removePhone(ctx.home);
    print("This replaces your current phone connection.\n");
  }

  const code = newPairingCode();
  print(
    [
      "",
      `Found your bot, @${bot}. Now pair your phone: open this link on your phone and tap Start:`,
      "",
      `  ${pairingLink(bot, code)}`,
      "",
      `Or send this code to @${bot}: ${code}`,
      "Waiting for it (up to 10 minutes; press Ctrl+C to stop)…",
      "",
    ].join("\n"),
  );
  const controller = new AbortController();
  const onInt = () => controller.abort();
  process.once("SIGINT", onInt);
  let paired: Awaited<ReturnType<typeof waitForPairing>>;
  try {
    paired = await waitForPairing(tg, code, {
      signal: controller.signal,
      deadline: ctx.now() + PAIRING_MS,
      now: ctx.now,
      onOther: (from) => {
        print(`(Ignored a message without the code${from?.first_name ? ` from ${from.first_name}` : ""}.)\n`);
        audit(ctx, "phone.ignored", { kind: "message", fromId: from?.id ?? 0, during: "pairing" });
      },
    });
  } finally {
    process.off("SIGINT", onInt);
  }
  if (!paired)
    return {
      code: 1,
      out: "The pairing code didn't arrive, so nothing was connected. Run covo phone connect to try again.\n",
    };

  await (ctx.secrets ?? secrets()).put(TOKEN_ID, token, `Covo phone (Telegram bot @${bot})`);
  const db = openDb(covoPaths(ctx.home).db);
  let approvalsAfter = 0;
  try {
    migrate(db, ctx.now);
    approvalsAfter = db.query<{ n: number | null }, []>("SELECT MAX(rowid) AS n FROM approvals").get()?.n ?? 0;
  } finally {
    db.close();
  }
  const config: PhoneConfig = {
    botId: me.id,
    botUsername: bot,
    chatId: paired.chatId,
    userId: paired.userId,
    name: paired.name,
    pairedAt: ctx.now(),
    approvalsAfter,
    notify: "summaries",
    tasks: false,
  };
  writeOffset(ctx.home, paired.offset);
  savePhone(ctx.home, config);
  audit(ctx, "phone.connected", { bot, name: paired.name });
  await tg.sendMessage(config.chatId, `Connected to Covo on your Mac.\n\n${helpText(config)}`).catch(() => {});
  const running = await serviceHealth(ctx.home);
  return {
    code: 0,
    out: [
      "",
      `Your phone is connected (${paired.name}, through @${bot}).`,
      "It gets spending pauses to answer, and short summaries of finished and failed tasks (never your files' contents).",
      "Only this chat is listened to; messages from anyone else are ignored and logged.",
      running
        ? "Covo's service is running, so it's listening now. Try it with: covo phone test"
        : "Covo's service isn't running, so nothing is sent yet. Start it with: covo service install",
      "",
    ].join("\n"),
  };
}

async function status(ctx: Ctx): Promise<CliResult> {
  const c = loadPhone(ctx.home);
  if (!c) return { code: 0, out: "No phone is connected. Connect one with: covo phone connect\n" };
  const running = await serviceHealth(ctx.home);
  const since = new Date(c.pairedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  return {
    code: 0,
    out: [
      `Phone: connected to @${c.botUsername}, chatting with ${c.name} (since ${since}).`,
      c.notify === "summaries"
        ? "Sends: spending pauses to answer, and finished or failed tasks (short summaries)."
        : "Sends: only what needs you (spending pauses and changes to review).",
      `Starting tasks from your phone: ${c.tasks ? "on" : "off"}.`,
      running
        ? "Covo's service is running, so it's listening."
        : "Covo's service isn't running: start it with covo service install",
      "",
    ].join("\n"),
  };
}

async function test(ctx: Ctx): Promise<CliResult> {
  const c = loadPhone(ctx.home);
  if (!c) return { code: 1, out: "No phone is connected. Connect one with: covo phone connect\n" };
  const token = await (ctx.secrets ?? secrets()).get(TOKEN_ID);
  if (!token) return { code: 1, out: "The bot's token isn't in the Keychain any more. Run: covo phone connect\n" };
  const nonce = randomBytes(6).toString("hex");
  await telegramFor(ctx, token).sendMessage(
    c.chatId,
    "Covo\nTest: Spend up to $0.10 more?\nThis is only a test of the buttons. Nothing will change, whatever you tap.",
    [
      [
        { text: "Allow once", data: `t:${nonce}:y` },
        { text: "Deny", data: `t:${nonce}:n` },
      ],
    ],
  );
  const running = await serviceHealth(ctx.home);
  return {
    code: 0,
    out: running
      ? "Sent a test card to your phone. Tap Allow once or Deny: Covo's service answers it.\n"
      : "Sent a test card to your phone, but Covo's service isn't running, so nothing will answer the tap. Start it with: covo service install\n",
  };
}

async function change(ctx: Ctx, c: Partial<Pick<PhoneConfig, "notify" | "tasks">>): Promise<CliResult> {
  const cur = loadPhone(ctx.home);
  if (!cur) return { code: 1, out: "No phone is connected. Connect one with: covo phone connect\n" };
  savePhone(ctx.home, { ...cur, ...c });
  audit(ctx, "phone.settings", c);
  if (c.notify) {
    return {
      code: 0,
      out:
        c.notify === "summaries"
          ? "Your phone now gets spending pauses, and finished or failed tasks (short summaries).\n"
          : "Your phone now gets only what needs you: spending pauses and changes to review.\n",
    };
  }
  return {
    code: 0,
    out: c.tasks
      ? "Messages to your bot now start tasks with your main bot (Assistant), with its usual limits.\n"
      : "Messages to your bot no longer start tasks.\n",
  };
}

async function disconnect(ctx: Ctx): Promise<CliResult> {
  const c = loadPhone(ctx.home);
  if (!c) return { code: 0, out: "No phone is connected.\n" };
  const store = ctx.secrets ?? secrets();
  const token = await store.get(TOKEN_ID);
  if (token) {
    await telegramFor(ctx, token)
      .sendMessage(c.chatId, "Covo disconnected from this chat. Messages here aren't read any more.")
      .catch(() => {});
  }
  await store.delete(TOKEN_ID);
  removePhone(ctx.home);
  audit(ctx, "phone.disconnected", { bot: c.botUsername });
  return {
    code: 0,
    out: `Disconnected, and the bot's token is gone from the Keychain. You can delete @${c.botUsername} in Telegram with @BotFather (/deletebot).\n`,
  };
}
