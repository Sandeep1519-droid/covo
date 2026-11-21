import { createHash, webcrypto } from "node:crypto";

// A stand-in for OpenAI's sign-in service (auth.openai.com) and API (api.openai.com/v1), following
// developers.openai.com/siwc (checked 20 Nov 2026), for tests. It signs its ID tokens with its own key.
// Exported as "@covo/models/fake-openai".

export const PLAN = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
let clock = () => Date.now();
/** Tests that move time tell the stand-in, so the ID tokens it signs aren't expired. */
export function fakeClock(now: () => number): void {
  clock = now;
}

/** A stand-in for auth.openai.com and api.openai.com/v1. */
export async function fakeOpenAI(o: { scope?: string; signWith?: "own" | "other"; refuseFirstCodes?: number } = {}) {
  const gen = () =>
    webcrypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    ) as Promise<webcrypto.CryptoKeyPair>;
  const keys = await gen();
  const other = await gen();
  const jwk = { ...(await webcrypto.subtle.exportKey("jwk", keys.publicKey)), kid: "k1", use: "sig", alg: "RS256" };
  const s = {
    authorize: [] as URLSearchParams[],
    token: [] as URLSearchParams[],
    revoked: [] as string[],
    responses: [] as { auth: string | null; body: Record<string, unknown> }[],
    pending: new Map<string, { challenge: string; nonce: string; redirect: string; client: string }>(),
    refresh: new Set<string>(),
    access: 0,
    codes: 0,
    refused: 0,
  };
  const sign = async (claims: Record<string, unknown>) => {
    const enc = (x: unknown) => Buffer.from(JSON.stringify(x)).toString("base64url");
    const data = `${enc({ alg: "RS256", kid: "k1", typ: "JWT" })}.${enc(claims)}`;
    const key = o.signWith === "other" ? other.privateKey : keys.privateKey;
    const sig = await webcrypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(data));
    return `${data}.${Buffer.from(sig).toString("base64url")}`;
  };
  const tokens = () => {
    s.access++;
    const refresh = `rt${s.access}`;
    s.refresh.add(refresh);
    return { access_token: `at${s.access}`, refresh_token: refresh, token_type: "Bearer", expires_in: 3600 };
  };
  let port = 0;
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    port: 0,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const base = `http://127.0.0.1:${port}`;
      if (url.pathname === "/.well-known/openid-configuration")
        return Response.json({ issuer: base, jwks_uri: `${base}/jwks`, revocation_endpoint: `${base}/revoke` });
      if (url.pathname === "/jwks") return Response.json({ keys: [jwk] });
      if (url.pathname === "/api/accounts/authorize") {
        // You sign in on OpenAI's page and agree: OpenAI sends the browser back with a code.
        const q = url.searchParams;
        s.authorize.push(q);
        const code = `code${++s.codes}`;
        const client = q.get("client_id") === "dynamic_agent_client" ? "oaiapp_test" : (q.get("client_id") as string);
        s.pending.set(code, {
          challenge: q.get("code_challenge") as string,
          nonce: q.get("nonce") as string,
          redirect: q.get("redirect_uri") as string,
          client,
        });
        const back = new URL(q.get("redirect_uri") as string);
        back.searchParams.set("code", code);
        back.searchParams.set("state", q.get("state") as string);
        back.searchParams.set("scope", o.scope ?? PLAN);
        if (q.get("client_id") === "dynamic_agent_client") back.searchParams.set("client_id", client);
        return Response.redirect(back.toString(), 302);
      }
      if (url.pathname === "/api/accounts/oauth/token") {
        const f = new URLSearchParams(await req.text());
        s.token.push(f);
        if (f.get("grant_type") === "authorization_code") {
          // Like OpenAI sometimes does on a first registration: refuse the code; a fresh attempt works.
          if ((o.refuseFirstCodes ?? 0) > s.refused) {
            s.refused++;
            s.pending.delete(f.get("code") ?? "");
            return Response.json({ error: "invalid_grant", error_description: "test refusal" }, { status: 400 });
          }
          const p = s.pending.get(f.get("code") ?? "");
          const verifier = createHash("sha256")
            .update(f.get("code_verifier") ?? "")
            .digest("base64url");
          if (!p || verifier !== p.challenge || f.get("redirect_uri") !== p.redirect || f.get("client_id") !== p.client)
            return Response.json({ error: "invalid_grant" }, { status: 400 });
          s.pending.delete(f.get("code") ?? "");
          const id_token = await sign({
            iss: base,
            aud: p.client,
            sub: "user-1",
            email: "me@example.com",
            nonce: p.nonce,
            exp: Math.floor(clock() / 1000) + 3600,
          });
          return Response.json({ ...tokens(), id_token, scope: o.scope ?? PLAN });
        }
        if (f.get("grant_type") === "refresh_token") {
          const r = f.get("refresh_token") ?? "";
          if (!s.refresh.has(r)) return Response.json({ error: "refresh_token_reused" }, { status: 400 });
          s.refresh.delete(r); // it rotates: the old one is spent
          return Response.json({ ...tokens(), scope: PLAN });
        }
      }
      if (url.pathname === "/revoke") {
        const f = new URLSearchParams(await req.text());
        s.revoked.push(f.get("token") ?? "");
        s.refresh.delete(f.get("token") ?? "");
        return new Response(null, { status: 200 });
      }
      if (url.pathname === "/v1/models")
        return Response.json({
          data: [
            { slug: "gpt-6.1-sol", display_name: "GPT-6.1 Sol", visibility: "list" },
            { slug: "internal-preview", display_name: "Hidden", visibility: "hide" },
          ],
        });
      if (url.pathname === "/v1/responses") {
        const body = (await req.json()) as { input?: { type?: string }[]; tools?: { name?: string }[] };
        s.responses.push({ auth: req.headers.get("authorization"), body: body as Record<string, unknown> });
        // A task (it has tools): write a file first, then finish. A plain chat: just answer.
        const usedTool = (body.input ?? []).some((i) => i.type === "function_call_output");
        const tools = (body.tools ?? []).map((t) => t.name);
        const call = (name: string, args: Record<string, unknown>) => ({
          type: "response.output_item.done",
          item: { type: "function_call", call_id: `call_${name}`, name, arguments: JSON.stringify(args) },
        });
        const events: Record<string, unknown>[] =
          tools.includes("write_file") && !usedTool
            ? [call("write_file", { path: "PLAN.md", content: "Written on your ChatGPT plan.\n" })]
            : tools.includes("finish") && usedTool
              ? [call("finish", { summary: "Wrote PLAN.md on your ChatGPT plan." })]
              : [{ type: "response.output_text.delta", delta: "Hello from your plan." }];
        events.push({ type: "response.completed", response: { usage: { input_tokens: 12, output_tokens: 5 } } });
        return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  port = server.port as number;
  const base = `http://127.0.0.1:${port}`;
  return { s, base, api: `${base}/v1`, stop: () => server.stop(true) };
}

/** You, in the browser: open the link, sign in, get sent back to Covo's one-time page. */
export async function browse(url: string): Promise<string> {
  const r = await fetch(url, { redirect: "manual" });
  const back = r.headers.get("location");
  if (!back) throw new Error("no redirect");
  return (await fetch(back)).text();
}
