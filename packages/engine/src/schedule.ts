// When a routine runs (Phase 3 M6), written the way people say it:
//   "weekdays 9:00", "every day at 7:30 and 18:00", "mon, wed and fri at 8:30", "sundays 10am",
//   "18:00" (every day), "hourly", "every 30 minutes", "every 2 hours".
// Times are this Mac's local time. Intervals run on the clock (every 30 minutes: :00 and :30).

export class ScheduleError extends Error {}

export type Schedule =
  /** On these days (0 = Sunday) at these times (minutes after midnight, sorted). */
  | { kind: "times"; days: number[]; times: number[] }
  /** Every N minutes, counted from midnight. */
  | { kind: "every"; minutes: number };

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const ALL = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKENDS = [0, 6];

const HELP = 'Try "weekdays 9:00", "every day at 18:00", "mon, wed and fri at 8:30", "hourly" or "every 30 minutes".';

/** "9", "9:30", "09:30", "9am", "6:30 pm", "noon", "midnight" → minutes after midnight, or null. */
export function parseTime(s: string): number | null {
  const t = s.trim().toLowerCase();
  if (t === "noon") return 12 * 60;
  if (t === "midnight") return 0;
  const m = t.match(/^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (min > 59) return null;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    if (m[3] === "am" && h === 12) h = 0;
    if (m[3] === "pm" && h !== 12) h += 12;
  } else if (h > 23) return null;
  return h * 60 + min;
}

function dayOf(word: string): number | null {
  const w = word.replace(/s$/, "");
  const i = DAYS.findIndex((d) => d === w || d.slice(0, 3) === w || (w.length >= 3 && d.startsWith(w)));
  return i === -1 ? null : i;
}

function parseDays(s: string): number[] | null {
  const t = s
    .trim()
    .replace(/^on\s+/, "")
    .replace(/^(every|each)\s+/, "");
  if (["", "day", "days", "daily", "every day"].includes(t)) return ALL;
  if (["weekday", "weekdays", "working day", "working days", "workday", "workdays"].includes(t)) return WEEKDAYS;
  if (["weekend", "weekends"].includes(t)) return WEEKENDS;
  const words = t.split(/\s*(?:,|\band\b|&|\/|\s)\s*/).filter(Boolean);
  if (!words.length) return null;
  const days = new Set<number>();
  for (const w of words) {
    const d = dayOf(w);
    if (d === null) return null;
    days.add(d);
  }
  return [...days].sort((a, b) => a - b);
}

/** Reads a schedule; throws ScheduleError with an example when it can't. */
export function parseSchedule(text: string): Schedule {
  const t = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (!t) throw new ScheduleError(`When should it run? ${HELP}`);

  // Intervals: "hourly", "every hour", "every 30 minutes", "every 2 hours".
  if (t === "hourly" || t === "every hour") return { kind: "every", minutes: 60 };
  const iv = t.match(/^(?:every|each)\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/);
  if (iv) {
    const n = Number(iv[1]);
    const minutes = /^h/.test(iv[2] as string) ? n * 60 : n;
    if (minutes < 5) throw new ScheduleError("Routines can run at most every 5 minutes.");
    if (minutes > 24 * 60) throw new ScheduleError('For less than once a day, name the days, like "mondays 9:00".');
    return { kind: "every", minutes };
  }

  // Days and times: the times come last ("at" is optional).
  const TIME = "(?:\\d{1,2}(?:[:.]\\d{2})?\\s*(?:am|pm)?|noon|midnight)";
  const m = t.match(new RegExp(`^(.*?)(?:\\s*\\bat\\b\\s*|\\s+|^)(${TIME}(?:\\s*(?:,|\\band\\b|&)\\s*${TIME})*)$`));
  if (!m) throw new ScheduleError(`I couldn't tell when "${text}" means. ${HELP}`);
  const times = (m[2] as string)
    .split(/\s*(?:,|\band\b|&)\s*/)
    .map(parseTime)
    .filter((x): x is number => x !== null);
  if (!times.length) throw new ScheduleError(`I couldn't read the time in "${text}". ${HELP}`);
  const days = parseDays((m[1] as string).replace(/^(every|each)\s+/, ""));
  if (!days) throw new ScheduleError(`I couldn't read the days in "${text}". ${HELP}`);
  return { kind: "times", days, times: [...new Set(times)].sort((a, b) => a - b) };
}

