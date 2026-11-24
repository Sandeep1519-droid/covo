// Your own AI plans in Settings → AI models (Phase 4 M1, Figma S2; docs/SUBSCRIPTIONS.md):
// - programs that use your plan, Claude Code and Codex: Get (the maker's own installer), Sign in (the
//   program's own sign-in, in your browser), Connect (after the notice);
// - ChatGPT Go, Plus, Pro or Business through OpenAI's "Sign in with ChatGPT". Its wording follows
//   OpenAI's rules: the button says "Continue with ChatGPT", and "Manage usage" goes to ChatGPT;
// - Google's plans, which other apps may not use: a free Gemini key instead.

import type { ApiEngine, ApiRoutineSettings, ApiSubscriptions } from "@covo/api";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { inMacApp } from "../shell.ts";
import { Icon } from "./Icon.tsx";
import { Button, Pill, Toggle } from "./Pill.tsx";

/** "your Claude plan" / "your ChatGPT plan", and the account you sign in with. */
const planOf = (e: ApiEngine) => (e.maker === "OpenAI" ? "ChatGPT" : "Claude");
const tilde = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");

export function SubscriptionRows({
  refresh,
  onAddKey,
}: {
  refresh: () => void;
  onAddKey?: (provider: string) => void;
}) {
  const [s, setS] = useState<ApiSubscriptions | null>(null);
  const [routines, setRoutines] = useState<ApiRoutineSettings | null>(null);
  /** The engine whose notice you're reading before Connect. */
  const [agreeing, setAgreeing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The sign-in link, when the browser blocked the new tab: you click it yourself. */
  const [link, setLink] = useState<string | null>(null);
  const checked = useRef(new Set<string>());

  const load = useCallback(async () => {
    try {
      setS(await api<ApiSubscriptions>("/subscriptions"));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const call = useCallback(
    async (path: string, method = "POST", body: Record<string, unknown> = {}) => {
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
    },
    [refresh],
  );

  useEffect(() => {
    void load();
    api<ApiRoutineSettings>("/routine-settings")
      .then(setRoutines)
      .catch(() => {});
  }, [load]);

  // While something waits (an install, a sign-in in your browser), look again every two seconds.
  const waiting = Boolean(s && (s.chatgpt.signingIn || s.engines.some((e) => e.installing || e.signingIn)));
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => void load(), 2_000);
    return () => clearInterval(t);
  }, [waiting, load]);

  // Once per visit: ask each installed program whether you're signed in (`claude auth status`…).
  useEffect(() => {
    for (const e of s?.engines ?? []) {
      if (!e.path || e.connected || e.signedIn !== null || e.installing || e.signingIn) continue;
      if (checked.current.has(e.id)) continue;
      checked.current.add(e.id);
      void call(`/subscriptions/${e.id}/check`);
    }
  }, [s, call]);

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
  const agreeTo = s.engines.find((e) => e.id === agreeing);

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
        {s.engines.map((e) => (
          <EngineRow
            key={e.id}
            e={e}
            busy={busy}
            agreeing={agreeing === e.id}
            onAgree={() => setAgreeing(e.id)}
            call={call}
          />
        ))}

        <div className="row">
          <Icon name="key" />
          <span className="file-text grow">
            <span className="t-body-m-strong">
              {gpt.connected ? "ChatGPT plan" : "Use your ChatGPT plan (Sign in with ChatGPT)"}
            </span>
            <span className="t-body-s muted">
              {gpt.connected
                ? (gpt.email ?? "Signed in")
                : gpt.signingIn
                  ? "Finish signing in in your browser; this page updates by itself. If OpenAI says a required permission is unavailable, your plan can't be shared this way: use Codex above, which works with every plan."
                  : "For ChatGPT Go, Plus, Pro or Business. Complete eligible AI requests in this app with usage included in your ChatGPT plan or credits balance."}
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
                    onChange={(ev) => void call("/subscriptions/chatgpt", "PUT", { model: ev.target.value })}
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
          <Icon name="key" />
          <span className="file-text grow">
            <span className="t-body-m-strong">Google AI Pro or Ultra</span>
            <span className="t-body-s muted">
              Google doesn't let other apps use these plans. A free Gemini API key works instead.
            </span>
          </span>
          {onAddKey && (
            <Button small onClick={() => onAddKey("gemini")}>
              Add a free key
            </Button>
          )}
        </div>
      </div>
      {agreeTo && (
        <div className="card">
          <span className="t-title-m">Covo will run {agreeTo.label} to do tasks</span>
          <ul className="notice t-body-s secondary">
            {agreeTo.notice.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="t-body-s muted">The terms we checked are in docs/SUBSCRIPTIONS.md.</p>
          <div className="card-actions">
            <Button
              kind="primary"
              disabled={busy}
              onClick={async () => {
                if (await call(`/subscriptions/${agreeTo.id}`, "POST", { accept: true })) setAgreeing(null);
              }}
            >
              Use my {planOf(agreeTo)} plan
            </Button>
            <Button onClick={() => setAgreeing(null)}>Cancel</Button>
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
                } catch (err) {
                  setError((err as Error).message);
                }
              }}
            />
          </div>
        </div>
      )}
    </>
  );
}

