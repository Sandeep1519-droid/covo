// A small page at /ui until the real app arrives (Phase 3 M2). It signs the browser in with the
// one-time code from `covo app`, then shows your bots and recent tasks through the API, which
// proves the whole path works. It holds no data itself, so it needs no sign-in to load.

export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

export const UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Covo</title>
<style>
  :root { color-scheme: light dark; --bg: #fff; --fg: #111; --muted: #666; --line: #e5e5e5; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111; --fg: #f2f2f2; --muted: #999; --line: #2a2a2a; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 -apple-system, system-ui, sans-serif; }
  main { max-width: 720px; margin: 48px auto; padding: 0 16px; }
  h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 15px; margin: 28px 0 8px; }
  p.muted, .muted { color: var(--muted); }
  ul { list-style: none; padding: 0; margin: 0; border-top: 1px solid var(--line); }
  li { padding: 10px 0; border-bottom: 1px solid var(--line); display: flex; gap: 12px; justify-content: space-between; }
  code { font: 13px ui-monospace, monospace; }
</style>
</head>
<body>
<main>
  <h1>Covo</h1>
  <p class="muted" id="status">Signing in…</p>
  <section id="data" hidden>
    <h2>Your bots</h2><ul id="bots"></ul>
    <h2>Recent tasks</h2><ul id="runs"></ul>
    <p class="muted">This is a placeholder. The full app arrives in the next update.</p>
  </section>
</main>
<script src="/ui/app.js"></script>
</body>
</html>
`;

export const UI_JS = `"use strict";
(async () => {
  const status = document.getElementById("status");
  const api = (path, init = {}) =>
    fetch("/api" + path, { credentials: "same-origin", ...init, headers: { "content-type": "application/json", ...(init.headers || {}) } });
  const code = new URLSearchParams(location.hash.slice(1)).get("code");
  if (code) {
    history.replaceState(null, "", location.pathname); // the code works once; don't keep it around
    await api("/pair", { method: "POST", body: JSON.stringify({ code }) });
  }
  const bots = await api("/bots");
  if (bots.status === 401) {
    status.textContent = code
      ? "That sign-in link has expired or was already used. Run covo app again."
      : "Not signed in. Open Covo from your terminal with: covo app";
    return;
  }
  const runs = await api("/runs?limit=10");
  const li = (left, right) => { const e = document.createElement("li"); const a = document.createElement("span"); a.textContent = left; const b = document.createElement("span"); b.className = "muted"; b.textContent = right; e.append(a, b); return e; };
  for (const b of await bots.json()) document.getElementById("bots").append(li(b.name, b.level + " · " + (b.models.join(", ") || "default model")));
  for (const r of await runs.json()) document.getElementById("runs").append(li(r.goal, r.state.toLowerCase()));
  status.textContent = "Signed in to Covo on this Mac.";
  document.getElementById("data").hidden = false;
})();
`;
