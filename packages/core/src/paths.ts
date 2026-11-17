import { homedir } from "node:os";
import { join } from "node:path";

export interface CovoPaths {
  home: string;
  state: string;
  db: string;
  workspaces: string;
  runs: string;
  logs: string;
}

/** Covo's data folder: $COVO_HOME, or ~/Covo. */
export function covoHome(env: Record<string, string | undefined> = process.env): string {
  return env.COVO_HOME && env.COVO_HOME.length > 0 ? env.COVO_HOME : join(homedir(), "Covo");
}

export function covoPaths(home: string): CovoPaths {
  return {
    home,
    state: join(home, "state"),
    db: join(home, "state", "covo.db"),
    workspaces: join(home, "workspaces"),
    runs: join(home, "runs"),
    logs: join(home, "logs"),
  };
}

/** Show a path with the home folder shortened to ~. */
export function tildify(path: string): string {
  const h = homedir();
  return path === h || path.startsWith(`${h}/`) ? `~${path.slice(h.length)}` : path;
}
