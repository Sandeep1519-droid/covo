import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiEngine, ApiModel, ApiModelGroup, ApiSubscriptions } from "@covo/api";
import { covoPaths } from "@covo/core";
import { openDb } from "@covo/db";
import { browse, fakeClock, fakeOpenAI } from "@covo/models/fake-openai";
import { memorySecrets, type SystemInfo } from "@covo/platform";
import { type Ctx, main } from "../main.ts";
import { apiToken } from "./gate.ts";
import { type Running, serve } from "./server.ts";

// Phase 4 M1: your own AI plans, from the app. ChatGPT through Sign in with ChatGPT (against a
// stand-in for OpenAI), Claude through the Claude Code program (with a stand-in for its answers), and
// Codex: Get runs a stand-in installer, Sign in a stand-in for Codex's own sign-in.

let root: string;
let home: string;
let running: Running | undefined;
let base: string;
let token: string;
let fake: Awaited<ReturnType<typeof fakeOpenAI>> | undefined;
const secrets = memorySecrets();
const env = (extra: Record<string, string> = {}) => ({ COVO_HOME: home, HOME: root, COVO_PORT: "0", ...extra });
const mac8 = (): SystemInfo => ({
  memoryGB: 8,
  chip: "Apple M3",
  performanceCores: 4,
  cores: 8,
  memoryPressure: "normal",
  power: { source: "ac", percent: 100 },
  thermal: "normal",
});

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "covo-subs-")));
  home = join(root, "Covo");
  await main(["init"], env());
  writeFileSync(join(home, "workspaces/default/README.md"), "# Demo\n");
  for (const k of [...secrets.items.keys()]) secrets.items.delete(k);
  fakeClock(Date.now);
});
afterEach(async () => {
  await running?.close();
  running = undefined;
  fake?.stop();
  fake = undefined;
  rmSync(root, { recursive: true, force: true });
});

async function start(extra: Partial<Ctx> = {}, envExtra: Record<string, string> = {}) {
  const ctx: Ctx = { home, now: Date.now, env: env(envExtra), print: () => {}, system: mac8, secrets, ...extra };
  running = await serve(ctx);
  base = `http://127.0.0.1:${running.port}`;
  token = apiToken(home);
}
const api = (path: string, init: RequestInit = {}) =>
  fetch(`${base}/api${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
  });
const status = async () => (await (await api("/subscriptions")).json()) as ApiSubscriptions;
const row = (s: ApiSubscriptions, id: string) => s.engines.find((e) => e.id === id) as ApiEngine;
async function until<T>(get: () => Promise<T | false | undefined> | T | false | undefined, what: string): Promise<T> {
  for (let i = 0; i < 250; i++) {
    const v = await get();
    if (v) return v;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for ${what}`);
}
const db = () => openDb(covoPaths(home).db);
const runs = () => {
  const d = db();
  const r = d
    .query<{ id: string; state: string; cost: number }, []>("SELECT id, state, cost_usd AS cost FROM runs")
    .all();
  d.close();
  return r;
};
const actions = () => {
  const d = db();
  const a = d.query<{ a: string }, []>("SELECT action AS a FROM audit_log").all();
  d.close();
  return a.map((x) => x.a);
};

