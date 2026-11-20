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

/** Bot characters (Figma "Bot avatar"): 12 shapes, and the avatar colours from the Color variables. */
export const AVATAR_SHAPES = [
  "Circle",
  "Squircle",
  "Blob",
  "Cloud",
  "Drop",
  "Hexagon",
  "Pill",
  "Flower",
  "Triangle",
  "Diamond",
  "Gem",
  "Bean",
] as const;
export type AvatarShape = (typeof AVATAR_SHAPES)[number];

export const AVATAR_COLORS = {
  sky: "#5cb8f2",
  blue: "#4c8df6",
  navy: "#3b4ba8",
  indigo: "#6366f1",
  violet: "#9b8cff",
  purple: "#8b5cf6",
  magenta: "#d45bb8",
  rose: "#f27bae",
  red: "#e5534b",
  wine: "#a3324d",
  coral: "#f28b6b",
  orange: "#f2994a",
  gold: "#f2c14e",
  sand: "#d8c29d",
  brown: "#8b5e3c",
  lime: "#9acd32",
  green: "#5fcb7a",
  mint: "#5fd39a",
  teal: "#3cc4b4",
  silver: "#a8a8ae",
} as const;
export type AvatarColor = keyof typeof AVATAR_COLORS;

/** GET /api/me: who is using this Mac. */
export interface ApiMe {
  name: string;
}

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
  shape?: AvatarShape;
  color?: AvatarColor;
}

/** A message in a bot's chat (Phase 3 M3). Your messages start tasks; `runId` is that task. */
export interface ApiChatMessage {
  id: string;
  role: "you" | "bot";
  text: string;
  runId: string | null;
  model: string | null;
  /** Why the task couldn't start. */
  error: string | null;
  /** More than text, on the bot's own messages: the daily summary (kind "summary"), a routine made in chat. */
  data?: Record<string, unknown> | null;
  createdAt: number;
}

/** GET /api/bots/:id/messages, POST /api/bots/:id/messages { text, model? } */
export interface NewMessageRequest {
  text: string;
  model?: string;
}

/** A file a task changed, with a line diff when both sides are text. */
export interface ApiFileChange {
  path: string;
  kind: "added" | "modified" | "deleted";
  hunks?: { header: string; lines: string[] }[];
  /** Why there's no diff: "binary", "too large", "symlink", "undone", "changed since". */
  note?: string;
  /** You changed this file after the task started; keeping it will be refused. */
  workspaceChanged: boolean;
}

/** GET /api/runs/:id/changes: changes waiting for review, or what a kept task changed. */
export interface ApiChanges {
  runId: string;
  state: RunState;
  files: ApiFileChange[];
  added: number;
  modified: number;
  deleted: number;
}

/** GET /api/providers: the AI services you can connect. */
export interface ApiProvider {
  id: string;
  label: string;
  local: boolean;
  needsKey: boolean;
  models: string[];
  keyUrl?: string;
  note?: string;
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
  /** The routine it ran for (M6). */
  routineId?: string | null;
  routineName?: string | null;
}

/** GET /api/routines (M6): a bot's task on a schedule. */
export interface ApiRoutine {
  id: string;
  name: string;
  botId: string;
  botName: string;
  task: string;
  /** As written ("weekdays 9:00") and in words ("Weekdays at 09:00"). */
  schedule: string;
  scheduleText: string;
  status: "active" | "paused";
  model: string | null;
  runLimitUsd: number | null;
  quiet: boolean;
  nextAt: number | null;
  lastAt: number | null;
  lastError: string | null;
  lastRun: { id: string; state: string; costUsd: number; finishedAt: number | null } | null;
  createdAt: number;
}

/** POST /api/routines; PATCH /api/routines/:id takes any of these, plus status. */
export interface NewRoutineRequest {
  name: string;
  bot: string;
  task: string;
  every: string;
  model?: string | null;
  runLimitUsd?: number | null;
  quiet?: boolean;
}

/** GET/PUT /api/routine-settings */
export interface ApiRoutineSettings {
  missed: "run-once" | "skip";
  quiet: { from: string; to: string } | null;
  summaryAt: string | null;
  subscriptions: boolean;
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
  /** For spending pauses: what was spent, the next step's estimate, and what approving allows. */
  spend?: { spentUsd: number; estimateUsd: number; grantUsd: number; overDay: boolean; dayUsd: number | null };
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
  | { type: "error"; job: string; message: string }
  | { type: "paused"; paused: boolean }
  | { type: "changed"; what: string };

/** GET /api/pause, POST /api/pause { paused }: pausing all bots stops new tasks from starting. */
export interface ApiPause {
  paused: boolean;
  since: number | null;
  by: string | null;
  /** Tasks waiting to start. */
  queued: number;
}

/** GET /api/summary: what the menu bar shows. */
export interface ApiSummary {
  paused: boolean;
  running: { runId: string; botId: string; botName: string; goal: string; startedAt: number | null }[];
  queued: number;
  /** Everything waiting on you: spending pauses and changes to review, newest first. */
  waiting: {
    id: string;
    kind: "approval" | "changes";
    runId: string;
    botId: string;
    botName: string;
    title: string;
    /** For approvals: answer with POST /api/approvals/:id and this hash. */
    payloadHash?: string;
    at: number;
  }[];
  todayUsd: number;
  dayLimitUsd: number | null;
}
