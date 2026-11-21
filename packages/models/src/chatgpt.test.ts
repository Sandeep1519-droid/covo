import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memorySecrets } from "@covo/platform";
import {
  beginChatGPTSignIn,
  ChatGPTSignInEnded,
  chatgptAccessToken,
  chatgptModels,
  chatgptSignedIn,
  readAccount,
  signOutChatGPT,
} from "./chatgpt.ts";
import { providerFromConfig } from "./config.ts";
import { addConnection, resolveModel } from "./connections.ts";
import { browse, fakeClock, fakeOpenAI } from "./fake-openai.ts";
import { priceFor } from "./prices.ts";
import { collect } from "./types.ts";

// Phase 4 M1: Sign in with ChatGPT, against a stand-in for OpenAI's sign-in service and API that
// follows developers.openai.com/siwc (checked 20 Nov 2026), signing its ID tokens with its own key.

let home: string;
let clock = Date.now();
const store = memorySecrets();

let fake: Awaited<ReturnType<typeof fakeOpenAI>>;
const opts = () => ({ home, store, now: () => clock, authBase: fake.base, apiBase: fake.api, port: 0 });

beforeEach(() => {
  clock = Date.now();
  fakeClock(() => clock);
  home = mkdtempSync(join(tmpdir(), "covo-chatgpt-"));
  for (const k of [...store.items.keys()]) store.items.delete(k);
});
afterEach(() => {
  fake?.stop();
  rmSync(home, { recursive: true, force: true });
});

