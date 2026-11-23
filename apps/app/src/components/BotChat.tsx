import type { ApiBot, ApiChatMessage, ApiRoutine, ApiRun, ApiRunDetail } from "@covo/api";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import {
  approvalsOf,
  clock,
  type Data,
  dayLabel,
  isActive,
  LEVEL_LABEL,
  type LiveStep,
  modelFor,
  runById,
  runStatus,
  runsOf,
  sameDay,
  type View,
} from "../model.ts";
import { Avatar } from "./Avatar.tsx";
import { ChangesCard, LiveSteps, SpendCard, StoppedCard, useChanges } from "./Cards.tsx";
import { Composer } from "./Composer.tsx";
import { Icon } from "./Icon.tsx";
import { Button, Pill } from "./Pill.tsx";
import { BotDetails, type DailySummary, type DetailsTab, RoutineEditor, SummaryCard } from "./Routines.tsx";
import { LATER } from "./Sidebar.tsx";

const SUGGESTIONS = [
  "Summarise what's in my files",
  "Tidy up the README",
  "List the TODOs in my notes",
  "What did you do last time?",
];

/** A bot's chat (Figma H1/H2): your messages, and each task's progress and result as the bot's reply. */
export function BotChat({
  data,
  bot,
  tick,
  steps,
  refresh,
  go,
}: {
  data: Data;
  bot: ApiBot;
  /** Changes whenever the service reports something, so the chat reloads. */
  tick: number;
  steps: (runId: string) => LiveStep[];
  refresh: () => void;
  go: (v: View) => void;
}) {
  const [messages, setMessages] = useState<ApiChatMessage[] | null>(null);
  const [text, setText] = useState("");
  const [modelName, setModelName] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The details panel beside the chat (Figma B4), and the routine open in the editor (B5; null: a new one).
  const [details, setDetails] = useState(false);
  const [detailsTab, setDetailsTab] = useState<DetailsTab>("about");
  const [editing, setEditing] = useState<ApiRoutine | null | undefined>(undefined);
  const end = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  /** You're at the bottom of the chat (or haven't scrolled up). */
  const pinned = useRef(true);

  const model = (modelName && data.models.find((m) => m.name === modelName)) || modelFor(data, bot);
  const known = useRef(new Set<string>());
  const asked = useRef(new Set<string>());
  known.current = new Set(data.runs.map((r) => r.id));
  const waiting = approvalsOf(data, bot.id).length;
  const timeline = messages === null ? null : chatTimeline(data, bot.id, messages);
  const latest = runsOf(data, bot.id)[0];

  const load = useCallback(async () => {
    try {
      const list = await api<ApiChatMessage[]>(`/bots/${bot.id}/messages?limit=100`);
      setMessages(list);
      // A task the app hasn't heard about yet (it started while the page was loading): reload.
      // Ask once per task, so a very old one outside the loaded list can't cause a loop.
      const missing = list.filter((m) => m.runId && !known.current.has(m.runId) && !asked.current.has(m.runId));
      for (const m of missing) asked.current.add(m.runId as string);
      if (missing.length) refresh();
    } catch {}
  }, [bot.id, refresh]);

  // A new bot, a new draft.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the bot changes
  useEffect(() => {
    setMessages(null);
    setText("");
    setModelName(undefined);
    setError(null);
    setEditing(undefined);
  }, [bot.id]);

  const openRoutine = (r: ApiRoutine | null) => setEditing(r);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload on every update from the service
  useEffect(() => {
    void load();
  }, [load, tick]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: follow the newest message
  useEffect(() => {
    pinned.current = true;
    end.current?.scrollIntoView({ block: "end" });
  }, [messages?.length, latest?.state, bot.id]);

  // Cards fill in after they appear (a task's changes load a moment later), which made the chat stop
  // short of the newest one. While you're at the bottom, stay there as the chat grows; once you scroll
  // up to read, it stays where you are.
  const hasMessages = (timeline?.length ?? 0) > 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: set up again when the message list appears or the bot changes
  useEffect(() => {
    const box = scroller.current;
    const list = box?.querySelector(".messages");
    if (!box || !list) return;
    const onScroll = () => {
      pinned.current = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    };
    box.addEventListener("scroll", onScroll, { passive: true });
    const grow = new ResizeObserver(() => {
      if (pinned.current) box.scrollTop = box.scrollHeight;
    });
    grow.observe(list);
    return () => {
      box.removeEventListener("scroll", onScroll);
      grow.disconnect();
    };
  }, [hasMessages, bot.id]);

  const send = async (goal = text.trim()) => {
    if (!goal) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/bots/${bot.id}/messages`, {
        method: "POST",
        body: { text: goal, ...(model ? { model: model.name } : {}) },
      });
      if (goal === text.trim()) setText("");
      await load();
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  let pill: React.ReactNode = null;
  if (waiting > 0) pill = <Pill label="Needs your OK" tone="warning" />;
  else if (bot.status === "paused") pill = <Pill label="Paused" />;
  else if (latest?.state === "REVIEWING") pill = <Pill label="Changes ready" tone="accent" />;
  else if (latest && isActive(latest.state)) pill = <Pill label="Working" />;

  return (
    <section className="chat" aria-label={`Chat with ${bot.name}`}>
      <header className="chat-header">
        <Avatar shape={bot.shape} color={bot.color} size={32} />
        <span className="chat-title">
          <span className="t-title-m">{bot.name}</span>
          <span className="t-caption muted">{bot.department}</span>
        </span>
        {pill}
        <span className="grow" />
        <span className="header-btn t-caption" title={`Computer: ${LATER}`}>
          <Icon name="computer" />
          Computer
        </span>
        <button
          type="button"
          className={details ? "icon-btn on" : "icon-btn"}
          aria-label="Details"
          aria-pressed={details}
          title={details ? "Hide details" : "Details and routines"}
          onClick={() => setDetails((d) => !d)}
        >
          <Icon name="details" />
        </button>
        <span className="icon-btn" title={`Share: ${LATER}`}>
          <Icon name="share" />
        </span>
      </header>

      <div className="chat-body">
        <div className="chat-main">
          <div className="chat-scroll" ref={scroller}>
            {timeline === null ? null : timeline.length === 0 ? (
              <div className="chat-empty">
                <Avatar shape={bot.shape} color={bot.color} size={72} />
                <h1 className="t-display">What should {bot.name} do?</h1>
                <div className="suggestions">
                  {SUGGESTIONS.map((s) => (
                    <button type="button" key={s} className="suggestion t-body-s" onClick={() => setText(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="messages">
                {timeline.map((item, i) => {
                  const prev = timeline[i - 1];
                  const m = item.message;
                  return (
                    <Fragment key={item.key}>
                      {(!prev || !sameDay(prev.at, item.at)) && (
                        <div className="day t-caption muted">
                          <span className="rule" />
                          {dayLabel(item.at)}
                          <span className="rule" />
                        </div>
                      )}
                      <Turn
                        data={data}
                        bot={bot}
                        message={m}
                        from={item.from}
                        steps={m.runId ? steps(m.runId) : []}
                        refresh={() => {
                          refresh();
                          void load();
                        }}
                        retry={() => send(m.text)}
                        go={go}
                        openRoutine={(id) => {
                          const r = data.routines.find((x) => x.id === id);
                          if (r) openRoutine(r);
                        }}
                      />
                    </Fragment>
                  );
                })}
                <div ref={end} />
              </div>
            )}
          </div>

          <div className="composer-wrap">
            {error && (
              <p className="composer-error t-body-s" role="alert">
                {error}
              </p>
            )}
            <Composer
              botName={bot.name}
              section={bot.department}
              level={LEVEL_LABEL[bot.level]}
              models={data.models}
              model={model}
              onModel={setModelName}
              text={text}
              onText={setText}
              onSend={() => void send()}
              busy={busy}
            />
          </div>
        </div>
        {details && (
          <BotDetails data={data} bot={bot} tab={detailsTab} setTab={setDetailsTab} openRoutine={openRoutine} />
        )}
      </div>
      {editing !== undefined && (
        <RoutineEditor
          data={data}
          routine={editing && (data.routines.find((r) => r.id === editing.id) ?? editing)}
          botId={bot.id}
          fixedBot
          close={() => setEditing(undefined)}
          refresh={() => {
            refresh();
            void load();
          }}
          go={go}
        />
      )}
    </section>
  );
}

function Turn({
  data,
  bot,
  message,
  from,
  steps,
  refresh,
  retry,
  go,
  openRoutine,
}: {
  data: Data;
  bot: ApiBot;
  message: ApiChatMessage;
  /** Where the task came from, when it wasn't this chat ("From the terminal"). */
  from?: string | undefined;
  steps: LiveStep[];
  refresh: () => void;
  retry: () => void;
  go: (v: View) => void;
  openRoutine: (id: string) => void;
}) {
  if (message.role === "bot")
    return <BotNote data={data} bot={bot} message={message} refresh={refresh} go={go} openRoutine={openRoutine} />;
  const run = runById(data, message.runId);
  // Asking for a routine starts no task now: the bot's answer is its own message.
  const routineAsk = message.data?.kind === "routine";
  return (
    <>
      <div className="you-says">
        <div className="bubble">
          <p className="t-body-m">{message.text}</p>
          <span className="t-caption muted">
            {from ? `${from} · ` : ""}
            {clock(message.createdAt)}
          </span>
        </div>
      </div>
      {!routineAsk && (
        <BotReply
          data={data}
          bot={bot}
          message={message}
          run={run}
          steps={steps}
          refresh={refresh}
          retry={retry}
          go={go}
        />
      )}
    </>
  );
}

/** A message the bot wrote by itself: the daily summary, or "OK: I'll do that every weekday at 9:00". */
function BotNote({
  data,
  bot,
  message,
  refresh,
  go,
  openRoutine,
}: {
  data: Data;
  bot: ApiBot;
  message: ApiChatMessage;
  refresh: () => void;
  go: (v: View) => void;
  openRoutine: (id: string) => void;
}) {
  const d = message.data;
  const summary = d?.kind === "summary" ? (d as unknown as DailySummary) : null;
  const routineId = d?.kind === "routine-made" && typeof d.routineId === "string" ? d.routineId : null;
  const routine = routineId ? data.routines.find((r) => r.id === routineId) : undefined;
  return (
    <div className="bot-says">
      <Avatar shape={bot.shape} color={bot.color} size={28} />
      <div className="bot-says-body">
        <div className="bot-says-head">
          <span className="t-body-m-strong">{bot.name}</span>
          <span className="t-caption muted">{clock(message.createdAt)}</span>
        </div>
        {/* The summary's text is for your phone; here, its first line and the card. */}
        <p className="t-body-m">{summary ? message.text.split("\n")[0] : message.text}</p>
        {summary && <SummaryCard data={data} summary={summary} go={go} onDone={refresh} />}
        {routine && (
          <div>
            <Button kind="secondary" small onClick={() => openRoutine(routine.id)}>
              Open routine
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function BotReply({
  data,
  bot,
  message,
  run,
  steps,
  refresh,
  retry,
  go,
}: {
  data: Data;
  bot: ApiBot;
  message: ApiChatMessage;
  run: ApiRun | undefined;
  steps: LiveStep[];
  refresh: () => void;
  retry: () => void;
  go: (v: View) => void;
}) {
  const changes = useChanges(run);
  const [seeded, setSeeded] = useState<LiveStep[]>([]);
  const active = run !== undefined && isActive(run.state);

  // A task that was already running when the page opened: show the steps it took so far.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the task or its activity changes
  useEffect(() => {
    if (!run || !active) return;
    let live = true;
    api<ApiRunDetail>(`/runs/${run.id}`)
      .then((d) => {
        if (!live) return;
        setSeeded(
          d.steps
            .filter((s) => s.kind === "tool" && s.tool)
            .map((s) => ({
              seq: s.seq,
              name: s.tool ?? "",
              target: targetOf(s.args),
              label: "",
              ok: s.decision !== "deny",
            })),
        );
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [run?.id, active]);

  const at = run?.finishedAt ?? run?.startedAt ?? message.createdAt;
  const head = (pillNode: React.ReactNode) => (
    <div className="bot-says-head">
      <span className="t-body-m-strong">{bot.name}</span>
      <span className="t-caption muted">{clock(at)}</span>
      {pillNode}
    </div>
  );

  let body: React.ReactNode;
  let pill: React.ReactNode = null;
  if (message.error) {
    body = (
      <>
        <p className="t-body-m">I couldn't start this task.</p>
        <StoppedCard title="Couldn't start" reason={message.error} onRetry={retry} />
      </>
    );
  } else if (!run) {
    body = (
      <p className="t-body-m">
        {data.pause.paused
          ? "Waiting to start: all bots are paused. Resume them to let me begin."
          : data.approvals.length > 0
            ? "Waiting to start: another task is paused for your OK and is using this Mac's free slot. Answer it (in Needs you) and I'll begin."
            : "Waiting for a free slot. I'll start soon."}
      </p>
    );
    pill = <Pill label="Queued" />;
  } else {
    const s = runStatus(run);
    const approval = data.approvals.find((a) => a.runId === run.id);
    if (run.state === "AWAITING_APPROVAL" && approval) {
      body = (
        <>
          <p className="t-body-m">I've paused. This needs your OK before I go on.</p>
          <SpendCard approval={approval} go={go} onDone={refresh} />
        </>
      );
    } else if (isActive(run.state) && run.state !== "REVIEWING") {
      const live = mergeSteps(seeded, steps);
      body = (
        <>
          <p className="t-body-m">{s.text}</p>
          <LiveSteps
            steps={live}
            onStop={() => void api(`/runs/${run.id}/stop`, { method: "POST", body: {} }).finally(refresh)}
          />
        </>
      );
      pill = <Pill label={s.pill} />;
    } else if (run.state === "FAILED" || run.state === "STOPPED") {
      body = (
        <>
          <p className="t-body-m">{run.state === "STOPPED" ? "I stopped this task." : "This task didn't work out."}</p>
          <StoppedCard
            title={run.state === "STOPPED" ? "Stopped" : "It didn't finish"}
            reason={run.error ?? "Something went wrong."}
            run={run}
            onRetry={retry}
            onDetails={() => go({ name: "review", runId: run.id })}
          />
        </>
      );
    } else {
      const summary =
        run.state === "REVIEWING"
          ? `${run.summary ?? "Done."} I worked on a safe copy. Nothing is in your files until you keep it.`
          : run.state === "DISCARDED"
            ? "You threw these changes away."
            : (run.summary ?? s.text);
      body = (
        <>
          <p className="t-body-m">{summary}</p>
          {(run.blockedSteps ?? 0) > 0 && <StoppedSteps run={run} go={go} />}
          {changes && <ChangesCard run={run} changes={changes} go={go} onDone={refresh} />}
        </>
      );
    }
  }

  return (
    <div className="bot-says">
      <Avatar shape={bot.shape} color={bot.color} size={28} />
      <div className="bot-says-body">
        {head(pill)}
        {body}
      </div>
    </div>
  );
}

/** Steps Covo stopped in this task: the proof that a planted instruction went nowhere. */
function StoppedSteps({ run, go }: { run: ApiRun; go: (v: View) => void }) {
  const n = run.blockedSteps ?? 0;
  return (
    <div className="stopped-note" role="status">
      <Icon name="run-failed" />
      <span className="file-text grow">
        <span className="t-body-m-strong">
          Covo stopped {n} step{n === 1 ? "" : "s"} in this task
        </span>
        <span className="t-body-s secondary">
          They reached outside the bot's copy of your files, or did something the sandbox doesn't allow, so they did
          nothing.
        </span>
      </span>
      <button type="button" className="link t-body-s" onClick={() => go({ name: "review", runId: run.id })}>
        See the steps
      </button>
    </div>
  );
}

function targetOf(args: string | null): string {
  if (!args) return "";
  try {
    const a = JSON.parse(args) as Record<string, unknown>;
    const v = a.path ?? a.command ?? a.pattern ?? "";
    return typeof v === "string" ? v : "";
  } catch {
    return "";
  }
}

function mergeSteps(a: LiveStep[], b: LiveStep[]): LiveStep[] {
  const by = new Map<number, LiveStep>();
  for (const s of a) by.set(s.seq, s);
  for (const s of b) by.set(s.seq, s);
  return [...by.values()].sort((x, y) => x.seq - y.seq);
}

/** Where a task came from, when it wasn't this chat. */
const FROM: Record<string, string> = {
  cli: "From the terminal",
  phone: "From your phone",
  api: "From the API",
  chat: "From the app",
  cron: "From a routine",
  heartbeat: "From a routine",
  webhook: "From a webhook",
};

interface TimelineItem {
  key: string;
  at: number;
  message: ApiChatMessage;
  from?: string;
}

/**
 * The chat as you see it: your messages, plus this bot's tasks that were started somewhere else
 * (the terminal, the API, a routine), so their progress, pauses and results show here too.
 */
function chatTimeline(data: Data, botId: string, messages: ApiChatMessage[]): TimelineItem[] {
  const inChat = new Set(messages.map((m) => m.runId));
  // With a full page of messages, older tasks may belong to messages that weren't loaded.
  const since = messages.length >= 100 ? (messages[0]?.createdAt ?? 0) : 0;
  const outside = runsOf(data, botId)
    .filter((r) => !inChat.has(r.id) && r.createdAt >= since)
    .map(
      (r): TimelineItem => ({
        key: r.id,
        at: r.createdAt,
        from:
          r.trigger === "routine"
            ? r.routineName
              ? `Routine: ${r.routineName}`
              : "From a routine"
            : (FROM[r.trigger] ?? "From outside this chat"),
        message: {
          id: r.id,
          role: "you",
          text: r.goal,
          runId: r.id,
          model: r.model,
          error: null,
          createdAt: r.createdAt,
        },
      }),
    );
  return [...messages.map((m): TimelineItem => ({ key: m.id, at: m.createdAt, message: m })), ...outside].sort(
    (a, b) => a.at - b.at,
  );
}
