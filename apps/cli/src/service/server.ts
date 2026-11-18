import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { covoPaths, VERSION } from "@covo/core";
import { openDb } from "@covo/db";
import { RunError, type RunEvent, type RunSummary, recoverStaleRuns, startRun } from "@covo/engine";
import { currentCapacity } from "../commands/profile.ts";
import type { Ctx } from "../main.ts";
import { type Prepared, PrepareError, prepareRun, type RunHeader, type RunRequest } from "../runner.ts";
import { serviceHealth, socketPath } from "./client.ts";

// covod, Covo's background service (Phase 3 M0). One process runs every bot task, so a task
// carries on after the terminal closes, and the app, phone and schedules (later milestones) can
// all use it. It listens only on a socket in ~/Covo/run/, a folder only you can open.
//
// Tasks wait in a queue until the power profile allows another to start (ADR-011). Each job's
// progress goes to whoever is watching it, and to anyone watching all events.

export type ServiceMessage =
  | { type: "queued"; job: string; position: number }
  | { type: "waiting"; job: string; reason: string }
  | { type: "header"; job: string; header: RunHeader }
  | { type: "event"; job: string; event: RunEvent }
  | { type: "done"; job: string; summary: RunSummary }
  | { type: "error"; job: string; message: string }
  /** Sent every few seconds so a long, quiet model step doesn't look like a dead connection. */
  | { type: "ping" };

interface Job {
  id: string;
  req: RunRequest;
  prepared: Prepared;
  controller: AbortController;
  runId?: string;
  status: "queued" | "running" | "done";
  waitingNoted?: string;
  listeners: Set<(m: ServiceMessage) => void>;
  finished?: Promise<void>;
}

const ACTIVE = "('QUEUED','PREPARING','RUNNING','AWAITING_APPROVAL')";
const PING_MS = 5_000;
let jobSeq = 0;

export class Service {
  private readonly jobs: Job[] = [];
  private readonly watchers = new Set<(m: ServiceMessage) => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closing = false;

  constructor(
    private readonly ctx: Ctx,
    private readonly o: { retryMs?: number } = {},
  ) {}

  /** Checks the request and queues it. Throws PrepareError with a message for people. */
  async submit(req: RunRequest): Promise<Job> {
    if (this.closing) throw new PrepareError("Covo's service is shutting down.");
    const prepared = await prepareRun(this.ctx, req);
    const job: Job = {
      id: `job${++jobSeq}-${Date.now().toString(36)}`,
      req,
      prepared,
      controller: new AbortController(),
      status: "queued",
      listeners: new Set(),
    };
    this.jobs.push(job);
    return job;
  }

  /** Called after the submitter has attached its listener, so it sees every message. */
  start(job: Job): void {
    const ahead = this.jobs.filter((j) => j !== job && j.status !== "done").length;
    this.emit(job, { type: "queued", job: job.id, position: ahead });
    this.emit(job, { type: "header", job: job.id, header: job.prepared.header });
    this.pump();
  }

  watch(fn: (m: ServiceMessage) => void): () => void {
    this.watchers.add(fn);
    return () => this.watchers.delete(fn);
  }

  /** Stops a job by its job id or run id (or the run id's last 4+ characters). */
  stop(id: string): boolean {
    const job = this.jobs.find(
      (j) => j.status !== "done" && (j.id === id || j.runId === id || (id.length >= 4 && j.runId?.endsWith(id))),
    );
    if (!job) return false;
    if (job.status === "queued")
      this.finish(job, { type: "error", job: job.id, message: "Stopped before it started." });
    else job.controller.abort();
    return true;
  }

  stats(): { running: number; queued: number } {
    return {
      running: this.jobs.filter((j) => j.status === "running").length,
      queued: this.jobs.filter((j) => j.status === "queued").length,
    };
  }

  /** Stops everything safely: queued jobs are dropped, running ones stop after their current step. */
  async shutdown(graceMs = 30_000): Promise<void> {
    this.closing = true;
    clearTimeout(this.timer);
    for (const j of this.jobs.filter((j) => j.status === "queued"))
      this.finish(j, { type: "error", job: j.id, message: "Covo's service stopped before this task started." });
    const running = this.jobs.filter((j) => j.status === "running");
    for (const j of running) j.controller.abort();
    await Promise.race([Promise.all(running.map((j) => j.finished)), new Promise((r) => setTimeout(r, graceMs))]);
  }

  private emit(job: Job, m: ServiceMessage): void {
    for (const l of job.listeners) l(m);
    for (const w of this.watchers) w(m);
  }

  private finish(job: Job, m: ServiceMessage): void {
    job.status = "done";
    this.emit(job, m);
    job.listeners.clear();
    const i = this.jobs.indexOf(job);
    if (i >= 0) this.jobs.splice(i, 1);
  }

