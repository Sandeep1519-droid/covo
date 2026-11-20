// Routines in the app (Phase 3 M6). A bot's details panel with its routines (Figma B4), the routine
// editor (B5), the daily summary in chat, and the More page: every routine, and how routines run
// (the daily summary, quiet hours, missed runs, subscriptions). Every button calls the same API as
// `covo routines`, so it all lands in the activity log.

import type { ApiBot, ApiRoutine, ApiRoutineSettings } from "@covo/api";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api.ts";
import { clock, type Data, LEVEL_LABEL, modelFor, runById, usd, type View } from "../model.ts";
import { Avatar } from "./Avatar.tsx";
import { Icon } from "./Icon.tsx";
import { needsYou } from "./NeedsYou.tsx";
import { Button, Pill, Toggle } from "./Pill.tsx";

const startOfDay = (t: number) => new Date(t).setHours(0, 0, 0, 0);

/** "today", "yesterday", "tomorrow", "Mon", "12 Nov": past or future (routines run ahead). */
function dayWord(t: number, now = Date.now()): string {
  const days = Math.round((startOfDay(t) - startOfDay(now)) / 86_400_000);
  if (days === 0) return "today";
  if (days === -1) return "yesterday";
  if (days === 1) return "tomorrow";
  if (Math.abs(days) < 7) return new Date(t).toLocaleDateString(undefined, { weekday: "short" });
  return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** "Today 08:30", "Fri 08:30". */
function runWhen(t: number): string {
  const d = dayWord(t);
  return `${d.charAt(0).toUpperCase()}${d.slice(1)} ${clock(t)}`;
}

/** Under a routine's name: "Weekdays at 08:30 · last run today, $0.03". */
export function routineLine(r: ApiRoutine): string {
  if (r.status === "paused") return r.scheduleText;
  const last = r.lastRun?.finishedAt ?? r.lastAt;
  let more = "";
  if (r.lastError) more = "couldn't start last time";
  else if (last) more = `last run ${dayWord(last)}${r.lastRun?.costUsd ? `, ${usd(r.lastRun.costUsd)}` : ""}`;
  else if (r.nextAt) more = `first run ${dayWord(r.nextAt)} ${clock(r.nextAt)}`;
  return more ? `${r.scheduleText} · ${more}` : r.scheduleText;
}

/** B4: the rows of routines. */
export function RoutineRows({
  routines,
  open,
  showBot,
}: {
  routines: ApiRoutine[];
  open: (r: ApiRoutine) => void;
  showBot?: boolean;
}) {
  if (!routines.length) return null;
  return (
    <div className="rows">
      {routines.map((r) => (
        <button type="button" key={r.id} className="row routine-row" onClick={() => open(r)}>
          <Icon name="clock" />
          <span className="file-text">
            <span className="t-body-m-strong">
              {r.name}
              {showBot ? <span className="muted"> · {r.botName}</span> : null}
            </span>
            <span className="t-body-s muted">{routineLine(r)}</span>
          </span>
          {r.status === "active" ? <Pill label="On" tone="success" /> : <Pill label="Paused" />}
          <Icon name="chevron-row" />
        </button>
      ))}
    </div>
  );
}

export type DetailsTab = "about" | "routines";

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="fact">
      <span className="t-body-s muted">{label}</span>
      <span className="t-body-m">{value}</span>
    </div>
  );
}

