import { randomInt } from "node:crypto";
import type { TelegramApi, TgUpdate, TgUser } from "./telegram.ts";

// Pairing: `covo phone connect` shows a one-time code; you send it to your bot from your phone. The
// chat it arrives in becomes the only one Covo listens to.

const ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789"; // no 0/O, 1/I/L, U

/** A one-time code like COVO-7K2M-9QXR (about 39 bits; it works for a few minutes). */
export function newPairingCode(): string {
  const part = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  return `COVO-${part()}-${part()}`;
}

/** Opens Telegram on the phone with the code ready to send. */
export const pairingLink = (botUsername: string, code: string) => `https://t.me/${botUsername}?start=${code}`;

export interface Paired {
  chatId: number;
  userId: number;
  name: string;
  /** The next update to ask Telegram for, so the pairing message isn't handled again. */
  offset: number;
}

/**
 * Waits until the code arrives in a private chat with the bot. Messages without the code are
 * reported to `onOther` (someone else, or a typo) and otherwise ignored.
 */
export async function waitForPairing(
  tg: TelegramApi,
  code: string,
  o: { signal?: AbortSignal; deadline: number; now?: () => number; onOther?: (from: TgUser | undefined) => void },
): Promise<Paired | null> {
  const now = o.now ?? Date.now;
  let offset = 0;
  const wanted = code.toUpperCase();
  while (now() < o.deadline && !o.signal?.aborted) {
    const wait = Math.max(1, Math.min(25, Math.floor((o.deadline - now()) / 1000)));
    let updates: TgUpdate[];
    try {
      updates = await tg.getUpdates(offset, wait, o.signal);
    } catch {
      if (o.signal?.aborted) return null;
      // Another copy of Covo asking at the same time (409), or the network: try again shortly.
      await Bun.sleep(1_000);
      continue;
    }
    for (const u of updates) {
      offset = u.update_id + 1;
      const m = u.message;
      if (!m) continue;
      const text = (m.text ?? "").toUpperCase();
      if (m.chat.type === "private" && m.from && !m.from.is_bot && text.includes(wanted)) {
        // Tell Telegram this update is handled, so it isn't delivered again.
        await tg.getUpdates(offset, 0, o.signal).catch(() => []);
        return { chatId: m.chat.id, userId: m.from.id, name: m.from.first_name ?? m.from.username ?? "you", offset };
      }
      o.onOther?.(m.from);
    }
  }
  return null;
}