/** One program that uses your plan: Get → Sign in → Connect. */
/** For a sign-in page that shows a code instead of finishing by itself: paste it here. */
function CodeBox({ onSend }: { onSend: (code: string) => Promise<boolean> }) {
  const [code, setCode] = useState("");
  return (
    <form
      className="code-box"
      onSubmit={(ev) => {
        ev.preventDefault();
        if (code.trim()) void onSend(code.trim()).then((ok) => ok && setCode(""));
      }}
    >
      <input
        className="input t-body-s"
        placeholder="Page shows a code? Paste it here"
        aria-label="Sign-in code from the page"
        autoComplete="off"
        spellCheck={false}
        value={code}
        onChange={(ev) => setCode(ev.target.value)}
      />
      <Button small type="submit" disabled={!code.trim()}>
        Send
      </Button>
    </form>
  );
}

function EngineRow({
  e,
  busy,
  agreeing,
  onAgree,
  call,
}: {
  e: ApiEngine;
  busy: boolean;
  agreeing: boolean;
  onAgree: () => void;
  call: (path: string, method?: string, body?: Record<string, unknown>) => Promise<boolean>;
}) {
  const plan = planOf(e);
  const base = `/subscriptions/${e.id}`;
  const canSignIn = Boolean(e.path) && (e.signedIn === false || e.method === "api_key");

  let line: string;
  if (e.connected) line = `Uses your ${plan} plan, through ${e.label} on this Mac`;
  else if (e.installing) line = `Getting ${e.label} from ${e.maker}… ${e.step ?? ""}`.trim();
  else if (e.signingIn) line = `Finish signing in on ${e.maker}'s page in your browser. This updates by itself.`;
  else if (!e.path)
    line = `${e.maker === "OpenAI" ? "Works with every ChatGPT plan, Free included." : "For Claude Pro, Max or Ultra."} Covo gets it with ${e.maker}'s own installer (about ${e.downloadMb} MB).`;
  else if (e.signedIn === null) line = busy ? "Checking whether you're signed in…" : `Installed at ${tilde(e.path)}`;
  else if (!e.signedIn)
    line = `Installed. Sign in with your ${plan} account${e.maker === "OpenAI" ? " (any plan, Free included)" : " (Claude Pro, Max or Ultra)"}.`;
  else if (e.method === "api_key")
    line = `Signed in with an API key, which would bill that key, not your plan. Sign in with your ${plan} account instead.`;
  else line = `Signed in · ready to use your ${plan} plan`;

  return (
    <>
      <div className="row">
        <Icon name="terminal" />
        <span className="file-text grow">
          <span className="t-body-m-strong">
            Use your {plan} plan ({e.label})
          </span>
          <span className="t-body-s muted">{line}</span>
          {e.signingIn && e.url && (
            <a className="link t-body-s" href={e.url} target="_blank" rel="noreferrer">
              Browser didn't open? Open {e.maker}'s sign-in page
            </a>
          )}
          {e.signingIn && e.codePrompt && <CodeBox onSend={(code) => call(`${base}/code`, "POST", { code })} />}
        </span>
        {e.connected ? (
          <>
            <Pill label="Connected" tone="success" />
            <Button small disabled={busy} onClick={() => void call(base, "DELETE")}>
              {e.maker === "OpenAI" ? "Sign out" : "Remove"}
            </Button>
          </>
        ) : e.installing || e.signingIn ? (
          <Button small onClick={() => void call(`${base}/cancel`)}>
            Cancel
          </Button>
        ) : !e.path ? (
          <Button kind="secondary" small disabled={busy} onClick={() => void call(`${base}/install`)}>
            Get {e.label}
          </Button>
        ) : canSignIn ? (
          <Button kind="secondary" small disabled={busy} onClick={() => void call(`${base}/sign-in`)}>
            Sign in
          </Button>
        ) : e.signedIn ? (
          <Button kind="secondary" small disabled={busy || agreeing} onClick={onAgree}>
            Connect
          </Button>
        ) : (
          <Button small disabled={busy} onClick={() => void call(`${base}/check`)}>
            Check again
          </Button>
        )}
      </div>
      {e.error && !e.installing && !e.signingIn && (
        <div className="row">
          <span className="t-body-s danger">{e.error}</span>
        </div>
      )}
    </>
  );
}