/** B4: the panel beside a bot's chat. About it, and its routines. */
export function BotDetails({
  data,
  bot,
  tab,
  setTab,
  openRoutine,
}: {
  data: Data;
  bot: ApiBot;
  tab: DetailsTab;
  setTab: (t: DetailsTab) => void;
  /** null: a new routine. */
  openRoutine: (r: ApiRoutine | null) => void;
}) {
  const routines = data.routines.filter((r) => r.botId === bot.id);
  const model = modelFor(data, bot);
  return (
    <aside className="details" aria-label={`About ${bot.name}`}>
      <div className="details-head">
        <Avatar shape={bot.shape} color={bot.color} size={72} />
        <span className="t-title-l">{bot.name}</span>
        <span className="t-body-s muted">{bot.department}</span>
      </div>
      <div className="details-tabs" role="tablist">
        {(["about", "routines"] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className={tab === t ? "details-tab on t-body-m-strong" : "details-tab t-body-m"}
            onClick={() => setTab(t)}
          >
            {t === "about" ? "About" : "Routines"}
          </button>
        ))}
      </div>
      {tab === "about" ? (
        <div className="facts">
          <Fact label="What it does" value={bot.purpose || "Anything you ask."} />
          <Fact label="Works" value={LEVEL_LABEL[bot.level]} />
          <Fact label="Model" value={model?.name ?? "local Ollama"} />
          <Fact label="Limit per task" value={bot.taskLimitUsd === null ? "Your daily limit" : usd(bot.taskLimitUsd)} />
          <Fact
            label="Tasks"
            value={bot.runs ? `${bot.runs}${bot.lastRunAt ? `, last ${dayWord(bot.lastRunAt)}` : ""}` : "None yet"}
          />
          <Fact label="Routines" value={routines.length ? String(routines.length) : "None yet"} />
        </div>
      ) : (
        <>
          {routines.length === 0 && <p className="t-body-s muted">No routines yet.</p>}
          <RoutineRows routines={routines} open={openRoutine} />
          <div>
            <Button kind="secondary" small icon="plus-small" onClick={() => openRoutine(null)}>
              New routine
            </Button>
          </div>
          <p className="t-body-s muted">
            Tip: you can also ask in chat, like “every Monday at 9, summarise last week”.
          </p>
        </>
      )}
    </aside>
  );
}

interface RunRow {
  id: string;
  state: string;
  costUsd: number;
  createdAt: number;
  finishedAt: number | null;
  error: string | null;
}

const RUNNING = ["QUEUED", "PREPARING", "RUNNING", "AWAITING_APPROVAL"];
const FAILED = ["FAILED", "STOPPED"];

function runNote(x: RunRow): string {
  if (x.state === "AWAITING_APPROVAL") return "waiting for your OK";
  if (RUNNING.includes(x.state)) return "running now";
  if (FAILED.includes(x.state)) return x.error ?? (x.state === "STOPPED" ? "stopped" : "didn't finish");
  const mins = x.finishedAt ? Math.max(1, Math.round((x.finishedAt - x.createdAt) / 60_000)) : null;
  const parts = [mins ? `${mins} min` : "", usd(x.costUsd)];
  if (x.state === "REVIEWING") parts.push("ready to review");
  if (x.state === "ROLLED_BACK") parts.push("undone");
  if (x.state === "DISCARDED") parts.push("discarded");
  return parts.filter(Boolean).join(" · ");
}

