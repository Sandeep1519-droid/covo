import type { Database } from "bun:sqlite";
import { userInfo } from "node:os";
import type {
  ApiApproval,
  ApiBot,
  ApiChatMessage,
  ApiLimits,
  ApiMe,
  ApiModel,
  ApiPause,
  ApiProfile,
  ApiProvider,
  ApiRoutineSettings,
  ApiRun,
  ApiRunDetail,
  ApiStep,
  ApiSummary,
  ApiUsage,
  UsageRow,
} from "@covo/api";
import { covoPaths, VERSION } from "@covo/core";
import { openDb, verifyAudit } from "@covo/db";
import {
  addBotMessage,
  addMessage,
  addRoutine,
  archiveBot,
  type Bot,
  type ChatMessage,
  changesOf,
  createBot,
  decide,
  describeSchedule,
  discardRun,
  failMessage,
  getRoutine,
  isPaused,
  keepRun,
  linkRun,
  listBots,
  listMessages,
  listRoutines,
  nextRun,
  parseSchedule,
  pauseState,
  postSummary,
  type RefusedAnswer,
  RunError,
  refuseAnswer,
  removeRoutine,
  reviewRun,
  routineFromChat,
  routineRuns,
  ScheduleError,
  setPaused,
  startOfLocalDay,
  undoRun,
  updateBot,
  updateRoutine,
} from "@covo/engine";
import {
  addConnection,
  engineById,
  getLimits,
  getRoutineSettings,
  listModelsFor,
  loadSettings,
  ModelConfigError,
  modelConfig,
  PRESETS,
  presetById,
  removeConnection,
  setDefault,
  setLimits,
  setRoutineSettings,
} from "@covo/models";
import { SecretError, secrets } from "@covo/platform";
import { UndoError } from "@covo/sandbox";
import { doctorCommand } from "../commands/doctor.ts";
import { findProgram } from "../commands/engines.ts";
import { currentCapacity, readSystem } from "../commands/profile.ts";
import type { Ctx } from "../main.ts";
import { PrepareError } from "../runner.ts";
import { COOKIE, type Gate } from "./gate.ts";
import type { Service, ServiceMessage } from "./server.ts";

// Covo's local API (Phase 3 M1): everything the command line does, as JSON, for the app and the
// Mac app. Same engine functions, same activity log. Keys go in and never come out.

let fullName: string | undefined;
/** Your name as macOS knows it (for the app's sidebar), else your account name. */
function userName(): string {
  if (fullName === undefined) {
    let n = "";
    try {
      n = Bun.spawnSync(["/usr/bin/id", "-F"]).stdout.toString().trim();
    } catch {}
    fullName = n || userInfo().username;
  }
  return fullName;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
};

export const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...SECURITY_HEADERS, ...extra },
  });

const fail = (status: number, error: string) => json({ error }, status);

function withDb<T>(ctx: Ctx, fn: (db: Database) => T): T {
  const db = openDb(covoPaths(ctx.home).db);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

const toBot = (b: Bot): ApiBot => ({ ...b });

type RunRow = {
  id: string;
  state: string;
  goal: string;
  agent_id: string;
  bot_name: string | null;
  model: string | null;
  trigger: string;
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  summary: string | null;
  error: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  routine_id: string | null;
  routine_name: string | null;
};
const RUN_SELECT = `SELECT r.id, r.state, r.goal, r.agent_id, a.name AS bot_name, r.model, r.trigger, r.cost_usd,
  r.tokens_in, r.tokens_out, r.summary, r.error, r.created_at, r.started_at, r.finished_at,
  r.routine_id, t.name AS routine_name
  FROM runs r LEFT JOIN agents a ON a.id = r.agent_id LEFT JOIN routines t ON t.id = r.routine_id`;
const toRun = (r: RunRow): ApiRun => ({
  id: r.id,
  state: r.state,
  goal: r.goal,
  botId: r.agent_id,
  botName: r.bot_name ?? "",
  model: r.model,
  trigger: r.trigger,
  costUsd: r.cost_usd,
  tokensIn: r.tokens_in,
  tokensOut: r.tokens_out,
  summary: r.summary,
  error: r.error,
  createdAt: r.created_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  routineId: r.routine_id,
  routineName: r.routine_name,
});

function findRunId(db: Database, arg: string): string {
  const exact = db.query<{ id: string }, [string]>("SELECT id FROM runs WHERE id = ?").get(arg);
  if (exact) return exact.id;
  if (arg.length >= 4) {
    const hits = db.query<{ id: string }, [string]>("SELECT id FROM runs WHERE id LIKE ?").all(`%${arg}`);
    if (hits.length === 1 && hits[0]) return hits[0].id;
  }
  throw new HttpError(404, `No run "${arg}".`);
}

async function body<T>(req: Request): Promise<T> {
  try {
    const v = (await req.json()) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v as T;
  } catch {
    throw new HttpError(400, "Expected a JSON object.");
  }
}

const isLimit = (v: unknown) => v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0);

