// Figma S1, S2, S6, S7: Settings as a window over the app. General (theme, this browser), AI models and
// keys (a key goes straight to the Keychain and is never shown again), Spending (limits and what was
// spent), and Computer (this Mac's power profile and the activity log check).

import type { ApiHealth, ApiLimits, ApiModel, ApiProfile, ApiProvider, ApiUsage } from "@covo/api";
import { useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { type Data, type SettingsTab, usd } from "../model.ts";
import type { ThemeChoice } from "../theme.ts";
import { Icon, type IconName } from "./Icon.tsx";
import { Button, Pill } from "./Pill.tsx";
import { SubscriptionRows } from "./Subscriptions.tsx";

const TABS: [SettingsTab, string, IconName][] = [
  ["general", "General", "tab-general"],
  ["models", "AI models and keys", "tab-models"],
  ["spending", "Spending", "tab-spending"],
  ["computer", "Computer", "tab-computer"],
];

export function SettingsWindow({
  tab,
  setTab,
  close,
  data,
  refresh,
  choice,
  choose,
  onSignOut,
}: {
  tab: SettingsTab;
  setTab: (t: SettingsTab) => void;
  close: () => void;
  data: Data;
  refresh: () => void;
  choice: ThemeChoice;
  choose: (c: ThemeChoice) => void;
  onSignOut: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);
  const title = TABS.find(([t]) => t === tab)?.[1] ?? "Settings";
  return (
    <div className="overlay">
      <button type="button" className="overlay-close" aria-label="Close settings" tabIndex={-1} onClick={close} />
      <div className="settings" role="dialog" aria-modal="true" aria-label="Settings" tabIndex={-1} ref={box}>
        <nav className="settings-nav" aria-label="Settings">
          <span className="t-title-m">Settings</span>
          <span className="gap-12" />
          {TABS.map(([t, label, icon]) => (
            <button
              type="button"
              key={t}
              className={tab === t ? "nav-row on" : "nav-row"}
              aria-current={tab === t ? "page" : undefined}
              onClick={() => setTab(t)}
            >
              <Icon name={icon} />
              <span className={tab === t ? "t-body-m-strong" : "t-body-m"}>{label}</span>
            </button>
          ))}
        </nav>
        <div className="settings-body">
          <div className="settings-head">
            <h2 className="t-title-l grow">{title}</h2>
            <button type="button" className="icon-btn" aria-label="Close settings" onClick={close}>
              <Icon name="close" />
            </button>
          </div>
          {tab === "general" && <General choice={choice} choose={choose} onSignOut={onSignOut} />}
          {tab === "models" && <Models models={data.models} refresh={refresh} />}
          {tab === "spending" && <Spending data={data} refresh={refresh} />}
          {tab === "computer" && <Computer />}
        </div>
      </div>
    </div>
  );
}

function General({
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
    <div className="rows">
      <div className="row">
        <span className="file-text grow">
          <span className="t-body-m-strong">Appearance</span>
          <span className="t-body-s muted">Light, dark, or whatever this Mac uses.</span>
        </span>
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
      </div>
      <div className="row">
        <span className="file-text grow">
          <span className="t-body-m-strong">This browser</span>
          <span className="t-body-s muted">
            Signing out ends this browser's session. Open Covo again with covo app.
          </span>
        </span>
        <Button kind="secondary" small onClick={onSignOut}>
          Sign out
        </Button>
      </div>
    </div>
  );
}

function Models({ models, refresh }: { models: ApiModel[]; refresh: () => void }) {
  const [providers, setProviders] = useState<ApiProvider[]>([]);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<ApiProvider[]>("/providers")
      .then(setProviders)
      .catch(() => {});
  }, []);
  const act = async (path: string, method: string) => {
    setError(null);
    try {
      await api(path, { method, ...(method === "POST" ? { body: {} } : {}) });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      refresh();
    }
  };
  return (
    <>
      <span className="t-overline muted">Your subscriptions</span>
      <SubscriptionRows refresh={refresh} />
      <span className="t-overline muted">Your models</span>
      <div className="rows">
        {models.map((m) => (
          <div className="row" key={m.name}>
            <Icon name={m.engine ? "terminal" : "key"} />
            <span className="file-text grow">
              <span className="t-body-m-strong">
                {m.name} <span className="muted t-body-s">· {m.providerLabel}</span>
              </span>
              <span className="t-body-s muted">
                {m.subscription === "chatgpt"
                  ? `Uses your ChatGPT plan · ${m.model}`
                  : m.engine
                    ? "Uses your subscription"
                    : m.model}
                {m.hasKey ? " · key in the Keychain" : ""}
              </span>
            </span>
            {m.isDefault ? (
              <Pill label="Default" tone="success" />
            ) : (
              <Button small onClick={() => act(`/models/${encodeURIComponent(m.name)}/default`, "POST")}>
                Make default
              </Button>
            )}
            <Button
              small
              onClick={() =>
                // Your ChatGPT plan: removing it also signs Covo out at OpenAI.
                act(
                  m.subscription === "chatgpt" ? "/subscriptions/chatgpt" : `/models/${encodeURIComponent(m.name)}`,
                  "DELETE",
                )
              }
            >
              {m.subscription === "chatgpt" ? "Sign out" : "Remove"}
            </Button>
          </div>
        ))}
        <div className="row">
          <Icon name="folder-lg" />
          <span className="file-text grow">
            <span className="t-body-m-strong">Local model (Ollama)</span>
            <span className="t-body-s muted">
              Free · runs on this Mac · used when no other model is set{models.length ? "" : " (now)"}
            </span>
          </span>
        </div>
        <div className="row">
          <Icon name="key" />
          <span className="file-text grow">
            <span className="t-body-m-strong">Claude, OpenAI, Gemini, xAI and more</span>
            <span className="t-body-s muted">
              Your key goes straight to the macOS Keychain. Covo never shows it again.
            </span>
          </span>
          {!adding && (
            <Button kind="secondary" small onClick={() => setAdding(true)}>
              Add key
            </Button>
          )}
        </div>
      </div>
      {error && <p className="t-body-s danger">{error}</p>}
      {adding && (
        <AddModel
          providers={providers}
          onDone={() => {
            setAdding(false);
            refresh();
          }}
          onCancel={() => setAdding(false)}
        />
      )}
    </>
  );
}

