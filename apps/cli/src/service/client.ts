import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RunRequest } from "../runner.ts";
import type { ServiceMessage } from "./server.ts";

// Talking to covod over its socket (~/Covo/run/covod.sock).

export const socketPath = (home: string) => join(home, "run", "covod.sock");

export interface Health {
  ok: true;
  version: string;
  pid: number;
  rssMB: number;
  running: number;
  queued: number;
}

/** The service's health, or null when it isn't running. */
export async function serviceHealth(home: string, timeoutMs = 1_000): Promise<Health | null> {
  const unix = socketPath(home);
  if (!existsSync(unix)) return null;
  try {
    const r = await fetch("http://covod/health", { unix, signal: AbortSignal.timeout(timeoutMs) });
    return r.ok ? ((await r.json()) as Health) : null;
  } catch {
    return null;
  }
}

export class ServiceRefused extends Error {}

/** Sends a task to the service and reports each message until it ends (or the service goes away). */
export async function runViaService(
  home: string,
  req: RunRequest,
  onMessage: (m: ServiceMessage) => void,
): Promise<ServiceMessage | null> {
  const r = await fetch("http://covod/runs", {
    unix: socketPath(home),
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!r.ok)
    throw new ServiceRefused(((await r.json()) as { error?: string }).error ?? `The service answered ${r.status}.`);
  let last: ServiceMessage | null = null;
  const reader = (r.body as ReadableStream<Uint8Array>).getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    let chunk: Awaited<ReturnType<typeof reader.read>>;
    try {
      chunk = await reader.read();
    } catch {
      break; // the service went away
    }
    if (chunk.done) break;
    buf += dec.decode(chunk.value, { stream: true });
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const m = JSON.parse(line) as ServiceMessage;
      onMessage(m);
      if (m.type === "done" || m.type === "error") last = m;
    }
  }
  return last;
}

export async function stopViaService(home: string, id: string): Promise<boolean> {
  try {
    const r = await fetch(`http://covod/runs/${encodeURIComponent(id)}/stop`, {
      unix: socketPath(home),
      method: "POST",
    });
    return r.ok;
  } catch {
    return false;
  }
}
