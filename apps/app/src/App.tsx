import type { ApiApproval, ApiBot, ApiEvent, ApiMe, ApiModel, ApiRun, ApiUsage } from "@covo/api";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiFail, api, listen, pair } from "./api.ts";
import { BotChat } from "./components/BotChat.tsx";
import { NeedsYou, needsYou } from "./components/NeedsYou.tsx";
import { NewBot } from "./components/NewBot.tsx";
import { Gatekeeper, Later } from "./components/Pages.tsx";
import { Rail } from "./components/Rail.tsx";
import { Review } from "./components/Review.tsx";
import { SettingsWindow } from "./components/Settings.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { type Data, hashFor, type LiveStep, MAIN_BOT, type View, viewFromHash } from "./model.ts";
import { ThemeContext, useThemeState } from "./theme.ts";

async function load(): Promise<Data> {
  const [me, bots, models, runs, approvals, usage] = await Promise.all([
    api<ApiMe>("/me"),
    api<ApiBot[]>("/bots"),
    api<ApiModel[]>("/models"),
    api<ApiRun[]>("/runs?limit=200"),
    api<ApiApproval[]>("/approvals"),
    api<ApiUsage>("/usage?days=1"),
  ]);
  return { me, bots, models, runs, approvals, usage };
}

type Gate = "loading" | "expired" | "signed-out" | "down" | "ready";

export function App() {
  const { choice, theme, choose } = useThemeState();
  const [gate, setGate] = useState<Gate>("loading");
  const [data, setData] = useState<Data | null>(null);
  const [view, setView] = useState<View>(() => viewFromHash(location.hash) ?? { name: "bot", id: "" });
  const [sidebar, setSidebar] = useState(true);
  const [tick, setTick] = useState(0);
  // Steps of running tasks as they stream in, by run; and which run each service job is.
  const steps = useRef(new Map<string, LiveStep[]>());
  const jobRun = useRef(new Map<string, string>());
  const [, setStepTick] = useState(0);
  // The screen under the Settings window.
  const under = useRef<View>({ name: "bot", id: "" });
  const loading = useRef(false);
  const again = useRef(false);

  const refresh = useCallback(async () => {
    // One load at a time; if more changes arrive meanwhile, load once more after.
    if (loading.current) {
      again.current = true;
      return;
    }
    loading.current = true;
    try {
      do {
        again.current = false;
        try {
          setData(await load());
          setGate("ready");
          setTick((t) => t + 1);
        } catch (e) {
          if (e instanceof ApiFail && e.status === 401) setGate((g) => (g === "expired" ? g : "signed-out"));
          // Can't reach the service at all; any other error keeps what's on screen until the next update.
          else if (!(e instanceof ApiFail)) setGate("down");
        }
      } while (again.current);
    } finally {
      loading.current = false;
    }
  }, []);

  // Sign in with the one-time code from `covo app`, then drop it from the address.
  useEffect(() => {
    void (async () => {
      const code = new URLSearchParams(location.hash.slice(1)).get("code");
      if (code) {
        history.replaceState(null, "", location.pathname);
        if (!(await pair(code))) setGate("expired");
      }
      await refresh();
    })();
  }, [refresh]);

  // Live updates. Steps update the running task in place; anything else reloads.
  useEffect(() => {
    if (gate !== "ready") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const later = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 150);
    };
    const stop = listen((m: ApiEvent) => {
      if (m.type === "event") {
        const e = m.event;
        if (e.type === "state" && typeof e.runId === "string") jobRun.current.set(m.job, e.runId);
        if (e.type === "tool") {
          const runId = jobRun.current.get(m.job);
          if (runId) {
            const list = steps.current.get(runId) ?? [];
            list.push({
              seq: Number(e.seq),
              name: String(e.name ?? ""),
              target: String(e.target ?? ""),
              label: String(e.label ?? ""),
              ok: e.ok === true,
              ...(typeof e.blocked === "string" ? { blocked: e.blocked } : {}),
            });
            steps.current.set(runId, list.slice(-50));
            setStepTick((t) => t + 1);
          }
          return;
        }
        if (e.type === "model") return;
      }
      later();
    });
    return () => {
      clearTimeout(timer);
      stop();
    };
  }, [gate, refresh]);

  // Back and forward move between screens.
  useEffect(() => {
    const onHash = () => {
      const v = viewFromHash(location.hash);
      if (v) setView(v);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const go = useCallback(
    (v: View) => {
      const next = v.name === "bot" && !v.id ? { name: "bot" as const, id: lastBot(data) } : v;
      if (location.hash !== hashFor(next)) location.hash = hashFor(next);
      setView(next);
    },
    [data],
  );

  const signOut = async () => {
    try {
      await api("/session", { method: "DELETE" });
    } catch {}
    setData(null);
    setGate("signed-out");
  };

  if (gate !== "ready" || !data) {
    return (
      <ThemeContext.Provider value={theme}>
        <Gatekeeper state={gate === "ready" ? "loading" : gate} />
      </ThemeContext.Provider>
    );
  }

  if (view.name !== "settings") under.current = view;
  const screen = view.name === "settings" ? under.current : view;
  const active = data.bots.filter((b) => b.status !== "archived");
  const botId = screen.name === "bot" ? screen.id || lastBot(data) : "";
  const bot = active.find((b) => b.id === botId) ?? active[0];
  const stepsOf = (runId: string) => steps.current.get(runId) ?? [];

  let main: React.ReactNode;
  if (screen.name === "needs-you") main = <NeedsYou data={data} go={go} />;
  else if (screen.name === "review")
    main = <Review data={data} runId={screen.runId} tick={tick} go={go} refresh={refresh} />;
  else if (screen.name === "new-bot") main = <NewBot data={data} go={go} refresh={refresh} />;
  else if (screen.name === "library")
    main = <Later title="Library" what="Your files, memory and the activity log will live here. For now: covo log." />;
  else if (screen.name === "more")
    main = <Later title="More" what="Routines, skills and connections arrive here later." />;
  else if (bot) main = <BotChat data={data} bot={bot} tick={tick} steps={stepsOf} refresh={refresh} go={go} />;
  else main = <Later title="Covo" what="No bots yet. Make one with New bot." />;

  const sideView: View = bot && screen.name === "bot" ? { name: "bot", id: bot.id } : screen;
  return (
    <ThemeContext.Provider value={theme}>
      <div className="app">
        <Rail view={view} waiting={needsYou(data).length} go={go} />
        {sidebar ? (
          <Sidebar data={data} view={sideView} go={go} onHide={() => setSidebar(false)} />
        ) : (
          <button type="button" className="show-sidebar" aria-label="Show sidebar" onClick={() => setSidebar(true)}>
            ›
          </button>
        )}
        <main className="main">{main}</main>
      </div>
      {view.name === "settings" && (
        <SettingsWindow
          tab={view.tab}
          setTab={(tab) => go({ name: "settings", tab })}
          close={() => go(under.current)}
          data={data}
          refresh={refresh}
          choice={choice}
          choose={choose}
          onSignOut={signOut}
        />
      )}
    </ThemeContext.Provider>
  );
}

/** The bot you last talked to, or the main one. */
function lastBot(d: Data | null): string {
  const r = d?.runs[0];
  return r?.botId ?? d?.bots.find((b) => b.id === MAIN_BOT)?.id ?? d?.bots[0]?.id ?? "";
}
