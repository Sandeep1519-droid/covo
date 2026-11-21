import { connect, createServer, type Socket } from "node:net";

// A small network filter for an engine that runs commands (Codex). The sandbox lets the engine
// connect only to this filter on 127.0.0.1 (no DNS, nothing else), and the filter opens a tunnel
// only to its maker's own servers, on port 443. So a bad instruction planted in a file can't make
// a command send your files anywhere else (docs/SUBSCRIPTIONS.md).
//
// The programs find it through HTTPS_PROXY and friends; anything that ignores those is simply
// refused by the sandbox.

export interface EgressFilter {
  port: number;
  /** Hosts it let through, and hosts it refused (for the activity log). */
  allowed: Set<string>;
  refused: Set<string>;
  stop(): void;
}

/** OpenAI's own servers: what Codex needs to work and to renew its sign-in. */
export const openAiOnly = (host: string, port: number): boolean =>
  port === 443 && /^([a-z0-9-]+\.)*(openai\.com|chatgpt\.com)$/i.test(host);

const MAX_HEADER = 8 * 1024;

/** The environment that points a program (and the commands it runs) at the filter. */
export function proxyEnv(port: number): Record<string, string> {
  const url = `http://127.0.0.1:${port}`;
  return { HTTPS_PROXY: url, https_proxy: url, HTTP_PROXY: url, http_proxy: url, ALL_PROXY: url, all_proxy: url };
}

export function startEgressFilter(o: {
  allow: (host: string, port: number) => boolean;
  /** Tests point tunnels at a local server. */
  dial?: (host: string, port: number) => Socket;
}): Promise<EgressFilter> {
  const allowed = new Set<string>();
  const refused = new Set<string>();
  const live = new Set<Socket>();
  const dial = o.dial ?? ((host: string, port: number) => connect({ host, port }));

  const server = createServer((client) => {
    live.add(client);
    client.on("close", () => live.delete(client));
    client.on("error", () => client.destroy());
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) {
        if (head.length > MAX_HEADER) client.end("HTTP/1.1 431 Request Header Fields Too Large\r\n\r\n");
        return;
      }
      client.off("data", onData);
      const line = head.subarray(0, head.indexOf("\r\n")).toString("latin1");
      const rest = head.subarray(end + 4);
      const m = /^CONNECT ([^\s:]+|\[[0-9a-f:.]+\]):(\d{1,5}) HTTP\/1\.[01]$/i.exec(line);
      if (!m) {
        // Only encrypted tunnels: plain HTTP requests through the filter are refused.
        const target = /^[A-Z]+ (\S+)/.exec(line)?.[1] ?? "?";
        refused.add(target.replace(/^https?:\/\//, "").split("/")[0] ?? "?");
        client.end("HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n");
        return;
      }
      const host = (m[1] as string).toLowerCase();
      const port = Number(m[2]);
      if (!o.allow(host, port)) {
        refused.add(`${host}:${port}`);
        client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      allowed.add(host);
      const upstream = dial(host, port);
      live.add(upstream);
      upstream.on("close", () => {
        live.delete(upstream);
        client.destroy();
      });
      client.on("close", () => upstream.destroy());
      upstream.on("error", () => {
        if (!client.destroyed) client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      });
      upstream.once("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (rest.length) upstream.write(rest);
        client.pipe(upstream);
        upstream.pipe(client);
      });
    };
    client.on("data", onData);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        port,
        allowed,
        refused,
        stop() {
          server.close();
          for (const s of live) s.destroy();
          live.clear();
        },
      });
    });
  });
}
