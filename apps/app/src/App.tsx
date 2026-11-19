import type { ApiApproval, ApiBot, ApiMe, ApiModel, ApiRun, ApiUsage } from "@covo/api";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiFail, api, listen, pair } from "./api.ts";
import { BotChat } from "./components/BotChat.tsx";
import { Gatekeeper, Later, NeedsYou, Settings } from "./components/Pages.tsx";
import { Rail } from "./components/Rail.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { type Data, hashFor, MAIN_BOT, type View, viewFromHash } from "./model.ts";
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
        if (!(await pair(code))) {
          setGate("expired");
        }
      }
      await refresh();
    })();
  }, [refresh]);

  // Live updates: anything the service reports means something changed.
  useEffect(() => {
    if (gate !== "ready") return;
    return listen(() => void refresh());
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

  const go = (v: View) => {
    const next = v.name === "bot" && !v.id ? { name: "bot" as const, id: lastBot(data) } : v;
    if (location.hash !== hashFor(next)) location.hash = hashFor(next);
    setView(next);
  };

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

  const active = data.bots.filter((b) => b.status !== "archived");
  const botId = view.name === "bot" ? view.id || lastBot(data) : "";
  const bot = active.find((b) => b.id === botId) ?? active[0];

  let main: React.ReactNode;
  if (view.name === "needs-you") main = <NeedsYou data={data} refresh={refresh} go={go} />;
  else if (view.name === "library")
    main = <Later title="Library" what="Your files, memory and the activity log will live here. For now: covo log." />;
  else if (view.name === "more")
    main = <Later title="More" what="Routines, skills and connections arrive here later." />;
  else if (view.name === "settings") main = <Settings choice={choice} choose={choose} onSignOut={signOut} />;
  else if (bot) main = <BotChat data={data} bot={bot} refresh={refresh} />;
  else main = <Later title="Covo" what="No bots yet. Make one with: covo bots add" />;

  return (
    <ThemeContext.Provider value={theme}>
      <div className="app">
        <Rail view={view} waiting={data.approvals.length} go={go} />
        {sidebar ? (
          <Sidebar
            data={data}
            view={bot && view.name === "bot" ? { name: "bot", id: bot.id } : view}
            go={go}
            onHide={() => setSidebar(false)}
          />
        ) : (
          <button type="button" className="show-sidebar" aria-label="Show sidebar" onClick={() => setSidebar(true)}>
            ›
          </button>
        )}
        <main className="main">{main}</main>
      </div>
    </ThemeContext.Provider>
  );
}

/** The bot you last talked to, or the main one. */
function lastBot(d: Data | null): string {
  const r = d?.runs[0];
  return r?.botId ?? d?.bots.find((b) => b.id === MAIN_BOT)?.id ?? d?.bots[0]?.id ?? "";
}
