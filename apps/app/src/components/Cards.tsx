// Cards inside a bot's chat (Figma R3, R7, R8): what a task changed, a spending pause, and a task that
// stopped. Every button calls the same API the command line uses, so it all lands in the activity log.

import type { ApiApproval, ApiChanges, ApiFileChange, ApiRun } from "@covo/api";
import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { type LiveStep, stepText, usd, type View } from "../model.ts";
import { Icon } from "./Icon.tsx";
import { Button, Pill } from "./Pill.tsx";

/** +added −removed, from a file's diff. `long` leaves out "new"/"deleted" (the review says Added/Deleted). */
export function lineCounts(f: ApiFileChange, long = false): string {
  if (f.note === "undone") return "undone";
  if (f.note === "changed since") return "changed since";
  if (f.note) return f.note;
  if (f.kind === "added" && !f.hunks?.length) return "new";
  let add = 0;
  let del = 0;
  for (const h of f.hunks ?? [])
    for (const l of h.lines) {
      if (l.startsWith("+")) add++;
      else if (l.startsWith("-")) del++;
    }
  if (f.kind === "added") return long ? `+${add}` : `new · +${add}`;
  if (f.kind === "deleted") return long ? `−${del}` : `deleted · −${del}`;
  return [add && `+${add}`, del && `−${del}`].filter(Boolean).join(" ") || "no line changes";
}

