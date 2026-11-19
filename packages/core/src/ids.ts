// Sortable, URL-safe IDs like "run_01JD3XKQ7M4Z8V2N6P0R5T9W1Y".
// Format: <prefix>_<10-char time><16-char random>, Crockford base32 (ULID layout).

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export type IdPrefix = "run" | "step" | "bot" | "dept" | "appr" | "evt" | "chat" | "msg";

function encodeTime(ms: number): string {
  let out = "";
  let t = ms;
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function encodeRandom(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let out = "";
  for (const b of bytes) out += ALPHABET[b % 32];
  return out;
}

export function newId(prefix: IdPrefix, now: number = Date.now()): string {
  return `${prefix}_${encodeTime(now)}${encodeRandom()}`;
}

const ID_PATTERN = /^(run|step|bot|dept|appr|evt|chat|msg)_[0-9A-HJKMNP-TV-Z]{26}$/;

export function isId(value: string, prefix?: IdPrefix): boolean {
  if (!ID_PATTERN.test(value)) return false;
  return prefix ? value.startsWith(`${prefix}_`) : true;
}

/** Milliseconds encoded in an ID's time part. */
export function idTime(id: string): number {
  const time = id.slice(id.indexOf("_") + 1, id.indexOf("_") + 11);
  let ms = 0;
  for (const ch of time) ms = ms * 32 + ALPHABET.indexOf(ch);
  return ms;
}
