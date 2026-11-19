import { Avatar } from "./Avatar.tsx";

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

export function Later({ title, what }: { title: string; what: string }) {
  return (
    <Page title={title}>
      <p className="t-body-m muted">{what}</p>
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
