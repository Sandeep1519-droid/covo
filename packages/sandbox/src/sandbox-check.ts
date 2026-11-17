import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type ExecResult, type Sandbox, sandbox } from "@covo/platform";

export interface SandboxCheck {
  name: string;
  status: "pass" | "fail" | "skip" | "warn";
  detail: string;
}

export interface SandboxCheckOptions {
  /** Folder for the throwaway test workspace (removed afterwards). */
  scratchDir: string;
  /** Covo's database, which commands must not be able to read. */
  dbPath: string;
  home?: string;
  sandbox?: Sandbox;
}

const firstLine = (r: ExecResult) => (r.stderr || r.stdout).trim().split("\n")[0] ?? "";

/**
 * Runs real commands inside the sandbox and checks each safety promise:
 * 7 safety checks, plus a warning-only check that ordinary developer tools still work.
 */
export async function checkSandbox(o: SandboxCheckOptions): Promise<SandboxCheck[]> {
  const home = o.home ?? homedir();
  const sb = o.sandbox ?? sandbox();
  const root = join(o.scratchDir, `sandbox-check-${process.pid}-${Date.now()}`);
  const workspace = join(root, "ws");
  const tmp = join(root, "tmp");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(tmp, { recursive: true });
  const run = (...argv: string[]) => sb.exec(argv, { workspace, tmp, timeoutMs: 15_000 });
  const escapeFile = `/private/tmp/covo-sandbox-escape-${process.pid}`;
  const desktopFile = join(home, "Desktop", `covo-sandbox-escape-${process.pid}`);

  const blocked = async (name: string, paths: string[], argv: (p: string) => string[]): Promise<SandboxCheck> => {
    const present = paths.filter((p) => existsSync(p));
    if (present.length === 0)
      return { name, status: "skip", detail: `Nothing to protect here: ${paths.join(", ")} not found` };
    for (const p of present) {
      const r = await run(...argv(p));
      if (r.code === 0) return { name, status: "fail", detail: `A sandboxed command could read ${p}` };
    }
    return {
      name,
      status: "pass",
      detail: `Blocked (${present.length === 1 ? present[0] : `${present.length} locations`})`,
    };
  };

  try {
    const checks: SandboxCheck[] = [];
    checks.push(await blocked("Home folder is hidden", [home], (p) => ["/bin/ls", p]));
    checks.push(await blocked("SSH keys are hidden", [join(home, ".ssh")], (p) => ["/bin/ls", p]));
    checks.push(
      await blocked(
        "Passwords and keychains are hidden",
        [join(home, "Library/Keychains"), "/Library/Keychains"],
        (p) => ["/bin/ls", p],
      ),
    );
    checks.push(await blocked("Covo's own data is hidden", [o.dbPath], (p) => ["/bin/cat", p]));

    const w = await run("/bin/sh", "-c", "echo ok > .covo-check && cat .covo-check");
    checks.push(
      w.code === 0 && w.stdout.trim() === "ok"
        ? { name: "Workspace copy is writable", status: "pass", detail: "Created and read a file" }
        : { name: "Workspace copy is writable", status: "fail", detail: firstLine(w) || `exit code ${w.code}` },
    );

    await run("/usr/bin/touch", escapeFile);
    await run("/usr/bin/touch", desktopFile);
    const escaped = [escapeFile, desktopFile].filter((p) => existsSync(p));
    checks.push(
      escaped.length === 0
        ? { name: "Can't write anywhere else", status: "pass", detail: "Writes to /tmp and your Desktop were refused" }
        : { name: "Can't write anywhere else", status: "fail", detail: `Wrote ${escaped.join(" and ")}` },
    );

    const n = await run("/usr/bin/curl", "-sS", "-m", "5", "-o", "/dev/null", "https://example.com");
    checks.push(
      n.code !== 0
        ? { name: "No network access", status: "pass", detail: firstLine(n) || "Connection refused" }
        : { name: "No network access", status: "fail", detail: "A sandboxed command reached https://example.com" },
    );

    const tools: string[] = [];
    for (const argv of [
      ["/usr/bin/git", "--version"],
      ["/usr/bin/python3", "-c", "print(1)"],
    ]) {
      const r = await run(...argv);
      if (r.code !== 0) tools.push(`${argv[0]}: ${firstLine(r)}`);
    }
    checks.push(
      tools.length === 0
        ? { name: "Developer tools still work", status: "pass", detail: "git and python3 ran normally" }
        : { name: "Developer tools still work", status: "warn", detail: tools.join("; ") },
    );
    return checks;
  } finally {
    rmSync(root, { recursive: true, force: true });
    for (const p of [escapeFile, desktopFile]) rmSync(p, { force: true }); // only exists if a check failed
  }
}
