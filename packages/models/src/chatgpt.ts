import { createHash, randomBytes, randomUUID, webcrypto } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { SecretStore } from "@covo/platform";

// "Sign in with ChatGPT" (Phase 4 M1): your ChatGPT Plus or Pro plan pays for Covo's model calls.
// OpenAI allows this for open-source apps that run on your own computer (developers.openai.com/siwc,
// a preview, checked 20 Nov 2026; docs/SUBSCRIPTIONS.md). How it works:
//   1. Covo opens OpenAI's own sign-in page in your browser (OAuth with PKCE: no client secret).
//      You sign in there and agree; Covo never sees your password.
//   2. OpenAI sends you back to a one-time page Covo serves on 127.0.0.1, with a code. Covo trades
//      it for tokens and checks OpenAI's signature on who you are.
//   3. The tokens go to the macOS Keychain. The access token lasts an hour; Covo renews it with the
//      refresh token (which changes every time, so renewals are done one at a time).
// Covo never reads the Codex program's sign-in (~/.codex), and never puts tokens in a URL or a log.

export const CHATGPT = {
  auth: "https://auth.openai.com",
  api: "https://api.openai.com/v1",
  scopes: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
  planScope: "chatgpt.tokens.use.direct",
  manageUsage: "https://chatgpt.com/settings/usage",
  appName: "Covo",
  port: 1455,
};

/** What to say when OpenAI won't let Covo use the plan (seen live: a plan that ended). */
export const PLAN_NEEDED =
  "OpenAI didn't let Covo use your ChatGPT plan. Using it in other apps needs an active ChatGPT Plus or Pro plan; OpenAI's page says \"A required permission is unavailable\" when the plan doesn't include it. Nothing was saved.";

const ACCESS_ID = "chatgpt-access";
const REFRESH_ID = "chatgpt-refresh";
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;
/** Refresh errors that mean the sign-in is over: sign in again (siwc token reference). */
const ENDED = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

export class ChatGPTError extends Error {}
/** The sign-in ended (revoked, expired or replaced): sign in again. */
export class ChatGPTSignInEnded extends ChatGPTError {}

export interface ChatGPTOptions {
  home: string;
  store: SecretStore;
  fetch?: typeof fetch;
  now?: () => number;
  /** Tests point these at stand-in servers. */
  authBase?: string;
  apiBase?: string;
  /** Where to say what happened, in plain words (never a code or token): the service's log. */
  log?: (line: string) => void;
}

/** What Covo keeps about the ChatGPT sign-in, besides the tokens. Nothing secret. */
export interface ChatGPTAccount {
  /** This Mac, to OpenAI: an opaque id made once (ext_agent_host_id). */
  hostId: string;
  /** The id OpenAI gave Covo for your account ("oaiapp_…"), reused when you sign in again. */
  clientId?: string;
  subject?: string;
  email?: string | null;
  scopes?: string[];
  /** When the access token runs out. */
  expiresAt?: number;
  signedInAt?: number;
  /** The one-time "You're using your ChatGPT plan" note was shown. */
  welcomed?: boolean;
}

const statePath = (home: string) => join(home, "state", "chatgpt.json");
const lockPath = (home: string) => join(home, "state", "chatgpt-refresh.lock");

export function readAccount(home: string): ChatGPTAccount | null {
  try {
    const a = JSON.parse(readFileSync(statePath(home), "utf8")) as ChatGPTAccount;
    return typeof a.hostId === "string" ? a : null;
  } catch {
    return null;
  }
}