describe("your ChatGPT plan, from the app", () => {
  test("Continue with ChatGPT → you sign in → a task with a tool call runs on your plan → Sign out revokes it", async () => {
    fake = await fakeOpenAI();
    await start({}, { COVO_CHATGPT_AUTH: fake.base, COVO_CHATGPT_API: fake.api });
    const started = await api("/subscriptions/chatgpt", { method: "POST", body: "{}" });
    expect(started.status).toBe(200);
    const { url } = (await started.json()) as { url: string };
    expect((await status()).chatgpt.signingIn).toBe(true);

    // In your browser: OpenAI's page, then back to Covo's one-time page.
    expect(await browse(url)).toContain("You're signed in");
    const s = await until(async () => {
      const x = await status();
      return x.chatgpt.connected && x;
    }, "the sign-in to finish");
    expect(s.chatgpt).toMatchObject({
      connected: true,
      email: "me@example.com",
      connection: "chatgpt",
      model: "gpt-6.1-sol",
      models: [{ slug: "gpt-6.1-sol", name: "GPT-6.1 Sol" }],
      welcomed: false,
      signingIn: false,
      error: null,
      manageUsageUrl: "https://chatgpt.com/settings/usage",
    });
    const models = (await (await api("/models")).json()) as ApiModel[];
    expect(models).toEqual([expect.objectContaining({ name: "chatgpt", subscription: "chatgpt", isDefault: true })]);
    // The app shows the one-time welcome, then says it did.
    const after = (await (
      await api("/subscriptions/chatgpt/welcomed", { method: "POST", body: "{}" })
    ).json()) as ApiSubscriptions;
    expect(after.chatgpt.welcomed).toBe(true);

    // A task on your plan: the model asks for write_file, then finishes.
    expect((await api("/runs", { method: "POST", body: JSON.stringify({ goal: "write the plan" }) })).status).toBe(202);
    const run = await until(() => runs().find((r) => ["SUCCEEDED", "KEPT", "FAILED"].includes(r.state)), "the task");
    expect(run.state).toBe("KEPT");
    expect(run.cost).toBe(0); // your plan is a flat fee: nothing counts against Covo's limits
    expect(readFileSync(join(home, "workspaces/default/PLAN.md"), "utf8")).toContain("ChatGPT plan");
    const sent = fake.s.responses;
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(sent.every((x) => x.auth === "Bearer at1" && x.body.store === false && x.body.stream === true)).toBe(true);
    expect(sent.some((x) => "temperature" in x.body || "max_output_tokens" in x.body)).toBe(false);

    // Tokens never come back out, and aren't in Covo's files.
    expect(JSON.stringify(s)).not.toMatch(/\bat1\b|\brt1\b/);
    expect(readFileSync(join(home, "config.json"), "utf8")).not.toMatch(/\bat1\b|\brt1\b/);
    expect(readFileSync(join(home, "state/chatgpt.json"), "utf8")).not.toMatch(/\bat1\b|\brt1\b/);

    // Sign out: OpenAI revokes it, and the model is gone.
    const out = (await (await api("/subscriptions/chatgpt", { method: "DELETE" })).json()) as ApiSubscriptions;
    expect(out.chatgpt).toMatchObject({ connected: false, connection: null });
    expect(fake.s.revoked).toEqual(["rt1"]);
    expect(await (await api("/models")).json()).toEqual([]);
    expect(actions()).toEqual(expect.arrayContaining(["subscription.connected", "subscription.removed"]));
  });

  test("a sign-in without permission to use the plan saves nothing, and says why", async () => {
    fake = await fakeOpenAI({ scope: "openid profile email offline_access" });
    await start({}, { COVO_CHATGPT_AUTH: fake.base, COVO_CHATGPT_API: fake.api });
    const { url } = (await (await api("/subscriptions/chatgpt", { method: "POST", body: "{}" })).json()) as {
      url: string;
    };
    await browse(url);
    const s = await until(async () => {
      const x = await status();
      return !x.chatgpt.signingIn && x;
    }, "the sign-in to end");
    expect(s.chatgpt.connected).toBe(false);
    expect(s.chatgpt.error).toContain("needs an active ChatGPT Go, Plus, Pro or Business plan");
    expect(secrets.items.size).toBe(0);
    expect(await (await api("/models")).json()).toEqual([]);
  });
});

