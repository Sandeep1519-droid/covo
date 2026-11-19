import type { Database } from "bun:sqlite";
import { userInfo } from "node:os";
import type {
  ApiApproval,
  ApiBot,
  ApiLimits,
  ApiMe,
  ApiModel,
  ApiProfile,
  ApiRun,
  ApiRunDetail,
  ApiStep,
  ApiUsage,
  UsageRow,
} from "@covo/api";
import { covoPaths, VERSION } from "@covo/core";
import { openDb, verifyAudit } from "@covo/db";
import {
  archiveBot,
  type Bot,
  createBot,
  decide,
  discardRun,
  keepRun,
  listBots,
  RunError,
  reviewRun,
  startOfLocalDay,
  undoRun,
  updateBot,
} from "@covo/engine";
import {
  addConnection,
  engineById,
  getLimits,
  listModelsFor,
  loadSettings,
  ModelConfigError,
  modelConfig,
  presetById,
  removeConnection,
  setDefault,
  setLimits,
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
};
const RUN_SELECT = `SELECT r.id, r.state, r.goal, r.agent_id, a.name AS bot_name, r.model, r.trigger, r.cost_usd,
  r.tokens_in, r.tokens_out, r.summary, r.error, r.created_at, r.started_at, r.finished_at
  FROM runs r LEFT JOIN agents a ON a.id = r.agent_id`;
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

function approvals(ctx: Ctx): ApiApproval[] {
  return withDb(ctx, (db) =>
    db
      .query<
        { id: string; run_id: string; kind: string; summary: string; payload_hash: string; expires_at: number },
        []
      >(
        "SELECT id, run_id, kind, summary, payload_hash, expires_at FROM approvals WHERE status = 'pending' ORDER BY rowid",
      )
      .all()
      .map((a) => ({
        id: a.id,
        runId: a.run_id,
        kind: a.kind,
        summary: a.summary,
        payloadHash: a.payload_hash,
        expiresAt: a.expires_at,
      })),
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
    if (a.status !== "pending") throw new HttpError(409, `That request was already ${a.status}.`);
    // The answer applies only to the exact request the person saw.
    if (typeof b.payloadHash !== "string" || b.payloadHash !== a.payload_hash)
      throw new HttpError(409, "That request has changed since you saw it. Look at it again.");
    if (a.expires_at < ctx.now()) throw new HttpError(409, "That request has expired.");
    const status = b.decision === "approve" ? "approved" : "denied";
    if (!decide(db, id, status, by, ctx.now)) throw new HttpError(409, "That request was already answered.");
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
  const who = by === "session" ? "you (app)" : "you (API)";

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
      if (m === "PATCH" && id) return json(toBot(updateBot(ctx.home, id, (await body(req)) as never, ctx.now)));
      if (m === "DELETE" && id) return json(toBot(archiveBot(ctx.home, id, ctx.now)));
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