function writeAccount(home: string, a: ChatGPTAccount): void {
  const p = statePath(home);
  mkdirSync(join(home, "state"), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(a, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, p);
}

/** Signed in, with the plan scope, and the tokens are there. */
export async function chatgptSignedIn(o: Pick<ChatGPTOptions, "home" | "store">): Promise<boolean> {
  const a = readAccount(o.home);
  return Boolean(a?.subject && a.scopes?.includes(CHATGPT.planScope) && (await o.store.get(REFRESH_ID)));
}

export function markWelcomed(home: string): void {
  const a = readAccount(home);
  if (a) writeAccount(home, { ...a, welcomed: true });
}

const b64url = (b: Uint8Array | Buffer) => Buffer.from(b).toString("base64url");
const random = (n = 32) => b64url(randomBytes(n));

interface Discovery {
  issuer: string;
  jwks_uri: string;
  revocation_endpoint?: string;
}

async function discover(o: ChatGPTOptions): Promise<Discovery> {
  const base = o.authBase ?? CHATGPT.auth;
  const res = await (o.fetch ?? fetch)(`${base}/.well-known/openid-configuration`);
  if (!res.ok) throw new ChatGPTError(`OpenAI's sign-in service answered ${res.status}.`);
  const d = (await res.json()) as Discovery;
  if (!d.issuer || !d.jwks_uri) throw new ChatGPTError("OpenAI's sign-in service sent an incomplete configuration.");
  return d;
}

/** Checks OpenAI's signature on the ID token, and that it's for this sign-in. Returns its claims. */
export async function verifyIdToken(
  token: string,
  want: { issuer: string; jwksUri: string; audience: string; nonce: string; now: number; fetch?: typeof fetch },
): Promise<{ sub: string; email?: string }> {
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) throw new ChatGPTError("OpenAI's ID token is malformed.");
  const header = JSON.parse(Buffer.from(h, "base64url").toString()) as { alg?: string; kid?: string };
  const claims = JSON.parse(Buffer.from(p, "base64url").toString()) as {
    iss?: string;
    aud?: string | string[];
    exp?: number;
    nonce?: string;
    sub?: string;
    email?: string;
  };
  if (header.alg !== "RS256") throw new ChatGPTError(`OpenAI's ID token uses an unexpected signature (${header.alg}).`);
  const res = await (want.fetch ?? fetch)(want.jwksUri);
  if (!res.ok) throw new ChatGPTError(`Couldn't get OpenAI's signing keys (${res.status}).`);
  const keys = ((await res.json()) as { keys?: (webcrypto.JsonWebKey & { kid?: string })[] }).keys ?? [];
  const jwk = keys.find((k) => k.kid === header.kid) ?? (keys.length === 1 ? keys[0] : undefined);
  if (!jwk) throw new ChatGPTError("OpenAI's ID token is signed with a key Covo can't find.");
  const key = await webcrypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
    "verify",
  ]);
  const ok = await webcrypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    Buffer.from(s, "base64url"),
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!ok) throw new ChatGPTError("OpenAI's signature on the ID token doesn't match.");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const bare = (u: string | undefined) => (u ?? "").replace(/\/+$/, "");
  if (bare(claims.iss) !== bare(want.issuer))
    throw new ChatGPTError("The ID token wasn't issued by OpenAI's sign-in service.");
  if (!aud.includes(want.audience)) throw new ChatGPTError("The ID token was made for another app.");
  if (!claims.exp || claims.exp * 1000 < want.now) throw new ChatGPTError("The ID token has expired.");
  if (claims.nonce !== want.nonce) throw new ChatGPTError("The ID token is from another sign-in attempt.");
  if (!claims.sub) throw new ChatGPTError("The ID token doesn't say who signed in.");
  return { sub: claims.sub, ...(claims.email ? { email: claims.email } : {}) };
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(
  o: ChatGPTOptions,
  form: Record<string, string>,
): Promise<{ status: number; body: TokenResponse }> {
  const res = await (o.fetch ?? fetch)(`${o.authBase ?? CHATGPT.auth}/api/accounts/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  let body: TokenResponse = {};
  try {
    body = (await res.json()) as TokenResponse;
  } catch {}
  return { status: res.status, body };
}

async function saveTokens(o: ChatGPTOptions, t: TokenResponse): Promise<void> {
  if (!t.access_token || !t.refresh_token) throw new ChatGPTError("OpenAI didn't send the tokens Covo needs.");
  await o.store.put(ACCESS_ID, t.access_token, "ChatGPT sign-in (access)");
  await o.store.put(REFRESH_ID, t.refresh_token, "ChatGPT sign-in (refresh)");
}

const PAGE = (title: string, text: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{font:16px -apple-system,system-ui,sans-serif;max-width:480px;margin:18vh auto;padding:0 24px;color:#1d1d1f}@media(prefers-color-scheme:dark){body{background:#1f1f1f;color:#ececec}}</style><h1 style="font-size:22px">${title}</h1><p>${text}</p>`;

export interface SignIn {
  /** Open this in the browser. */
  url: string;
  /** Resolves when you've signed in and Covo has saved the sign-in. */
  done: Promise<{ email: string | null; firstTime: boolean }>;
  cancel(): void;
}

/**
 * Starts signing in: a one-time page on 127.0.0.1 waits for OpenAI to send you back. Open `url` in
 * your browser; `done` settles when it's over (or after 10 minutes).
 *
 * If OpenAI refuses the code with invalid_grant, its docs say to discard that code and start a fresh
 * authorization with the issued client ID. Covo does that once by itself: the page you land on sends
 * your browser straight into the new attempt.
 */
export async function beginChatGPTSignIn(o: ChatGPTOptions & { port?: number }): Promise<SignIn> {
  const now = o.now ?? Date.now;
  const log = o.log ?? (() => {});
  const before = readAccount(o.home);
  // This Mac's id for OpenAI: made once, kept, and never a credential.
  const account: ChatGPTAccount = before ?? { hostId: `urn:uuid:${randomUUID()}` };
  if (!before) writeAccount(o.home, account);
  const discovery = await discover(o);

  let settle: { ok: (v: { email: string | null; firstTime: boolean }) => void; fail: (e: Error) => void };
  const done = new Promise<{ email: string | null; firstTime: boolean }>((ok, fail) => {
    settle = { ok, fail };
  });
  // The result may settle before anyone awaits it (the browser comes back first): that's not an error.
  done.catch(() => {});
  let finished = false;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = (err: Error | null, value?: { email: string | null; firstTime: boolean }) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    setTimeout(() => server?.stop(true), 250); // let the browser get its page first
    if (err) {
      log(`sign-in ended: ${err.message}`);
      settle.fail(err);
    } else {
      log("signed in");
      settle.ok(value as { email: string | null; firstTime: boolean });
    }
  };

  let redirect = "";
  /** One authorization attempt: its own state, nonce and PKCE verifier. */
  interface Attempt {
    n: number;
    state: string;
    nonce: string;
    verifier: string;
    /** The client id sent to OpenAI's authorize page. */
    client: string;
    /** The first callback for this attempt; a second one gets the same answer (no second exchange). */
    result?: Promise<{ title: string; text: string; status: number; location?: string }>;
  }
  let attempt: Attempt;
  const authorizeUrl = (a: Attempt) => {
    const q = new URLSearchParams({
      client_id: a.client,
      ...(a.client === "dynamic_agent_client" ? { agent_name_hint: CHATGPT.appName } : {}),
      ext_agent_host_id: account.hostId,
      ...(a.client !== "dynamic_agent_client" && account.email ? { login_hint: account.email } : {}),
      response_type: "code",
      redirect_uri: redirect,
      scope: CHATGPT.scopes,
      resource: CHATGPT.api,
      state: a.state,
      nonce: a.nonce,
      code_challenge_method: "S256",
      code_challenge: b64url(createHash("sha256").update(a.verifier).digest()),
    });
    return `${o.authBase ?? CHATGPT.auth}/api/accounts/authorize?${q.toString()}`;
  };
  const newAttempt = (n: number): Attempt => ({
    n,
    state: random(24),
    nonce: random(24),
    verifier: random(48),
    client: account.clientId ?? "dynamic_agent_client",
  });

  const callback = async (
    a: Attempt,
    url: URL,
  ): Promise<{ title: string; text: string; status: number; location?: string }> => {
    log(`callback ${a.n}: OpenAI sent back ${[...url.searchParams.keys()].join(", ") || "nothing"}`);
    if (url.searchParams.get("error")) {
      const declined = url.searchParams.get("error") === "access_denied";
      finish(
        new ChatGPTError(
          declined ? "You didn't allow Covo to use your ChatGPT plan." : "OpenAI's sign-in didn't finish.",
        ),
      );
      return declined
        ? {
            title: "Not connected",
            text: "You didn't allow it, so nothing changed. You can close this tab.",
            status: 200,
          }
        : {
            title: "Not connected",
            text: "The sign-in didn't finish. You can close this tab and try again in Covo.",
            status: 200,
          };
    }
    const code = url.searchParams.get("code");
    const issued = url.searchParams.get("client_id");
    const clientId = issued ?? account.clientId;
    if (!code || !clientId) {
      finish(new ChatGPTError("OpenAI didn't finish registering Covo. Try again."));
      return {
        title: "Not connected",
        text: "OpenAI didn't finish the sign-in. You can close this tab and try again in Covo.",
        status: 400,
      };
    }
    // When signing in again, OpenAI must send back the same id it gave before.
    if (account.clientId && issued && issued !== account.clientId) {
      finish(new ChatGPTError("OpenAI sent back a different app id than before. Nothing was saved."));
      return {
        title: "Not connected",
        text: "Something didn't match, so nothing was saved. You can close this tab.",
        status: 400,
      };
    }
    // OpenAI's docs: keep the issued client ID, even if this attempt goes no further.
    if (!account.clientId) {
      account.clientId = clientId;
      writeAccount(o.home, account);
    }
    // What you allowed on OpenAI's page. Without the plan, there's nothing to trade the code for.
    const granted = url.searchParams.get("scope");
    if (granted !== null) {
      const names = granted.split(/[\s+]+/).filter(Boolean);
      log(`callback ${a.n}: you allowed ${names.join(", ") || "nothing"}`);
      if (!names.includes(CHATGPT.planScope)) {
        finish(new ChatGPTError(PLAN_NEEDED));
        return {
          title: "Not connected",
          text: "OpenAI didn't let Covo use your ChatGPT plan. This needs an active ChatGPT Plus or Pro plan. You can close this tab.",
          status: 200,
        };
      }
    }
    try {
      const t = await tokenRequest(o, {
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        code_verifier: a.verifier,
        redirect_uri: redirect,
        resource: CHATGPT.api,
      });
      if (t.status !== 200) {
        log(
          `exchange ${a.n}: OpenAI answered ${t.status} ${t.body.error ?? ""}${t.body.error_description ? `: ${t.body.error_description}` : ""} (client ${clientId.slice(0, 7)}…, redirect ${redirect}, verifier ${a.verifier.length} characters)`,
        );
        // Discard the code and start a fresh authorization with the issued client ID, once.
        if (t.body.error === "invalid_grant" && a.n === 1) {
          attempt = newAttempt(2);
          log("starting a fresh authorization with the issued client ID, as OpenAI's docs say");
          return {
            title: "One more step",
            text: "Covo is asking OpenAI again…",
            status: 302,
            location: authorizeUrl(attempt),
          };
        }
        const why = t.body.error_description ? `: ${t.body.error_description}` : "";
        throw new ChatGPTError(
          `OpenAI refused the sign-in code (${t.body.error ?? t.status}${why}). The usual reason: your ChatGPT account doesn't have an active Plus or Pro plan, which using it in other apps needs.`,
        );
      }
      const scopes = (t.body.scope ?? url.searchParams.get("scope") ?? "").split(/[\s+]+/).filter(Boolean);
      // A valid sign-in alone isn't permission to use the plan.
      if (!scopes.includes(CHATGPT.planScope))
        throw new ChatGPTError("You signed in, but didn't allow Covo to use your ChatGPT plan. Nothing was saved.");
      if (!t.body.id_token) throw new ChatGPTError("OpenAI didn't say who signed in.");
      const who = await verifyIdToken(t.body.id_token, {
        issuer: discovery.issuer,
        jwksUri: discovery.jwks_uri,
        audience: clientId,
        nonce: a.nonce,
        now: now(),
        ...(o.fetch ? { fetch: o.fetch } : {}),
      });
      if (account.subject && account.subject !== who.sub) {
        // Another ChatGPT account: start fresh rather than mix the two.
        account.welcomed = false;
      }
      await saveTokens(o, t.body);
      const firstTime = !account.welcomed;
      writeAccount(o.home, {
        ...account,
        clientId,
        subject: who.sub,
        email: who.email ?? null,
        scopes,
        expiresAt: now() + (t.body.expires_in ?? 3600) * 1000,
        signedInAt: now(),
      });
      finish(null, { email: who.email ?? null, firstTime });
      return {
        title: "You're signed in",
        text: "Covo can now use your ChatGPT plan. You can close this tab and go back to Covo.",
        status: 200,
      };
    } catch (e) {
      finish(e instanceof ChatGPTError ? e : new ChatGPTError(`The sign-in didn't finish: ${(e as Error).message}`));
      return {
        title: "Not connected",
        text: "The sign-in didn't finish, and nothing was saved. You can close this tab and try again in Covo.",
        status: 400,
      };
    }
  };

  const handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname !== "/auth/callback") return new Response("Not found", { status: 404 });
    const a = attempt;
    // The state comes first: anything else may be someone else's request.
    if (url.searchParams.get("state") !== a.state) {
      log("callback: a request with a state Covo didn't send was turned away");
      return new Response(PAGE("Covo", "This sign-in link isn't Covo's current one."), {
        status: 400,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (a.result) log(`callback ${a.n}: the browser came back again; answering with the first result`);
    a.result ??= callback(a, url);
    const r = await a.result;
    if (r.location)
      return new Response(null, { status: 302, headers: { location: r.location, "cache-control": "no-store" } });
    return new Response(PAGE(r.title, r.text), {
      status: r.status,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  };

  // OpenAI's own example port first; any free port works, as long as it's 127.0.0.1.
  for (const port of [o.port ?? CHATGPT.port, 0]) {
    try {
      server = Bun.serve({ hostname: "127.0.0.1", port, fetch: handle });
      break;
    } catch {}
  }
  if (!server) throw new ChatGPTError("Couldn't open a local page for the sign-in to come back to.");
  redirect = `http://127.0.0.1:${server.port}/auth/callback`;
  timer = setTimeout(
    () => finish(new ChatGPTError("The sign-in took longer than 10 minutes. Try again.")),
    SIGN_IN_TIMEOUT_MS,
  );
  attempt = newAttempt(1);
  log(
    `sign-in started: ${attempt.client === "dynamic_agent_client" ? "first registration" : "signing in again"}, callback ${redirect}`,
  );
  return {
    url: authorizeUrl(attempt),
    done,
    cancel: () => finish(new ChatGPTError("Sign-in cancelled.")),
  };
}

/** One renewal at a time, in this process and between Covo's processes (the refresh token rotates). */
const renewing = new Map<string, Promise<string>>();

async function withLock<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const p = lockPath(home);
  mkdirSync(join(home, "state"), { recursive: true });
  for (let i = 0; i < 200; i++) {
    try {
      closeSync(openSync(p, "wx"));
      try {
        return await fn();
      } finally {
        rmSync(p, { force: true });
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // A renewal left behind by a crash: take over after 30 seconds.
      try {
        if (Date.now() - statSync(p).mtimeMs > 30_000) rmSync(p, { force: true });
      } catch {}
      await Bun.sleep(50);
    }
  }
  throw new ChatGPTError("Another Covo process is renewing the ChatGPT sign-in; try again in a moment.");
}

/** A valid access token, renewed first when it's about to run out. */
export async function chatgptAccessToken(o: ChatGPTOptions): Promise<string> {
  const now = o.now ?? Date.now;
  const a = readAccount(o.home);
  if (!a?.clientId || !a.subject) throw new ChatGPTSignInEnded("Covo isn't signed in to ChatGPT.");
  const access = await o.store.get(ACCESS_ID);
  if (access && a.expiresAt && now() < a.expiresAt - 120_000) return access;
  const running = renewing.get(o.home);
  if (running) return running;
  const p = withLock(o.home, async () => {
    // Another process may have renewed it while this one waited.
    const fresh = readAccount(o.home);
    const latest = await o.store.get(ACCESS_ID);
    if (latest && fresh?.expiresAt && now() < fresh.expiresAt - 120_000) return latest;
    const refresh = await o.store.get(REFRESH_ID);
    if (!refresh || !fresh?.clientId) throw new ChatGPTSignInEnded("The ChatGPT sign-in is missing. Sign in again.");
    const t = await tokenRequest(o, {
      grant_type: "refresh_token",
      client_id: fresh.clientId,
      refresh_token: refresh,
      resource: CHATGPT.api,
    });
    if (t.status !== 200) {
      if (t.body.error && ENDED.has(t.body.error)) {
        await o.store.delete(ACCESS_ID);
        await o.store.delete(REFRESH_ID);
        writeAccount(o.home, { ...fresh, scopes: [], expiresAt: 0 });
        throw new ChatGPTSignInEnded(
          "Your ChatGPT sign-in has ended. Sign in again: Settings → AI models → Continue with ChatGPT.",
        );
      }
      // Anything else (a network problem, OpenAI being down) keeps the sign-in for next time.
      throw new ChatGPTError(
        `Couldn't renew the ChatGPT sign-in (${t.body.error ?? t.status}). Try again in a moment.`,
      );
    }
    await saveTokens(o, t.body);
    writeAccount(o.home, {
      ...fresh,
      ...(t.body.scope ? { scopes: t.body.scope.split(/\s+/).filter(Boolean) } : {}),
      expiresAt: now() + (t.body.expires_in ?? 3600) * 1000,
    });
    return t.body.access_token as string;
  });
  renewing.set(o.home, p);
  try {
    return await p;
  } finally {
    renewing.delete(o.home);
  }
}

/** Signs out: tells OpenAI to revoke the sign-in, then forgets the tokens. Keeps this Mac's id. */
export async function signOutChatGPT(o: ChatGPTOptions): Promise<void> {
  const a = readAccount(o.home);
  const refresh = await o.store.get(REFRESH_ID);
  if (refresh && a?.clientId) {
    try {
      const d = await discover(o);
      if (d.revocation_endpoint) {
        await (o.fetch ?? fetch)(d.revocation_endpoint, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            token: refresh,
            token_type_hint: "refresh_token",
            client_id: a.clientId,
          }).toString(),
        });
      }
    } catch {} // offline: the tokens are forgotten here anyway, and expire on their own
  }
  await o.store.delete(ACCESS_ID);
  await o.store.delete(REFRESH_ID);
  if (a) {
    const { subject: _s, scopes: _sc, expiresAt: _e, signedInAt: _si, ...keep } = a;
    writeAccount(o.home, keep);
  }
}

export interface ChatGPTModel {
  slug: string;
  name: string;
}

/** The models your ChatGPT account may use (a catalog: a finished task is the real check). */
export async function chatgptModels(o: ChatGPTOptions): Promise<ChatGPTModel[]> {
  const token = await chatgptAccessToken(o);
  const res = await (o.fetch ?? fetch)(`${o.apiBase ?? CHATGPT.api}/models`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new ChatGPTError(`OpenAI's model list answered ${res.status}.`);
  const json = (await res.json()) as {
    data?: { slug?: string; id?: string; display_name?: string; visibility?: string }[];
    models?: { slug?: string; id?: string; display_name?: string; visibility?: string }[];
  };
  const all = (json.data ?? json.models ?? []).filter((m) => m.slug ?? m.id);
  // OpenAI marks the ones to offer with visibility "list"; a list without that field offers them all.
  const shown = all.some((m) => m.visibility !== undefined) ? all.filter((m) => m.visibility === "list") : all;
  return shown.map((m) => ({ slug: (m.slug ?? m.id) as string, name: m.display_name ?? ((m.slug ?? m.id) as string) }));
}

/** For tests and `covo doctor`: is a sign-in in progress or saved here at all? */
export const chatgptFilesExist = (home: string) => existsSync(statePath(home));
