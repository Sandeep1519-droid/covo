import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { covoPaths, newId } from "@covo/core";
import { migrate, openDb } from "@covo/db";
import { RunError } from "./run.ts";
import type { RunState } from "./state.ts";

// Chats (Phase 3 M3). Each bot has a conversation; each of your messages becomes a task. The bot's
// side of the chat is the task itself (its state, summary and changes), so only your words are stored.
// When a message starts a task, the last few turns go along as context, clearly marked, so "do the
// same for the other file" works. The context is never treated as instructions on its own.

/** Turns of earlier chat sent with a new task, and how much text at most. */
export const CONTEXT_TURNS = 6;
const CONTEXT_CHARS = 3_000;
const TURN_CHARS = 500;
const MAX_TEXT = 20_000;

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: "you" | "bot";
  text: string;
  runId: string | null;
  model: string | null;
  /** The task couldn't start (no model, Covo shutting down…). */
  error: string | null;
  /** More than text: the daily summary's sections, a routine made in chat. */
  data: Record<string, unknown> | null;
  createdAt: number;
}

interface Row {
  id: string;
  conversation_id: string;
  role: "you" | "bot";
  text: string;
  run_id: string | null;
  model: string | null;
  error: string | null;
  data_json: string | null;
  created_at: number;
}

