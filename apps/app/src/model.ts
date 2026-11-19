// What the app knows, and the small rules for showing it.

import type { ApiApproval, ApiBot, ApiMe, ApiModel, ApiRun, ApiUsage, Level, RunState } from "@covo/api";

export interface Data {
  me: ApiMe;
  bots: ApiBot[];
  models: ApiModel[];
  runs: ApiRun[];
  approvals: ApiApproval[];
  usage: ApiUsage;
}

export type SettingsTab = "general" | "models" | "spending" | "computer";
export const SETTINGS_TABS: SettingsTab[] = ["general", "models", "spending", "computer"];

export type View =
  | { name: "bot"; id: string }
  | { name: "review"; runId: string }
  | { name: "new-bot" }
  | { name: "needs-you" }
  | { name: "library" }
  | { name: "more" }
  | { name: "settings"; tab: SettingsTab };

export function viewFromHash(hash: string): View | null {
  const [, a, id] = hash.replace(/^#/, "").split("/");
  const arg = id ? decodeURIComponent(id) : "";
  if (a === "bot" && arg) return { name: "bot", id: arg };
  if (a === "review" && arg) return { name: "review", runId: arg };
  if (a === "settings")
    return { name: "settings", tab: (SETTINGS_TABS as string[]).includes(arg) ? (arg as SettingsTab) : "general" };
  if (a === "new-bot" || a === "needs-you" || a === "library" || a === "more") return { name: a };
  return null;
}

export function hashFor(v: View): string {
  if (v.name === "bot") return `#/bot/${encodeURIComponent(v.id)}`;
  if (v.name === "review") return `#/review/${encodeURIComponent(v.runId)}`;
  if (v.name === "settings") return `#/settings/${v.tab}`;
  return `#/${v.name}`;
}

/** A step a task took, as it streams in. */
export interface LiveStep {
  seq: number;
  name: string;
  target: string;
  label: string;
  ok: boolean;
  blocked?: string;
}

const VERB: Record<string, string> = {
  list_files: "Looked in",
  read_file: "Read",
  write_file: "Wrote",
  edit_file: "Edited",
  run_command: "Ran",
  search_files: "Searched",
  finish: "Finished",
};
export const stepText = (s: LiveStep) =>
  s.blocked
    ? `Blocked: ${s.name} ${s.target} (${s.blocked === "path" ? "outside the workspace" : "by the sandbox"})`
    : `${VERB[s.name] ?? s.name} ${s.target}`.trim();

export const runById = (d: Data, id: string | null) => (id ? d.runs.find((r) => r.id === id) : undefined);

export const MAIN_BOT = "bot_assistant";

const ACTIVE: RunState[] = ["QUEUED", "PREPARING", "RUNNING", "AWAITING_APPROVAL", "REVIEWING"];
export const isActive = (s: RunState) => ACTIVE.includes(s);

export const LEVEL_LABEL: Record<Level, string> = {
  supervised: "Ask for approval",
  automatic: "Works on its own",
  full: "Full access",
};

/** The pill for a run, and what the bot says about it. */
export function runStatus(r: ApiRun): { pill: string; warning?: boolean; text: string } {
  switch (r.state) {
    case "QUEUED":
      return { pill: "Queued", text: "Waiting for a free slot. I'll start soon." };
    case "PREPARING":
    case "RUNNING":
      return { pill: "Working", text: "On it. I'm working on a safe copy of your files." };
    case "AWAITING_APPROVAL":
      return { pill: "Needs your OK", warning: true, text: "I've paused. This needs your OK before I go on." };
    case "REVIEWING":
      return {
        pill: "Ready",
        text: `${r.summary ?? "Done."} My changes are waiting for you: see them with covo diff ${r.id.slice(-6)}, then covo keep or covo discard.`,
      };
    case "KEPT":
    case "SUCCEEDED":
      return { pill: "Done", text: r.summary ?? "Done." };
    case "DISCARDED":
      return { pill: "Discarded", text: r.summary ?? "You discarded my changes." };
    case "ROLLED_BACK":
      return { pill: "Undone", text: r.summary ?? "My changes were undone." };
    case "STOPPED":
      return { pill: "Stopped", text: r.error ?? "Stopped." };
    case "FAILED":
      return { pill: "Failed", text: r.error ?? "Something went wrong." };
    default:
      return { pill: String(r.state).toLowerCase(), text: r.summary ?? r.error ?? "" };
  }
}

/** Latest first. */
export const runsOf = (d: Data, botId: string) => d.runs.filter((r) => r.botId === botId);

export function approvalsOf(d: Data, botId: string): ApiApproval[] {
  const mine = new Set(runsOf(d, botId).map((r) => r.id));
  return d.approvals.filter((a) => mine.has(a.runId));
}

export function botLine(d: Data, b: ApiBot): string {
  if (b.status === "paused") return "Paused";
  const last = runsOf(d, b.id)[0];
  if (!last) return b.purpose || "No tasks yet";
  if (last.state === "AWAITING_APPROVAL") return "Needs your OK";
  if (last.state === "REVIEWING") return "Changes ready to review";
  if (isActive(last.state)) return `Working: ${last.goal}`;
  if (last.state === "FAILED") return `Failed: ${last.goal}`;
  return last.summary || last.goal;
}

export function modelFor(d: Data, b: ApiBot | undefined): ApiModel | undefined {
  const name = b?.models[0];
  return d.models.find((m) => m.name === name) ?? d.models.find((m) => m.isDefault) ?? d.models[0];
}

// Times, in the style of the Figma screens: 10:04 today, Mon this week, 12 Nov before.
const two = (n: number) => String(n).padStart(2, "0");
export const clock = (t: number) => {
  const d = new Date(t);
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
};
const dayStart = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
export function shortWhen(t: number, now = Date.now()): string {
  const days = Math.round((dayStart(now) - dayStart(t)) / 86_400_000);
  if (days <= 0) return clock(t);
  if (days < 7) return new Date(t).toLocaleDateString(undefined, { weekday: "short" });
  return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
export function dayLabel(t: number, now = Date.now()): string {
  const days = Math.round((dayStart(now) - dayStart(t)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return new Date(t).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
}
export const sameDay = (a: number, b: number) => dayStart(a) === dayStart(b);

export const usd = (n: number) => `$${n < 0.01 && n > 0 ? n.toFixed(3) : n.toFixed(2)}`;

export function spendLine(u: ApiUsage): string {
  return u.limits.dayUsd === null ? `${usd(u.todayUsd)} today` : `${usd(u.todayUsd)} of ${usd(u.limits.dayUsd)} today`;
}
