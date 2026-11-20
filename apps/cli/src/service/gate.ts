import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { covoPaths } from "@covo/core";

// Who may use the local API (Phase 3 M1). Any website you visit can try to send requests to
// 127.0.0.1, so a request must pass every check:
//   1. Host is exactly 127.0.0.1:<port> or localhost:<port> (stops DNS rebinding).
//   2. If an Origin is sent, it is this service's own (stops other websites; there is no CORS).
//   3. It carries the API token (scripts, the Mac app) or a session cookie from pairing (the app).
//   4. A cookie-signed request that changes something must also carry our own Origin and send JSON.
// Pairing: `covo app` asks for a one-time code over the private socket and opens the app with it
// in the address fragment (never sent to any server). The app trades it for an HttpOnly,
// SameSite=Strict cookie. Codes last 2 minutes and work once.

export const tokenPath = (home: string) => join(covoPaths(home).state, "api-token");
export const COOKIE = "covo_session";
const CODE_TTL_MS = 2 * 60_000;
const SESSION_TTL_MS = 30 * 86_400_000;

/** The API token, created on first use, readable only by you. */
export function apiToken(home: string): string {
  const p = tokenPath(home);
  if (existsSync(p)) {
    const t = readFileSync(p, "utf8").trim();
    if (/^[a-f0-9]{64}$/.test(t)) return t;
  }
  mkdirSync(dirname(p), { recursive: true });
  const t = randomBytes(32).toString("hex");
  writeFileSync(p, `${t}\n`, { mode: 0o600 });
  chmodSync(p, 0o600);
  return t;
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

function cookieValue(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

/** Why a request was refused. */
export type Refusal = "address" | "website" | "token" | "session" | "origin" | "code" | "format";

export type Verdict =
  | { ok: true; by: "token" | "session" }
  | { ok: false; status: 400 | 401 | 403 | 415; error: string; reason: Refusal };

export class Gate {
  private readonly codes = new Map<string, number>();
  private readonly sessions = new Map<string, number>();

  constructor(
    private readonly token: string,
    private port: number,
    private readonly now: () => number = Date.now,
  ) {}

  setPort(port: number): void {
    this.port = port;
  }

  get origins(): string[] {
    return [`http://127.0.0.1:${this.port}`, `http://localhost:${this.port}`];
  }

  /** Checks 1 and 2: the request is addressed to this service and comes from no other website. */
  checkPlace(req: Request): Verdict | null {
    const host = req.headers.get("host") ?? "";
    if (!this.origins.some((o) => o === `http://${host}`)) {
      return {
        ok: false,
        status: 403,
        reason: "address",
        error: "Wrong address. Covo's API only answers at 127.0.0.1.",
      };
    }
    const origin = req.headers.get("origin");
    if (origin !== null && !this.origins.includes(origin)) {
      return { ok: false, status: 403, reason: "website", error: "Requests from other websites aren't allowed." };
    }
    return null;
  }

  /** Checks 3 and 4. */
  checkAuth(req: Request): Verdict {
    const auth = req.headers.get("authorization") ?? "";
    if (auth.startsWith("Bearer ") && same(auth.slice(7).trim(), this.token)) return { ok: true, by: "token" };
    const sid = cookieValue(req, COOKIE);
    const exp = sid ? this.sessions.get(sid) : undefined;
    if (sid && exp !== undefined) {
      if (exp < this.now()) {
        this.sessions.delete(sid);
        return {
          ok: false,
          status: 401,
          reason: "session",
          error: "Your session ended. Open the app again with: covo app",
        };
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        if (!this.origins.includes(req.headers.get("origin") ?? "")) {
          return { ok: false, status: 403, reason: "origin", error: "Changes must come from Covo's own app." };
        }
      }
      return { ok: true, by: "session" };
    }
    return {
      ok: false,
      status: 401,
      reason: "token",
      error: "Sign in first: open the app with covo app, or send the API token.",
    };
  }

  /** A one-time pairing code (asked for over the private socket only). */
  newCode(): string {
    for (const [c, exp] of this.codes) if (exp < this.now()) this.codes.delete(c);
    const code = randomBytes(16).toString("base64url");
    this.codes.set(code, this.now() + CODE_TTL_MS);
    return code;
  }

  /** Trades a pairing code for a session; returns the Set-Cookie value, or null. */
  pair(code: unknown): string | null {
    if (typeof code !== "string") return null;
    const exp = this.codes.get(code);
    this.codes.delete(code); // one use, right or wrong
    if (exp === undefined || exp < this.now()) return null;
    const sid = randomBytes(32).toString("base64url");
    this.sessions.set(sid, this.now() + SESSION_TTL_MS);
    return `${COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`;
  }

  endSession(req: Request): void {
    const sid = cookieValue(req, COOKIE);
    if (sid) this.sessions.delete(sid);
  }
}

const HOUR = 3_600_000;
const clip = (s: string | null, n: number) => (s === null ? null : s.slice(0, n));

/**
 * Refused requests go to the activity log (Phase 3 M7): another website or address, no token or a
 * wrong one, a change without the app's own origin, a bad sign-in code. At most once an hour for each
 * kind of refusal and each place it came from, so a page hammering the port can't flood the log; the
 * next entry counts the ones in between. The token, cookies and codes are never logged.
 */
export class RefusalLog {
  private readonly seen = new Map<string, { at: number; more: number }>();

  constructor(
    private readonly write: (detail: Record<string, unknown>) => void,
    private readonly now: () => number = Date.now,
  ) {}

  note(req: Request, reason: Refusal, status: number): void {
    if (reason === "session") return; // an old session ran out: routine, not an attack
    const origin = clip(req.headers.get("origin"), 120);
    const host = clip(req.headers.get("host"), 120);
    const key = `${reason}|${origin ?? host ?? ""}`;
    const last = this.seen.get(key);
    if (last && this.now() - last.at < HOUR) {
      last.more++;
      return;
    }
    if (this.seen.size > 500) this.seen.clear();
    this.seen.set(key, { at: this.now(), more: 0 });
    let path = "";
    try {
      path = new URL(req.url).pathname.slice(0, 200);
    } catch {}
    try {
      this.write({
        reason,
        status,
        method: req.method,
        path,
        host,
        origin,
        ...(last?.more ? { notLogged: last.more } : {}),
      });
    } catch {} // logging must never break the API
  }
}
