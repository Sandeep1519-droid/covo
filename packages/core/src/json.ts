// Canonical JSON: object keys sorted at every level, no extra whitespace.
// The same value always produces the same bytes, which is what hashing and signing need.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalise(value));
}

function normalise(value: unknown): Json {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: ${value} is not valid JSON`);
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : normalise(v)));
  if (typeof value === "object") {
    const out: { [key: string]: Json } = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = normalise(v);
    }
    return out;
  }
  throw new TypeError(`canonicalJson: cannot encode a ${typeof value}`);
}

export function sha256Hex(input: string): string {
  return new Bun.CryptoHasher("sha256").update(input).digest("hex");
}