const at = (y: number, mo: number, d: number, minutes: number) => new Date(y, mo, d, 0, minutes).getTime();

/** The first time the schedule fires after `after` (local time). */
export function nextRun(s: Schedule, after: number): number {
  const d = new Date(after);
  if (s.kind === "every") {
    const midnight = at(d.getFullYear(), d.getMonth(), d.getDate(), 0);
    const since = Math.floor((after - midnight) / 60_000);
    const next = (Math.floor(since / s.minutes) + 1) * s.minutes;
    return next >= 24 * 60
      ? at(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0)
      : at(d.getFullYear(), d.getMonth(), d.getDate(), next);
  }
  for (let i = 0; i <= 7; i++) {
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i);
    if (!s.days.includes(day.getDay())) continue;
    for (const minutes of s.times) {
      const t = at(day.getFullYear(), day.getMonth(), day.getDate(), minutes);
      if (t > after) return t;
    }
  }
  throw new ScheduleError("That schedule never runs."); // only with no days at all
}

const hhmm = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const list = (xs: string[]) => (xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/** In words, like the app shows it: "Weekdays at 08:30", "Every 30 minutes". */
export function describeSchedule(s: Schedule): string {
  if (s.kind === "every") {
    if (s.minutes === 60) return "Every hour";
    return s.minutes % 60 === 0 ? `Every ${s.minutes / 60} hours` : `Every ${s.minutes} minutes`;
  }
  const same = (a: number[]) => a.length === s.days.length && a.every((x) => s.days.includes(x));
  const days = same(ALL)
    ? "Every day"
    : same(WEEKDAYS)
      ? "Weekdays"
      : same(WEEKENDS)
        ? "Weekends"
        : s.days.length === 1
          ? `${(DAYS[s.days[0] as number] as string).replace(/^./, (c) => c.toUpperCase())}s`
          : list(s.days.map((d) => SHORT[d] as string));
  return `${days} at ${list(s.times.map(hhmm))}`;
}

export interface Quiet {
  from: string;
  to: string;
}

const minutesOf = (hm: string) => parseTime(hm) ?? 0;

/** Is `t` inside quiet hours (which may cross midnight, like 22:00–07:00)? */
export function inQuietHours(t: number, q: Quiet | null): boolean {
  if (!q) return false;
  const d = new Date(t);
  const m = d.getHours() * 60 + d.getMinutes();
  const from = minutesOf(q.from);
  const to = minutesOf(q.to);
  return from < to ? m >= from && m < to : m >= from || m < to;
}

/** When the current quiet hours end. */
export function quietHoursEnd(t: number, q: Quiet): number {
  return nextRun({ kind: "times", days: ALL, times: [minutesOf(q.to)] }, t - 1);
}

/**
 * A routine asked for in chat: "every Monday at 9, summarise last week" → the schedule and the task.
 * Only when the start really is a schedule, so "every file here, rename to lowercase" stays a task.
 */
export function routineFromChat(text: string): { every: string; task: string; schedule: Schedule } | null {
  const m = text.trim().match(/^((?:every|each|daily|weekdays|weekends|on weekdays|on weekends)\b[^,]*?),\s*(.+)$/is);
  if (!m) return null;
  const every = (m[1] as string).trim();
  const task = (m[2] as string).trim();
  if (task.length < 3) return null;
  try {
    return { every, task, schedule: parseSchedule(every) };
  } catch {
    return null;
  }
}