describe("your Claude plan, through Claude Code", () => {
  test("not installed: how to install; signed in with your account: connect once you agree; an API key: refused", async () => {
    let path: string | null = null;
    let signIn: { signedIn: boolean | null; method: string | null } = { signedIn: false, method: "none" };
    await start({
      which: (c: string) => (c === "claude" ? path : null),
      engineSignIn: async () => signIn,
    });
    let s = await status();
    expect(row(s, "claude-code")).toMatchObject({
      path: null,
      maker: "Anthropic",
      install: "curl -fsSL https://claude.ai/install.sh | bash",
      signIn: "claude auth login",
      connected: false,
      installing: false,
    });
    expect(row(s, "claude-code").notice[0]).toContain("Covo never sees, copies or stores your sign-in");

    path = "/Users/me/.local/bin/claude";
    s = (await (
      await api("/subscriptions/claude-code/check", { method: "POST", body: "{}" })
    ).json()) as ApiSubscriptions;
    expect(row(s, "claude-code")).toMatchObject({ path, signedIn: false });

    // Signed in with an API key: tasks would bill that key, not your plan.
    signIn = { signedIn: true, method: "api_key" };
    const refused = await api("/subscriptions/claude-code", { method: "POST", body: JSON.stringify({ accept: true }) });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toContain("API key");

    signIn = { signedIn: true, method: "claude.ai" };
    expect((await api("/subscriptions/claude-code", { method: "POST", body: "{}" })).status).toBe(400); // agree first
    s = (await (
      await api("/subscriptions/claude-code", { method: "POST", body: JSON.stringify({ accept: true }) })
    ).json()) as ApiSubscriptions;
    expect(row(s, "claude-code")).toMatchObject({
      connected: true,
      connection: "claude-sub",
      signedIn: true,
      method: "claude.ai",
    });
    expect(await (await api("/models")).json()).toEqual([
      expect.objectContaining({ name: "claude-sub", subscription: "claude-code", engine: true }),
    ]);
    s = (await (await api("/subscriptions/claude-code", { method: "DELETE" })).json()) as ApiSubscriptions;
    expect(row(s, "claude-code").connected).toBe(false);
  });
});

