import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { covoPaths } from "@covo/core";
import { openDb, verifyAudit } from "@covo/db";
import { listMessages } from "@covo/engine";
import { type ChatRequest, MockProvider, type ModelEvent, type ModelProvider } from "@covo/models";
import { FakeTelegram } from "@covo/phone/fake";
import { memorySecrets, type SystemInfo } from "@covo/platform";
import { type Ctx, main } from "../main.ts";
import type { Prompter } from "../prompt.ts";
import { socketPath } from "./client.ts";
import { type Running, serve } from "./server.ts";

// Phase 3 M7: the acceptance demo in PHASE3.md §4, end to end, with a stand-in model and a stand-in
// Telegram. What you do in the app goes through the same API the app uses; what you type goes
// through `covo`; what you tap on your phone goes through Telegram updates.

const TELEGRAM_TOKEN = "123456789:AAEabcdefghijklmnopqrstuvwxyz012345";
const ME = { id: 777, first_name: "Sandeep" };
const CHAT = 555;

let root: string;
let home: string;
let running: Running | undefined;
let tg: FakeTelegram;
let clock = Date.now();
const secrets = memorySecrets();
const env = () => ({ COVO_HOME: home, HOME: root, COVO_PORT: "0", COVO_SERVICE: "off" });
const mac8 = (): SystemInfo => ({
  memoryGB: 8,
  chip: "Apple M3",
  performanceCores: 4,
  cores: 8,
  memoryPressure: "normal",
  power: { source: "ac", percent: 100 },
  thermal: "normal",
});

/** A stand-in model billed like Claude Opus 5.5 that answers each task by what it was asked. */
function model(): ModelProvider {
  const script = (goal: string): ModelEvent[][] => {
    if (goal.includes("every file in docs"))
      return [
        MockProvider.tool("list_files", { path: "docs" }),
        MockProvider.tool("read_file", { path: "docs/guide.md" }),
        MockProvider.tool("finish", { summary: "docs/ has one guide, about getting started." }),
      ];
    if (goal.includes("NOTES.md"))
      return [
        MockProvider.tool("read_file", { path: "NOTES.md" }),
        MockProvider.tool("finish", { summary: "Your notes are about the launch." }),
      ];
    if (goal.includes("slow"))
      return [
        MockProvider.tool("write_file", { path: "SLOW.md", content: "1\n" }),
        MockProvider.tool("write_file", { path: "SLOW.md", content: "2\n" }),
        MockProvider.tool("finish", { summary: "Slow job done." }),
      ];
    return [
      MockProvider.tool("write_file", { path: "README.md", content: "# Demo\n\n## Setup\n\nRun covo init.\n" }),
      MockProvider.tool("finish", { summary: "Added a Setup section to README.md." }),
    ];
  };
  return {
    id: "anthropic:claude-opus-5-5",
    async *chat(req: ChatRequest) {
      // What it was asked: the "Task:" line (the prompt also lists the workspace's files).
      const prompt = req.messages
        .filter((m) => m.role === "user")
        .map((m) => m.content)
        .join("\n");
      const goal = prompt.match(/Task: ([^\n]*)/)?.[1] ?? prompt;
      if (goal.includes("slow")) await Bun.sleep(400);
      const turn = req.messages.filter((m) => m.role === "assistant").length;
      yield* script(goal)[turn] ?? MockProvider.tool("finish", { summary: "Done." });
    },
  };
}

beforeEach(async () => {
  clock = Date.now();
  root = realpathSync(mkdtempSync(join(tmpdir(), "covo-demo-")));
  home = join(root, "Covo");
  await main(["init"], env());
  const ws = join(home, "workspaces/default");
  writeFileSync(join(ws, "README.md"), "# Demo\n");
  writeFileSync(join(ws, "NOTES.md"), "Launch on Friday.\n");
  mkdirSync(join(ws, "docs"));
  writeFileSync(join(ws, "docs/guide.md"), "# Getting started\n");
  tg = new FakeTelegram();
  for (const k of [...secrets.items.keys()]) secrets.items.delete(k);
});
afterEach(async () => {
  await running?.close();
  running = undefined;
  rmSync(root, { recursive: true, force: true });
});

