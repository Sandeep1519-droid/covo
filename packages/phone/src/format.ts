// What Covo sends to your phone, laid out like the Figma "C · Telegram" screens: the bot's name, a
// one-line headline, then a detail or two. Plain text only (no Markdown), short, and never the
// contents of your files: a task's summary is cut to a few lines.

import type { PhoneConfig } from "./config.ts";
import type { Button } from "./telegram.ts";

export const clip = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

const money = (n: number) => `$${n.toFixed(2)}`;
const two = (n: number) => String(n).padStart(2, "0");
const clock = (t: number) => {
  const d = new Date(t);
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
};

/** "today at 10:06", "tomorrow at 10:06", or "Fri at 10:06". */
export function when(t: number, now: number): string {
  const day = (x: number) => {
    const d = new Date(x);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const days = Math.round((day(t) - day(now)) / 86_400_000);
  const which =
    days === 0 ? "today" : days === 1 ? "tomorrow" : new Date(t).toLocaleDateString("en-GB", { weekday: "short" });
  return `${which} at ${clock(t)}`;
}

export interface ApprovalInfo {
  bot: string;
  summary: string;
  goal: string;
  /** What allowing lets it spend, if known. */
  grantUsd: number | null;
  expiresAt: number;
}

export function approvalText(a: ApprovalInfo, mode: PhoneConfig["notify"], now: number): string {
  const lines = [
    a.bot,
    a.grantUsd !== null ? `Spend up to ${money(a.grantUsd)} more?` : "Can it go on?",
    clip(a.summary, 300),
  ];
  if (mode === "summaries") lines.push(`Task: ${clip(a.goal, 160)}`);
  lines.push(`Answer by ${when(a.expiresAt, now)}. No answer means no.`);
  return lines.join("\n");
}

/** Allow once / Deny, tied to this request: its id and the start of its hash (fits in 64 bytes). */
export function approvalButtons(id: string, payloadHash: string): Button[][] {
  const tag = `ap:${id}:${payloadHash.slice(0, 12)}`;
  return [
    [
      { text: "Allow once", data: `${tag}:y` },
      { text: "Deny", data: `${tag}:n` },
    ],
  ];
}

/** Where an answer came from, in words. */
function where(by: string | null): string {
  switch (by) {
    case "you (phone)":
      return " from your phone";
    case "you (app)":
      return " in the Covo app";
    case "you (Mac app)":
      return " on your Mac";
    case "you (terminal)":
    case "you (in the terminal)":
      return " in the terminal";
    case "you (API)":
      return " through Covo's API";
    default:
      return "";
  }
}

/** The card after it's answered: the same text, the buttons gone, and what happened. */
export function outcomeText(card: string, status: string, by: string | null, at: number): string {
  const line =
    status === "approved"
      ? `✓ Allowed${where(by)} at ${clock(at)}.`
      : status === "denied"
        ? by === "stopped"
          ? `The task was stopped at ${clock(at)}.`
          : `✕ Denied${where(by)} at ${clock(at)}.`
        : "Expired: nobody answered, so the answer was no.";
  return `${card.replace(/\nAnswer by .*$/, "")}\n\n${line}`;
}

export interface Changes {
  added: number;
  modified: number;
  deleted: number;
}

export function filesLine(c: Changes): string {
  const n = c.added + c.modified + c.deleted;
  const parts = [
    c.modified ? `${c.modified} modified` : "",
    c.added ? `${c.added} added` : "",
    c.deleted ? `${c.deleted} deleted` : "",
  ].filter(Boolean);
  return `${n} file${n === 1 ? "" : "s"} changed: ${parts.join(", ")}`;
}

export interface RunInfo {
  bot: string;
  goal: string;
  summary: string | null;
  error: string | null;
  state: string;
  changes?: Changes | undefined;
}

export function finishedText(r: RunInfo): string {
  const lines = [r.bot, `Done: ${clip(r.goal, 120)}`];
  if (r.summary) lines.push(clip(r.summary, 240));
  const c = r.changes;
  const any = c && c.added + c.modified + c.deleted > 0;
  if (r.state === "REVIEWING")
    lines.push(`${any && c ? `${filesLine(c)}. ` : ""}Nothing is in your files yet: review the changes on your Mac.`);
  else if (r.state === "KEPT" && any && c)
    lines.push(`${filesLine(c)}. They're in your files; you can undo them on your Mac.`);
  return lines.join("\n");
}

/** For "only what needs you": no task details. */
export const reviewOnlyText = (bot: string) => `${bot}\nHas changes for you to review on your Mac.`;

export function failedText(r: RunInfo): string {
  return [r.bot, `Couldn't finish: ${clip(r.goal, 120)}`, clip(r.error ?? "Something went wrong.", 240)].join("\n");
}

export function helpText(c: PhoneConfig): string {
  return [
    "This is Covo, on your Mac. I'll message you here when:",
    "• a task needs your OK to spend more: tap Allow once or Deny",
    c.notify === "summaries"
      ? "• a task finishes or fails (a short summary, never your files' contents)"
      : "• a task has changes for you to review",
    "",
    c.tasks ? "Send me a message to start a task." : "Send /status to see what's going on.",
    "Limits, levels and keys can only be changed on your Mac.",
  ].join("\n");
}
