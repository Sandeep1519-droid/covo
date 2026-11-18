import { existsSync, realpathSync } from "node:fs";
import type { ExecResult, Sandbox, SandboxOptions } from "../index.ts";

// macOS sandbox (Seatbelt) via /usr/bin/sandbox-exec.
//
// The profile denies everything by default, then allows:
//   - reading the operating system, Homebrew and developer tools (system folders only, never your home folder)
//   - reading and writing the run's own workspace copy and temp folder
//   - running programs and signalling processes inside the same sandbox
// Network access is denied. Your home folder (SSH keys, keychains, documents, Covo's own data)
// is invisible except for the run's workspace copy and any read-only folders passed in.
//
// sandbox-exec is marked deprecated by Apple but is still shipped and used by Apple, browsers and
// developer tools. `covo doctor sandbox` re-checks the behaviour on every machine and macOS update.

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const MAX_OUTPUT = 200_000;

/** SBPL string literal. */
const lit = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

const SYSTEM_READ = [
  "/usr",
  "/bin",
  "/sbin",
  "/System",
  "/Library",
  "/opt/homebrew",
  "/private/etc",
  "/private/var/db/timezone",
  "/private/var/db/xcode_select_link",
  "/private/var/select",
  "/Applications/Xcode.app", // developer tools and the frameworks they load (read-only)
  "/dev",
];

const ALWAYS_DENIED = ["/Library/Keychains", "/private/var/db/SystemPolicy"];

export interface ProfileOptions {
  workspace: string;
  tmp: string;
  /** Extra folders the command may read but not change, e.g. a language toolchain in your home folder. */
  readOnly?: string[];
  /** Extra folders it may change (the cli-agent profile: an engine's own settings folder). */
  readWrite?: string[];
  /** Files it may change, each with any suffix (e.g. ~/.claude.json and its backups). */
  readWriteFilePrefixes?: string[];
  /** Allow network access. Off for bots' own commands; on only for subscription engines. */
  network?: boolean;
  /** Allow talking to the Keychain services (an engine reading its own sign-in). */
  keychain?: boolean;
}

const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Network and Keychain rules for the cli-agent profile (ADR-009, docs/SUBSCRIPTIONS.md). */
function extras(o: ProfileOptions): string {
  const out: string[] = [];
  if (o.network) {
    out.push(
      "(allow network-outbound)",
      '(allow network-inbound (local ip "localhost:*"))',
      "(allow system-socket)",
      '(allow mach-lookup (global-name "com.apple.dnssd.service") (global-name "com.apple.SystemConfiguration.configd") (global-name "com.apple.SystemConfiguration.DNSConfiguration") (global-name "com.apple.networkd") (global-name "com.apple.nsurlsessiond") (global-name "com.apple.trustd") (global-name "com.apple.trustd.agent") (global-name "com.apple.ocspd"))',
    );
  }
  if (o.keychain) {
    out.push(
      '(allow mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd.xpc") (global-name "com.apple.security.agent") (global-name "com.apple.cfprefsd.agent") (global-name "com.apple.cfprefsd.daemon") (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.CoreServices.coreservicesd"))',
      "(allow ipc-posix-shm-read* ipc-posix-shm-write-data)",
      "(allow user-preference-read)",
    );
  }
  return out.join("\n");
}

export function buildProfile(o: ProfileOptions): string {
  const rw = [
    ...[o.workspace, o.tmp, ...(o.readWrite ?? [])].map((p) => `(subpath ${lit(p)})`),
    ...(o.readWriteFilePrefixes ?? []).map((p) => `(regex ${lit(`^${reEscape(p)}`)})`),
  ].join(" ");
  const ro = [...SYSTEM_READ, ...(o.readOnly ?? [])].map((p) => `(subpath ${lit(p)})`).join("\n  ");
  return `(version 1)
(deny default)
(import "system.sb")
(allow process-fork)
(allow process-exec)
(allow signal (target same-sandbox))
(allow sysctl-read)
(allow file-read-metadata)
(allow file-read* (literal "/")
  ${ro}
  ${rw})
(allow file-write* ${rw}
  (literal "/dev/null") (literal "/dev/zero") (regex #"^/dev/tty") (regex #"^/dev/fd/"))
(allow file-ioctl (literal "/dev/null") (regex #"^/dev/tty"))
; Apple's xcrun (behind /usr/bin/git, python3, clang…) insists on a cache file in the per-user temp
; folder. Allow only files named xcrun_db*, not the folder itself, which other apps share.
(allow file-read* file-write* (regex #"^/private/var/folders/[^/]+/[^/]+/T/xcrun_db"))
(deny file-read* file-write* ${ALWAYS_DENIED.map((p) => `(subpath ${lit(p)})`).join(" ")})
${o.network ? extras(o) : `(deny network*)${o.keychain ? `\n${extras(o)}` : ""}`}
`;
}

function capped(s: string): string {
  return s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n… (output cut at ${MAX_OUTPUT} characters)` : s;
}

export const macSandbox: Sandbox = {
  async exec(argv: string[], opts: SandboxOptions): Promise<ExecResult> {
    if (argv.length === 0) throw new Error("sandbox exec: no command given");
    // Seatbelt matches real paths, so resolve symlinks like /tmp -> /private/tmp first.
    const workspace = realpathSync(opts.workspace);
    const tmp = realpathSync(opts.tmp);
    const real = (ps?: string[]) => (ps ?? []).filter((p) => existsSync(p)).map((p) => realpathSync(p));
    const profile = buildProfile({
      workspace,
      tmp,
      readOnly: real(opts.readOnly),
      readWrite: real(opts.readWrite),
      readWriteFilePrefixes: opts.readWriteFilePrefixes,
      network: opts.network,
      keychain: opts.keychain,
    });
    const proc = Bun.spawn([SANDBOX_EXEC, "-p", profile, ...argv], {
      cwd: workspace,
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
        HOME: workspace,
        TMPDIR: `${tmp}/`,
        LANG: "en_US.UTF-8",
        ...opts.env,
      },
      stdin: opts.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, opts.timeoutMs);
    const onAbort = () => proc.kill("SIGINT");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
    return { code, stdout: capped(stdout), stderr: capped(stderr), timedOut };
  },
};
