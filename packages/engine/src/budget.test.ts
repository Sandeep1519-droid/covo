import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { covoPaths } from "@covo/core";
import { initHome, openDb, verifyAudit } from "@covo/db";
import { MockProvider, type ModelEvent, type ModelProvider } from "@covo/models";
import { createBot } from "./bots.ts";
import { decide, startOfLocalDay } from "./budget.ts";
import { type RunEvent, startRun } from "./run.ts";

let home: string;
beforeEach(() => {
  home = join(realpathSync(mkdtempSync(join(tmpdir(), "covo-budget-"))), "Covo");
  initHome(home);
  writeFileSync(join(home, "workspaces/default/README.md"), "# Project\n");
});
afterEach(() => rmSync(join(home, ".."), { recursive: true, force: true }));

/** A scripted model billed as Claude Opus 5.5: each call uses 100k tokens in and 10k out = $0.60. */
function paid(turns: ModelEvent[][], id = "anthropic:claude-opus-5-5"): ModelProvider {
  const m = new MockProvider(
    turns.map((t) => [{ type: "usage", tokensIn: 100_000, tokensOut: 10_000 } as ModelEvent, ...t]),
  );
  return { id, chat: (req) => m.chat(req) };
}
const threeSteps = () => [
  MockProvider.tool("list_files", {}),
  MockProvider.tool("read_file", { path: "README.md" }),
  MockProvider.tool("finish", { summary: "Looked around" }),
];
const db = () => openDb(covoPaths(home).db);

test("records what each call cost", async () => {
  const r = await startRun({ home, goal: "x", provider: paid(threeSteps()) });
  expect(r.state).toBe("SUCCEEDED");
  expect(r.costUsd).toBeCloseTo(1.8, 6);
  const d = db();
  const sum = d
    .query<{ s: number; e: number }, []>("SELECT SUM(usd) AS s, MAX(estimated) AS e FROM budget_ledger")
    .get();
  expect(sum?.s).toBeCloseTo(1.8, 6);
  expect(sum?.e).toBe(0);
  expect(d.query<{ c: number }, []>("SELECT cost_usd AS c FROM runs").get()?.c).toBeCloseTo(1.8, 6);
  d.close();
});

test("pauses before going over the task limit; approving lets it continue", async () => {
  const states: string[] = [];
  const asked: string[] = [];
  const r = await startRun({
    home,
    goal: "x",
    provider: paid(threeSteps()),
    spend: { runUsd: 1, dayUsd: null },
    askApproval: async (req) => {
      asked.push(req.summary);
      return true;
    },
    onEvent: (e: RunEvent) => e.type === "state" && states.push(e.state),
  });
  expect(r.state).toBe("SUCCEEDED");
  // Approving covers the next step ($0.60) plus four more steps' worth ($2.40, more than the $1.00 limit).
  expect(asked).toHaveLength(1);
  expect(asked[0]).toContain("has spent $0.60 of its $1.00 limit for this task");
  expect(asked[0]).toContain("Approve to let it spend up to $3.00 more");
  expect(states).toEqual(["PREPARING", "RUNNING", "AWAITING_APPROVAL", "RUNNING", "SUCCEEDED"]);
  const d = db();
  expect(d.query("SELECT kind, status, decided_by FROM approvals LIMIT 1").get()).toEqual({
    kind: "spend",
    status: "approved",
    decided_by: "you (in the terminal)",
  });
  expect(verifyAudit(d).ok).toBe(true);
  d.close();
});

test("a step that costs more than the whole limit doesn't mean a question before every step", async () => {
  const many = [1, 2, 3, 4, 5].map((i) => MockProvider.tool("write_file", { path: `f${i}.txt`, content: "x" }));
  let asked = 0;
  const r = await startRun({
    home,
    goal: "x",
    provider: paid([...many, MockProvider.tool("finish", { summary: "done" })]),
    spend: { runUsd: 0.1, dayUsd: null },
    askApproval: async () => {
      asked++;
      return true;
    },
  });
  expect(r.state).toBe("KEPT"); // the main bot is Automatic, so it kept its own work
  expect(asked).toBeLessThanOrEqual(2); // six $0.60 steps on a $0.10 limit
});

test("saying no stops the run before the call that would go over", async () => {
  const r = await startRun({
    home,
    goal: "x",
    provider: paid(threeSteps()),
    spend: { runUsd: 0.5, dayUsd: null },
    askApproval: async () => false,
  });
  expect(r.state).toBe("STOPPED");
  expect(r.error).toContain("you said no");
  // The first call looked cheap and ran; the second would have gone over, so it never happened.
  expect(r.costUsd).toBeCloseTo(0.6, 6);
});

test("without a terminal it waits for covo approve from elsewhere", async () => {
  const r = await startRun({
    home,
    goal: "x",
    provider: paid(threeSteps()),
    spend: { runUsd: 1, dayUsd: null },
    approvalPollMs: 5,
    onEvent: (e) => {
      if (e.type === "approval") {
        // what `covo approve` does, from another process
        setTimeout(() => {
          const d = db();
          decide(d, e.approvalId, "approved", "you (covo approve)", Date.now);
          d.close();
        }, 20);
      }
    },
  });
  expect(r.state).toBe("SUCCEEDED");
});

test("the daily limit counts every bot's spending today", async () => {
  const d = db();
  d.query(
    "INSERT INTO budget_ledger (ts, tier, provider, model, usd) VALUES (?, 'api', 'anthropic', 'claude-opus-5-5', 4.99)",
  ).run(startOfLocalDay(Date.now()) + 1);
  d.query("INSERT INTO budget_ledger (ts, tier, provider, model, usd) VALUES (?, 'api', 'anthropic', 'x', 99)").run(
    startOfLocalDay(Date.now()) - 1, // yesterday doesn't count
  );
  d.close();
  const asked: string[] = [];
  await startRun({
    home,
    goal: "x",
    provider: paid(threeSteps()),
    spend: { runUsd: null, dayUsd: 5 },
    askApproval: async (req) => {
      asked.push(req.summary);
      return false;
    },
  });
  expect(asked[0]).toContain("past your $5.00 daily limit ($4.99 so far)");
});

test("a bot's own task limit wins; free local models never pause", async () => {
  const bot = createBot(home, { name: "Careful" });
  const d = db();
  d.query("UPDATE agents SET run_limit_usd = 0.1 WHERE id = ?").run(bot.id);
  d.close();
  let asked = 0;
  const ask = async () => {
    asked++;
    return false;
  };
  await startRun({
    home,
    goal: "x",
    agentId: bot.id,
    provider: paid(threeSteps()),
    spend: { runUsd: 100, dayUsd: null },
    askApproval: ask,
  });
  expect(asked).toBe(1);

  const local = await startRun({
    home,
    goal: "y",
    provider: new MockProvider(threeSteps()),
    spend: { runUsd: 0, dayUsd: 0 },
    askApproval: ask,
  });
  expect(local.state).toBe("SUCCEEDED");
  expect(asked).toBe(1);
});

test("an unknown cloud model is charged at a cautious estimate and marked", async () => {
  await startRun({ home, goal: "x", provider: paid(threeSteps(), "openrouter:some/new-model") });
  const d = db();
  expect(d.query("SELECT MIN(estimated) AS e FROM budget_ledger").get()).toEqual({ e: 1 });
  d.close();
});
