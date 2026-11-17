import { homedir } from "node:os";
import { join } from "node:path";

export interface CwPaths {
  home: string;
  state: string;
  db: string;
  workspaces: string;
  runs: string;
  logs: string;
}

/** Coworker's data folder: $CW_HOME, or ~/Coworker. */
export function cwHome(env: Record<string, string | undefined> = process.env): string {
  return env.CW_HOME && env.CW_HOME.length > 0 ? env.CW_HOME : join(homedir(), "Coworker");
}

export function cwPaths(home: string): CwPaths {
  return {
    home,
    state: join(home, "state"),
    db: join(home, "state", "cw.db"),
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