const parseData = (s: string | null): Record<string, unknown> | null => {
  if (!s) return null;
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const toMessage = (r: Row): ChatMessage => ({
  id: r.id,
  conversationId: r.conversation_id,
  role: r.role,
  text: r.text,
  runId: r.run_id,
  model: r.model,
  error: r.error,
  data: parseData(r.data_json),
  createdAt: r.created_at,
});

function withDb<T>(home: string, now: () => number, fn: (db: Database) => T): T {
  const p = covoPaths(home).db;
  if (!existsSync(p)) throw new RunError("Covo isn't set up yet. Run: covo init");
  const db = openDb(p);
  try {
    migrate(db, now);
    return fn(db);
  } finally {
    db.close();
  }
}

function botId(db: Database, nameOrId: string): { id: string; name: string } {
  const b = db
    .query<{ id: string; name: string }, [string, string]>(
      "SELECT id, name FROM agents WHERE (id = ? OR lower(name) = lower(?)) AND status != 'archived'",
    )
    .get(nameOrId, nameOrId);
  if (!b) throw new RunError(`No bot called "${nameOrId}".`);
  return b;
}

/** The bot's current conversation, started if there is none. */
function conversation(db: Database, agentId: string, now: () => number): string {
  const c = db
    .query<{ id: string }, [string]>(
      "SELECT id FROM conversations WHERE agent_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1",
    )
    .get(agentId);
  if (c) return c.id;
  const id = newId("chat", now());
  db.query("INSERT INTO conversations (id, agent_id, created_at, updated_at) VALUES (?, ?, ?, ?)").run(
    id,
    agentId,
    now(),
    now(),
  );
  return id;
}

const SELECT = "SELECT id, conversation_id, role, text, run_id, model, error, data_json, created_at FROM messages";

/** The latest messages with a bot, oldest first. */
export function listMessages(home: string, bot: string, o: { limit?: number; now?: () => number } = {}): ChatMessage[] {
  const now = o.now ?? Date.now;
  return withDb(home, now, (db) => {
    const b = botId(db, bot);
    const rows = db
      .query<Row, [string, number]>(
        `${SELECT} WHERE conversation_id IN (SELECT id FROM conversations WHERE agent_id = ?)
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(b.id, Math.min(500, Math.max(1, o.limit ?? 100)));
    return rows.reverse().map(toMessage);
  });
}

/** What the bot said back, in a few words, for the context of the next task. */
function replyOf(state: RunState | null, summary: string | null, error: string | null): string {
  if (error && (state === "FAILED" || state === "STOPPED")) return `(it didn't finish: ${error})`;
  if (summary) return summary;
  if (!state) return "(no reply)";
  return `(${String(state).toLowerCase()})`;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The earlier turns of this conversation, as a marked block for the model. Empty if none. */
function contextFor(db: Database, conversationId: string, before: number, botName: string): string {
  const turns = db
    .query<
      { text: string; error: string | null; state: RunState | null; summary: string | null; run_error: string | null },
      [string, number, number]
    >(
      `SELECT m.text, m.error, r.state, r.summary, r.error AS run_error FROM messages m
       LEFT JOIN runs r ON r.id = m.run_id
       WHERE m.conversation_id = ? AND m.role = 'you' AND m.created_at <= ?
       ORDER BY m.created_at DESC, m.id DESC LIMIT ?`,
    )
    .all(conversationId, before, CONTEXT_TURNS); // newest first, so the newest win when space runs out
  const lines: string[] = [];
  let used = 0;
  for (const t of turns) {
    const reply = t.error ? `(couldn't start: ${t.error})` : replyOf(t.state, t.summary, t.run_error);
    const pair = `You: ${clip(t.text, TURN_CHARS)}\n${botName}: ${clip(reply, TURN_CHARS)}`;
    if (used + pair.length > CONTEXT_CHARS) break;
    lines.unshift(pair);
    used += pair.length;
  }
  return lines.join("\n");
}

export interface NewMessage {
  message: ChatMessage;
  bot: { id: string; name: string };
  /** Earlier turns, to send with the task (empty for the first message). */
  context: string;
}

/** Saves your message in the bot's conversation and returns the context for its task. */
export function addMessage(
  home: string,
  bot: string,
  text: string,
  o: { model?: string; now?: () => number; data?: Record<string, unknown> } = {},
): NewMessage {
  const now = o.now ?? Date.now;
  const t = text.trim();
  if (!t) throw new RunError("Write a message first.");
  if (t.length > MAX_TEXT) throw new RunError(`A message can be at most ${MAX_TEXT} characters.`);
  return withDb(home, now, (db) =>
    db.transaction(() => {
      const b = botId(db, bot);
      const conv = conversation(db, b.id, now);
      const at = now();
      const context = contextFor(db, conv, at, b.name);
      const id = newId("msg", at);
      db.query(
        "INSERT INTO messages (id, conversation_id, role, text, model, data_json, created_at) VALUES (?, ?, 'you', ?, ?, ?, ?)",
      ).run(id, conv, t, o.model ?? null, o.data ? JSON.stringify(o.data) : null, at);
      db.query("UPDATE conversations SET updated_at = ? WHERE id = ?").run(at, conv);
      const row = db.query<Row, [string]>(`${SELECT} WHERE id = ?`).get(id) as Row;
      return { message: toMessage(row), bot: b, context };
    })(),
  );
}

/** Records which task a message started. */
export function linkRun(home: string, messageId: string, runId: string, now: () => number = Date.now): void {
  withDb(home, now, (db) => {
    db.query("UPDATE messages SET run_id = ? WHERE id = ? AND run_id IS NULL").run(runId, messageId);
  });
}

/** Records why a message's task never started. */
export function failMessage(home: string, messageId: string, error: string, now: () => number = Date.now): void {
  withDb(home, now, (db) => {
    db.query("UPDATE messages SET error = ? WHERE id = ? AND run_id IS NULL").run(error, messageId);
  });
}

/** A message from the bot that isn't a task's reply: the daily summary, a routine made in chat. */
export function addBotMessage(
  home: string,
  bot: string,
  text: string,
  data: Record<string, unknown> | null = null,
  now: () => number = Date.now,
): ChatMessage {
  return withDb(home, now, (db) =>
    db.transaction(() => {
      const b = botId(db, bot);
      const conv = conversation(db, b.id, now);
      const at = now();
      const id = newId("msg", at);
      db.query(
        "INSERT INTO messages (id, conversation_id, role, text, data_json, created_at) VALUES (?, ?, 'bot', ?, ?, ?)",
      ).run(id, conv, text, data ? JSON.stringify(data) : null, at);
      db.query("UPDATE conversations SET updated_at = ? WHERE id = ?").run(at, conv);
      return toMessage(db.query<Row, [string]>(`${SELECT} WHERE id = ?`).get(id) as Row);
    })(),
  );
}