function AddModel({
  providers,
  onDone,
  onCancel,
}: {
  providers: ApiProvider[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const [provider, setProvider] = useState("anthropic");
  const p = providers.find((x) => x.id === provider);
  const [model, setModel] = useState("");
  const [key, setKey] = useState("");
  const [makeDefault, setMakeDefault] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/models", {
        method: "POST",
        body: { provider, model: model || p?.models[0] || "", makeDefault, ...(p?.needsKey ? { key } : {}) },
      });
      setKey("");
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="add-model"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label className="field">
        <span className="t-body-s muted">Service</span>
        <select
          className="input t-body-m"
          value={provider}
          onChange={(e) => {
            setProvider(e.target.value);
            setModel("");
          }}
        >
          {providers.map((x) => (
            <option key={x.id} value={x.id}>
              {x.label}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="t-body-s muted">Model</span>
        <input
          className="input t-body-m"
          list="model-suggestions"
          value={model}
          placeholder={p?.models[0] ?? "model name"}
          onChange={(e) => setModel(e.target.value)}
        />
        <datalist id="model-suggestions">
          {p?.models.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </label>
      {p?.needsKey && (
        <label className="field">
          <span className="t-body-s muted">
            Key{" "}
            {p.keyUrl && (
              <a href={p.keyUrl} target="_blank" rel="noreferrer noopener">
                (get one)
              </a>
            )}
          </span>
          <input
            className="input t-body-m"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </label>
      )}
      {p?.note && <p className="t-body-s muted">{p.note}</p>}
      <label className="check t-body-s">
        <input type="checkbox" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} />
        Use it by default
      </label>
      {error && <p className="t-body-s danger">{error}</p>}
      <div className="card-actions">
        <Button kind="primary" type="submit" disabled={busy || (p?.needsKey === true && !key)}>
          {busy ? "Checking the key…" : "Check and save"}
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

const money = (s: string): number | null | undefined => {
  const t = s.trim().replace(/^\$/, "");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

function Spending({ data, refresh }: { data: Data; refresh: () => void }) {
  const [usage, setUsage] = useState<ApiUsage | null>(null);
  const [editing, setEditing] = useState(false);
  const [day, setDay] = useState("");
  const [task, setTask] = useState("");
  const [error, setError] = useState<string | null>(null);
  const limits = data.usage.limits;
  useEffect(() => {
    api<ApiUsage>("/usage?days=30")
      .then(setUsage)
      .catch(() => {});
  }, []);
  const save = async () => {
    const d = money(day);
    const t = money(task);
    if (d === undefined || t === undefined) {
      setError("Limits are dollar amounts, like 1.50. Leave one empty for no limit.");
      return;
    }
    try {
      await api<ApiLimits>("/limits", { method: "PUT", body: { dayUsd: d, runUsd: t } });
      setEditing(false);
      setError(null);
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const days = lastDays(usage, 14);
  const max = Math.max(0.0001, ...days.map((d) => d.usd));
  const top = usage?.byBot.filter((r) => r.usd > 0).sort((a, b) => b.usd - a.usd)[0];
  const botLimits = data.bots.filter((b) => b.status !== "archived" && b.taskLimitUsd !== null);
  return (
    <>
      <div className="stats">
        <div className="stat">
          <span className="t-caption muted">Today</span>
          <span className="t-title-l">{usd(data.usage.todayUsd)}</span>
          <span className="t-body-s muted">
            {limits.dayUsd === null ? "no daily limit" : `of ${usd(limits.dayUsd)}`}
          </span>
        </div>
        <div className="stat">
          <span className="t-caption muted">Last 30 days</span>
          <span className="t-title-l">{usd(usage?.totalUsd ?? 0)}</span>
          <span className="t-body-s muted">all bots</span>
        </div>
        <div className="stat">
          <span className="t-caption muted">Top spender</span>
          <span className="t-title-l">{usd(top?.usd ?? 0)}</span>
          <span className="t-body-s muted">{top?.label ?? "nobody yet"}</span>
        </div>
      </div>
      <div className="bars" role="img" aria-label="Spending per day, last 14 days">
        {days.map((d, i) => (
          <span
            key={d.key}
            className={i === days.length - 1 ? "bar today" : "bar"}
            style={{ height: `${Math.max(2, (d.usd / max) * 100)}%` }}
            title={`${d.key}: ${usd(d.usd)}`}
          />
        ))}
      </div>
      <div className="table">
        <div className="table-row t-body-s muted">
          <span>Limit</span>
          <span>Amount</span>
          <span>Spent so far</span>
        </div>
        <div className="table-row t-body-m">
          <span>All bots, per day</span>
          {editing ? (
            <input
              className="input t-body-m"
              aria-label="Daily limit in dollars"
              value={day}
              placeholder="no limit"
              onChange={(e) => setDay(e.target.value)}
            />
          ) : (
            <span>{limits.dayUsd === null ? "No limit" : usd(limits.dayUsd)}</span>
          )}
          <span>{usd(data.usage.todayUsd)}</span>
        </div>
        <div className="table-row t-body-m">
          <span>Each task</span>
          {editing ? (
            <input
              className="input t-body-m"
              aria-label="Task limit in dollars"
              value={task}
              placeholder="no limit"
              onChange={(e) => setTask(e.target.value)}
            />
          ) : (
            <span>{limits.runUsd === null ? "No limit" : usd(limits.runUsd)}</span>
          )}
          <span>—</span>
        </div>
        {botLimits.map((b) => (
          <div className="table-row t-body-m" key={b.id}>
            <span>{b.name}, per task</span>
            <span>{usd(b.taskLimitUsd ?? 0)}</span>
            <span>—</span>
          </div>
        ))}
      </div>
      {error && <p className="t-body-s danger">{error}</p>}
      <div className="card-actions">
        {editing ? (
          <>
            <Button kind="primary" onClick={() => void save()}>
              Save limits
            </Button>
            <Button onClick={() => setEditing(false)}>Cancel</Button>
          </>
        ) : (
          <Button
            kind="secondary"
            onClick={() => {
              setDay(limits.dayUsd === null ? "" : String(limits.dayUsd));
              setTask(limits.runUsd === null ? "" : String(limits.runUsd));
              setEditing(true);
            }}
          >
            Edit limits
          </Button>
        )}
      </div>
      <p className="t-body-s muted">
        Free local models never count. A task that would go over a limit pauses and asks you.
      </p>
    </>
  );
}

/** The last `n` days, oldest first, with $0 for days without spending. */
function lastDays(u: ApiUsage | null, n: number): { key: string; usd: number }[] {
  const by = new Map((u?.byDay ?? []).map((r) => [r.label, r.usd]));
  const out: { key: string; usd: number }[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    out.push({ key, usd: by.get(key) ?? 0 });
  }
  return out;
}

function Computer() {
  const [p, setP] = useState<ApiProfile | null>(null);
  const [h, setH] = useState<ApiHealth | null>(null);
  const [log, setLog] = useState<{ ok: boolean } | null>(null);
  useEffect(() => {
    api<ApiProfile>("/profile")
      .then(setP)
      .catch(() => {});
    api<ApiHealth>("/health")
      .then(setH)
      .catch(() => {});
    api<{ ok: boolean }>("/audit/verify")
      .then(setLog)
      .catch(() => {});
  }, []);
  return (
    <>
      <div className="rows">
        <div className="row">
          <span className="file-text grow">
            <span className="t-body-m-strong">Activity log</span>
            <span className="t-body-s muted">
              Every action is chained to the one before, so gaps and edits show up.
            </span>
          </span>
          {log && <Pill label={log.ok ? "Verified" : "Broken"} tone={log.ok ? "success" : "warning"} />}
        </div>
      </div>
      {p && (
        <div className="facts">
          <Fact k="This Mac" v={`${p.mac.chip}, ${p.mac.memoryGB} GB`} />
          <Fact
            k="Memory"
            v={p.now.memoryPressure === "normal" ? "Normal" : `Under pressure (${p.now.memoryPressure})`}
          />
          <Fact k="Temperature" v={p.now.thermal === "normal" ? "Normal" : p.now.thermal} />
          <Fact
            k="Power"
            v={p.now.batteryPercent === null ? p.now.power : `${p.now.power}, ${p.now.batteryPercent}%`}
          />
          <Fact k="Tasks at once" v={`${p.maxRuns} (${p.profile.label})`} />
          <Fact k="Local models up to" v={`${p.local.maxParamsB}B parameters`} />
          {h && <Fact k="Covo itself" v={`${h.rssMB} MB, ${h.running} running, ${h.queued} waiting`} />}
        </div>
      )}
      {p?.notes.map((n) => (
        <p key={n} className="t-body-s muted">
          {n}
        </p>
      ))}
      <p className="t-body-s muted">Choose a different power profile with covo profile in the terminal.</p>
    </>
  );
}

function Fact({ k, v }: { k: string; v: string }) {
  return (
    <div className="fact">
      <span className="t-body-s muted">{k}</span>
      <span className="t-body-m">{v}</span>
    </div>
  );
}
