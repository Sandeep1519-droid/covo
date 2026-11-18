import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { covoPaths } from "@covo/core";
import { openDb } from "@covo/db";
import { type ChatRequest, MockProvider, type ModelEvent, type ModelProvider } from "@covo/models";
import type { SystemInfo } from "@covo/platform";
import { LABEL, plistXml } from "../commands/service.ts";
import { type Ctx, main } from "../main.ts";
import { runViaService, serviceHealth, socketPath } from "./client.ts";
import { type Running, type ServiceMessage, ServiceRunningError, serve } from "./server.ts";

// Phase 3 M0: Covo's background service.

let root: string;
let home: string;
let running: Running | undefined;
const env = () => ({ COVO_HOME: home, HOME: root });
const mac8: () => SystemInfo = () => ({
  memoryGB: 8,
  chip: "Apple M3",
  performanceCores: 4,
  cores: 8,
  memoryPressure: "normal",
  power: { source: "ac", percent: 100 },
  thermal: "normal",
});

/** A scripted model that takes a moment per step, like a real one. */
class SlowModel implements ModelProvider {
  readonly id = "mock:slow";
  private readonly inner: MockProvider;
  constructor(
    script: ModelEvent[][],
    private readonly ms: number,
  ) {
    this.inner = new MockProvider(script);
  }
  async *chat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
    await Bun.sleep(this.ms);
    if (signal?.aborted) {
      yield { type: "done", stop: "error", error: "aborted" };
      return;
    }
    yield* this.inner.chat(req);
  }
}

const write = (path: string, content: string) => MockProvider.tool("write_file", { path, content });
const finish = (summary: string) => MockProvider.tool("finish", { summary });

function serviceCtx(provider: ModelProvider): Ctx {
  return { home, now: Date.now, env: env(), print: () => {}, provider, system: mac8 };
}

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "covo-svc-")));
  home = join(root, "Covo");
  await main(["init"], env());
  writeFileSync(join(home, "workspaces/default/README.md"), "# Demo\n");
});
afterEach(async () => {
  await running?.close();
  running = undefined;
  rmSync(root, { recursive: true, force: true });
});

test("covo run hands the task to the service and prints the same result", async () => {
  running = await serve(serviceCtx(new MockProvider([write("NOTES.md", "hi\n"), finish("Wrote notes")])));
  const h = await serviceHealth(home);
  expect(h).toMatchObject({ ok: true, running: 0, queued: 0 });
  expect(h?.pid).toBe(process.pid);

  let printed = "";
  const r = await main(["run", "write NOTES.md"], env(), { print: (s) => (printed += s), system: mac8 });
  expect(r.code).toBe(0);
  expect(printed).toContain("Making a safe copy of the workspace");
  expect(printed).toContain("write_file");
  expect(r.out).toContain("Kept in your workspace");
  expect(readFileSync(join(home, "workspaces/default/NOTES.md"), "utf8")).toBe("hi\n");

  const status = await main(["status"], env(), { system: mac8 });
  expect(status.out).toContain("Covo's service: running, 0 tasks now, 0 waiting.");
});

test("a task carries on after the terminal goes away", async () => {
  running = await serve(serviceCtx(new SlowModel([write("A.md", "a\n"), finish("done")], 150)));
  const ac = new AbortController();
  const first = await fetch("http://covod/runs", {
    unix: socketPath(home),
    method: "POST",
    body: JSON.stringify({ goal: "write A.md" }),
    signal: ac.signal,
  });
  const reader = (first.body as ReadableStream<Uint8Array>).getReader();
  await reader.read(); // the first message arrives…
  ac.abort(); // …then the terminal closes
  for (let i = 0; i < 100 && !existsSync(join(home, "workspaces/default/A.md")); i++) await Bun.sleep(50);
  expect(readFileSync(join(home, "workspaces/default/A.md"), "utf8")).toBe("a\n");
  const db = openDb(covoPaths(home).db);
  expect(db.query<{ state: string }, []>("SELECT state FROM runs").get()?.state).toBe("KEPT");
  db.close();
});

