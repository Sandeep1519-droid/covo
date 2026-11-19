import type { ApiBot, ApiChatMessage, ApiRun, ApiRunDetail } from "@covo/api";
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
import { Pill } from "./Pill.tsx";
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
  const end = useRef<HTMLDivElement>(null);

  const model = (modelName && data.models.find((m) => m.name === modelName)) || modelFor(data, bot);
  const known = useRef(new Set<string>());
  const asked = useRef(new Set<string>());
  known.current = new Set(data.runs.map((r) => r.id));
  const waiting = approvalsOf(data, bot.id).length;
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
  }, [bot.id]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload on every update from the service
  useEffect(() => {
    void load();
  }, [load, tick]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: follow the newest message
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [messages?.length, latest?.state, bot.id]);

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
        <span className="icon-btn" title={`Details: ${LATER}`}>
          <Icon name="details" />
        </span>
        <span className="icon-btn" title={`Share: ${LATER}`}>
          <Icon name="share" />
        </span>
      </header>

      <div className="chat-scroll">
        {messages === null ? null : messages.length === 0 ? (
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
            {messages.map((m, i) => {
              const prev = messages[i - 1];
              return (
                <Fragment key={m.id}>
                  {(!prev || !sameDay(prev.createdAt, m.createdAt)) && (
                    <div className="day t-caption muted">
                      <span className="rule" />
                      {dayLabel(m.createdAt)}
                      <span className="rule" />
                    </div>
                  )}
                  <Turn
                    data={data}
                    bot={bot}
                    message={m}
                    steps={m.runId ? steps(m.runId) : []}
                    refresh={() => {
                      refresh();
                      void load();
                    }}
                    retry={() => send(m.text)}
                    go={go}
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
    </section>
  );
}

function Turn({
  data,
  bot,
  message,
  steps,
  refresh,
  retry,
  go,
}: {
  data: Data;
  bot: ApiBot;
  message: ApiChatMessage;
  steps: LiveStep[];
  refresh: () => void;
  retry: () => void;
  go: (v: View) => void;
}) {
  const run = runById(data, message.runId);
  return (
    <>
      <div className="you-says">
        <div className="bubble">
          <p className="t-body-m">{message.text}</p>
          <span className="t-caption muted">{clock(message.createdAt)}</span>
        </div>
      </div>
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
    </>
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
    body = <p className="t-body-m">Waiting for a free slot. I'll start soon.</p>;
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