/** B5: one routine, new or existing. Shown over everything, like the Settings window. */
export function RoutineEditor({
  data,
  routine,
  botId,
  fixedBot,
  close,
  refresh,
  go,
}: {
  data: Data;
  /** null: a new one. */
  routine: ApiRoutine | null;
  botId: string;
  /** Opened from a bot's own panel: the routine is for that bot. */
  fixedBot?: boolean;
  close: () => void;
  refresh: () => void;
  go: (v: View) => void;
}) {
  const [name, setName] = useState(routine?.name ?? "");
  const [every, setEvery] = useState(routine?.schedule ?? "weekdays 9:00");
  const [task, setTask] = useState(routine?.task ?? "");
  const [limit, setLimit] = useState(routine?.runLimitUsd != null ? routine.runLimitUsd.toFixed(2) : "");
  const [model, setModel] = useState(routine?.model ?? "");
  const [quiet, setQuiet] = useState(routine?.quiet ?? false);
  const [bot, setBot] = useState(routine?.botId ?? botId);
  const [preview, setPreview] = useState<{ text: string; ok: boolean }>({ text: "", ok: true });
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [sure, setSure] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  // What the schedule means, as you type.
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      api<{ scheduleText: string; nextAt: number }>(`/schedule?every=${encodeURIComponent(every)}`)
        .then(
          (p) => live && setPreview({ text: `${p.scheduleText}. Next: ${runWhen(p.nextAt).toLowerCase()}.`, ok: true }),
        )
        .catch((e) => live && setPreview({ text: (e as Error).message, ok: false }));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [every]);

  // Its last runs; again when something changes (a test run finishing).
  const lastRunState = routine ? runById(data, routine.lastRun?.id ?? null)?.state : undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload when its latest run moves on
  useEffect(() => {
    if (!routine) return;
    let live = true;
    api<{ runs: RunRow[] }>(`/routines/${routine.id}`)
      .then((d) => live && setRuns(d.runs))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [routine?.id, routine?.lastAt, lastRunState]);

  // Focus once, when it opens; Escape closes it. (Updates from the service mustn't move the focus.)
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    box.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const fields = () => {
    const n = limit.trim().replace(/^\$/, "");
    const runLimitUsd = n === "" ? null : Number(n);
    if (runLimitUsd !== null && (!Number.isFinite(runLimitUsd) || runLimitUsd < 0)) {
      throw new Error("The spending limit is dollars per run, like 0.10. Leave it empty to use the bot's own.");
    }
    const named = name.trim() || task.trim().replace(/\s+/g, " ").slice(0, 40);
    return {
      name: named,
      task: task.trim(),
      // Unchanged, the schedule keeps its next run as it is.
      ...(routine && every.trim() === routine.schedule ? {} : { every: every.trim() }),
      model: model || null,
      runLimitUsd,
      quiet,
    };
  };

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const save = () =>
    act(async () => {
      if (routine) await api(`/routines/${routine.id}`, { method: "PATCH", body: fields() });
      else await api("/routines", { method: "POST", body: { ...fields(), bot } });
      close();
    });

  const owner = data.bots.find((b) => b.id === bot);
  const bots = data.bots.filter((b) => b.status !== "archived");
  return createPortal(
    <div className="overlay">
      <button type="button" className="overlay-close" aria-label="Close" tabIndex={-1} onClick={close} />
      <div
        className="modal routine-editor"
        role="dialog"
        aria-modal="true"
        aria-label={routine ? routine.name : "New routine"}
        tabIndex={-1}
        ref={box}
      >
        <div className="modal-head">
          <input
            className="title-input t-title-l"
            value={name}
            placeholder="New routine"
            aria-label="Routine name"
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
          />
          <button type="button" className="icon-btn" aria-label="Close" title="Close" onClick={close}>
            <Icon name="close" />
          </button>
        </div>
        <div className="modal-fields">
          {!routine && !fixedBot && (
            <label className="field">
              <span className="t-caption secondary">Bot</span>
              <span className="select-field">
                <select className="input t-body-m" value={bot} onChange={(e) => setBot(e.target.value)}>
                  {bots.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
                <Icon name="chevron-row" />
              </span>
            </label>
          )}
          <label className="field">
            <span className="t-caption secondary">When</span>
            <input
              className="input t-body-m"
              value={every}
              placeholder="weekdays 9:00, every day at 18:00, every 30 minutes"
              onChange={(e) => setEvery(e.target.value)}
            />
            <span className={`t-body-s ${preview.ok ? "muted" : "danger"}`}>{preview.text}</span>
          </label>
          <label className="field">
            <span className="t-caption secondary">What to do</span>
            <textarea
              className="input area t-body-m"
              value={task}
              rows={2}
              placeholder="Sort new email into labels, flag invoices for Finance, and send me a 3-line summary."
              onChange={(e) => setTask(e.target.value)}
            />
          </label>
        </div>
        <div className="field-pair">
          <label className="field">
            <span className="t-caption secondary">Spending limit per run</span>
            <input
              className="input t-body-m"
              value={limit}
              inputMode="decimal"
              placeholder={owner?.taskLimitUsd != null ? `${usd(owner.taskLimitUsd)} (the bot's)` : "The bot's own"}
              onChange={(e) => setLimit(e.target.value)}
            />
          </label>
          <label className="field">
            <span className="t-caption secondary">Model</span>
            <span className="select-field">
              <select className="input t-body-m" value={model} onChange={(e) => setModel(e.target.value)}>
                <option value="">Automatic</option>
                {data.models.map((m) => (
                  <option key={m.name} value={m.name}>
                    {m.engine ? `${m.name} (subscription)` : m.name}
                  </option>
                ))}
              </select>
              <Icon name="chevron-row" />
            </span>
          </label>
        </div>
        <div className="rows">
          <div className="row">
            <span className="file-text">
              <span className="t-body-m-strong">Message me only if something needs me</span>
              <span className="t-body-s muted">Otherwise it works quietly</span>
            </span>
            <Toggle label="Message me only if something needs me" on={quiet} onChange={setQuiet} />
          </div>
        </div>
        {routine && (
          <>
            <span className="t-overline muted">Last runs</span>
            {runs.length === 0 ? (
              <p className="t-body-s muted">
                Not run yet.
                {routine.status === "active" && routine.nextAt
                  ? ` First run ${runWhen(routine.nextAt).toLowerCase()}.`
                  : ""}
              </p>
            ) : (
              <div className="rows">
                {runs.slice(0, 5).map((x) => (
                  <button
                    type="button"
                    className="row run-row"
                    key={x.id}
                    title="See what happened"
                    onClick={() => {
                      close();
                      go({ name: "review", runId: x.id });
                    }}
                  >
                    <Icon
                      name={FAILED.includes(x.state) ? "run-failed" : RUNNING.includes(x.state) ? "clock" : "run-ok"}
                    />
                    <span className="t-body-m-strong grow">{runWhen(x.createdAt)}</span>
                    <span className="t-body-s muted ellipsis run-note">{runNote(x)}</span>
                  </button>
                ))}
              </div>
            )}
            {routine.lastError && <p className="t-body-s danger">Last time it couldn't start: {routine.lastError}</p>}
          </>
        )}
        {error && (
          <p className="t-body-s danger" role="alert">
            {error}
          </p>
        )}
        {note && <p className="t-body-s muted">{note}</p>}
        <div className="modal-actions">
          {routine ? (
            <>
              <Button
                kind="danger"
                disabled={busy}
                onClick={() =>
                  sure
                    ? void act(async () => {
                        await api(`/routines/${routine.id}`, { method: "DELETE" });
                        close();
                      })
                    : setSure(true)
                }
              >
                {sure ? "Delete it?" : "Delete"}
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await api(`/routines/${routine.id}`, {
                      method: "PATCH",
                      body: { status: routine.status === "active" ? "paused" : "active" },
                    });
                    close();
                  })
                }
              >
                {routine.status === "active" ? "Pause" : "Turn on"}
              </Button>
              <Button
                icon="play"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await api(`/routines/${routine.id}/run`, { method: "POST", body: {} });
                    setNote(`Started. It shows in ${routine.botName}'s chat.`);
                  })
                }
              >
                Test now
              </Button>
              <Button kind="primary" disabled={busy || !task.trim() || !preview.ok} onClick={() => void save()}>
                Save
              </Button>
            </>
          ) : (
            <>
              <Button onClick={close}>Cancel</Button>
              <Button kind="primary" disabled={busy || !task.trim() || !preview.ok} onClick={() => void save()}>
                Create routine
              </Button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** What the daily summary message carries (packages/engine/src/summary.ts). */
interface SummaryRun {
  runId: string;
  botName: string;
  goal: string;
  state: string;
  summary: string | null;
  error: string | null;
  routine: string | null;
  files: { added: number; modified: number; deleted: number } | null;
  undoable: boolean;
}
export interface DailySummary {
  kind: "summary";
  ran: SummaryRun[];
  spentUsd: number;
}

/** The daily summary in chat: what ran, what changed (with Undo), what was spent and what's waiting. */
export function SummaryCard({
  data,
  summary,
  go,
  onDone,
}: {
  data: Data;
  summary: DailySummary;
  go: (v: View) => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const undo = async (runId: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ conflicts?: { path: string }[] }>(`/runs/${runId}/undo`, { method: "POST", body: {} });
      if (r.conflicts?.length)
        setError(`Nothing was undone: you edited ${r.conflicts.map((c) => c.path).join(", ")} since.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      onDone();
    }
  };
  const ran = summary.ran ?? [];
  const shown = ran.slice(0, 10);
  const waiting = needsYou(data).length;
  return (
    <div className="card">
      <div className="card-head">
        <Icon name="clock" />
        <span className="t-title-m grow">Daily summary</span>
        <Pill label={`${usd(summary.spentUsd ?? 0)} spent`} />
      </div>
      {shown.length > 0 && (
        <div className="rows">
          {shown.map((r) => {
            const state = runById(data, r.runId)?.state ?? r.state;
            const n = r.files ? r.files.added + r.files.modified + r.files.deleted : 0;
            const failed = FAILED.includes(state);
            return (
              <div className="row" key={r.runId}>
                <Icon name={failed ? "run-failed" : "run-ok"} />
                <span className="file-text">
                  <span className="t-body-m-strong ellipsis">
                    {r.botName}
                    {r.routine ? `, ${r.routine}` : ""}
                  </span>
                  <span className="t-body-s muted">
                    {failed ? `Didn't finish: ${r.error ?? r.goal}` : (r.summary ?? r.goal)}
                  </span>
                </span>
                {n > 0 && (
                  <Button small onClick={() => go({ name: "review", runId: r.runId })}>
                    {n} file{n === 1 ? "" : "s"}
                  </Button>
                )}
                {r.undoable && state === "KEPT" && (
                  <Button small disabled={busy} onClick={() => void undo(r.runId)}>
                    Undo
                  </Button>
                )}
                {state === "ROLLED_BACK" && <span className="t-body-s muted nowrap">Undone</span>}
              </div>
            );
          })}
          {ran.length > shown.length && (
            <div className="row">
              <span className="t-body-s muted">and {ran.length - shown.length} more</span>
            </div>
          )}
        </div>
      )}
      {error && <p className="t-body-s danger">{error}</p>}
      {waiting > 0 && (
        <div className="card-actions">
          <Button kind="secondary" onClick={() => go({ name: "needs-you" })}>
            {waiting === 1 ? "1 thing needs you" : `${waiting} things need you`}
          </Button>
        </div>
      )}
    </div>
  );
}

