import type { ApiBot } from "@covo/api";
import { approvalsOf, botLine, type Data, MAIN_BOT, runsOf, shortWhen, spendLine, type View } from "../model.ts";
import { Avatar } from "./Avatar.tsx";
import { Icon } from "./Icon.tsx";

export const LATER = "Arrives in a later update";

/** Figma "Chat sidebar": Needs you, Library, the pinned main bot, then a section per department. */
export function Sidebar({
  data,
  view,
  go,
  onHide,
}: {
  data: Data;
  view: View;
  go: (v: View) => void;
  onHide: () => void;
}) {
  const bots = data.bots.filter((b) => b.status !== "archived");
  const pinned = bots.filter((b) => b.id === MAIN_BOT);
  const sections = new Map<string, ApiBot[]>();
  for (const b of bots) {
    if (b.id === MAIN_BOT) continue;
    const list = sections.get(b.department) ?? [];
    list.push(b);
    sections.set(b.department, list);
  }
  const waiting = data.approvals.length;
  const initial = (data.me.name.trim()[0] ?? "?").toUpperCase();

  const row = (b: ApiBot) => {
    const on = view.name === "bot" && view.id === b.id;
    const badge = approvalsOf(data, b.id).length;
    const last = runsOf(data, b.id)[0];
    const when = last?.createdAt ?? b.lastRunAt;
    return (
      <button
        type="button"
        key={b.id}
        className={on ? "bot-row on" : "bot-row"}
        aria-current={on ? "page" : undefined}
        onClick={() => go({ name: "bot", id: b.id })}
      >
        <Avatar shape={b.shape} color={b.color} size={30} />
        <span className="bot-row-text">
          <span className="t-body-m-strong ellipsis">{b.name}</span>
          <span className="t-caption muted ellipsis">{botLine(data, b)}</span>
        </span>
        <span className="bot-row-meta">
          {when ? <span className="t-caption muted">{shortWhen(when)}</span> : null}
          {badge > 0 && <span className="badge t-caption">{badge}</span>}
        </span>
      </button>
    );
  };

  return (
    <aside className="sidebar" aria-label="Bots">
      <div className="sidebar-top">
        <button type="button" className="icon-btn" aria-label="Back" title="Back" onClick={() => history.back()}>
          <Icon name="back" />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Forward"
          title="Forward"
          onClick={() => history.forward()}
        >
          <Icon name="forward" />
        </button>
        <span className="grow" />
        <button type="button" className="icon-btn" aria-label="Hide sidebar" title="Hide sidebar" onClick={onHide}>
          <Icon name="panel" />
        </button>
      </div>

      <div className="workspace">
        <span className="t-title-l">Covo Bot</span>
        <Icon name="chevron-lg" />
        <span className="grow" />
        <button
          type="button"
          className="icon-btn"
          aria-label="Needs you"
          title="Needs you"
          onClick={() => go({ name: "needs-you" })}
        >
          <Icon name="bell" />
        </button>
        <button type="button" className="icon-btn" aria-label="Search" title={`Search: ${LATER}`} aria-disabled="true">
          <Icon name="search" />
        </button>
      </div>

      <button type="button" className="new-bot t-body-m" title={`New bot: ${LATER}`} aria-disabled="true">
        <Icon name="plus-row" />
        New bot
      </button>
      <span className="gap-8" />

      <button
        type="button"
        className={view.name === "needs-you" ? "nav-row on" : "nav-row"}
        onClick={() => go({ name: "needs-you" })}
      >
        <Icon name="inbox" />
        <span className="t-body-m">Needs you</span>
        {waiting > 0 && <span className="count t-caption">{waiting}</span>}
      </button>
      <button
        type="button"
        className={view.name === "library" ? "nav-row on" : "nav-row"}
        onClick={() => go({ name: "library" })}
      >
        <Icon name="folder-nav" />
        <span className="t-body-m">Library</span>
      </button>

      <div className="sidebar-bots">
        {pinned.length > 0 && (
          <>
            <div className="section t-body-m">Pinned</div>
            {pinned.map(row)}
          </>
        )}
        {[...sections].map(([dept, list]) => (
          <div key={dept} className="section-group">
            <div className="section t-body-m">
              <span className="grow">{dept}</span>
              <span className="icon-btn" title={`New section: ${LATER}`}>
                <Icon name="new-section" />
              </span>
            </div>
            {list.map(row)}
          </div>
        ))}
      </div>

      <div className="you">
        <span className="you-initial t-caption">{initial}</span>
        <span className="you-text">
          <span className="t-body-m-strong ellipsis">{data.me.name}</span>
          <span className="t-caption muted">{spendLine(data.usage)}</span>
        </span>
      </div>
    </aside>
  );
}
