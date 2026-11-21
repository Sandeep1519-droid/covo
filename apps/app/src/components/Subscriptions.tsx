// Your own AI plans in Settings → AI models (Phase 4 M1, Figma S2): ChatGPT Plus or Pro through
// OpenAI's "Sign in with ChatGPT", and Claude Pro or Max through the Claude Code program on this Mac.
// The wording follows OpenAI's rules for Sign in with ChatGPT: the button says "Continue with
// ChatGPT", and "Manage usage" goes to ChatGPT's own usage page.

import type { ApiRoutineSettings, ApiSubscriptions } from "@covo/api";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { inMacApp } from "../shell.ts";
import { Icon } from "./Icon.tsx";
import { Button, Pill, Toggle } from "./Pill.tsx";

const CLAUDE_NOTICE = [
  "You sign in with Claude Code itself. Covo never sees, copies or stores your sign-in.",
  "Tasks count toward your plan's usage limits. When you hit one, the bot's next model takes over.",
  "Claude Code works on Covo's copy of your files, with file tools only (no shell, no web).",
  "Covo's spending limits don't apply: a subscription is a flat fee.",
];

export function SubscriptionRows({ refresh }: { refresh: () => void }) {
  const [s, setS] = useState<ApiSubscriptions | null>(null);
  const [routines, setRoutines] = useState<ApiRoutineSettings | null>(null);
  const [agreeing, setAgreeing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  /** The sign-in link, when the browser blocked the new tab: you click it yourself. */
  const [link, setLink] = useState<string | null>(null);
  const checked = useRef(false);

  const load = useCallback(async () => {
    try {
      setS(await api<ApiSubscriptions>("/subscriptions"));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const call = async (path: string, method = "POST", body: Record<string, unknown> = {}) => {
    setBusy(true);
    setError(null);
    try {
      setS(await api<ApiSubscriptions>(path, { method, ...(method === "DELETE" ? {} : { body }) }));
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
      refresh();
    }
  };

  useEffect(() => {
    void load();
    api<ApiRoutineSettings>("/routine-settings")
      .then(setRoutines)
      .catch(() => {});
  }, [load]);

  // While the sign-in waits for you in your browser, look again every two seconds.
  useEffect(() => {
    if (!s?.chatgpt.signingIn) return;
    const t = setInterval(() => void load(), 2_000);
    return () => clearInterval(t);
  }, [s?.chatgpt.signingIn, load]);

  // Once per visit: ask Claude Code whether you're signed in (it runs `claude auth status`).
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when Claude Code is found
  useEffect(() => {
    if (!s?.claudeCode.path || s.claudeCode.connected || checked.current) return;
    checked.current = true;
    void call("/subscriptions/claude-code/check");
  }, [s?.claudeCode.path]);

  const continueWithChatGPT = async () => {
    setError(null);
    // A browser lets a page open a tab only right after your click, so open it now and point it at
    // OpenAI once Covo has the link. The Mac app sends the link to your default browser instead.
    const tab = inMacApp() ? null : window.open("", "_blank");
    if (tab) tab.opener = null;
    try {
      const r = await api<{ url: string }>("/subscriptions/chatgpt", { method: "POST", body: {} });
      if (tab) tab.location.href = r.url;
      else if (inMacApp())
        window.open(r.url, "_blank"); // the Mac app hands it to your browser
      else if (!window.open(r.url, "_blank")) setLink(r.url);
      await load();
    } catch (e) {
      tab?.close();
      setError((e as Error).message);
    }
  };

  if (!s) return error ? <p className="t-body-s danger">{error}</p> : null;
  const gpt = s.chatgpt;
  const cc = s.claudeCode;

  let ccLine: string;
  if (cc.connected) ccLine = "Uses your Claude subscription, through Claude Code on this Mac";
  else if (!cc.path) ccLine = "Claude Code isn't installed. Install it, then sign in with your Claude account:";
  else if (cc.signedIn === null) ccLine = busy ? "Checking whether you're signed in…" : `Found at ${cc.path}`;
  else if (!cc.signedIn) ccLine = `Found, but not signed in. In Terminal, run: ${cc.signIn}`;
  else if (cc.method === "api_key")
    ccLine = `Signed in with an API key, which would bill that key, not your plan. Sign in with your Claude account: ${cc.signIn}`;
  else ccLine = "Signed in · ready to use your Claude Pro or Max plan";

  return (
    <>
      {gpt.connected && !gpt.welcomed && (
        <div className="card" role="status">
          <span className="t-title-m">You're using your ChatGPT plan</span>
          <p className="t-body-m secondary">
            Eligible usage in this app uses your ChatGPT plan. Manage usage in your ChatGPT settings.
          </p>
          <div className="card-actions">
            <Button kind="primary" onClick={() => void call("/subscriptions/chatgpt/welcomed")}>
              Got it
            </Button>
            <a className="link t-body-s" href={gpt.manageUsageUrl} target="_blank" rel="noreferrer">
              Manage usage
            </a>
          </div>
        </div>
      )}
      <div className="rows">
        <div className="row">
          <Icon name="key" />
          <span className="file-text grow">
            <span className="t-body-m-strong">{gpt.connected ? "ChatGPT plan" : "Use your ChatGPT plan"}</span>
            <span className="t-body-s muted">
              {gpt.connected
                ? (gpt.email ?? "Signed in")
                : gpt.signingIn
                  ? "Finish signing in in your browser; this page updates by itself. If OpenAI says a required permission is unavailable, your account needs an active Plus or Pro plan."
                  : "Complete eligible AI requests in this app with usage included in your ChatGPT plan or credits balance."}
            </span>
            {gpt.signingIn && link && (
              <a className="link t-body-s" href={link} target="_blank" rel="noreferrer" onClick={() => setLink(null)}>
                Your browser didn't open a new tab. Open OpenAI's sign-in page
              </a>
            )}
            {gpt.connected && (
              <span className="t-body-s muted sub-actions">
                {gpt.models.length > 1 ? (
                  <select
                    className="t-body-s plan-model"
                    aria-label="ChatGPT model"
                    value={gpt.model ?? ""}
                    onChange={(e) => void call("/subscriptions/chatgpt", "PUT", { model: e.target.value })}
                  >
                    {gpt.models.map((m) => (
                      <option key={m.slug} value={m.slug}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span>{gpt.model}</span>
                )}
                {" · "}
                <a href={gpt.manageUsageUrl} target="_blank" rel="noreferrer">
                  Manage usage
                </a>
              </span>
            )}
          </span>
          {gpt.connected ? (
            <>
              <Pill label="Connected" tone="success" />
              <Button small disabled={busy} onClick={() => void call("/subscriptions/chatgpt", "DELETE")}>
                Sign out
              </Button>
            </>
          ) : gpt.signingIn ? (
            <Button small onClick={() => void call("/subscriptions/chatgpt/cancel")}>
              Cancel
            </Button>
          ) : (
            <Button kind="secondary" small disabled={busy} onClick={() => void continueWithChatGPT()}>
              Continue with ChatGPT
            </Button>
          )}
        </div>
        {gpt.error && !gpt.signingIn && (
          <div className="row">
            <span className="t-body-s danger">{gpt.error}</span>
          </div>
        )}

        <div className="row">
          <Icon name="terminal" />
          <span className="file-text grow">
            <span className="t-body-m-strong">Use your Claude plan (Claude Code)</span>
            <span className="t-body-s muted">{ccLine}</span>
            {!cc.path && (
              <span className="install-line">
                <code className="t-mono-s">{cc.install}</code>
                <Button
                  small
                  onClick={() => {
                    void navigator.clipboard?.writeText(cc.install).then(() => setCopied(true));
                  }}
                >
                  {copied ? "Copied" : "Copy"}
                </Button>
                <span className="t-body-s muted">then</span>
                <code className="t-mono-s">{cc.signIn}</code>
              </span>
            )}
          </span>
          {cc.connected ? (
            <>
              <Pill label="Connected" tone="success" />
              <Button small disabled={busy} onClick={() => void call("/subscriptions/claude-code", "DELETE")}>
                Remove
              </Button>
            </>
          ) : cc.path && cc.signedIn && cc.method !== "api_key" ? (
            <Button kind="secondary" small disabled={busy || agreeing} onClick={() => setAgreeing(true)}>
              Connect
            </Button>
          ) : (
            <Button small disabled={busy} onClick={() => void call("/subscriptions/claude-code/check")}>
              Check again
            </Button>
          )}
        </div>
      </div>
      {agreeing && (
        <div className="card">
          <span className="t-title-m">Covo will run your Claude Code program to do tasks</span>
          <ul className="notice t-body-s secondary">
            {CLAUDE_NOTICE.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="t-body-s muted">The terms we checked are in docs/SUBSCRIPTIONS.md.</p>
          <div className="card-actions">
            <Button
              kind="primary"
              disabled={busy}
              onClick={async () => {
                if (await call("/subscriptions/claude-code", "POST", { accept: true })) setAgreeing(false);
              }}
            >
              Use my Claude plan
            </Button>
            <Button onClick={() => setAgreeing(false)}>Cancel</Button>
          </div>
        </div>
      )}
      {error && (
        <p className="t-body-s danger" role="alert">
          {error}
        </p>
      )}
      {routines && (
        <div className="rows">
          <div className="row">
            <span className="file-text grow">
              <span className="t-body-m-strong">Let scheduled routines use your subscriptions</span>
              <span className="t-body-s muted">Off by default. Check your provider's terms first.</span>
            </span>
            <Toggle
              label="Let scheduled routines use your subscriptions"
              on={routines.subscriptions}
              onChange={async (on) => {
                try {
                  setRoutines(
                    await api<ApiRoutineSettings>("/routine-settings", { method: "PUT", body: { subscriptions: on } }),
                  );
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            />
          </div>
        </div>
      )}
    </>
  );
}
