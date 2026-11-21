import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandbox } from "@covo/platform";
import { CodexEngine, codexArgs, codexFolders, codexOutcome, parseCodexEvents } from "./codex.ts";
import { openAiOnly, startEgressFilter } from "./egress.ts";

// Codex on your ChatGPT plan (docs/SUBSCRIPTIONS.md, update of 22 Nov 2026), with a stand-in for
// the codex program, in the real macOS sandbox.

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "covo-codex-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const macSandbox = sandbox();

/**
 * Sends a request through the filter. With `then`: once the tunnel is open, sends it and waits for
 * the stand-in server's echo. Returns everything that came back.
 */
async function ask(port: number, request: string, then?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = connect({ host: "127.0.0.1", port }, () => s.write(request));
    let got = "";
    let sent = false;
    s.on("data", (d) => {
      got += d.toString();
      if (then && !sent && got.includes("200 Connection Established\r\n\r\n")) {
        sent = true;
        s.write(then);
      }
      if (then && got.includes(`echo:${then}`)) {
        s.destroy();
        resolve(got);
      }
    });
    s.on("close", () => resolve(got));
    s.on("error", reject);
  });
}

describe("the network filter", () => {
  test("lets only OpenAI's servers through, on 443", () => {
    expect(openAiOnly("chatgpt.com", 443)).toBe(true);
    expect(openAiOnly("api.openai.com", 443)).toBe(true);
    expect(openAiOnly("auth.openai.com", 443)).toBe(true);
    expect(openAiOnly("chatgpt.com", 80)).toBe(false);
    expect(openAiOnly("example.com", 443)).toBe(false);
    expect(openAiOnly("openai.com.example.com", 443)).toBe(false);
    expect(openAiOnly("evilchatgpt.com", 443)).toBe(false);
  });

  test("tunnels allowed hosts and refuses the rest", async () => {
    const upstream = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data: (s, d) => void s.write(`echo:${d.toString()}`) },
    });
    const f = await startEgressFilter({
      allow: (h, p) => h === "api.openai.com" && p === 443,
      dial: () => connect({ host: "127.0.0.1", port: upstream.port }),
    });
    try {
      const ok = await ask(f.port, "CONNECT api.openai.com:443 HTTP/1.1\r\nHost: api.openai.com\r\n\r\n", "ping");
      expect(ok).toContain("HTTP/1.1 200 Connection Established");
      expect(ok).toContain("echo:ping");
      const no = await ask(f.port, "CONNECT example.com:443 HTTP/1.1\r\n\r\n");
      expect(no).toContain("HTTP/1.1 403");
      const plain = await ask(f.port, "GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n");
      expect(plain).toContain("HTTP/1.1 405");
      expect([...f.allowed]).toEqual(["api.openai.com"]);
      expect([...f.refused].sort()).toEqual(["example.com", "example.com:443"]);
    } finally {
      f.stop();
      upstream.stop(true);
    }
  });
});

describe("reading Codex's output", () => {
  const events = (...e: unknown[]) => e.map((x) => JSON.stringify(x)).join("\n");

  test("a finished task: the closing message, tokens and steps", () => {
    const out = events(
      { type: "thread.started", thread_id: "t" },
      { type: "item.completed", item: { type: "command_execution", status: "completed" } },
      { type: "item.completed", item: { type: "file_change", status: "completed" } },
      { type: "item.completed", item: { type: "agent_message", text: "Fixed the typo." } },
      { type: "turn.completed", usage: { input_tokens: 900, cached_input_tokens: 400, output_tokens: 80 } },
    );
    expect(parseCodexEvents(out)).toMatchObject({ summary: "Fixed the typo.", tokensIn: 900, tokensOut: 80, steps: 2 });
    const r = codexOutcome({ code: 0, stdout: out, stderr: "", timedOut: false }, { timeoutMs: 60_000 });
    expect(r).toMatchObject({ ok: true, summary: "Fixed the typo.", turns: 2 });
  });

  test("a usage limit hands over to the bot's next model; a lost sign-in says so", () => {
    const limit = events({ type: "turn.failed", error: { message: "You've hit your usage limit. Try again later." } });
    expect(codexOutcome({ code: 1, stdout: limit, stderr: "", timedOut: false }, { timeoutMs: 1 })).toMatchObject({
      ok: false,
      errorKind: "quota",
    });
    const auth = codexOutcome(
      { code: 1, stdout: "", stderr: "Error: Not logged in\n", timedOut: false },
      { timeoutMs: 1 },
    );
    expect(auth).toMatchObject({ ok: false, errorKind: "auth" });
    const slow = codexOutcome({ code: 137, stdout: "", stderr: "", timedOut: true }, { timeoutMs: 120_000 });
    expect(slow).toMatchObject({ ok: false, stopped: true });
  });

  test("the folders it may read: OpenAI's release folder, never a whole ~/.local", () => {
    const rel = join(root, ".codex", "packages", "standalone", "releases", "0.171.0");
    mkdirSync(join(rel, "bin"), { recursive: true });
    writeFileSync(join(rel, "bin", "codex"), "");
    const local = join(root, ".local", "bin");
    mkdirSync(local, { recursive: true });
    symlinkSync(join(rel, "bin", "codex"), join(local, "codex"));
    const real = (p: string) => realpathSync(p);
    const folders = (bin: string) => [...new Set(codexFolders(bin).read.map(real))].sort();
    expect(folders(join(local, "codex"))).toEqual([real(local), real(rel), real(join(rel, "bin"))].sort());
    writeFileSync(join(local, "codex2"), "");
    expect(folders(join(local, "codex2"))).toEqual([real(local)]);
  });

  test("the command line: Codex's own sandbox off (Covo's is on), nothing kept between tasks", () => {
    const a = codexArgs({ ws: "/w", model: "gpt-x", config: ["-c", 'cli_auth_credentials_store="file"'] });
    expect(a.slice(0, 2)).toEqual(["exec", "--json"]);
    for (const f of ["--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check"])
      expect(a).toContain(f);
    expect(a.join(" ")).toContain("--sandbox danger-full-access --cd /w");
    expect(a.join(" ")).toContain('approval_policy="never"');
    expect(a.join(" ")).toContain('web_search="disabled"');
    expect(a.slice(-2)).toEqual(["--model", "gpt-x"]);
  });
});