describe("your ChatGPT plan, through Codex", () => {
  /** A stand-in for OpenAI's installer: it puts a stand-in codex in ~/.local/bin. */
  const INSTALLER = `#!/bin/sh
echo "==> Installing Codex CLI"
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/codex" <<'EOS'
#!/bin/sh
case "$1" in
  --version) echo "codex-cli 0.0.0-test" ;;
  login)
    if [ "$2" = "status" ]; then
      if [ -f "$CODEX_HOME/auth.json" ]; then echo "Logged in using ChatGPT" >&2; exit 0; fi
      echo "Not logged in" >&2; exit 1
    fi
    echo "Starting local login server on http://localhost:1455." >&2
    echo "If your browser did not open, navigate to this URL to authenticate:" >&2
    echo "" >&2
    echo "https://auth.openai.com/oauth/authorize?client_id=test&state=abc" >&2
    while [ ! -f "$CODEX_HOME/approve" ]; do sleep 0.05; done
    echo "{}" > "$CODEX_HOME/auth.json"
    echo "Successfully logged in" >&2 ;;
  logout) rm -f "$CODEX_HOME/auth.json"; echo "Successfully logged out" >&2 ;;
  debug) echo '{"models":[{"slug":"gpt-hidden","display_name":"Hidden","visibility":"hide","priority":1},{"slug":"gpt-b","display_name":"GPT-B","visibility":"list","priority":3},{"slug":"gpt-a","display_name":"GPT-A","visibility":"list","priority":2}]}' ;;
esac
EOS
chmod +x "$HOME/.local/bin/codex"
echo "==> Codex CLI installed"
`;

  test("Get runs the installer, Sign in starts Codex's own sign-in, then Connect; Sign out revokes it", async () => {
    const srv = Bun.serve({ port: 0, fetch: () => new Response(INSTALLER) });
    try {
      await start({}, { COVO_INSTALLER_CODEX: `http://127.0.0.1:${srv.port}/install.sh`, PATH: "/usr/bin:/bin" });
      let s = await status();
      expect(row(s, "codex")).toMatchObject({ path: null, maker: "OpenAI", installing: false, connected: false });
      expect(row(s, "codex").notice.join(" ")).toContain("its network reaches only OpenAI's servers");

      expect((await api("/subscriptions/codex/install", { method: "POST", body: "{}" })).status).toBe(200);
      s = await until(async () => {
        const x = await status();
        return !row(x, "codex").installing && row(x, "codex").signedIn !== null && x;
      }, "Codex to be installed and checked");
      expect(row(s, "codex")).toMatchObject({
        path: join(root, ".local/bin/codex"),
        signedIn: false,
        error: null,
      });

      // Connecting before signing in is refused.
      const early = await api("/subscriptions/codex", { method: "POST", body: JSON.stringify({ accept: true }) });
      expect(early.status).toBe(409);

      expect((await api("/subscriptions/codex/sign-in", { method: "POST", body: "{}" })).status).toBe(200);
      s = await until(async () => {
        const x = await status();
        return row(x, "codex").url ? x : false;
      }, "the sign-in link");
      expect(row(s, "codex")).toMatchObject({
        signingIn: true,
        url: "https://auth.openai.com/oauth/authorize?client_id=test&state=abc",
      });
      // You finish signing in on OpenAI's page: Codex saves its sign-in in Covo's Codex folder.
      const codexHome = join(home, "engines", "codex");
      writeFileSync(join(codexHome, "approve"), "");
      s = await until(async () => {
        const x = await status();
        return !row(x, "codex").signingIn && row(x, "codex").signedIn ? x : false;
      }, "the sign-in to finish");
      expect(row(s, "codex")).toMatchObject({ signedIn: true, method: "chatgpt", url: null });

      s = (await (
        await api("/subscriptions/codex", { method: "POST", body: JSON.stringify({ accept: true }) })
      ).json()) as ApiSubscriptions;
      expect(row(s, "codex")).toMatchObject({ connected: true, connection: "codex" });
      expect(await (await api("/models")).json()).toEqual([
        expect.objectContaining({ name: "codex", subscription: "codex", engine: true }),
      ]);

      // Its models, from Codex's own catalog (only the ones it lists, in its order), to pick per
      // message or as its usual one.
      const groups = (await (await api("/model-choices")).json()) as ApiModelGroup[];
      expect(groups[0]).toMatchObject({ connection: "codex", subscription: "codex", isDefault: true });
      expect(groups[0]?.options.map((o) => o.value)).toEqual(["codex", "codex:gpt-a", "codex:gpt-b"]);
      expect((await api("/models/codex", { method: "PUT", body: JSON.stringify({ model: "gpt-b" }) })).status).toBe(
        200,
      );
      const again = (await (await api("/model-choices")).json()) as ApiModelGroup[];
      expect(again[0]?.options.find((o) => o.current)?.value).toBe("codex:gpt-b");

      s = (await (await api("/subscriptions/codex", { method: "DELETE" })).json()) as ApiSubscriptions;
      expect(row(s, "codex").connected).toBe(false);
      expect(existsSync(join(codexHome, "auth.json"))).toBe(false);
      expect(actions()).toEqual(
        expect.arrayContaining([
          "engine.installed",
          "engine.signed-in",
          "subscription.connected",
          "subscription.removed",
        ]),
      );
    } finally {
      srv.stop(true);
    }
  });

  test("an installer that fails says why; a sign-in can be cancelled", async () => {
    let script = '#!/bin/sh\necho "error: this Mac is not supported" >&2\nexit 3\n';
    const srv = Bun.serve({ port: 0, fetch: () => new Response(script) });
    try {
      await start({}, { COVO_INSTALLER_CODEX: `http://127.0.0.1:${srv.port}/install.sh`, PATH: "/usr/bin:/bin" });
      await api("/subscriptions/codex/install", { method: "POST", body: "{}" });
      let s = await until(async () => {
        const x = await status();
        return row(x, "codex").error ? x : false;
      }, "the installer to fail");
      expect(row(s, "codex").error).toBe("OpenAI's installer stopped (code 3): error: this Mac is not supported");

      script = INSTALLER;
      await api("/subscriptions/codex/install", { method: "POST", body: "{}" });
      await until(async () => row(await status(), "codex").signedIn === false, "the install");
      await api("/subscriptions/codex/sign-in", { method: "POST", body: "{}" });
      await until(async () => row(await status(), "codex").url, "the sign-in link");
      s = (await (await api("/subscriptions/codex/cancel", { method: "POST", body: "{}" })).json()) as ApiSubscriptions;
      s = await until(async () => {
        const x = await status();
        return !row(x, "codex").signingIn && x;
      }, "the cancel");
      expect(row(s, "codex")).toMatchObject({ signedIn: false, error: null });
    } finally {
      srv.stop(true);
    }
  });
});