/** The changes of one task, loaded when it reaches review or is kept, and again if that changes. */
export function useChanges(run: ApiRun | undefined): ApiChanges | null {
  const [c, setC] = useState<ApiChanges | null>(null);
  const id = run?.id;
  const state = run?.state;
  useEffect(() => {
    setC(null);
    if (!id || !(state === "REVIEWING" || state === "KEPT" || state === "ROLLED_BACK")) return;
    let live = true;
    api<ApiChanges>(`/runs/${id}/changes`)
      .then((x) => live && setC(x))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [id, state]);
  return c;
}

function FileRows({ files }: { files: ApiFileChange[] }) {
  const shown = files.slice(0, 8);
  return (
    <div className="rows">
      {shown.map((f) => (
        <div className="row" key={f.path}>
          <Icon name="file-lg" />
          <span className="t-body-m-strong grow ellipsis">{f.path}</span>
          {f.kind === "deleted" && <Pill label="Deleted" tone="warning" />}
          <span className="t-body-s muted nowrap">{f.kind === "deleted" ? "deleted" : lineCounts(f)}</span>
        </div>
      ))}
      {files.length > shown.length && (
        <div className="row">
          <span className="t-body-s muted">and {files.length - shown.length} more</span>
        </div>
      )}
    </div>
  );
}

/** R3: files changed. In review: Review, Keep all, Discard. Kept: Undo. Undone: just the list. */
export function ChangesCard({
  run,
  changes,
  go,
  onDone,
}: {
  run: ApiRun;
  changes: ApiChanges;
  go: (v: View) => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const n = changes.files.length;
  if (n === 0) return null;
  const act = async (path: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ conflicts?: { path: string }[] }>(`/runs/${run.id}/${path}`, { method: "POST", body: {} });
      if (r.conflicts?.length)
        setError(
          `Nothing was changed: you edited ${r.conflicts.map((c) => c.path).join(", ")} since. Review the changes to pick what to keep.`,
        );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      onDone();
    }
  };
  const reviewing = run.state === "REVIEWING";
  const undone = run.state === "ROLLED_BACK";
  return (
    <div className="card">
      <div className="card-head">
        <Icon name="file" />
        <span className="t-title-m grow">
          {n} file{n === 1 ? "" : "s"} changed
        </span>
        <Pill
          label={reviewing ? "Review before keeping" : undone ? "Undone" : "Kept"}
          tone={reviewing ? "accent" : "neutral"}
        />
      </div>
      <FileRows files={changes.files} />
      {error && <p className="t-body-s danger">{error}</p>}
      <div className="card-actions">
        {reviewing ? (
          <>
            <Button kind="primary" onClick={() => go({ name: "review", runId: run.id })}>
              Review changes
            </Button>
            <Button kind="secondary" icon="check-secondary" disabled={busy} onClick={() => act("keep")}>
              Keep all
            </Button>
            <Button disabled={busy} onClick={() => act("discard")}>
              Discard
            </Button>
          </>
        ) : (
          <>
            <Button kind="secondary" onClick={() => go({ name: "review", runId: run.id })}>
              See changes
            </Button>
            {!undone && (
              <Button disabled={busy} onClick={() => act("undo")}>
                Undo
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** R8: a spending pause. Approving applies only to this exact request (its hash). */
export function SpendCard({
  approval,
  go,
  onDone,
}: {
  approval: ApiApproval;
  go: (v: View) => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const s = approval.spend;
  const answer = async (decision: "approve" | "deny") => {
    setBusy(true);
    setError(null);
    try {
      await api(`/approvals/${approval.id}`, { method: "POST", body: { decision, payloadHash: approval.payloadHash } });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      onDone();
    }
  };
  return (
    <div className="card">
      <div className="card-head">
        <Icon name="dollar" />
        <span className="t-title-m grow">{s?.overDay ? "Daily limit reached" : "Task limit reached"}</span>
        {s && <Pill label={`${usd(s.spentUsd)} spent`} tone="warning" />}
      </div>
      <p className="t-body-m secondary">{approval.summary}</p>
      {error && <p className="t-body-s danger">{error}</p>}
      <div className="card-actions">
        <Button kind="primary" disabled={busy} onClick={() => answer("approve")}>
          {s ? `Allow ${usd(s.grantUsd)} more` : "Allow once"}
        </Button>
        <Button onClick={() => go({ name: "settings", tab: "spending" })}>Change limits</Button>
        <Button disabled={busy} onClick={() => answer("deny")}>
          Stop
        </Button>
      </div>
    </div>
  );
}

/** R7: a task that failed, stopped, or never started. */
export function StoppedCard({
  title,
  reason,
  run,
  onRetry,
  onDetails,
}: {
  title: string;
  reason: string;
  run?: ApiRun;
  onRetry: () => void;
  onDetails?: () => void;
}) {
  const mins =
    run?.startedAt && run.finishedAt ? Math.max(1, Math.round((run.finishedAt - run.startedAt) / 60_000)) : null;
  return (
    <div className="card">
      <div className="card-head">
        <Icon name="x" />
        <span className="t-title-m grow">{title}</span>
        <Pill label="Nothing kept" />
      </div>
      <p className="t-body-m secondary">{reason} Your files are unchanged.</p>
      {run && (
        <div className="facts">
          {run.model && (
            <div className="fact">
              <span className="t-body-s muted">Model</span>
              <span className="t-body-m">{run.model}</span>
            </div>
          )}
          <div className="fact">
            <span className="t-body-s muted">Spent</span>
            <span className="t-body-m">{usd(run.costUsd)}</span>
          </div>
          {mins !== null && (
            <div className="fact">
              <span className="t-body-s muted">Time</span>
              <span className="t-body-m">{mins} min</span>
            </div>
          )}
        </div>
      )}
      <div className="card-actions">
        <Button kind="primary" icon="refresh-primary" onClick={onRetry}>
          Try again
        </Button>
        {onDetails && <Button onClick={onDetails}>See what happened</Button>}
      </div>
    </div>
  );
}

/** The steps of a running task, newest last. */
export function LiveSteps({ steps, onStop }: { steps: LiveStep[]; onStop: () => void }) {
  const last = steps.slice(-6);
  return (
    <div className="live">
      {last.map((s) => (
        <div key={s.seq} className={`t-body-s step${s.ok ? "" : " step-bad"}`}>
          {stepText(s)}
          {s.label && !s.blocked ? <span className="muted"> · {s.label}</span> : null}
        </div>
      ))}
      <div>
        <Button small onClick={onStop}>
          Stop
        </Button>
      </div>
    </div>
  );
}