describe("Sign in with ChatGPT", () => {
  test("PKCE in your browser; OpenAI's signature checked; tokens in the Keychain, never in a file", async () => {
    fake = await fakeOpenAI();
    const s = await beginChatGPTSignIn(opts());
    const q = new URL(s.url).searchParams;
    expect(new URL(s.url).pathname).toBe("/api/accounts/authorize");
    expect(Object.fromEntries(q)).toMatchObject({
      client_id: "dynamic_agent_client",
      agent_name_hint: "Covo",
      response_type: "code",
      scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
      resource: "https://api.openai.com/v1",
      code_challenge_method: "S256",
    });
    expect(q.get("ext_agent_host_id")).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    expect(q.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
    expect(q.get("state")).toBeTruthy();
    expect(q.get("nonce")).toBeTruthy();

    expect(await browse(s.url)).toContain("You're signed in");
    expect(await s.done).toEqual({ email: "me@example.com", firstTime: true });
    expect(await chatgptSignedIn(opts())).toBe(true);
    expect(store.items.get("chatgpt-access")).toBe("at1");
    expect(store.items.get("chatgpt-refresh")).toBe("rt1");
    const saved = readFileSync(join(home, "state/chatgpt.json"), "utf8");
    expect(saved).not.toContain("at1");
    expect(saved).not.toContain("rt1");
    expect(readAccount(home)).toMatchObject({ clientId: "oaiapp_test", subject: "user-1", email: "me@example.com" });
    // The code exchange used the issued id and the same redirect, with the PKCE verifier.
    expect(Object.fromEntries(fake.s.token[0] as URLSearchParams)).toMatchObject({
      grant_type: "authorization_code",
      client_id: "oaiapp_test",
      redirect_uri: q.get("redirect_uri"),
      resource: "https://api.openai.com/v1",
    });

    // Signing in again: Covo's id for you is reused, with your email as a hint.
    const again = await beginChatGPTSignIn(opts());
    const q2 = new URL(again.url).searchParams;
    expect(q2.get("client_id")).toBe("oaiapp_test");
    expect(q2.get("agent_name_hint")).toBeNull();
    expect(q2.get("login_hint")).toBe("me@example.com");
    expect(q2.get("ext_agent_host_id")).toBe(q.get("ext_agent_host_id"));
    await browse(again.url);
    expect((await again.done).firstTime).toBe(true); // the welcome note wasn't marked as seen
  });

  test("refused code: Covo keeps the issued id and asks again by itself, once; a second callback isn't traded twice", async () => {
    fake = await fakeOpenAI({ refuseFirstCodes: 1 });
    const lines: string[] = [];
    const s = await beginChatGPTSignIn({ ...opts(), log: (l) => lines.push(l) });
    // The browser lands on the first callback, which sends it into a fresh authorization.
    expect(await browse(s.url)).toContain("You're signed in");
    expect(await s.done).toMatchObject({ email: "me@example.com" });
    const asked = fake.s.authorize.map((q) => [q.get("client_id"), q.get("agent_name_hint")]);
    expect(asked).toEqual([
      ["dynamic_agent_client", "Covo"],
      ["oaiapp_test", null],
    ]);
    expect(lines.join("\n")).toContain("invalid_grant: test refusal");
    expect(lines.join("\n")).toContain("starting a fresh authorization with the issued client ID");
    expect(lines.join("\n")).not.toContain("code=");
    expect(readAccount(home)?.clientId).toBe("oaiapp_test");

    // Refused twice: it stops and says why, keeping the issued id for next time.
    fake.stop();
    fake = await fakeOpenAI({ refuseFirstCodes: 5 });
    rmSync(join(home, "state/chatgpt.json"));
    const again = await beginChatGPTSignIn(opts());
    await browse(again.url);
    await expect(again.done).rejects.toThrow("OpenAI refused the sign-in code (invalid_grant: test refusal)");
    expect(readAccount(home)?.clientId).toBe("oaiapp_test");

    // The browser delivers the callback twice: the code is traded once, both get the same answer.
    fake.stop();
    fake = await fakeOpenAI();
    const twice = await beginChatGPTSignIn(opts());
    const back = (await fetch(twice.url, { redirect: "manual" })).headers.get("location") as string;
    const pages = await Promise.all([fetch(back).then((r) => r.text()), fetch(back).then((r) => r.text())]);
    expect(pages.every((p) => p.includes("You're signed in"))).toBe(true);
    expect(fake.s.token.filter((f) => f.get("grant_type") === "authorization_code")).toHaveLength(1);
  });

  test("renewed one at a time when it runs out; the refresh token rotates; an ended sign-in says so", async () => {
    fake = await fakeOpenAI();
    const s = await beginChatGPTSignIn(opts());
    await browse(s.url);
    await s.done;
    expect(await chatgptAccessToken(opts())).toBe("at1"); // still fresh
    clock += 3_600_000; // an hour later
    const [a, b] = await Promise.all([chatgptAccessToken(opts()), chatgptAccessToken(opts())]);
    expect([a, b]).toEqual(["at2", "at2"]);
    expect(fake.s.token.filter((f) => f.get("grant_type") === "refresh_token")).toHaveLength(1);
    expect(store.items.get("chatgpt-refresh")).toBe("rt2");

    // You turned it off in ChatGPT's settings: the next renewal fails for good.
    fake.s.refresh.clear();
    clock += 3_600_000;
    await expect(chatgptAccessToken(opts())).rejects.toBeInstanceOf(ChatGPTSignInEnded);
    expect(store.items.has("chatgpt-access")).toBe(false);
    expect(store.items.has("chatgpt-refresh")).toBe(false);
    expect(await chatgptSignedIn(opts())).toBe(false);
  });

  test("nothing is saved without the plan permission, with a forged ID token, or when you decline", async () => {
    fake = await fakeOpenAI({ scope: "openid profile email offline_access" });
    let s = await beginChatGPTSignIn(opts());
    expect(await browse(s.url)).toContain("needs an active ChatGPT Plus or Pro plan");
    await expect(s.done).rejects.toThrow("needs an active ChatGPT Plus or Pro plan");
    expect(store.items.size).toBe(0);
    expect(fake.s.token).toHaveLength(0); // no point trading a code that can't use the plan
    fake.stop();

    fake = await fakeOpenAI({ signWith: "other" });
    s = await beginChatGPTSignIn(opts());
    await browse(s.url);
    await expect(s.done).rejects.toThrow("signature");
    expect(store.items.size).toBe(0);

    // A request to the callback with someone else's state is turned away; yours still works after.
    s = await beginChatGPTSignIn(opts());
    const redirect = new URL(s.url).searchParams.get("redirect_uri") as string;
    const forged = await fetch(`${redirect}?code=x&state=not-yours&client_id=oaiapp_evil`);
    expect(forged.status).toBe(400);
    // You decline on OpenAI's page.
    const state = new URL(s.url).searchParams.get("state");
    expect(await (await fetch(`${redirect}?error=access_denied&state=${state}`)).text()).toContain(
      "You didn't allow it",
    );
    await expect(s.done).rejects.toThrow("You didn't allow Covo");
    expect(store.items.size).toBe(0);
  });

  test("signing out revokes the sign-in at OpenAI and forgets the tokens; this Mac's id stays", async () => {
    fake = await fakeOpenAI();
    const s = await beginChatGPTSignIn(opts());
    await browse(s.url);
    await s.done;
    const host = readAccount(home)?.hostId;
    await signOutChatGPT(opts());
    expect(fake.s.revoked).toEqual(["rt1"]);
    expect(store.items.size).toBe(0);
    expect(readAccount(home)).toEqual({ hostId: host as string, clientId: "oaiapp_test", email: "me@example.com" });
  });

  test("as a model: listed models only; requests carry the plan's token; plan usage costs nothing here", async () => {
    fake = await fakeOpenAI();
    const s = await beginChatGPTSignIn(opts());
    await browse(s.url);
    await s.done;
    expect(await chatgptModels(opts())).toEqual([{ slug: "gpt-6.1-sol", name: "GPT-6.1 Sol" }]);
    await addConnection(home, store, { name: "chatgpt", provider: "chatgpt", model: "gpt-6.1-sol", makeDefault: true });
    const cfg = await resolveModel(home, store, { COVO_CHATGPT_AUTH: fake.base, COVO_CHATGPT_API: fake.api });
    expect(cfg).toMatchObject({ kind: "openai-responses", subscription: "chatgpt", model: "gpt-6.1-sol" });
    const reply = await collect(providerFromConfig(cfg).chat({ messages: [{ role: "user", content: "hi" }] }));
    expect(reply.text).toBe("Hello from your plan.");
    expect(fake.s.responses[0]?.auth).toBe("Bearer at1");
    expect(priceFor("chatgpt:gpt-6.1-sol")).toEqual({ in: 0, out: 0, source: "plan" });
    await expect(
      addConnection(home, store, { name: "x", provider: "chatgpt", model: "m", key: "sk-nope" }),
    ).rejects.toThrow("own sign-in");
  });
});
