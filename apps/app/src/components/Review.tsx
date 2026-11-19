// Figma R4 "Review changes": what a task changed, file by file, with a line diff. In review you pick
// which files to keep; a kept task can be undone. Also shows the steps a task took ("See what happened").

import type { ApiChanges, ApiFileChange, ApiRunDetail } from "@covo/api";
import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { type Data, runStatus, usd, type View } from "../model.ts";
import { lineCounts } from "./Cards.tsx";
import { Icon } from "./Icon.tsx";
import { Button, Pill, Toggle } from "./Pill.tsx";

export function Review({
  data,
  runId,
  tick,
  go,
  refresh,
}: {
  data: Data;
  runId: string;
  tick: number;
  go: (v: View) => void;
  refresh: () => void;
}) {
  const [detail, setDetail] = useState<ApiRunDetail | null>(null);
  const [changes, setChanges] = useState<ApiChanges | null>(null);
  const [keep, setKeep] = useState<Set<string>>(new Set());
  const [viewing, setViewing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload on updates from the service
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const d = await api<ApiRunDetail>(`/runs/${runId}`);
        if (!live) return;
        setDetail(d);
        const c = await api<ApiChanges>(`/runs/${runId}/changes`).catch(() => null);
        if (!live) return;
        setChanges(c);
        if (c) {
          // Deleted files start unticked: a deletion is the change most worth a second look.
          setKeep((k) => (k.size ? k : new Set(c.files.filter((f) => f.kind !== "deleted").map((f) => f.path))));
          setViewing((v) => v ?? c.files[0]?.path ?? null);
        }
      } catch (e) {
        if (live) setError((e as Error).message);
      }
    })();
    return () => {
      live = false;
    };
  }, [runId, tick]);

  if (error && !detail) return <Page>{<p className="t-body-m danger">{error}</p>}</Page>;
  if (!detail) return <Page>{null}</Page>;

  const bot = data.bots.find((b) => b.id === detail.botId);
  const files = changes?.files ?? [];
  const reviewing = detail.state === "REVIEWING";
  const kept = detail.state === "KEPT";
  const conflicts = files.filter((f) => f.workspaceChanged).length;
  const shown = files.find((f) => f.path === viewing);

  const act = async (path: string, body: unknown = {}, done?: string) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const r = await api<{ conflicts?: { path: string }[] }>(`/runs/${runId}/${path}`, { method: "POST", body });
      if (r.conflicts?.length)
        setError(`Nothing was changed: you edited ${r.conflicts.map((c) => c.path).join(", ")} since.`);
      else if (done) setNote(done);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const subtitle = reviewing
    ? `${detail.botName} changed ${files.length} file${files.length === 1 ? "" : "s"} in a safe copy. Nothing is in your files yet.`
    : kept
      ? `${detail.botName} changed ${files.length} file${files.length === 1 ? "" : "s"}, and they're in your files. Undo puts them back.`
      : runStatus(detail).text;

  return (
    <Page>
      <div className="review-head">
        <div className="review-title">
          <button
            type="button"
            className="back t-caption muted"
            onClick={() => (bot ? go({ name: "bot", id: bot.id }) : history.back())}
          >
            <Icon name="back" />
            {detail.botName}
          </button>
          <h1 className="t-display">{reviewing ? "Review changes" : files.length ? "Changes" : "What happened"}</h1>
          <p className="t-body-m muted">{subtitle}</p>
        </div>
        {reviewing && (
          <>
            <Button kind="danger" disabled={busy} onClick={() => act("discard", {}, "Thrown away.")}>
              Discard all
            </Button>
            <Button
              kind="secondary"
              disabled={busy || keep.size === 0}
              onClick={() => act("keep", { only: [...keep] }, "Kept the files you picked.")}
            >
              Keep selected
            </Button>
            <Button kind="primary" icon="check-primary" disabled={busy} onClick={() => act("keep", {}, "Kept.")}>
              Keep all changes
            </Button>
          </>
        )}
        {kept && (
          <Button
            kind="secondary"
            disabled={busy}
            onClick={() => act("undo", {}, "Undone: your files are back as they were.")}
          >
            Undo
          </Button>
        )}
      </div>
      {error && <p className="t-body-s danger">{error}</p>}
      {note && <p className="t-body-s muted">{note}</p>}

      {files.length > 0 && (
        <div className="stats">
          <Stat label="Modified" value={changes?.modified ?? 0} />
          <Stat label="Added" value={changes?.added ?? 0} />
          <Stat
            label="Deleted"
            value={changes?.deleted ?? 0}
            tone={changes?.deleted ? "warning" : undefined}
            note={changes?.deleted && reviewing ? "check before keeping" : undefined}
          />
          <Stat
            label="Conflicts"
            value={conflicts}
            tone={conflicts ? "warning" : "success"}
            note={conflicts ? "you changed these files since" : "nobody else changed these files"}
          />
        </div>
      )}

      <div className="review-body">
        {files.length > 0 && (
          <div className="panel">
            <span className="t-title-m">Files</span>
            <div className="rows">
              {files.map((f) => (
                <div className="row file-row" key={f.path}>
                  <button type="button" className="file-pick" onClick={() => setViewing(f.path)}>
                    <Icon name="file-lg" />
                    <span className="file-text">
                      <span className="t-body-m-strong ellipsis">{f.path}</span>
                      <span className="t-body-s muted">
                        {KIND[f.kind]} · {lineCounts(f, true)}
                      </span>
                    </span>
                  </button>
                  {viewing === f.path && <Pill label="Viewing" tone="accent" />}
                  {f.kind === "deleted" && <Pill label="Deleted" tone="warning" />}
                  {reviewing && (
                    <Toggle
                      label={`Keep ${f.path}`}
                      on={keep.has(f.path)}
                      onChange={(on) =>
                        setKeep((k) => {
                          const n = new Set(k);
                          if (on) n.add(f.path);
                          else n.delete(f.path);
                          return n;
                        })
                      }
                    />
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="panel">
          {shown ? (
            <>
              <span className="t-title-m">{shown.path}</span>
              <Diff file={shown} />
            </>
          ) : (
            <Steps detail={detail} />
          )}
        </div>
      </div>
      {files.length > 0 && (
        <div className="panel">
          <Steps detail={detail} />
        </div>
      )}
    </Page>
  );
}

const KIND: Record<ApiFileChange["kind"], string> = { added: "Added", modified: "Modified", deleted: "Deleted" };

function Page({ children }: { children: React.ReactNode }) {
  return (
    <section className="review" aria-label="Review changes">
      {children}
    </section>
  );
}

function Stat({
  label,
  value,
  tone,
  note,
}: {
  label: string;
  value: number;
  tone?: "warning" | "success";
  note?: string | undefined;
}) {
  return (
    <div className="stat">
      <span className="t-caption muted">{label}</span>
      <span className={`t-title-l${tone ? ` ${tone}` : ""}`}>{value}</span>
      {note && <span className="t-body-s muted">{note}</span>}
    </div>
  );
}

function Diff({ file }: { file: ApiFileChange }) {
  if (!file.hunks?.length)
    return <p className="t-body-s muted">{file.note ? `No line view: ${file.note}.` : "No text changes to show."}</p>;
  return (
    <div className="diff">
      {file.hunks.map((h, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: hunks have no id and never reorder
        <div key={i}>
          {i > 0 && <div className="diff-line diff-gap">⋯</div>}
          {h.lines.map((l, j) => {
            const kind = l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : l.startsWith("\\") ? "note" : "same";
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: lines of a diff are positional
              <div key={j} className={`diff-line diff-${kind}`}>
                <span className="diff-mark">{kind === "add" ? "+" : kind === "del" ? "-" : " "}</span>
                <span className="diff-text">{kind === "note" ? l : l.slice(1)}</span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function Steps({ detail }: { detail: ApiRunDetail }) {
  const tools = detail.steps.filter((s) => s.kind === "tool");
  return (
    <>
      <span className="t-title-m">Steps</span>
      <div className="facts">
        <div className="fact">
          <span className="t-body-s muted">Task</span>
          <span className="t-body-m">{detail.goal}</span>
        </div>
        {detail.model && (
          <div className="fact">
            <span className="t-body-s muted">Model</span>
            <span className="t-body-m">{detail.model}</span>
          </div>
        )}
        <div className="fact">
          <span className="t-body-s muted">Spent</span>
          <span className="t-body-m">{usd(detail.costUsd)}</span>
        </div>
        {detail.error && (
          <div className="fact">
            <span className="t-body-s muted">Why it stopped</span>
            <span className="t-body-m">{detail.error}</span>
          </div>
        )}
      </div>
      {tools.length === 0 ? (
        <p className="t-body-s muted">No steps were taken.</p>
      ) : (
        <ol className="step-list t-body-s">
          {tools.map((s) => (
            <li key={s.seq} className={s.decision === "deny" ? "step-bad" : ""}>
              <code>{s.tool}</code> {argsText(s.args)}
              {s.decision === "deny" && <span className="danger"> · blocked</span>}
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

function argsText(args: string | null): string {
  if (!args) return "";
  try {
    const a = JSON.parse(args) as Record<string, unknown>;
    const v = a.path ?? a.command ?? a.pattern ?? a.summary;
    return typeof v === "string" ? v.slice(0, 120) : "";
  } catch {
    return "";
  }
}