function usage(ctx: Ctx, days: number): ApiUsage {
  return withDb(ctx, (db) => {
    const today = startOfLocalDay(ctx.now());
    const since = today - (days - 1) * 86_400_000;
    const by = (expr: string): UsageRow[] =>
      db
        .query<{ label: string | null; calls: number; tin: number; tout: number; cost: number; est: number }, [number]>(
          `SELECT ${expr} AS label, COUNT(*) AS calls, SUM(tokens_in) AS tin, SUM(tokens_out) AS tout,
             SUM(usd) AS cost, MAX(estimated) AS est
           FROM budget_ledger l LEFT JOIN agents a ON a.id = l.agent_id
           WHERE l.ts >= ? GROUP BY label ORDER BY cost DESC, calls DESC`,
        )
        .all(since)
        .map((r) => ({
          label: r.label ?? "?",
          calls: r.calls,
          tokensIn: r.tin,
          tokensOut: r.tout,
          usd: r.cost,
          estimated: r.est === 1,
        }));
    const sum = (from: number) =>
      db.query<{ c: number | null }, [number]>("SELECT SUM(usd) AS c FROM budget_ledger WHERE ts >= ?").get(from)?.c ??
      0;
    return {
      days,
      totalUsd: sum(since),
      todayUsd: sum(today),
      limits: getLimits(ctx.home),
      byModel: by("l.model"),
      byBot: by("COALESCE(a.name, 'other')"),
      byDay: by("strftime('%Y-%m-%d', l.ts / 1000, 'unixepoch', 'localtime')"),
    };
  });
}

function profile(ctx: Ctx): ApiProfile {
  const sys = readSystem(ctx);
  const cap = currentCapacity(ctx, sys);
  return {
    mac: { chip: sys.chip, memoryGB: sys.memoryGB, cores: sys.cores, performanceCores: sys.performanceCores },
    now: {
      memoryPressure: sys.memoryPressure,
      power: sys.power.source,
      batteryPercent: sys.power.percent,
      thermal: sys.thermal,
    },
    profile: { name: cap.profile.name, label: cap.profile.label, chosen: cap.chosen },
    maxRuns: cap.maxRuns,
    canStart: cap.canStart,
    notes: cap.notes,
    local: {
      maxParamsB: cap.profile.localParamsB,
      contextTokens: cap.profile.contextTokens,
      keepAlive: cap.profile.keepAlive,
    },
  };
}

function models(ctx: Ctx): ApiModel[] {
  const s = loadSettings(ctx.home);
  return s.connections.map((c) => ({
    name: c.name,
    provider: c.provider,
    providerLabel: presetById(c.provider)?.label ?? engineById(c.provider)?.label ?? c.provider,
    model: c.model,
    hasKey: c.keyId !== undefined,
    isDefault: s.default === c.name,
    engine: engineById(c.provider) !== undefined,
  }));
}