test("on an 8 GB Mac a second task waits for the first, then runs", async () => {
  running = await serve(
    serviceCtx(new SlowModel([write("A.md", "a\n"), finish("a"), write("B.md", "b\n"), finish("b")], 100)),
    { retryMs: 50 },
  );
  const seen: ServiceMessage[][] = [[], []];
  const [a, b] = await Promise.all([
    runViaService(home, { goal: "write A.md" }, (m) => seen[0]?.push(m)),
    (async () => {
      await Bun.sleep(30);
      return runViaService(home, { goal: "write B.md" }, (m) => seen[1]?.push(m));
    })(),
  ]);
  expect(a?.type).toBe("done");
  expect(b?.type).toBe("done");
  expect(seen[1]?.find((m) => m.type === "queued")).toMatchObject({ position: 1 });
  expect(seen[1]?.some((m) => m.type === "waiting" && /1 task at a time/.test(m.reason))).toBe(true);
  // B started only after A finished.
  const db = openDb(covoPaths(home).db);
  const runs = db
    .query<{ goal: string; started_at: number; finished_at: number }, []>(
      "SELECT goal, started_at, finished_at FROM runs ORDER BY created_at",
    )
    .all();
  db.close();
  expect(runs.map((r) => r.goal)).toEqual(["write A.md", "write B.md"]);
  expect((runs[1] as { started_at: number }).started_at).toBeGreaterThanOrEqual(
    (runs[0] as { finished_at: number }).finished_at,
  );
});

test("covo stop stops a running task safely", async () => {
  running = await serve(serviceCtx(new SlowModel([write("A.md", "a\n"), write("B.md", "b\n"), finish("x")], 300)));
  let runId = "";
  const done = runViaService(home, { goal: "slow" }, (m) => {
    if (m.type === "event" && m.event.type === "state") runId = m.event.runId;
  });
  for (let i = 0; i < 50 && !runId; i++) await Bun.sleep(20);
  const r = await main(["stop", runId.slice(-6)], env());
  expect(r.code).toBe(0);
  const last = await done;
  expect(last?.type === "done" && last.summary.state).toBe("STOPPED");
  expect(existsSync(join(home, "workspaces/default/A.md"))).toBe(false);
});

test("tasks left by a crash are cleaned up when the service starts; a second service is refused", async () => {
  const db = openDb(covoPaths(home).db);
  db.query(
    `INSERT INTO runs (id, agent_id, department_id, trigger, goal, state, created_at, pid)
     VALUES ('run_crashed', 'bot_assistant', 'dept_default', 'cli', 'x', 'RUNNING', 1, 999999)`,
  ).run();
  db.close();
  mkdirSync(join(home, "runs", "run_crashed", "ws"), { recursive: true });
  // A stale socket file from the crash, too.
  mkdirSync(join(home, "run"), { recursive: true });
  writeFileSync(socketPath(home), "");

  running = await serve(serviceCtx(new MockProvider([])));
  expect(running.recovered).toEqual(["run_crashed"]);
  const db2 = openDb(covoPaths(home).db);
  expect(db2.query<{ state: string }, []>("SELECT state FROM runs WHERE id = 'run_crashed'").get()?.state).toBe(
    "FAILED",
  );
  db2.close();
  expect(existsSync(join(home, "runs", "run_crashed", "ws"))).toBe(false);
  expect(serve(serviceCtx(new MockProvider([])))).rejects.toBeInstanceOf(ServiceRunningError);
});

test("covo run without the service still works in the terminal", async () => {
  const r = await main(["run", "write NOTES.md"], env(), {
    provider: new MockProvider([write("NOTES.md", "x\n"), finish("ok")]),
    system: mac8,
    print: () => {},
  });
  expect(r.code).toBe(0);
  const status = await main(["status"], env());
  expect(status.out).toContain("Covo's service: not running");
});

test("install writes a login item and starts it; uninstall removes it", async () => {
  const calls: string[][] = [];
  const launchctl = (args: string[]) => {
    calls.push(args);
    return { code: 0, out: "" };
  };
  const inst = await main(["service", "install"], env(), { launchctl });
  expect(inst.code).toBe(0);
  const file = join(root, "Library", "LaunchAgents", `${LABEL}.plist`);
  const xml = readFileSync(file, "utf8");
  expect(xml).toContain(`<string>${LABEL}</string>`);
  expect(xml).toContain("<string>service</string>\n      <string>run</string>");
  expect(xml).toContain(`<key>COVO_HOME</key>\n      <string>${home}</string>`);
  expect(calls.map((c) => c[0])).toEqual(["bootout", "bootstrap"]);
  expect(calls[1]?.[2]).toBe(file);

  const un = await main(["service", "uninstall"], env(), { launchctl });
  expect(un.code).toBe(0);
  expect(existsSync(file)).toBe(false);
  expect(plistXml({ label: "a&b", args: ["<x>"], env: {}, log: "/l" })).toContain("<string>a&amp;b</string>");
});
