import type { Database } from "bun:sqlite";
import { covoPaths } from "@covo/core";
import { appendAudit, migrate, openDb } from "@covo/db";
import { changesOf, decide, refuseAnswer, startOfLocalDay } from "@covo/engine";
import { type PhoneConfig, readOffset, writeOffset } from "./config.ts";
import {
  approvalButtons,
  approvalText,
  type Changes,
  failedText,
  finishedText,
  helpText,
  money,
  outcomeText,
  reviewOnlyText,
} from "./format.ts";
import type { TelegramApi, TgCallback, TgMessage, TgUpdate, TgUser } from "./telegram.ts";

// The phone link (Phase 3 M5), run by Covo's service while a phone is connected:
//   • asks Telegram for new messages and button taps (long polling; no server needed)
//   • sends spending pauses as cards with Allow once / Deny, tied to that exact request
//   • sends finished and failed tasks (short summaries, never file contents) and reviews to do
//   • updates a card once it's answered anywhere, or expires
// Only your paired chat and Telegram account are listened to. Anything else is ignored, and logged.
// The phone can't change limits, levels or keys: those stay on the Mac (until Touch ID, Phase 4).

const HOUR = 3_600_000;
/** A task's state settles within moments of finishing (kept after review, say); wait that long. */
const SETTLE_MS = 3_000;

export interface PhoneLinkOptions {
  home: string;
  telegram: TelegramApi;
  config: PhoneConfig;
  now?: () => number;
  /** Starts a task from a phone message (only when tasks are on); returns the reply. */
  startTask?: (text: string) => Promise<string>;
  log?: (s: string) => void;
  /** How often to look for things to send. */
  scanMs?: number;
  pollTimeoutSec?: number;
}

type Kind = "approval" | "finished" | "failed" | "review" | "summary";

export class PhoneLink {
  private running = false;
  private abort?: AbortController;
  private timer?: ReturnType<typeof setInterval>;
  private scanning = false;
  private loop?: Promise<void>;
  private readonly ignoredAt = new Map<number, number>();
  private readonly now: () => number;

  constructor(private readonly o: PhoneLinkOptions) {
    this.now = o.now ?? Date.now;
  }

  private get c(): PhoneConfig {
    return this.o.config;
  }

  private get tg(): TelegramApi {
    return this.o.telegram;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.poll();
    this.timer = setInterval(() => void this.scan(), this.o.scanMs ?? 3_000);
    this.timer.unref?.();
    void this.scan();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abort?.abort();
    clearInterval(this.timer);
    await this.loop?.catch(() => {});
  }

  private withDb<T>(fn: (db: Database) => T): T {
    const db = openDb(covoPaths(this.o.home).db);
    try {
      migrate(db, this.now);
      return fn(db);
    } finally {
      db.close();
    }
  }