const hhmm = (s: string) => {
  const m = s.trim().match(/^(\d{1,2}):(\d{2})$/);
  return m ? `${(m[1] as string).padStart(2, "0")}:${m[2]}` : null;
};

/** The More page: every routine, and how routines and the daily summary behave. */
export function RoutinesPage({ data, refresh, go }: { data: Data; refresh: () => void; go: (v: View) => void }) {
  const [settings, setSettings] = useState<ApiRoutineSettings | null>(null);
  const [editing, setEditing] = useState<ApiRoutine | null | undefined>(undefined);
  const [summaryAt, setSummaryAt] = useState("18:00");
  const [quietFrom, setQuietFrom] = useState("22:00");
  const [quietTo, setQuietTo] = useState("07:00");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const show = (s: ApiRoutineSettings) => {
    setSettings(s);
    if (s.summaryAt) setSummaryAt(s.summaryAt);
    if (s.quiet) {
      setQuietFrom(s.quiet.from);
      setQuietTo(s.quiet.to);
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when the page opens
  useEffect(() => {
    api<ApiRoutineSettings>("/routine-settings")
      .then(show)
      .catch((e) => setError((e as Error).message));
  }, []);

  const put = async (body: Partial<ApiRoutineSettings>, done: string) => {
    setError(null);
    setNote(null);
    try {
      show(await api<ApiRoutineSettings>("/routine-settings", { method: "PUT", body }));
      setNote(done);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const saveSummaryAt = (v: string) => {
    const t = hhmm(v);
    if (t && t !== settings?.summaryAt) void put({ summaryAt: t }, `The daily summary is made at ${t}.`);
  };
  const saveQuiet = (from: string, to: string) => {
    const f = hhmm(from);
    const t = hhmm(to);
    if (f && t && (f !== settings?.quiet?.from || t !== settings?.quiet?.to))
      void put({ quiet: { from: f, to: t } }, `Quiet hours: ${f} to ${t}.`);
  };

  const groups = data.bots
    .filter((b) => b.status !== "archived")
    .map((b) => ({ bot: b, list: data.routines.filter((r) => r.botId === b.id) }))
    .filter((x) => x.list.length);

  return (
    <section className="review" aria-label="Routines">
      <div className="review-head">
        <div className="review-title">
          <h1 className="t-display">Routines</h1>
          <p className="t-body-m muted">Tasks your bots do on a schedule, by themselves.</p>
        </div>
        <Button kind="secondary" small icon="plus-small" onClick={() => setEditing(null)}>
          New routine
        </Button>
      </div>
      {groups.length === 0 ? (
        <p className="t-body-m muted">
          No routines yet. Make one here, or ask a bot in its chat, like “every Monday at 9, summarise last week”.
        </p>
      ) : (
        groups.map(({ bot, list }) => (
          <div className="group" key={bot.id}>
            <button type="button" className="group-head" onClick={() => go({ name: "bot", id: bot.id })}>
              <Avatar shape={bot.shape} color={bot.color} size={24} />
              <span className="t-title-m">{bot.name}</span>
            </button>
            <RoutineRows routines={list} open={setEditing} />
          </div>
        ))
      )}
      {settings && (
        <div className="group">
          <span className="t-title-m">How routines run</span>
          <div className="rows">
            <div className="row">
              <span className="file-text">
                <span className="t-body-m-strong">Daily summary</span>
                <span className="t-body-s muted">
                  What ran, what changed, what was spent and what's waiting. In your main bot's chat, and on your phone
                  if it's connected.
                </span>
              </span>
              {settings.summaryAt !== null && (
                <input
                  type="time"
                  className="input t-body-m time-input"
                  aria-label="Daily summary time"
                  value={summaryAt}
                  onChange={(e) => setSummaryAt(e.target.value)}
                  onBlur={(e) => saveSummaryAt(e.target.value)}
                />
              )}
              <Toggle
                label="Daily summary"
                on={settings.summaryAt !== null}
                onChange={(on) =>
                  void put(
                    { summaryAt: on ? (hhmm(summaryAt) ?? "18:00") : null },
                    on ? `The daily summary is made at ${hhmm(summaryAt) ?? "18:00"}.` : "No more daily summaries.",
                  )
                }
              />
            </div>
            <div className="row">
              <span className="file-text">
                <span className="t-body-m-strong">Quiet hours</span>
                <span className="t-body-s muted">
                  No routine starts in these hours. One that's due waits until they end.
                </span>
              </span>
              {settings.quiet !== null && (
                <span className="time-pair">
                  <input
                    type="time"
                    className="input t-body-m time-input"
                    aria-label="Quiet from"
                    value={quietFrom}
                    onChange={(e) => setQuietFrom(e.target.value)}
                    onBlur={(e) => saveQuiet(e.target.value, quietTo)}
                  />
                  <span className="t-body-s muted">to</span>
                  <input
                    type="time"
                    className="input t-body-m time-input"
                    aria-label="Quiet until"
                    value={quietTo}
                    onChange={(e) => setQuietTo(e.target.value)}
                    onBlur={(e) => saveQuiet(quietFrom, e.target.value)}
                  />
                </span>
              )}
              <Toggle
                label="Quiet hours"
                on={settings.quiet !== null}
                onChange={(on) => {
                  const f = hhmm(quietFrom) ?? "22:00";
                  const t = hhmm(quietTo) ?? "07:00";
                  void put(
                    { quiet: on ? { from: f, to: t } : null },
                    on ? `Quiet hours: ${f} to ${t}.` : "No quiet hours.",
                  );
                }}
              />
            </div>
            <div className="row">
              <span className="file-text">
                <span className="t-body-m-strong">Run a missed routine once when the Mac wakes</span>
                <span className="t-body-s muted">Off: a routine missed while the Mac was asleep is skipped.</span>
              </span>
              <Toggle
                label="Run a missed routine once when the Mac wakes"
                on={settings.missed === "run-once"}
                onChange={(on) =>
                  void put(
                    { missed: on ? "run-once" : "skip" },
                    on ? "A missed routine runs once when the Mac wakes." : "Missed routines are skipped.",
                  )
                }
              />
            </div>
            <div className="row">
              <span className="file-text">
                <span className="t-body-m-strong">Let routines use command-line subscriptions</span>
                <span className="t-body-s muted">
                  Off by default: routines use your API keys or the free local model. Check your provider's terms first.
                </span>
              </span>
              <Toggle
                label="Let routines use command-line subscriptions"
                on={settings.subscriptions}
                onChange={(on) =>
                  void put(
                    { subscriptions: on },
                    on ? "Routines may use your subscriptions." : "Routines won't use subscriptions.",
                  )
                }
              />
            </div>
          </div>
          <div>
            <Button
              kind="secondary"
              small
              onClick={async () => {
                setError(null);
                setNote(null);
                try {
                  const r = await api<{ text: string | null }>("/summary-now", { method: "POST", body: {} });
                  setNote(r.text ? "Done: it's in your main bot's chat." : "Nothing to tell since the last summary.");
                  refresh();
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              Make a summary now
            </Button>
          </div>
          {note && (
            <p className="t-body-s muted" role="status">
              {note}
            </p>
          )}
        </div>
      )}
      {error && (
        <p className="t-body-s danger" role="alert">
          {error}
        </p>
      )}
      <p className="t-body-s muted">Skills and connections arrive here later.</p>
      {editing !== undefined && (
        <RoutineEditor
          data={data}
          routine={editing && (data.routines.find((r) => r.id === editing.id) ?? editing)}
          botId={editing?.botId ?? data.bots.find((b) => b.status !== "archived")?.id ?? ""}
          close={() => setEditing(undefined)}
          refresh={refresh}
          go={go}
        />
      )}
    </section>
  );
}