async function addModel(ctx: Ctx, b: Record<string, unknown>): Promise<ApiModel> {
  const provider = String(b.provider ?? "").toLowerCase();
  const model = typeof b.model === "string" ? b.model.trim() : "";
  const key = typeof b.key === "string" && b.key.trim() ? b.key.trim() : undefined;
  const baseUrl = typeof b.baseUrl === "string" && b.baseUrl ? b.baseUrl : undefined;
  if (!model) throw new HttpError(400, "Choose a model.");
  const preset = presetById(provider);
  const engine = engineById(provider);
  if (!preset && !engine) throw new HttpError(400, `Unknown service "${provider}".`);
  if (engine) {
    if (!findProgram(ctx, engine.command)) throw new HttpError(422, `${engine.label} isn't installed.`);
  } else if (preset) {
    if (!preset.local && !key) throw new HttpError(400, `A ${preset.label} key is needed.`);
    // Check the key works before saving anything.
    const probe = {
      ...modelConfig({ COVO_PROVIDER: preset.id, COVO_MODEL_BASE_URL: baseUrl }, { requireModel: false }),
      ...(key ? { apiKey: key, keySource: "the app" } : {}),
    };
    try {
      await (ctx.listModels ?? listModelsFor)(probe, AbortSignal.timeout(15_000));
    } catch (e) {
      throw new HttpError(422, `That didn't work: ${(e as Error).message}. Nothing was saved.`);
    }
  }
  const s = loadSettings(ctx.home);
  const name =
    typeof b.name === "string" && b.name
      ? b.name
      : (engine?.suggestedName ?? (preset?.local ? "local" : provider === "anthropic" ? "claude" : provider));
  const c = await addConnection(ctx.home, ctx.secrets ?? secrets(), {
    name,
    provider,
    model,
    ...(baseUrl ? { baseUrl } : {}),
    ...(key ? { key } : {}),
    makeDefault: b.makeDefault === true || s.connections.length === 0,
  });
  const out = models(ctx).find((m) => m.name === c.name);
  if (!out) throw new HttpError(500, "Saved, but couldn't read it back.");
  return out;
}

const toMessage = (m: ChatMessage): ApiChatMessage => ({
  id: m.id,
  role: m.role,
  text: m.text,
  runId: m.runId,
  model: m.model,
  error: m.error,
  data: m.data,
  createdAt: m.createdAt,
});

const clipName = (task: string) => {
  const t = task.replace(/\s+/g, " ").trim();
  return t.length > 40 ? `${t.slice(0, 39).trimEnd()}…` : t;
};

