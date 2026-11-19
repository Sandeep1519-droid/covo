import type { ApiBot, ApiRun } from "@covo/api";
import { Fragment, useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import {
  approvalsOf,
  clock,
  type Data,
  dayLabel,
  isActive,
  LEVEL_LABEL,
  modelFor,
  runStatus,
  runsOf,
  sameDay,
  usd,
} from "../model.ts";
import { Avatar } from "./Avatar.tsx";
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

/** A bot's chat (Figma H1/H2). Each task shows as your message and the bot's reply; cards come in M3. */
export function BotChat({ data, bot, refresh }: { data: Data; bot: ApiBot; refresh: () => void }) {
  const [text, setText] = useState("");
  const [modelName, setModelName] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);

  const runs = runsOf(data, bot.id).slice().reverse(); // oldest first, like a chat
  const latest = runs[runs.length - 1];
  const model = (modelName && data.models.find((m) => m.name === modelName)) || modelFor(data, bot);
  const waiting = approvalsOf(data, bot.id).length;

  // A new bot, a new draft.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the bot changes
  useEffect(() => {
    setText("");
    setModelName(undefined);
    setError(null);
  }, [bot.id]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: follow the newest message
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [runs.length, latest?.state, bot.id]);

  const send = async () => {
    const goal = text.trim();
    if (!goal) return;
    setBusy(true);
    setError(null);
    try {
      await api("/runs", { method: "POST", body: { goal, bot: bot.id, ...(model ? { model: model.name } : {}) } });
      setText("");
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
        {runs.length === 0 ? (
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
            {runs.map((r, i) => {
              const prev = runs[i - 1];
              return (
                <Fragment key={r.id}>
                  {(!prev || !sameDay(prev.createdAt, r.createdAt)) && (
                    <div className="day t-caption muted">
                      <span className="rule" />
                      {dayLabel(r.createdAt)}
                      <span className="rule" />
                    </div>
                  )}
                  <Turn bot={bot} run={r} />
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
          onSend={send}
          busy={busy}
        />
      </div>
    </section>
  );
}

function Turn({ bot, run }: { bot: ApiBot; run: ApiRun }) {
  const s = runStatus(run);
  const at = run.finishedAt ?? run.startedAt ?? run.createdAt;
  const mins = run.startedAt && run.finishedAt ? Math.max(1, Math.round((run.finishedAt - run.startedAt) / 60_000)) : 0;
  return (
    <>
      <div className="you-says">
        <div className="bubble">
          <p className="t-body-m">{run.goal}</p>
          <span className="t-caption muted">{clock(run.createdAt)}</span>
        </div>
      </div>
      <div className="bot-says">
        <Avatar shape={bot.shape} color={bot.color} size={28} />
        <div className="bot-says-body">
          <div className="bot-says-head">
            <span className="t-body-m-strong">{bot.name}</span>
            <span className="t-caption muted">{clock(at)}</span>
            <Pill label={s.pill} tone={s.warning ? "warning" : "neutral"} />
          </div>
          <p className="t-body-m">{s.text}</p>
          {(run.costUsd > 0 || mins > 0 || run.model) && (
            <div className="meta">
              {run.model && <Pill label={run.model} />}
              {mins > 0 && <Pill label={`${mins} min`} />}
              {run.costUsd > 0 && <Pill label={usd(run.costUsd)} />}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
