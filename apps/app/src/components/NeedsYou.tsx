// Figma H6 "Needs you": everything waiting on you, from every bot. Each row opens the chat or the
// review where you answer it; the bot stays paused at that step until you do.

import { useState } from "react";
import { type Data, shortWhen, type View } from "../model.ts";
import { Avatar } from "./Avatar.tsx";
import { Icon } from "./Icon.tsx";
import { Pill } from "./Pill.tsx";

type Tab = "all" | "approvals" | "changes";

interface Item {
  key: string;
  kind: "approval" | "changes";
  title: string;
  sub: string;
  at: number;
  botId: string;
  open: View;
}

export function needsYou(d: Data): Item[] {
  const items: Item[] = [];
  for (const a of d.approvals) {
    const run = d.runs.find((r) => r.id === a.runId);
    if (!run) continue;
    items.push({
      key: a.id,
      kind: "approval",
      title: a.spend ? `Spend up to $${a.spend.grantUsd.toFixed(2)} more` : a.summary,
      sub: `${run.botName} · ${run.goal} · asks until ${shortWhen(a.expiresAt)}`,
      at: run.createdAt,
      botId: run.botId,
      open: { name: "bot", id: run.botId },
    });
  }
  for (const r of d.runs.filter((x) => x.state === "REVIEWING")) {
    items.push({
      key: r.id,
      kind: "changes",
      title: "Review changes",
      sub: `${r.botName} · ${r.goal}`,
      at: r.finishedAt ?? r.createdAt,
      botId: r.botId,
      open: { name: "review", runId: r.id },
    });
  }
  return items.sort((a, b) => b.at - a.at);
}

export function NeedsYou({ data, go }: { data: Data; go: (v: View) => void }) {
  const [tab, setTab] = useState<Tab>("all");
  const all = needsYou(data);
  const approvals = all.filter((i) => i.kind === "approval");
  const changes = all.filter((i) => i.kind === "changes");
  const shown = tab === "all" ? all : tab === "approvals" ? approvals : changes;
  const tabs: [Tab, string, number][] = [
    ["all", "All", all.length],
    ["approvals", "Approvals", approvals.length],
    ["changes", "Changes", changes.length],
  ];
  return (
    <section className="review" aria-label="Needs you">
      <div className="review-title">
        <h1 className="t-display">Needs you</h1>
        <p className="t-body-m muted">
          Everything waiting on you, from every bot. Each bot stays paused at that step until you answer.
        </p>
      </div>
      <div className="tabs" role="tablist">
        {tabs.map(([t, label, n]) => (
          <button
            type="button"
            role="tab"
            aria-selected={tab === t}
            key={t}
            className={tab === t ? "tab on t-body-s" : "tab t-body-s"}
            onClick={() => setTab(t)}
          >
            {label} · {n}
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <p className="t-body-m muted">Nothing needs you right now.</p>
      ) : (
        <div className="rows">
          {shown.map((i) => {
            const bot = data.bots.find((b) => b.id === i.botId);
            return (
              <button type="button" key={i.key} className="row inbox-row" onClick={() => go(i.open)}>
                {bot && <Avatar shape={bot.shape} color={bot.color} size={28} />}
                <span className="file-text grow">
                  <span className="t-body-m-strong ellipsis">{i.title}</span>
                  <span className="t-body-s muted ellipsis">{i.sub}</span>
                </span>
                {i.kind === "approval" ? <Pill label="Approval" tone="warning" /> : <Pill label="Changes" />}
                <Icon name="chevron" />
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