/** "Brief me", then "Brief me (2)": routine names are unique. */
function uniqueRoutineName(ctx: Ctx, base: string): string {
  const taken = new Set(listRoutines(ctx.home, { now: ctx.now }).map((r) => r.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base} (${i})`.toLowerCase())) return `${base} (${i})`;
}

/**
 * Saves your message and starts its task with the last few turns as context. If the task can't
 * start (no model, Covo shutting down), the message keeps the reason, so the chat can show it.
 */
export async function sendMessage(
  ctx: Ctx,
  service: Service,
  bot: string,
  b: Record<string, unknown>,
  by: "token" | "session",
  /** Where the task came from, when not the app or the API ("phone"). */
  from?: string,
): Promise<ApiChatMessage> {
  if (typeof b.text !== "string" || !b.text.trim()) throw new HttpError(400, "Write a message first.");
  const model = typeof b.model === "string" && b.model ? b.model : undefined;
  const asked = by === "session" || from === undefined ? routineFromChat(b.text) : null;
  if (asked) {
    const name = clipName(asked.task);
    const routine = addRoutine(
      ctx.home,
      { name: uniqueRoutineName(ctx, name), bot, task: asked.task, every: asked.every, ...(model ? { model } : {}) },
      ctx.now,
    );
    const mine = addMessage(ctx.home, bot, b.text, { now: ctx.now, data: { kind: "routine", routineId: routine.id } });
    const first = routine.nextAt ? new Date(routine.nextAt) : null;
    addBotMessage(
      ctx.home,
      bot,
      `OK: I'll do that ${routine.scheduleText.charAt(0).toLowerCase()}${routine.scheduleText.slice(1)}` +
        `${first ? `, starting ${first.toLocaleDateString("en-GB", { weekday: "long" })} at ${String(first.getHours()).padStart(2, "0")}:${String(first.getMinutes()).padStart(2, "0")}` : ""}.` +
        ` It's the routine "${routine.name}"; change or pause it in my details.`,
      { kind: "routine-made", routineId: routine.id },
      ctx.now,
    );
    service.announce({ type: "changed", what: "routine" });
    return toMessage(mine.message);
  }
  const {
    message,
    bot: found,
    context,
  } = addMessage(ctx.home, bot, b.text, { now: ctx.now, ...(model ? { model } : {}) });
  try {
    const job = await service.submit({
      goal: message.text,
      bot: found.id,
      ...(model ? { model } : {}),
      ...(context ? { context } : {}),
      trigger: from ?? (by === "session" ? "chat" : "api"),
    });
    job.listeners.add((msg: ServiceMessage) => {
      if (msg.type === "event" && msg.event.type === "state") linkRun(ctx.home, message.id, msg.event.runId, ctx.now);
      else if (msg.type === "error") failMessage(ctx.home, message.id, msg.message, ctx.now);
    });
    service.start(job);
    return toMessage(message);
  } catch (e) {
    if (!(e instanceof PrepareError || e instanceof ModelConfigError || e instanceof SecretError)) throw e;
    failMessage(ctx.home, message.id, e.message, ctx.now);
    return toMessage({ ...message, error: e.message });
  }
}

/** The routine fields a request may set, checked for type (the engine checks the rest). */
function routineFields(b: Record<string, unknown>, isNew: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ["name", "bot", "task", "every"]) {
    if (k in b) {
      if (typeof b[k] !== "string") throw new HttpError(400, `${k} must be text.`);
      out[k] = b[k];
    } else if (isNew) throw new HttpError(400, `A routine needs ${k === "every" ? "a schedule (every)" : `a ${k}`}.`);
  }
  if ("model" in b) out.model = typeof b.model === "string" && b.model ? b.model : null;
  if ("runLimitUsd" in b) {
    if (!isLimit(b.runLimitUsd)) throw new HttpError(400, "runLimitUsd must be a dollar amount of 0 or more, or null.");
    out.runLimitUsd = b.runLimitUsd;
  }
  if ("quiet" in b) out.quiet = b.quiet === true;
  if (!isNew && (b.status === "active" || b.status === "paused")) out.status = b.status;
  return out;
}

function pauseInfo(ctx: Ctx, service: Service): ApiPause {
  return { ...pauseState(ctx.home), queued: service.waitingJobs().length };
}

function summary(ctx: Ctx, service: Service): ApiSummary {
  const runs = withDb(ctx, (db) =>
    db
      .query<RunRow, []>(
        `${RUN_SELECT} WHERE r.state IN ('QUEUED','PREPARING','RUNNING','AWAITING_APPROVAL','REVIEWING') ORDER BY r.created_at DESC`,
      )
      .all()
      .map(toRun),
  );
  const byRun = new Map(runs.map((r) => [r.id, r]));
  const waiting: ApiSummary["waiting"] = [];
  for (const a of approvals(ctx)) {
    const r = byRun.get(a.runId);
    if (!r) continue;
    waiting.push({
      id: a.id,
      kind: "approval",
      runId: r.id,
      botId: r.botId,
      botName: r.botName,
      title: a.spend ? `Spend up to $${a.spend.grantUsd.toFixed(2)} more: ${r.goal}` : a.summary,
      payloadHash: a.payloadHash,
      at: r.createdAt,
    });
  }
  for (const r of runs.filter((x) => x.state === "REVIEWING")) {
    waiting.push({
      id: r.id,
      kind: "changes",
      runId: r.id,
      botId: r.botId,
      botName: r.botName,
      title: `Review changes: ${r.goal}`,
      at: r.finishedAt ?? r.createdAt,
    });
  }
  waiting.sort((x, y) => y.at - x.at);
  const u = usage(ctx, 1);
  return {
    paused: isPaused(ctx.home),
    running: runs
      .filter((r) => r.state === "PREPARING" || r.state === "RUNNING" || r.state === "QUEUED")
      .map((r) => ({ runId: r.id, botId: r.botId, botName: r.botName, goal: r.goal, startedAt: r.startedAt })),
    queued: service.waitingJobs().length,
    waiting,
    todayUsd: u.todayUsd,
    dayLimitUsd: u.limits.dayUsd,
  };
}

