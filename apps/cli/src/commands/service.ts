import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { covoPaths, tildify } from "@covo/core";
import type { CliResult, Ctx } from "../main.ts";
import { PrepareError } from "../runner.ts";
import { serviceHealth, socketPath, stopViaService } from "../service/client.ts";
import { ServiceRunningError, serve } from "../service/server.ts";

// covo service: Covo's background service (covod), started at login by macOS (launchd).

export const LABEL = "com.covobot.covod";

const USAGE = `Usage:
  covo service status        Is it running, and what is it doing?
  covo service install       Start it now and every time you log in
  covo service uninstall     Stop it and don't start it at login
  covo service run           Run it in this terminal (what launchd starts)
`;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The launchd job description (a property list). */
export function plistXml(o: { label: string; args: string[]; env: Record<string, string>; log: string }): string {
  const env = Object.entries(o.env)
    .map(([k, v]) => `      <key>${esc(k)}</key>\n      <string>${esc(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${esc(o.label)}</string>
    <key>ProgramArguments</key>
    <array>
${o.args.map((a) => `      <string>${esc(a)}</string>`).join("\n")}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${env}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>${esc(o.log)}</string>
    <key>StandardErrorPath</key>
    <string>${esc(o.log)}</string>
  </dict>
</plist>
`;
}

export type Launchctl = (args: string[]) => { code: number; out: string };

const realLaunchctl: Launchctl = (args) => {
  const p = Bun.spawnSync(["/bin/launchctl", ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, out: `${p.stdout.toString()}${p.stderr.toString()}`.trim() };
};

const uid = () => {
  try {
    return userInfo().uid;
  } catch {
    return process.getuid?.() ?? 501;
  }
};

const agentFile = (ctx: Ctx) => join(ctx.env.HOME ?? homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

async function waitForService(home: string, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await serviceHealth(home, 500)) return true;
    await Bun.sleep(250);
  }
  return false;
}

export async function serviceCommand(ctx: Ctx, args: string[]): Promise<CliResult> {
  const [sub] = args;
  if (!existsSync(covoPaths(ctx.home).db))
    return { code: 1, out: `Covo isn't set up in ${tildify(ctx.home)} yet. Run: covo init\n` };
  const launchctl = ctx.launchctl ?? realLaunchctl;
  const domain = `gui/${uid()}`;

  if (!sub || sub === "status") {
    const h = await serviceHealth(ctx.home);
    const installed = existsSync(agentFile(ctx));
    const lines = h
      ? [
          `Covo's service is running (process ${h.pid}, ${h.rssMB} MB memory).`,
          `  Tasks      ${h.running} running, ${h.queued} waiting`,
          `  Socket     ${tildify(socketPath(ctx.home))}`,
          `  App        covo app (opens http://127.0.0.1:${ctx.env.COVO_PORT ?? 7420}/ui/)`,
          `  At login   ${installed ? "starts automatically" : "no (covo service install)"}`,
        ]
      : [
          "Covo's service isn't running.",
          installed
            ? `  It's set to start at login. Check its log: ${tildify(join(covoPaths(ctx.home).logs, "covod.log"))}`
            : "  Start it now and at every login with: covo service install",
          "  Without it, covo run works in your terminal as before.",
        ];
    return { code: 0, out: `${lines.join("\n")}\n` };
  }

  if (sub === "run") {
    let running: Awaited<ReturnType<typeof serve>>;
    try {
      running = await serve(ctx);
    } catch (e) {
      if (e instanceof ServiceRunningError || e instanceof PrepareError) return { code: 1, out: `${e.message}\n` };
      throw e;
    }
    const stamp = () => new Date(ctx.now()).toISOString();
    ctx.print(`${stamp()} Covo's service started (process ${process.pid}) on ${running.socket}\n`);
    if (running.recovered.length)
      ctx.print(
        `${stamp()} Cleaned up ${running.recovered.length} task(s) left from before: ${running.recovered.join(", ")}\n`,
      );
    running.service.watch((m) => {
      if (m.type === "event" && m.event.type === "state") ctx.print(`${stamp()} ${m.event.runId} ${m.event.state}\n`);
      if (m.type === "error") ctx.print(`${stamp()} ${m.job} error: ${m.message}\n`);
    });
    await new Promise<void>((done) => {
      const stop = (sig: string) => {
        ctx.print(`${stamp()} ${sig}: stopping running tasks safely…\n`);
        void running.close().then(done);
      };
      process.once("SIGTERM", () => stop("SIGTERM"));
      process.once("SIGINT", () => stop("SIGINT"));
      ctx.serviceStarted?.(running);
    });
    return { code: 0, out: `${stamp()} Covo's service stopped.\n` };
  }

  if (sub === "install") {
    const file = agentFile(ctx);
    const logs = covoPaths(ctx.home).logs;
    mkdirSync(logs, { recursive: true });
    mkdirSync(join(file, ".."), { recursive: true });
    const entry = resolve(import.meta.dir, "..", "index.ts");
    writeFileSync(
      file,
      plistXml({
        label: LABEL,
        args: [process.execPath, entry, "service", "run"],
        env: {
          COVO_HOME: ctx.home,
          HOME: ctx.env.HOME ?? homedir(),
          PATH: ctx.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
          LANG: ctx.env.LANG ?? "en_US.UTF-8",
        },
        log: join(logs, "covod.log"),
      }),
      { mode: 0o644 },
    );
    launchctl(["bootout", `${domain}/${LABEL}`]); // replace an older copy, if any
    const r = launchctl(["bootstrap", domain, file]);
    if (r.code !== 0) return { code: 1, out: `macOS didn't start the service: ${r.out || `code ${r.code}`}\n` };
    const up = ctx.launchctl ? true : await waitForService(ctx.home, 10_000);
    return {
      code: up ? 0 : 1,
      out: up
        ? `Covo's service is running and starts at every login.\nTasks from covo run now carry on even if you close the terminal.\nStop it any time with: covo service uninstall\n`
        : `The service was registered but didn't answer. Check its log: ${tildify(join(logs, "covod.log"))}\n`,
    };
  }

  if (sub === "uninstall") {
    const file = agentFile(ctx);
    const r = launchctl(["bootout", `${domain}/${LABEL}`]);
    const had = existsSync(file);
    rmSync(file, { force: true });
    if (!had && r.code !== 0) return { code: 0, out: "Covo's service wasn't installed.\n" };
    return {
      code: 0,
      out: "Covo's service is stopped and won't start at login. Running tasks were stopped safely; covo run works in your terminal as before.\n",
    };
  }
  return { code: 2, out: USAGE };
}

/** covo stop <run>: stops a task the service is running. */
export async function stopCommand(ctx: Ctx, args: string[]): Promise<CliResult> {
  const id = args[0];
  if (!id) return { code: 2, out: "Usage: covo stop <run>\n" };
  if (!(await serviceHealth(ctx.home)))
    return { code: 1, out: "Covo's service isn't running. A task in a terminal stops with Ctrl-C there.\n" };
  return (await stopViaService(ctx.home, id))
    ? { code: 0, out: "Stopping after the current step. Its copy is thrown away; your files are untouched.\n" }
    : { code: 1, out: `No running task matches "${id}". See: covo status\n` };
}

/** covo app: opens Covo in your browser, signed in with a one-time code. */
export async function appCommand(ctx: Ctx): Promise<CliResult> {
  if (!(await serviceHealth(ctx.home)))
    return { code: 1, out: "Covo's service isn't running. Start it with: covo service install\n" };
  let link: { code?: string; url?: string; error?: string };
  try {
    const r = await fetch("http://covod/pair-code", { unix: socketPath(ctx.home), method: "POST" });
    link = (await r.json()) as typeof link;
  } catch (e) {
    return { code: 1, out: `Couldn't reach Covo's service: ${(e as Error).message}\n` };
  }
  if (!link.url) return { code: 1, out: `${link.error ?? "The service didn't give a sign-in link."}\n` };
  const open = ctx.openUrl ?? ((u: string) => Bun.spawnSync(["/usr/bin/open", u]).exitCode === 0);
  if (!open(link.url)) return { code: 1, out: "Couldn't open your browser. Run covo app again to get a new link.\n" };
  return { code: 0, out: "Opened Covo in your browser. The sign-in link works once, for 2 minutes.\n" };
}