describe("Claude Code's sign-in, from the app", () => {
  /** A stand-in Claude Code whose sign-in page shows a code you paste back (its manual flow). */
  const INSTALLER = `#!/bin/bash
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/claude" <<'EOS'
#!/bin/bash
case "$1 $2" in
  "auth status")
    if [ -f "$HOME/.claude/signed-in" ]; then echo '{"loggedIn":true,"authMethod":"claude.ai"}'; exit 0; fi
    echo '{"loggedIn":false,"authMethod":"none"}'; exit 1 ;;
  "auth login")
    echo "Opening browser to sign in…"
    echo "If the browser didn't open, visit: https://claude.ai/oauth/authorize?code=true&state=s1"
    printf "Paste code here if prompted > "
    read -r code
    if [ "$code" = "abc123#state" ]; then mkdir -p "$HOME/.claude"; touch "$HOME/.claude/signed-in"; echo "Login successful."; exit 0; fi
    echo "Invalid code"; exit 1 ;;
esac
EOS
chmod +x "$HOME/.local/bin/claude"
`;

  test("the page's code, pasted in the app, goes to Claude Code's own prompt", async () => {
    const srv = Bun.serve({ port: 0, fetch: () => new Response(INSTALLER) });
    try {
      await start({}, { COVO_INSTALLER_CLAUDE_CODE: `http://127.0.0.1:${srv.port}/install.sh`, PATH: "/usr/bin:/bin" });
      await api("/subscriptions/claude-code/install", { method: "POST", body: "{}" });
      await until(async () => row(await status(), "claude-code").signedIn === false, "Claude Code to be installed");
      expect((await api("/subscriptions/claude-code/sign-in", { method: "POST", body: "{}" })).status).toBe(200);
      const s = await until(async () => {
        const x = await status();
        return row(x, "claude-code").codePrompt ? x : false;
      }, "the code prompt");
      expect(row(s, "claude-code").url).toBe("https://claude.ai/oauth/authorize?code=true&state=s1");
      // Not a code: refused before it reaches the program.
      const bad = await api("/subscriptions/claude-code/code", {
        method: "POST",
        body: JSON.stringify({ code: "a b" }),
      });
      expect(bad.status).toBe(400);
      const ok = await api("/subscriptions/claude-code/code", {
        method: "POST",
        body: JSON.stringify({ code: "abc123#state" }),
      });
      expect(ok.status).toBe(200);
      const done = await until(async () => {
        const x = await status();
        return !row(x, "claude-code").signingIn && row(x, "claude-code").signedIn ? x : false;
      }, "the sign-in to finish");
      expect(row(done, "claude-code")).toMatchObject({ signedIn: true, method: "claude.ai", error: null });
    } finally {
      srv.stop(true);
    }
  });
});

describe("adding a key in the app", () => {
  test("pasting a key lists the service's chat models; a refused key says so", async () => {
    let refuse = false;
    await start({
      listModels: async () => {
        if (refuse) throw new Error("GET /models answered 401");
        return ["gpt-z", "text-embedding-3-large", "gpt-a", "whisper-1", "gpt-a"];
      },
    });
    const r = await api("/providers/openai/models", { method: "POST", body: JSON.stringify({ key: "sk-test" }) });
    expect(await r.json()).toEqual({ models: ["gpt-a", "gpt-z"] });
    expect((await api("/providers/openai/models", { method: "POST", body: "{}" })).status).toBe(400);
    refuse = true;
    const no = await api("/providers/cerebras/models", { method: "POST", body: JSON.stringify({ key: "bad-key" }) });
    expect(no.status).toBe(422);
    expect(((await no.json()) as { error: string }).error).toBe(
      "Cerebras didn't accept that key. Check you copied all of it.",
    );
  });
});