  private async poll(): Promise<void> {
    let offset = readOffset(this.o.home);
    let backoff = 1_000;
    while (this.running) {
      this.abort = new AbortController();
      try {
        const updates = await this.tg.getUpdates(offset, this.o.pollTimeoutSec ?? 50, this.abort.signal);
        backoff = 1_000;
        for (const u of updates) {
          // Saved before handling: a crash mid-way skips this update rather than doing it twice.
          offset = u.update_id + 1;
          writeOffset(this.o.home, offset);
          try {
            await this.handle(u);
          } catch (e) {
            this.o.log?.(`phone: couldn't handle a message: ${(e as Error).message}`);
          }
        }
      } catch (e) {
        if (!this.running) break;
        const ra = (e as { retryAfter?: number }).retryAfter;
        await Bun.sleep(ra ? ra * 1_000 : backoff);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  /** Handles one message or button tap from Telegram. */
  async handle(u: TgUpdate): Promise<void> {
    if (u.callback_query) await this.onButton(u.callback_query);
    else if (u.message) await this.onMessage(u.message);
  }

  private mine(from: TgUser | undefined, chatId: number | undefined): boolean {
    return from !== undefined && from.id === this.c.userId && chatId === this.c.chatId;
  }

  /** Someone else wrote to the bot, or tapped a button: ignore it, and log it (once an hour per sender). */
  private ignored(kind: "message" | "button", from: TgUser | undefined, chatId: number | undefined): void {
    const id = from?.id ?? 0;
    const t = this.now();
    if (t - (this.ignoredAt.get(id) ?? 0) < HOUR) return;
    this.ignoredAt.set(id, t);
    this.withDb((db) =>
      appendAudit(
        db,
        {
          actor: "system",
          action: "phone.ignored",
          decision: "deny",
          detail: { kind, fromId: id, chatId: chatId ?? null, reason: "not your paired chat" },
        },
        this.now,
      ),
    );
    this.o.log?.(`phone: ignored a ${kind} from another Telegram account (${id})`);
  }

  private async onMessage(m: TgMessage): Promise<void> {
    if (!this.mine(m.from, m.chat.id)) return this.ignored("message", m.from, m.chat.id);
    const text = (m.text ?? "").trim();
    if (!text) return;
    let reply: string;
    if (/^\/(start|help)\b/i.test(text)) reply = helpText(this.c);
    else if (/^\/status\b/i.test(text)) reply = this.statusText();
    else if (text.startsWith("/")) reply = "I don't know that one. Send /help to see what I can do.";
    else if (!this.c.tasks)
      reply = "Starting tasks from your phone is off. To turn it on, run this on your Mac: covo phone tasks on";
    else if (!this.o.startTask) reply = "I can't start tasks right now. Is Covo's service running on your Mac?";
    else reply = await this.o.startTask(text).catch((e: Error) => `Couldn't start it: ${e.message}`);
    await this.tg.sendMessage(this.c.chatId, reply);
  }

  private statusText(): string {
    return this.withDb((db) => {
      const n = (sql: string, ...args: number[]) => db.query<{ n: number }, number[]>(sql).get(...args)?.n ?? 0;
      const running = n("SELECT COUNT(*) AS n FROM runs WHERE state IN ('QUEUED','PREPARING','RUNNING')");
      const waiting =
        n("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'") +
        n("SELECT COUNT(*) AS n FROM runs WHERE state = 'REVIEWING'");
      const spent =
        db
          .query<{ c: number | null }, [number]>("SELECT SUM(usd) AS c FROM budget_ledger WHERE ts >= ?")
          .get(startOfLocalDay(this.now()))?.c ?? 0;
      return [`Running: ${running}`, `Waiting for you: ${waiting}`, `Spent today: ${money(spent)}`].join("\n");
    });
  }

  private async onButton(q: TgCallback): Promise<void> {
    const chatId = q.message?.chat.id;
    if (!this.mine(q.from, chatId)) return this.ignored("button", q.from, chatId);
    const parts = (q.data ?? "").split(":");

    // `covo phone test` cards ("t:<nonce>:<y|n>"): shows the round trip works; changes nothing.
    if (parts[0] === "t" && q.message) {
      await this.tg.answerCallback(q.id, "It works. This was a test, so nothing changed.");
      await this.tg.editMessage(
        q.message.chat.id,
        q.message.message_id,
        `${q.message.text ?? "Test"}\n\nYou tapped ${parts[2] === "y" ? "Allow once" : "Deny"}. It works: real spending pauses will look like this. Nothing was changed.`,
      );
      return;
    }
    // Approval cards: "ap:<approval id>:<start of its hash>:<y|n>".
    const [kind, id, hash, answer] = parts;
    if (kind !== "ap" || !id || !hash || (answer !== "y" && answer !== "n")) {
      await this.tg.answerCallback(q.id, "That button doesn't work any more.");
      return;
    }
    const r = this.withDb((db): { note: string; close: boolean } => {
      const a = db
        .query<{ status: string; payload_hash: string; expires_at: number }, [string]>(
          "SELECT status, payload_hash, expires_at FROM approvals WHERE id = ?",
        )
        .get(id);
      // Refused answers change nothing, and are logged.
      if (!a) {
        refuseAnswer(db, id, "unknown", "you (phone)", this.now);
        return { note: "That request isn't there any more.", close: false };
      }
      if (a.status !== "pending") {
        refuseAnswer(db, id, "already answered", "you (phone)", this.now);
        return { note: `That was already ${a.status === "approved" ? "allowed" : a.status}.`, close: true };
      }
      // The answer applies only to the exact request shown on the card.
      if (!a.payload_hash.startsWith(hash)) {
        refuseAnswer(db, id, "changed", "you (phone)", this.now);
        return { note: "That request changed. Look at it on your Mac.", close: false };
      }
      if (a.expires_at < this.now()) {
        decide(db, id, "expired", "nobody answered in 24 hours", this.now);
        refuseAnswer(db, id, "expired", "you (phone)", this.now);
        return { note: "That request expired.", close: true };
      }
      decide(db, id, answer === "y" ? "approved" : "denied", "you (phone)", this.now);
      return { note: answer === "y" ? "Allowed. The task goes on." : "Denied. The task stops.", close: true };
    });
    await this.tg.answerCallback(q.id, r.note);
    if (r.close) await this.closeCards(id);
  }

  /** Looks for things to send, and for cards to update. Runs every few seconds. */
  async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      await this.sendApprovals();
      await this.closeCards();
      await this.sendResults();
      await this.sendSummaries();
    } catch (e) {
      this.o.log?.(`phone: ${(e as Error).message}`);
    } finally {
      this.scanning = false;
    }
  }

  private record(kind: Kind, ref: string, messageId: number | null, text: string): void {
    this.withDb((db) =>
      db
        .query(
          "INSERT OR IGNORE INTO phone_messages (kind, ref_id, chat_id, message_id, text, sent_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(kind, ref, String(this.c.chatId), messageId, text, this.now()),
    );
  }

  private async sendApprovals(): Promise<void> {
    const rows = this.withDb((db) =>
      db
        .query<
          {
            id: string;
            summary: string;
            payload_json: string;
            payload_hash: string;
            expires_at: number;
            goal: string;
            bot: string;
          },
          [number, number]
        >(
          `SELECT a.id, a.summary, a.payload_json, a.payload_hash, a.expires_at, r.goal, COALESCE(g.name, 'A bot') AS bot
           FROM approvals a JOIN runs r ON r.id = a.run_id LEFT JOIN agents g ON g.id = r.agent_id
           WHERE a.status = 'pending' AND a.kind = 'spend' AND a.rowid > ? AND a.expires_at > ?
             AND NOT EXISTS (SELECT 1 FROM phone_messages p WHERE p.kind = 'approval' AND p.ref_id = a.id)
           ORDER BY a.rowid`,
        )
        .all(this.c.approvalsAfter, this.now()),
    );
    for (const a of rows) {
      let grant: number | null = null;
      try {
        const p = JSON.parse(a.payload_json) as { grantUsd?: unknown };
        if (typeof p.grantUsd === "number") grant = p.grantUsd;
      } catch {}
      const text = approvalText(
        { bot: a.bot, summary: a.summary, goal: a.goal, grantUsd: grant, expiresAt: a.expires_at },
        this.c.notify,
        this.now(),
      );
      const msg = await this.tg.sendMessage(this.c.chatId, text, approvalButtons(a.id, a.payload_hash));
      this.record("approval", a.id, msg.message_id, text);
    }
  }

  /** Cards whose request was answered (anywhere) or expired: show the outcome, remove the buttons. */
  private async closeCards(only?: string): Promise<void> {
    const t = this.now();
    const rows = this.withDb((db) =>
      db
        .query<
          {
            ref_id: string;
            message_id: number | null;
            text: string;
            status: string;
            decided_by: string | null;
            decided_at: number | null;
            expires_at: number;
          },
          [number]
        >(
          `SELECT p.ref_id, p.message_id, p.text, a.status, a.decided_by, a.decided_at, a.expires_at
           FROM phone_messages p JOIN approvals a ON a.id = p.ref_id
           WHERE p.kind = 'approval' AND p.closed_at IS NULL AND (a.status != 'pending' OR a.expires_at < ?)`,
        )
        .all(t),
    ).filter((r) => !only || r.ref_id === only);
    for (const r of rows) {
      const status = r.status === "pending" ? "expired" : r.status;
      if (r.message_id !== null) {
        await this.tg.editMessage(
          this.c.chatId,
          r.message_id,
          outcomeText(r.text, status, r.decided_by, r.decided_at ?? t),
        );
      }
      this.withDb((db) =>
        db.query("UPDATE phone_messages SET closed_at = ? WHERE kind = 'approval' AND ref_id = ?").run(t, r.ref_id),
      );
    }
  }

  private async sendResults(): Promise<void> {
    const t = this.now();
    const rows = this.withDb((db) =>
      db
        .query<
          {
            id: string;
            state: string;
            goal: string;
            summary: string | null;
            error: string | null;
            bot: string;
            routine: string | null;
            quiet: number;
          },
          [number, number]
        >(
          `SELECT r.id, r.state, r.goal, r.summary, r.error, COALESCE(g.name, 'A bot') AS bot,
                  t.name AS routine, COALESCE(t.quiet, 0) AS quiet
           FROM runs r LEFT JOIN agents g ON g.id = r.agent_id LEFT JOIN routines t ON t.id = r.routine_id
           WHERE r.finished_at > ? AND r.finished_at <= ? AND r.state IN ('REVIEWING','SUCCEEDED','KEPT','FAILED')
             AND NOT EXISTS (SELECT 1 FROM phone_messages p WHERE p.ref_id = r.id AND p.kind IN ('finished','failed','review'))
           ORDER BY r.finished_at`,
        )
        .all(this.c.pairedAt, t - SETTLE_MS),
    );
    for (const r of rows) {
      const kind: Kind = r.state === "FAILED" ? "failed" : r.state === "REVIEWING" ? "review" : "finished";
      const bot = r.routine ? `${r.bot}, ${r.routine}` : r.bot;
      // A quiet routine ("message me only if something needs me") sends no news of a job well done.
      if (r.quiet === 1 && kind === "finished") {
        this.record(kind, r.id, null, "");
        continue;
      }
      let text: string | null;
      if (this.c.notify === "needs-you") text = kind === "review" ? reviewOnlyText(bot) : null;
      else {
        let changes: Changes | undefined;
        if (r.state === "REVIEWING" || r.state === "KEPT") {
          try {
            const c = changesOf(this.o.home, r.id, this.now);
            changes = { added: c.added, modified: c.modified, deleted: c.deleted };
          } catch {}
        }
        const info = { bot, goal: r.goal, summary: r.summary, error: r.error, state: r.state, changes };
        text = kind === "failed" ? failedText(info) : finishedText(info);
      }
      if (text === null) {
        this.record(kind, r.id, null, ""); // nothing to send in this mode; don't look at it again
        continue;
      }
      const msg = await this.tg.sendMessage(this.c.chatId, text);
      this.record(kind, r.id, msg.message_id, text);
    }
  }

  /** The daily summary (M6), as it was written to your main bot's chat; not in "only what needs you". */
  private async sendSummaries(): Promise<void> {
    const rows = this.withDb((db) =>
      db
        .query<{ id: string; text: string }, [number]>(
          `SELECT m.id, m.text FROM messages m
           WHERE m.role = 'bot' AND m.created_at > ? AND m.data_json LIKE '%"kind":"summary"%'
             AND NOT EXISTS (SELECT 1 FROM phone_messages p WHERE p.kind = 'summary' AND p.ref_id = m.id)
           ORDER BY m.created_at`,
        )
        .all(this.c.pairedAt),
    );
    for (const m of rows) {
      if (this.c.notify === "needs-you") {
        this.record("summary", m.id, null, "");
        continue;
      }
      const msg = await this.tg.sendMessage(this.c.chatId, m.text);
      this.record("summary", m.id, msg.message_id, m.text);
    }
  }
}