describe("CodexEngine in the sandbox", () => {
  function fakeCodex(): string {
    const bin = join(root, "bin");
    mkdirSync(bin);
    const p = join(bin, "codex");
    writeFileSync(
      p,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex-cli 0.0.0-test"; exit 0; fi
if [ "$1" = "login" ] && [ "$2" = "status" ]; then
  if [ -f "$CODEX_HOME/auth.json" ]; then echo "Logged in using ChatGPT" >&2; exit 0; fi
  echo "Not logged in" >&2; exit 1
fi
cat > task.txt
touch "$CODEX_HOME/ran"
/usr/bin/curl -s -m 3 https://example.com > /dev/null 2>&1 && echo leaked > leak.txt
/usr/bin/curl -s -m 3 --noproxy '*' https://example.com > /dev/null 2>&1 && echo leaked > leak2.txt
ls "${root}" > /dev/null 2>&1 && echo saw > saw.txt
echo '{"type":"thread.started","thread_id":"t1"}'
echo '{"type":"item.completed","item":{"type":"command_execution","status":"completed"}}'
echo '{"type":"item.completed","item":{"type":"agent_message","text":"Wrote task.txt."}}'
echo '{"type":"turn.completed","usage":{"input_tokens":120,"cached_input_tokens":0,"output_tokens":30}}'
`,
    );
    chmodSync(p, 0o755);
    return p;
  }

  test("runs on the workspace copy, in its own Codex folder, and reaches nothing but the filter", async () => {
    const ws = join(root, "ws");
    const tmp = join(root, "tmp");
    mkdirSync(ws);
    mkdirSync(tmp);
    const codexHome = join(root, "codex-home");
    const e = new CodexEngine({ binary: fakeCodex(), codexHome });
    const r = await e.run({
      ws,
      tmp,
      goal: "Task: write the file",
      instructions: "You are Helper.",
      sandbox: macSandbox,
      home: root,
      timeoutMs: 30_000,
      maxTurns: 10,
    });
    expect(r).toMatchObject({ ok: true, summary: "Wrote task.txt.", tokensIn: 120, tokensOut: 30, turns: 1 });
    expect(readFileSync(join(ws, "task.txt"), "utf8")).toBe("You are Helper.\n\nTask: write the file");
    expect(existsSync(join(codexHome, "ran"))).toBe(true);
    // Through the filter: refused. Around it: blocked by the sandbox. Outside its folders: invisible.
    expect(existsSync(join(ws, "leak.txt"))).toBe(false);
    expect(existsSync(join(ws, "leak2.txt"))).toBe(false);
    expect(existsSync(join(ws, "saw.txt"))).toBe(false);
    expect(r.blockedHosts).toContain("example.com:443");
  });

  test("asks Codex whether it's signed in, offline", async () => {
    const ws = join(root, "ws");
    const tmp = join(root, "tmp");
    mkdirSync(ws);
    mkdirSync(tmp);
    const codexHome = join(root, "codex-home");
    const e = new CodexEngine({ binary: fakeCodex(), codexHome });
    expect(await e.authStatus(macSandbox, { ws, tmp })).toEqual({ signedIn: false, method: null });
    writeFileSync(join(codexHome, "auth.json"), "{}");
    expect(await e.authStatus(macSandbox, { ws, tmp })).toEqual({ signedIn: true, method: "chatgpt" });
    expect(await e.version(macSandbox, { ws, tmp })).toEqual({ ok: true, text: "codex-cli 0.0.0-test" });
  });
});