function approvals(ctx: Ctx): ApiApproval[] {
  return withDb(ctx, (db) =>
    db
      .query<
        {
          id: string;
          run_id: string;
          kind: string;
          summary: string;
          payload_json: string;
          payload_hash: string;
          expires_at: number;
        },
        []
      >(
        "SELECT id, run_id, kind, summary, payload_json, payload_hash, expires_at FROM approvals WHERE status = 'pending' ORDER BY rowid",
      )
      .all()
      .map((a): ApiApproval => {
        const out: ApiApproval = {
          id: a.id,
          runId: a.run_id,
          kind: a.kind,
          summary: a.summary,
          payloadHash: a.payload_hash,
          expiresAt: a.expires_at,
        };
        if (a.kind === "spend") {
          try {
            const p = JSON.parse(a.payload_json) as Record<string, unknown>;
            const n = (k: string) => (typeof p[k] === "number" ? (p[k] as number) : 0);
            out.spend = {
              spentUsd: n("spentUsd"),
              estimateUsd: n("estimateUsd"),
              grantUsd: n("grantUsd"),
              overDay: p.overDay === true,
              dayUsd: typeof p.day === "number" ? p.day : null,
            };
          } catch {}
        }
        return out;
      }),
  );
}

function decideApproval(ctx: Ctx, id: string, b: Record<string, unknown>, by: string): { status: string } {
  if (b.decision !== "approve" && b.decision !== "deny")
    throw new HttpError(400, 'decision must be "approve" or "deny".');
  return withDb(ctx, (db) => {
    const a = db
      .query<{ status: string; payload_hash: string; expires_at: number }, [string]>(
        "SELECT status, payload_hash, expires_at FROM approvals WHERE id = ?",
      )
      .get(id);
    if (!a) throw new HttpError(404, "No such request.");
    // A refused answer changes nothing, and is logged (an edited or replayed answer is an attack sign).
    const refuse = (reason: RefusedAnswer, error: string): never => {
      refuseAnswer(db, id, reason, by, ctx.now);
      throw new HttpError(409, error);
    };
    if (a.status !== "pending") refuse("already answered", `That request was already ${a.status}.`);
    // The answer applies only to the exact request the person saw.
    if (typeof b.payloadHash !== "string" || b.payloadHash !== a.payload_hash)
      refuse("changed", "That request has changed since you saw it. Look at it again.");
    if (a.expires_at < ctx.now()) {
      decide(db, id, "expired", "nobody answered in 24 hours", ctx.now);
      refuse("expired", "That request has expired.");
    }
    const status = b.decision === "approve" ? "approved" : "denied";
    if (!decide(db, id, status, by, ctx.now)) refuse("already answered", "That request was already answered.");
    return { status };
  });
}

