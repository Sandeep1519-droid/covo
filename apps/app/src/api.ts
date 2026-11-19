// Talks to Covo's service at /api with the session cookie from pairing (see apps/cli/src/service/gate.ts).

import type { ApiEvent } from "@covo/api";

export class ApiFail extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const r = await fetch(`/api${path}`, {
    method: init.method ?? "GET",
    credentials: "same-origin",
    headers: init.body === undefined ? {} : { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await r.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!r.ok) {
    const msg = (data as { error?: string } | null)?.error ?? `Covo answered ${r.status}.`;
    throw new ApiFail(r.status, msg);
  }
  return data as T;
}

/** Trades the one-time code from `covo app` for a session. The code works once. */
export async function pair(code: string): Promise<boolean> {
  try {
    await api("/pair", { method: "POST", body: { code } });
    return true;
  } catch {
    return false;
  }
}

/** Live updates from the service. Returns a function that stops listening. */
export function listen(onEvent: (e: ApiEvent) => void): () => void {
  const es = new EventSource("/api/events");
  es.onmessage = (m) => {
    try {
      onEvent(JSON.parse(m.data) as ApiEvent);
    } catch {}
  };
  return () => es.close();
}
