// The Library: what happened, in plain words, from Covo's tamper-checked activity log;
// every task your bots ran; and the files in your workspaces. Everything here is read-only.

import type { ApiActivity, ApiActivityEntry, ApiFile } from "@covo/api";
import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { clock, type Data, dayLabel, runStatus, sameDay, shortWhen, usd, type View } from "../model.ts";
import { Avatar } from "./Avatar.tsx";
import { Icon, type IconName } from "./Icon.tsx";
import { Pill } from "./Pill.tsx";

type Tab = "activity" | "tasks" | "files";

const KIND_ICON: Record<string, IconName> = {
  blocked: "run-failed",
  money: "dollar",
  files: "file",
  tool: "file",
  engine: "terminal",
  task: "run-ok",
  routine: "clock",
  phone: "computer",
  system: "key",
  bot: "plus-small",
};

const size = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
const secs = (a: number | null, b: number | null) => (a && b ? `${Math.max(1, Math.round((b - a) / 1000))} s` : "");

export function Library({ data, go }: { data: Data; go: (v: View) => void }) {
  const [tab, setTab] = useState<Tab>("activity");
  const [blockedOnly, setBlockedOnly] = useState(false);
  const [log, setLog] = useState<ApiActivity | null>(null);
  const [files, setFiles] = useState<ApiFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reload when new activity arrives (data changes on every event from the service).
  // biome-ignore lint/correctness/useExhaustiveDependencies: data.runs signals new activity
  useEffect(() => {
    if (tab !== "activity") return;
    api<ApiActivity>(`/activity?limit=200${blockedOnly ? "&blocked=1" : ""}`)
      .then(setLog)
      .catch((e: Error) => setError(e.message));
  }, [tab, blockedOnly, data.runs]);
  useEffect(() => {
    if (tab !== "files") return;
    api<ApiFile[]>("/files")
      .then(setFiles)
      .catch((e: Error) => setError(e.message));
  }, [tab]);

  const tabs: [Tab, string][] = [
    ["activity", "Activity"],
    ["tasks", `Tasks · ${data.runs.length}`],
    ["files", "Files"],
  ];

  return (
    <section className="review" aria-label="Library">
      <div className="review-title">
        <h1 className="t-display">Library</h1>
        <p className="t-body-m muted">
          Everything your bots did, what Covo stopped, and the files they work on. Nothing here can be edited.
        </p>
      </div>
      <div className="tabs" role="tablist">
        {tabs.map(([t, label]) => (
          <button
            type="button"
            role="tab"
            aria-selected={tab === t}
            key={t}
            className={tab === t ? "tab on t-body-s" : "tab t-body-s"}
            onClick={() => setTab(t)}
          >
            {label}
          </button>
        ))}
      </div>
      {error && <p className="t-body-s danger">{error}</p>}

      {tab === "activity" && log && (
        <>
          <div className={log.verified ? "lib-proof ok" : "lib-proof bad"} role="status">
            <Icon name={log.verified ? "check-primary" : "run-failed"} />
            <span className="file-text grow">
              <span className="t-body-m-strong">
                {log.verified
                  ? "Tamper-checked: nothing was changed or removed"
                  : `Check failed at entry #${log.problemAt}`}
              </span>
              <span className="t-body-s muted">
                {log.count.toLocaleString()} entries, each sealed with a hash of the one before
                {log.head ? ` · latest #${log.head.seq} (${log.head.hash}…)` : ""}
              </span>
            </span>
            <button
              type="button"
              className={blockedOnly ? "chip on t-body-s" : "chip t-body-s"}
              onClick={() => setBlockedOnly((b) => !b)}
            >
              Stopped by Covo · {log.blockedRecent}
            </button>
          </div>
          {log.entries.length === 0 ? (
            <p className="t-body-m muted">{blockedOnly ? "Covo hasn't had to stop anything." : "Nothing yet."}</p>
          ) : (
            <ActivityList entries={log.entries} />
          )}
        </>
      )}

      {tab === "tasks" &&
        (data.runs.length === 0 ? (
          <p className="t-body-m muted">No tasks yet. Ask a bot something in its chat.</p>
        ) : (
          <div className="rows">
            {data.runs.map((r) => {
              const bot = data.bots.find((b) => b.id === r.botId);
              const st = runStatus(r);
              const reviewable = r.state === "REVIEWING" || r.state === "KEPT";
              return (
                <button
                  type="button"
                  key={r.id}
                  className="row inbox-row"
                  onClick={() => go(reviewable ? { name: "review", runId: r.id } : { name: "bot", id: r.botId })}
                >
                  {bot && <Avatar shape={bot.shape} color={bot.color} size={28} />}
                  <span className="file-text grow">
                    <span className="t-body-m-strong ellipsis">{r.goal}</span>
                    <span className="t-body-s muted ellipsis">
                      {[
                        r.botName,
                        r.model,
                        shortWhen(r.createdAt),
                        secs(r.startedAt, r.finishedAt),
                        r.tokensIn + r.tokensOut ? `${(r.tokensIn + r.tokensOut).toLocaleString()} tokens` : "",
                        r.costUsd ? usd(r.costUsd) : "",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                  <Pill label={st.pill} tone={st.warning ? "warning" : r.state === "FAILED" ? undefined : "success"} />
                  <Icon name="chevron" />
                </button>
              );
            })}
          </div>
        ))}

      {tab === "files" &&
        files &&
        (files.length === 0 ? (
          <p className="t-body-m muted">Your workspaces are empty.</p>
        ) : (
          <div className="rows">
            {files.map((f) => (
              <div className="row" key={`${f.workspace}/${f.path}`}>
                <Icon name="file" />
                <span className="file-text grow">
                  <span className="t-body-m ellipsis">{f.path}</span>
                  <span className="t-body-s muted">
                    {f.workspace} · {size(f.bytes)} · changed {shortWhen(f.modifiedAt)}
                  </span>
                </span>
              </div>
            ))}
          </div>
        ))}
    </section>
  );
}

/** Entries by day, newest first. */
function ActivityList({ entries }: { entries: ApiActivityEntry[] }) {
  const out: React.ReactNode[] = [];
  let day: number | null = null;
  for (const e of entries) {
    if (day === null || !sameDay(day, e.ts)) {
      day = e.ts;
      out.push(
        <span key={`d${e.seq}`} className="t-overline muted lib-day">
          {dayLabel(e.ts)}
        </span>,
      );
    }
    out.push(
      <div key={e.seq} className={e.blocked ? "row lib-row stopped" : "row lib-row"}>
        <span className="t-mono-s muted lib-time">{clock(e.ts)}</span>
        <Icon name={KIND_ICON[e.blocked ? "blocked" : e.kind] ?? "dot"} />
        <span className="t-body-m grow lib-text">{e.text}</span>
        <span className="t-mono-s muted">#{e.seq}</span>
      </div>,
    );
  }
  return <div className="rows">{out}</div>;
}
