import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { covoPaths } from "@covo/core";

// Your phone's connection (Phase 3 M5). The bot's token is in the Keychain (TOKEN_ID), never in a
// file. This file only says which Telegram chat is yours, readable only by you.

/** The Keychain item that holds the Telegram bot's token. */
export const TOKEN_ID = "covo-telegram-bot";

export interface PhoneConfig {
  botId: number;
  botUsername: string;
  /** Your private chat with the bot, and your Telegram account: the only ones Covo listens to. */
  chatId: number;
  userId: number;
  /** Your Telegram first name, to show in `covo phone status`. */
  name: string;
  pairedAt: number;
  /** Only approvals newer than this (approvals' rowid at pairing) go to the phone. */
  approvalsAfter: number;
  /** "summaries": finished and failed tasks too (short, never file contents). "needs-you": only what waits on you. */
  notify: "summaries" | "needs-you";
  /** Start a task by messaging the bot. Off unless you turn it on. */
  tasks: boolean;
}

export const phonePath = (home: string) => join(covoPaths(home).state, "phone.json");
const offsetPath = (home: string) => join(covoPaths(home).state, "phone-offset");

export function loadPhone(home: string): PhoneConfig | null {
  const p = phonePath(home);
  if (!existsSync(p)) return null;
  try {
    const c = JSON.parse(readFileSync(p, "utf8")) as PhoneConfig;
    if (typeof c.chatId !== "number" || typeof c.userId !== "number") return null;
    return { ...c, notify: c.notify === "needs-you" ? "needs-you" : "summaries", tasks: c.tasks === true };
  } catch {
    return null;
  }
}

export function savePhone(home: string, c: PhoneConfig): void {
  const p = phonePath(home);
  mkdirSync(covoPaths(home).state, { recursive: true });
  writeFileSync(p, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
  chmodSync(p, 0o600);
}

export function removePhone(home: string): void {
  rmSync(phonePath(home), { force: true });
  rmSync(offsetPath(home), { force: true });
}

/** Telegram's position in the message stream, so nothing is handled twice after a restart. */
export function readOffset(home: string): number {
  try {
    const n = Number(readFileSync(offsetPath(home), "utf8").trim());
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function writeOffset(home: string, offset: number): void {
  writeFileSync(offsetPath(home), `${offset}\n`, { mode: 0o600 });
}