  /** Tasks running anywhere (this service, or a `covo run` that didn't use it), plus ones starting now. */
  private activeCount(): number {
    const db = openDb(covoPaths(this.ctx.home).db);
    try {
      const n = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM runs WHERE state IN ${ACTIVE}`).get()?.n ?? 0;
      return n + this.jobs.filter((j) => j.status === "running" && !j.runId).length;
    } finally {
      db.close();
    }
  }

  private retryLater(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.pump(), this.o.retryMs ?? 2_000);
  }

  private pump(): void {
    if (this.closing) return;
    for (;;) {
      const next = this.jobs.find((j) => j.status === "queued");
      if (!next) return;
      const cap = currentCapacity(this.ctx);
      const reason = !cap.canStart
        ? cap.notes.join(" ")
        : this.activeCount() >= cap.maxRuns
          ? `This Mac runs ${cap.maxRuns} task${cap.maxRuns === 1 ? "" : "s"} at a time; waiting for a free slot.`
          : undefined;
      if (reason) {
        if (next.waitingNoted !== reason) {
          next.waitingNoted = reason;
          this.emit(next, { type: "waiting", job: next.id, reason });
        }
        // A finished job calls pump() again; this catches runs that end elsewhere.
        this.retryLater();
        return;
      }
      this.launch(next, cap.maxRuns);
    }
  }

  private launch(job: Job, maxRuns: number): void {
    job.status = "running";
    job.finished = (async () => {
      try {
        const summary = await startRun({
          ...job.prepared.options,
          maxConcurrent: maxRuns,
          signal: job.controller.signal,
          onEvent: (e) => {
            if (e.type === "state" && !job.runId) job.runId = e.runId;
            this.emit(job, { type: "event", job: job.id, event: e });
          },
        });
        this.finish(job, { type: "done", job: job.id, summary });
      } catch (e) {
        // Someone else's task took the last slot between our check and the start: wait again.
        if (e instanceof RunError && /already running/.test(e.message) && !job.runId && !this.closing) {
          job.status = "queued";
          this.retryLater();
          return;
        }
        this.finish(job, { type: "error", job: job.id, message: (e as Error).message });
      } finally {
        this.pump();
      }
    })();
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A stream of newline-separated JSON messages. Closing it doesn't stop the job. */
function ndjson(attach: (send: (m: ServiceMessage) => void, close: () => void) => () => void): Response {
  let detach: (() => void) | undefined;
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      let open = true;
      const close = () => {
        if (!open) return;
        open = false;
        detach?.();
        try {
          c.close();
        } catch {}
      };
      const beat = setInterval(() => {
        try {
          c.enqueue(enc.encode(`${JSON.stringify({ type: "ping" })}\n`));
        } catch {
          close();
        }
      }, PING_MS);
      const stopBeat = () => clearInterval(beat);
      const inner = attach((m) => {
        if (!open) return;
        try {
          c.enqueue(enc.encode(`${JSON.stringify(m)}\n`));
        } catch {
          close();
        }
      }, close);
      detach = () => {
        stopBeat();
        inner();
      };
    },
    cancel() {
      detach?.();
    },
  });
  return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
}

export interface Running {
  service: Service;
  socket: string;
  recovered: string[];
  close(): Promise<void>;
}

export class ServiceRunningError extends Error {}

/** Starts the service on ~/Covo/run/covod.sock. */
export async function serve(ctx: Ctx, o: { retryMs?: number } = {}): Promise<Running> {
  const socket = socketPath(ctx.home);
  if (!existsSync(covoPaths(ctx.home).db)) throw new PrepareError("Covo isn't set up yet. Run: covo init");
  mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
  chmodSync(dirname(socket), 0o700);
  if (existsSync(socket)) {
    if (await serviceHealth(ctx.home)) throw new ServiceRunningError("Covo's service is already running.");
    rmSync(socket, { force: true }); // left over from a crash
  }
  const recovered = recoverStaleRuns(ctx.home, { now: ctx.now });
  const service = new Service(ctx, o);

  const server = Bun.serve({
    unix: socket,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      if (req.method === "GET" && path === "/health") {
        return json({
          ok: true,
          version: VERSION,
          pid: process.pid,
          rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
          ...service.stats(),
        });
      }
      if (req.method === "POST" && path === "/runs") {
        let body: RunRequest;
        try {
          body = (await req.json()) as RunRequest;
        } catch {
          return json({ error: "Expected JSON." }, 400);
        }
        if (typeof body?.goal !== "string" || !body.goal.trim()) return json({ error: "A task is needed." }, 400);
        let job: Job;
        try {
          job = await service.submit({
            goal: body.goal.trim(),
            ...(typeof body.bot === "string" ? { bot: body.bot } : {}),
            ...(typeof body.model === "string" ? { model: body.model } : {}),
            trigger: typeof body.trigger === "string" ? body.trigger : "cli",
          });
        } catch (e) {
          if (e instanceof PrepareError) return json({ error: e.message }, 422);
          throw e;
        }
        const res = ndjson((send, close) => {
          const l = (m: ServiceMessage) => {
            send(m);
            if (m.type === "done" || m.type === "error") queueMicrotask(close);
          };
          job.listeners.add(l);
          return () => job.listeners.delete(l);
        });
        service.start(job);
        return res;
      }
      const stop = path.match(/^\/runs\/([\w-]+)\/stop$/);
      if (req.method === "POST" && stop) {
        return service.stop(stop[1] as string)
          ? json({ stopped: true })
          : json({ error: "No such task is running." }, 404);
      }
      if (req.method === "GET" && path === "/events") return ndjson((send) => service.watch(send));
      return json({ error: "Not found." }, 404);
    },
  });

  return {
    service,
    socket,
    recovered,
    async close() {
      await service.shutdown();
      server.stop(true);
      rmSync(socket, { force: true });
    },
  };
}