/** Server-sent events: every message from the service, plus a keep-alive comment. */
function events(service: Service): Response {
  const enc = new TextEncoder();
  let stop: (() => void) | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      const send = (s: string) => {
        try {
          c.enqueue(enc.encode(s));
        } catch {
          stop?.();
        }
      };
      send(": connected\n\n");
      // Bun closes connections idle for 10 s, so stay well inside that.
      const beat = setInterval(() => send(": keep-alive\n\n"), 5_000);
      const unwatch = service.watch((m: ServiceMessage) => {
        if (m.type !== "ping") send(`data: ${JSON.stringify(m)}\n\n`);
      });
      stop = () => {
        clearInterval(beat);
        unwatch();
      };
    },
    cancel() {
      stop?.();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

/** Handles /api/* once the gate has let the request through. */
export async function handleApi(
  ctx: Ctx,
  service: Service,
  gate: Gate,
  req: Request,
  by: "token" | "session",
): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname.replace(/\/+$/, "");
  const m = req.method;
  const seg = p.split("/").slice(2).map(decodeURIComponent); // after /api
  const [a, id, action] = seg;
  // The Mac app signs its own requests with the token and says so; the token is yours either way.
  const who =
    by === "session" ? "you (app)" : req.headers.get("x-covo-client") === "mac-app" ? "you (Mac app)" : "you (API)";

  if (
    (m === "POST" || m === "PATCH" || m === "PUT") &&
    !(req.headers.get("content-type") ?? "").startsWith("application/json")
  )
    return fail(415, "Send JSON (Content-Type: application/json).");

  try {
    if (m === "GET" && a === "health" && !id) {
      return json({
        ok: true,
        version: VERSION,
        pid: process.pid,
        rssMB: Math.round(process.memoryUsage().rss / 1048576),
        ...service.stats(),
      });
    }
    if (m === "GET" && a === "me" && !id) return json({ name: userName() } satisfies ApiMe);
    // A one-time sign-in code for the Mac app's window. Token only: a browser session can't mint more.
    if (m === "POST" && a === "pair-code" && !id) {
      if (by !== "token") throw new HttpError(403, "Only Covo's own programs can ask for a sign-in code.");
      return json({ code: gate.newCode() });
    }
    if (a === "pause" && !id) {
      if (m === "POST") {
        const b = await body<{ paused?: unknown }>(req);
        if (typeof b.paused !== "boolean") throw new HttpError(400, "paused must be true or false.");
        setPaused(ctx.home, b.paused, who, ctx.now);
        service.announce({ type: "paused", paused: b.paused });
        if (!b.paused) service.kick();
      }
      if (m === "GET" || m === "POST") return json(pauseInfo(ctx, service));
    }
    if (m === "GET" && a === "summary" && !id) return json(summary(ctx, service));

    // Routines and the daily summary (M6)
    if (a === "routines") {
      if (m === "GET" && !id) {
        const bot = url.searchParams.get("bot");
        return json(listRoutines(ctx.home, { now: ctx.now, ...(bot ? { bot } : {}) }));
      }
      if (m === "POST" && !id) {
        const b = await body<Record<string, unknown>>(req);
        const r = addRoutine(ctx.home, routineFields(b, true) as never, ctx.now);
        service.announce({ type: "changed", what: "routine" });
        return json(r, 201);
      }
      if (id && m === "GET" && !action) {
        const r = getRoutine(ctx.home, id, ctx.now);
        return json({ ...r, runs: routineRuns(ctx.home, r.id, 10, ctx.now) });
      }
      if (id && m === "PATCH" && !action) {
        const r = updateRoutine(ctx.home, id, routineFields(await body(req), false) as never, ctx.now);
        service.announce({ type: "changed", what: "routine" });
        return json(r);
      }
      if (id && m === "DELETE" && !action) {
        const r = removeRoutine(ctx.home, id, ctx.now);
        service.announce({ type: "changed", what: "routine" });
        return json(r);
      }
      if (id && m === "POST" && action === "run") {
        if (!service.scheduler) throw new HttpError(503, "Covo's scheduler isn't running.");
        const job = await service.scheduler.launch(getRoutine(ctx.home, id, ctx.now), { manual: true });
        return json({ job }, 202);
      }
    }
    if (a === "schedule" && m === "GET" && !id) {
      // For the routine editor: what a schedule means, and when it would run next.
      const every = url.searchParams.get("every") ?? "";
      try {
        const sch = parseSchedule(every);
        return json({ scheduleText: describeSchedule(sch), nextAt: nextRun(sch, ctx.now()) });
      } catch (e) {
        if (e instanceof ScheduleError) throw new HttpError(400, e.message);
        throw e;
      }
    }
    if (a === "routine-settings" && !id) {
      if (m === "PUT") {
        const b = await body<Record<string, unknown>>(req);
        const changes: Partial<ApiRoutineSettings> = {};
        if (b.missed === "run-once" || b.missed === "skip") changes.missed = b.missed;
        if ("quiet" in b) changes.quiet = (b.quiet ?? null) as ApiRoutineSettings["quiet"];
        if ("summaryAt" in b) changes.summaryAt = (b.summaryAt ?? null) as string | null;
        if (typeof b.subscriptions === "boolean") changes.subscriptions = b.subscriptions;
        return json(setRoutineSettings(ctx.home, changes));
      }
      if (m === "GET") return json(getRoutineSettings(ctx.home));
    }
    if (a === "summary-now" && m === "POST" && !id) {
      const text = service.scheduler
        ? service.scheduler.summaryNow()
        : postSummary(ctx.home, { now: ctx.now, dayLimitUsd: getLimits(ctx.home).dayUsd }).text;
      return json({ text });
    }
    if (a === "session" && m === "DELETE") {
      gate.endSession(req);
      return json({ ok: true }, 200, { "set-cookie": `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
    }

    // Bots
    if (a === "bots") {
      if (m === "GET" && !id) return json(listBots(ctx.home, { now: ctx.now }).map(toBot));
      if (m === "POST" && !id) {
        const b = await body<Record<string, unknown>>(req);
        return json(toBot(createBot(ctx.home, b as never, ctx.now)), 201);
      }
      if (m === "PATCH" && id && !action)
        return json(toBot(updateBot(ctx.home, id, (await body(req)) as never, ctx.now)));
      if (id && action === "messages") {
        if (m === "GET") {
          const limit = Number(url.searchParams.get("limit") ?? 100) || 100;
          return json(listMessages(ctx.home, id, { limit, now: ctx.now }).map(toMessage));
        }
        if (m === "POST") return json(await sendMessage(ctx, service, id, await body(req), by), 201);
      }
      if (m === "DELETE" && id && !action) return json(toBot(archiveBot(ctx.home, id, ctx.now)));
    }

    // Models (keys go in, never out)
    if (a === "models") {
      if (m === "GET" && !id) return json(models(ctx));
      if (m === "POST" && !id) return json(await addModel(ctx, await body(req)), 201);
      if (m === "POST" && id && action === "default") {
        setDefault(ctx.home, id);
        return json(models(ctx));
      }
      if (m === "DELETE" && id) {
        await removeConnection(ctx.home, ctx.secrets ?? secrets(), id);
        return json(models(ctx));
      }
    }

    if (a === "providers" && m === "GET" && !id) {
      return json(
        PRESETS.map(
          (p): ApiProvider => ({
            id: p.id,
            label: p.label,
            local: p.local === true,
            needsKey: p.local !== true,
            models: p.models,
            ...(p.keyUrl ? { keyUrl: p.keyUrl } : {}),
            ...(p.note ? { note: p.note } : {}),
          }),
        ),
      );
    }

    // Runs
    if (a === "runs") {
      if (m === "GET" && !id) {
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));
        return json(
          withDb(ctx, (db) =>
            db
              .query<RunRow, [number]>(`${RUN_SELECT} ORDER BY r.created_at DESC, r.id DESC LIMIT ?`)
              .all(limit)
              .map(toRun),
          ),
        );
      }
      if (m === "POST" && !id) {
        const b = await body<Record<string, unknown>>(req);
        if (typeof b.goal !== "string" || !b.goal.trim()) throw new HttpError(400, "A task is needed.");
        const job = await service.submit({
          goal: b.goal.trim(),
          ...(typeof b.bot === "string" ? { bot: b.bot } : {}),
          ...(typeof b.model === "string" ? { model: b.model } : {}),
          trigger: by === "session" ? "chat" : "api",
        });
        service.start(job);
        return json({ job: job.id }, 202);
      }
      if (id && m === "POST" && action === "stop") {
        return service.stop(id) ? json({ stopped: true }) : fail(404, "No such task is running.");
      }
      if (id) {
        const runId = withDb(ctx, (db) => findRunId(db, id));
        if (m === "GET" && !action) {
          const detail = withDb(ctx, (db): ApiRunDetail => {
            const row = db.query<RunRow, [string]>(`${RUN_SELECT} WHERE r.id = ?`).get(runId) as RunRow;
            const steps = db
              .query<
                {
                  seq: number;
                  kind: "model" | "tool";
                  tool_name: string | null;
                  args_json: string | null;
                  result_preview: string | null;
                  decision: string | null;
                  mutating: number;
                },
                [string]
              >(
                "SELECT seq, kind, tool_name, args_json, result_preview, decision, mutating FROM run_steps WHERE run_id = ? ORDER BY seq",
              )
              .all(runId)
              .map(
                (s): ApiStep => ({
                  seq: s.seq,
                  kind: s.kind,
                  tool: s.tool_name,
                  args: s.args_json,
                  preview: s.result_preview,
                  decision: s.decision,
                  mutating: s.mutating === 1,
                }),
              );
            return { ...toRun(row), steps };
          });
          return json(detail);
        }
        if (m === "GET" && action === "review") return json(reviewRun(ctx.home, runId, ctx.now));
        if (m === "GET" && action === "changes") return json(changesOf(ctx.home, runId, ctx.now));
        if (m === "POST" && action === "keep") {
          const b = await body<{ only?: unknown }>(req);
          const only = Array.isArray(b.only) ? b.only.filter((x): x is string => typeof x === "string") : undefined;
          return json(keepRun(ctx.home, runId, { now: ctx.now, ...(only?.length ? { only } : {}) }));
        }
        if (m === "POST" && action === "discard") return json(discardRun(ctx.home, runId, ctx.now));
        if (m === "POST" && action === "undo") return json(undoRun(ctx.home, runId, ctx.now));
      }
    }

    // Approvals: the answer must name the exact request (payloadHash).
    if (a === "approvals") {
      if (m === "GET" && !id) return json(approvals(ctx));
      if (m === "POST" && id && !action) return json(decideApproval(ctx, id, await body(req), who));
    }

    // Spending, limits, this Mac, health of the log
    if (a === "usage" && m === "GET") {
      const days = Number(url.searchParams.get("days") ?? 7);
      if (!Number.isInteger(days) || days < 1 || days > 366) throw new HttpError(400, "days must be 1 to 366.");
      return json(usage(ctx, days));
    }
    if (a === "limits") {
      if (m === "GET") return json(getLimits(ctx.home));
      if (m === "PUT") {
        const b = await body<Record<string, unknown>>(req);
        const changes: Partial<ApiLimits> = {};
        for (const k of ["runUsd", "dayUsd"] as const) {
          if (k in b) {
            if (!isLimit(b[k])) throw new HttpError(400, `${k} must be a dollar amount of 0 or more, or null.`);
            changes[k] = b[k] as number | null;
          }
        }
        return json(setLimits(ctx.home, changes));
      }
    }
    if (a === "profile" && m === "GET") return json(profile(ctx));
    if (a === "audit" && id === "verify" && m === "GET") return json(withDb(ctx, (db) => verifyAudit(db)));
    if (a === "doctor" && m === "GET") {
      const r = await doctorCommand(ctx, []);
      return json({ ok: r.code === 0, text: r.out });
    }
    if (a === "events" && m === "GET") return events(service);
    return fail(404, "Not found.");
  } catch (e) {
    if (e instanceof HttpError) return fail(e.status, e.message);
    if (e instanceof PrepareError || e instanceof ModelConfigError || e instanceof SecretError)
      return fail(422, e.message);
    if (e instanceof RunError || e instanceof UndoError) return fail(409, e.message);
    return fail(500, `Something went wrong: ${(e as Error).message}`);
  }
}