const runs = () => {
  const db = openDb(covoPaths(home).db);
  const r = db
    .query<{ id: string; agent: string; state: string; trigger: string; routine: string | null }, []>(
      "SELECT id, agent_id AS agent, state, trigger, routine_id AS routine FROM runs ORDER BY created_at, id",
    )
    .all();
  db.close();
  return r;
};
async function until<T>(get: () => T | undefined | null | false, what: string, ms = 5_000): Promise<T> {
  for (let waited = 0; waited < ms; waited += 20) {
    const v = get();
    if (v) return v;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for ${what}`);
}
const DONE = ["SUCCEEDED", "KEPT", "FAILED", "REVIEWING", "ROLLED_BACK", "STOPPED"];
const actions = () => {
  const db = openDb(covoPaths(home).db);
  const a = db
    .query<{ a: string }, []>("SELECT action AS a FROM audit_log")
    .all()
    .map((x) => x.a);
  db.close();
  return a;
};
const hhmm = (t: number) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

test("the Phase 3 acceptance demo, end to end", async () => {
  const ws = join(home, "workspaces/default");
  const ctx: Ctx = {
    home,
    now: () => clock,
    env: env(),
    print: () => {},
    system: mac8,
    secrets,
    provider: model(),
    telegram: () => tg,
  };

  // covo phone connect: your own Telegram bot; you send the pairing code from your phone.
  const prompt: Prompter = { ask: async (_q, d) => d ?? "", secret: async () => TELEGRAM_TOKEN };
  const connected = await main(["phone", "connect"], env(), {
    prompt,
    secrets,
    telegram: () => tg,
    print: (s: string) => {
      const code = s.match(/COVO-[A-Z2-9]{4}-[A-Z2-9]{4}/)?.[0];
      if (code && s.includes("send this code")) tg.say(ME, CHAT, `/start ${code}`);
    },
  });
  expect(connected.code).toBe(0);

  // No automatic daily summary while this test moves the clock; `covo summary now` makes one below.
  expect((await main(["summary", "off"], env())).code).toBe(0);

  // The service (covo service install starts it at login), and the app, signed in with a one-time code.
  running = await serve(ctx);
  const base = `http://127.0.0.1:${running.port}`;
  const code = (
    (await (await fetch("http://covod/pair-code", { unix: socketPath(home), method: "POST" })).json()) as {
      code: string;
    }
  ).code;
  const paired = await fetch(`${base}/api/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ code }),
  });
  expect(paired.status).toBe(200);
  const cookie = (paired.headers.get("set-cookie") ?? "").split(";")[0] as string;
  const app = (path: string, body?: unknown) =>
    fetch(`${base}/api${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { cookie, origin: base, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  // In the app: New bot "Docs helper" (local model, works on its own).
  const made = await app("/bots", { name: "Docs helper", models: ["local"], level: "automatic" });
  expect(made.status).toBe(201);
  const bot = ((await made.json()) as { id: string }).id;

  // Chat: "add a Setup section to README.md" → kept → Undo → restored.
  expect((await app(`/bots/${bot}/messages`, { text: "add a Setup section to README.md" })).status).toBe(201);
  const first = await until(() => runs().find((r) => r.agent === bot && DONE.includes(r.state)), "the first task");
  expect(first.state).toBe("KEPT");
  expect(readFileSync(join(ws, "README.md"), "utf8")).toContain("## Setup");
  expect((await app(`/runs/${first.id}/undo`, {})).status).toBe(200);
  expect(readFileSync(join(ws, "README.md"), "utf8")).toBe("# Demo\n");

  // covo bots set "Docs helper" --task-limit 0.001
  expect((await main(["bots", "set", "Docs helper", "--task-limit", "0.001"], env())).code).toBe(0);

  // Chat: "summarise every file in docs/" → it pauses → the card is in the app AND on your phone.
  expect((await app(`/bots/${bot}/messages`, { text: "summarise every file in docs/" })).status).toBe(201);
  const card = await until(
    () => tg.sent.find((m) => m.chatId === CHAT && m.text.includes("Spend up to")),
    "the spending card on the phone",
  );
  const inApp = (await (await app("/approvals")).json()) as { id: string }[];
  expect(inApp).toHaveLength(1);
  // Approve on the phone.
  tg.push({
    callback_query: {
      id: "tap-1",
      from: ME,
      data: card.buttons?.[0]?.[0]?.data ?? "",
      message: { message_id: card.messageId, chat: { id: CHAT, type: "private" }, date: 0 },
    },
  });
  const second = await until(
    () => runs().filter((r) => r.agent === bot)[1]?.state === "SUCCEEDED" && runs().filter((r) => r.agent === bot)[1],
    "the paused task to go on and finish",
  );
  expect(second.state).toBe("SUCCEEDED");

  // covo routines add "Daily notes" ... two minutes from now; it runs by itself.
  const at = hhmm(clock + 2 * 60_000);
  const added = await main(
    [
      "routines",
      "add",
      "Daily notes",
      "--bot",
      "Docs helper",
      "--every",
      `every day at ${at}`,
      "--limit",
      "1",
      "summarise NOTES.md",
    ],
    env(),
    { now: () => clock },
  );
  expect(added.code).toBe(0);
  clock += 3 * 60_000;
  await running.service.scheduler?.tick();
  const routineRun = await until(
    () => runs().find((r) => r.routine !== null && DONE.includes(r.state)),
    "the routine to run by itself",
  );
  expect(routineRun).toMatchObject({ trigger: "routine", state: "SUCCEEDED" });

  // covo summary now: the daily summary lists both runs.
  const made2 = await main(["summary", "now"], env(), { now: () => clock });
  expect(made2.code).toBe(0);
  expect(made2.out).toContain("• Docs helper: docs/ has one guide");
  expect(made2.out).toContain("• Docs helper, Daily notes: Your notes are about the launch.");
  // It's in your main bot's chat too.
  const summary = listMessages(home, "Assistant", { now: () => clock }).filter((m) => m.role === "bot");
  expect(summary.map((m) => m.text)).toEqual([expect.stringContaining("Docs helper, Daily notes:")]);

  // curl http://127.0.0.1:7420/api/runs → 401: no token.
  expect((await fetch(`${base}/api/runs`)).status).toBe(401);

  // covo audit verify: the chain is whole; the phone's answer is recorded as yours, from your phone.
  expect((await main(["audit", "verify"], env())).code).toBe(0);
  const db = openDb(covoPaths(home).db);
  expect(db.query<{ by: string }, []>("SELECT decided_by AS by FROM approvals").get()?.by).toBe("you (phone)");
  expect(verifyAudit(db).ok).toBe(true);
  db.close();
  // Everything done in the app or on the phone is in the activity log, as from covo.
  const log = actions();
  for (const a of ["bot.created", "run.keep", "run.undo", "approval.decided", "routine.created", "api.refused"])
    expect(log).toContain(a);

  // Stopping the service stops a running task safely and throws its workspace copy away.
  expect((await app("/runs", { goal: "a slow job" })).status).toBe(202);
  const slow = await until(() => runs().find((r) => r.state === "RUNNING"), "the slow task to start");
  await running.close();
  running = undefined;
  const after = runs().find((r) => r.id === slow.id);
  expect(after?.state).toBe("STOPPED");
  expect(existsSync(join(ws, "SLOW.md"))).toBe(false);
  expect(existsSync(join(home, "runs", slow.id, "ws"))).toBe(false);
});
