import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { engineById } from "@covo/models";
import type { Ctx } from "../main.ts";
import { signInLink, startInstall } from "./engines.ts";

// Get (the maker's installer) and the sign-in link, with stand-ins (docs/SUBSCRIPTIONS.md rules 7, 8).

let root: string;
let server: ReturnType<typeof Bun.serve> | undefined;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "covo-setup-")));
});
afterEach(() => {
  server?.stop(true);
  rmSync(root, { recursive: true, force: true });
});

function ctxServing(script: string): Ctx {
  server = Bun.serve({ port: 0, fetch: () => new Response(script) });
  return {
    home: join(root, "Covo"),
    now: Date.now,
    env: { HOME: root, PATH: "/usr/bin:/bin", COVO_INSTALLER_CODEX: `http://127.0.0.1:${server.port}/install.sh` },
    print: () => {},
  };
}

test("Cancel stops the installer and everything it started", async () => {
  // The installer starts a download that would finish the install a second later.
  const ctx = ctxServing(`#!/bin/sh
echo "==> Downloading Codex CLI"
( sleep 1; mkdir -p "$HOME/.local/bin"; touch "$HOME/.local/bin/codex" ) &
sleep 30
`);
  const job = startInstall(ctx, engineById("codex") as NonNullable<ReturnType<typeof engineById>>);
  for (let i = 0; i < 100 && job.step() !== "==> Downloading Codex CLI"; i++) await Bun.sleep(20);
  job.cancel();
  await expect(job.done).rejects.toThrow("Cancelled.");
  await Bun.sleep(1500);
  expect(existsSync(join(root, ".local/bin/codex"))).toBe(false);
});

test("an installer that doesn't download, or isn't a script, is never run", async () => {
  const job = startInstall(
    ctxServing("<html>Not found</html>"),
    engineById("codex") as NonNullable<ReturnType<typeof engineById>>,
  );
  await expect(job.done).rejects.toThrow("didn't look like an installer");
});

test("the sign-in link: https on the maker's own sites only, also inside a terminal link", () => {
  const codex = engineById("codex") as NonNullable<ReturnType<typeof engineById>>;
  const claude = engineById("claude-code") as NonNullable<ReturnType<typeof engineById>>;
  expect(signInLink("visit:\n\nhttps://auth.openai.com/oauth/authorize?a=1&b=2\n", codex)).toBe(
    "https://auth.openai.com/oauth/authorize?a=1&b=2",
  );
  expect(signInLink("go to https://evil.example/oauth?x=https://auth.openai.com/", codex)).toBeNull();
  expect(signInLink("http://claude.ai/login", claude)).toBeNull();
  const esc = String.fromCharCode(27);
  const bel = String.fromCharCode(7);
  expect(
    signInLink(`${esc}]8;;https://claude.ai/oauth/authorize?code=true${bel}this link${esc}]8;;${bel}`, claude),
  ).toBe("https://claude.ai/oauth/authorize?code=true");
});
