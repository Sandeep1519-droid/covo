// Figma X1 "Menu bar": the Mac app's menu bar panel. What needs you (with the latest spending pause
// answerable right here), what's running, today's spending, and Open, New bot, Pause all.

import type { ApiPause } from "@covo/api";
import { useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { type Data, hashFor, isActive, spendLine } from "../model.ts";
import { openInWindow, reportHeight } from "../shell.ts";
import { Avatar } from "./Avatar.tsx";
import { needsYou } from "./NeedsYou.tsx";
import { Button } from "./Pill.tsx";

const ago = (t: number | null, now = Date.now()) => {
  if (!t) return "";
  const m = Math.max(0, Math.round((now - t) / 60_000));
  return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
};

export function MenuBar({ data, pause, refresh }: { data: Data; pause: ApiPause | null; refresh: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const items = needsYou(data);
  const running = data.runs.filter(
    (r) => isActive(r.state) && r.state !== "AWAITING_APPROVAL" && r.state !== "REVIEWING",
  );
  const latest = data.approvals[data.approvals.length - 1];
  const latestRun = latest ? data.runs.find((r) => r.id === latest.runId) : undefined;

  // Keep the Mac app's panel as tall as the content.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => reportHeight(el.scrollHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const open = (hash: string) => {
    if (!openInWindow(hash)) location.hash = hash;
  };
  const call = async (path: string, body: unknown) => {
    setBusy(true);
    setError(null);
    try {
      await api(path, { method: "POST", body });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      refresh();
    }
  };

  return (
    <div className="menubar" ref={box}>
      {pause?.paused && (
        <div className="menubar-paused t-body-s">
          All bots are paused{pause.queued ? `. ${pause.queued} waiting to start` : ""}.
        </div>
      )}
      {latest && latestRun && (
        <div className="menubar-approval">
          <span className="t-overline muted">Latest approval</span>
          <span className="t-body-m-strong">{latestRun.botName}</span>
          <span className="t-body-s secondary">{latest.summary}</span>
          <div className="card-actions">
            <Button
              kind="primary"
              small
              disabled={busy}
              onClick={() => call(`/approvals/${latest.id}`, { decision: "approve", payloadHash: latest.payloadHash })}
            >
              {latest.spend ? `Allow $${latest.spend.grantUsd.toFixed(2)} more` : "Allow once"}
            </Button>
            <Button
              small
              disabled={busy}
              onClick={() => call(`/approvals/${latest.id}`, { decision: "deny", payloadHash: latest.payloadHash })}
            >
              Stop
            </Button>
          </div>
        </div>
      )}
      <span className="t-overline muted">Needs you · {items.length}</span>
      <div className="rows">
        {items.length === 0 && (
          <div className="row">
            <span className="t-body-s muted">Nothing right now.</span>
          </div>
        )}
        {items.slice(0, 5).map((i) => {
          const bot = data.bots.find((b) => b.id === i.botId);
          return (
            <button type="button" key={i.key} className="row menubar-row" onClick={() => open(hashFor(i.open))}>
              {bot && <Avatar shape={bot.shape} color={bot.color} size={24} />}
              <span className="t-body-m-strong grow ellipsis">{i.title}</span>
            </button>
          );
        })}
      </div>
      {running.length > 0 && (
        <>
          <span className="t-overline muted">Running</span>
          <div className="rows">
            {running.slice(0, 4).map((r) => {
              const bot = data.bots.find((b) => b.id === r.botId);
              return (
                <button
                  type="button"
                  key={r.id}
                  className="row menubar-row"
                  onClick={() => open(`#/bot/${encodeURIComponent(r.botId)}`)}
                >
                  {bot && <Avatar shape={bot.shape} color={bot.color} size={24} />}
                  <span className="t-body-m-strong grow ellipsis">{r.goal}</span>
                  <span className="t-body-s muted">{ago(r.startedAt ?? r.createdAt)}</span>
                </button>
              );
            })}
          </div>
        </>
      )}
      <div className="facts">
        <div className="fact">
          <span className="t-body-s muted">Spent today</span>
          <span className="t-body-m">{spendLine(data.usage).replace(" today", "")}</span>
        </div>
      </div>
      {error && <p className="t-body-s danger">{error}</p>}
      <div className="card-actions">
        <Button kind="primary" small onClick={() => open("#/bot/")}>
          Open
        </Button>
        <Button small icon="plus-row" onClick={() => open("#/new-bot")}>
          New bot
        </Button>
        <Button small disabled={busy || !pause} onClick={() => call("/pause", { paused: !pause?.paused })}>
          {pause?.paused ? "Resume all" : "Pause all"}
        </Button>
      </div>
    </div>
  );
}
