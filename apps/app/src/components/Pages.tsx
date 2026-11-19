import type { ApiApproval } from "@covo/api";
import { useState } from "react";
import { api } from "../api.ts";
import { type Data, shortWhen, type View } from "../model.ts";
import type { ThemeChoice } from "../theme.ts";
import { Avatar } from "./Avatar.tsx";
import { Pill } from "./Pill.tsx";

function Page({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="page" aria-label={title}>
      <header className="chat-header">
        <span className="t-title-m">{title}</span>
      </header>
      <div className="page-body">{children}</div>
    </section>
  );
}

/** Everything waiting for you. An answer applies only to the exact request shown (payloadHash). */
export function NeedsYou({ data, refresh, go }: { data: Data; refresh: () => void; go: (v: View) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const runOf = (a: ApiApproval) => data.runs.find((r) => r.id === a.runId);
  const answer = async (a: ApiApproval, decision: "approve" | "deny") => {
    setBusy(a.id);
    setError(null);
    try {
      await api(`/approvals/${a.id}`, { method: "POST", body: { decision, payloadHash: a.payloadHash } });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
      refresh();
    }
  };
  return (
    <Page title="Needs you">
      {error && (
        <p className="composer-error t-body-s" role="alert">
          {error}
        </p>
      )}
      {data.approvals.length === 0 ? (
        <p className="t-body-m muted">Nothing needs you right now.</p>
      ) : (
        data.approvals.map((a) => {
          const run = runOf(a);
          return (
            <div className="card" key={a.id}>
              <div className="card-head">
                <span className="t-title-m grow">{a.summary}</span>
                <Pill label="Needs your OK" tone="warning" />
              </div>
              {run && (
                <button type="button" className="link t-body-s" onClick={() => go({ name: "bot", id: run.botId })}>
                  {run.botName}: {run.goal}
                </button>
              )}
              <p className="t-body-s muted">
                Asks until {shortWhen(a.expiresAt)}. If nobody answers, the answer is no.
              </p>
              <div className="card-actions">
                <button
                  type="button"
                  className="btn btn-primary t-body-m-strong"
                  disabled={busy === a.id}
                  onClick={() => answer(a, "approve")}
                >
                  Allow once
                </button>
                <button
                  type="button"
                  className="btn btn-ghost t-body-m-strong"
                  disabled={busy === a.id}
                  onClick={() => answer(a, "deny")}
                >
                  Deny
                </button>
              </div>
            </div>
          );
        })
      )}
    </Page>
  );
}

export function Later({ title, what }: { title: string; what: string }) {
  return (
    <Page title={title}>
      <p className="t-body-m muted">{what}</p>
    </Page>
  );
}

export function Settings({
  choice,
  choose,
  onSignOut,
}: {
  choice: ThemeChoice;
  choose: (c: ThemeChoice) => void;
  onSignOut: () => void;
}) {
  const options: [ThemeChoice, string][] = [
    ["system", "Match this Mac"],
    ["light", "Light"],
    ["dark", "Dark"],
  ];
  return (
    <Page title="Settings">
      <h2 className="t-title-m">Appearance</h2>
      <fieldset className="segmented" aria-label="Theme">
        {options.map(([c, label]) => (
          <button
            type="button"
            aria-pressed={choice === c}
            key={c}
            className={choice === c ? "seg on t-body-s" : "seg t-body-s"}
            onClick={() => choose(c)}
          >
            {label}
          </button>
        ))}
      </fieldset>
      <h2 className="t-title-m">This browser</h2>
      <p className="t-body-s muted">
        You're signed in to Covo on this Mac. Signing out ends this browser's session; open the app again with covo app.
      </p>
      <div>
        <button type="button" className="btn btn-ghost bordered t-body-m-strong" onClick={onSignOut}>
          Sign out
        </button>
      </div>
      <p className="t-body-s muted">
        Models, limits and the power profile get their screens in the next update. For now: covo models, covo limits and
        covo profile.
      </p>
    </Page>
  );
}

/** Shown before sign-in, or when the service can't be reached. */
export function Gatekeeper({ state }: { state: "loading" | "expired" | "signed-out" | "down" }) {
  const text = {
    loading: "Opening Covo…",
    expired: "That sign-in link has expired or was already used. Run covo app again.",
    "signed-out": "To open Covo, run this in your terminal: covo app",
    down: "Covo's service isn't answering. Start it with: covo service install",
  }[state];
  return (
    <main className="gate">
      <Avatar shape="Blob" color="sky" size={64} />
      <h1 className="t-title-l">Covo</h1>
      <p className="t-body-m muted" role={state === "loading" ? undefined : "status"}>
        {text}
      </p>
    </main>
  );
}
