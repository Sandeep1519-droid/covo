// The local API of Covo's service (Phase 3 M1): request and response shapes shared by the service,
// the app (M2/M3) and the Mac app (M4). Types only, no dependencies.
//
// Base URL: http://127.0.0.1:7420/api. Every request needs either
//   Authorization: Bearer <token from ~/Covo/state/api-token>   (scripts, the Mac app)
// or the session cookie the app gets by pairing (POST /api/pair with a one-time code from `covo app`).
// Requests from other websites are refused (Host and Origin checks; no CORS).

export const API_PORT = 7420;

export interface ApiError {
  error: string;
}

export type Level = "supervised" | "automatic" | "full";

export interface ApiHealth {
  ok: true;
  version: string;
  pid: number;
  rssMB: number;
  running: number;
  queued: number;
}

export interface ApiBot {
  id: string;
  name: string;
  purpose: string;
  department: string;
  models: string[];
  level: Level;
  taskLimitUsd: number | null;
  status: "active" | "paused" | "archived";
  shape: string;
  color: string;
  runs: number;
  lastRunAt: number | null;
}

/** POST /api/bots */
export interface NewBotRequest {
  name: string;
  purpose?: string;
  models?: string[];
  level?: Level;
  taskLimitUsd?: number | null;
}

/** PATCH /api/bots/:id */
export type BotChangesRequest = Partial<NewBotRequest>;

export interface ApiModel {
  name: string;
  provider: string;
  providerLabel: string;
  model: string;
  /** A key is saved in the Keychain. The key itself is never sent back. */
  hasKey: boolean;
  isDefault: boolean;
  /** A subscription engine (e.g. Claude Code). */
  engine: boolean;
}

/** POST /api/models: the key goes straight to the Keychain. */
export interface NewModelRequest {
  provider: string;
  model: string;
  name?: string;
  key?: string;
  baseUrl?: string;
  makeDefault?: boolean;
}

export type RunState =
  | "QUEUED"
  | "PREPARING"
  | "RUNNING"
  | "AWAITING_APPROVAL"
  | "REVIEWING"
  | "KEPT"
  | "SUCCEEDED"
  | "DISCARDED"
  | "FAILED"
  | "STOPPED"
  | "ROLLED_BACK"
  | (string & {});

export interface ApiRun {
  id: string;
  state: RunState;
  goal: string;
  botId: string;
  botName: string;
  model: string | null;
  trigger: string;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  summary: string | null;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface ApiStep {
  seq: number;
  kind: "model" | "tool";
  tool: string | null;
  args: string | null;
  preview: string | null;
  decision: string | null;
  mutating: boolean;
}

export interface ApiRunDetail extends ApiRun {
  steps: ApiStep[];
}

/** POST /api/runs → 202 { job }. Progress arrives on GET /api/events. */
export interface StartRunRequest {
  goal: string;
  bot?: string;
  model?: string;
}

export interface ApiApproval {
  id: string;
  runId: string;
  kind: string;
  summary: string;
  /** Send it back with the answer: an approval only applies to this exact request. */
  payloadHash: string;
  expiresAt: number;
}

/** POST /api/approvals/:id */
export interface DecideRequest {
  decision: "approve" | "deny";
  payloadHash: string;
}

export interface UsageRow {
  label: string;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  usd: number;
  /** Includes a price estimate for a model Covo doesn't know. */
  estimated: boolean;
}

export interface ApiUsage {
  days: number;
  totalUsd: number;
  todayUsd: number;
  limits: ApiLimits;
  byModel: UsageRow[];
  byBot: UsageRow[];
  byDay: UsageRow[];
}

export interface ApiLimits {
  runUsd: number | null;
  dayUsd: number | null;
}

export interface ApiProfile {
  mac: { chip: string; memoryGB: number; cores: number; performanceCores: number };
  now: { memoryPressure: string; power: string; batteryPercent: number | null; thermal: string };
  profile: { name: string; label: string; chosen: boolean };
  maxRuns: number;
  canStart: boolean;
  notes: string[];
  local: { maxParamsB: number; contextTokens: number; keepAlive: string };
}

/** Messages on GET /api/events (server-sent events, one JSON object per message). */
export type ApiEvent =
  | { type: "queued"; job: string; position: number }
  | { type: "waiting"; job: string; reason: string }
  | { type: "header"; job: string; header: unknown }
  | { type: "event"; job: string; event: { type: string; runId?: string; [k: string]: unknown } }
  | { type: "done"; job: string; summary: { runId: string; state: RunState; [k: string]: unknown } }
  | { type: "error"; job: string; message: string };
