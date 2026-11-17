// Everything operating-system specific sits behind these interfaces, so a Windows version
// can be added later without touching the engine (see docs/PHASE1.md §2).

import { macCloner } from "./mac/clonefile.ts";

export type CloneMethod = "clonefile" | "copy";

export interface WorkspaceCloner {
  /** Copies a whole folder. `dst` must not exist. Instant and space-free on APFS. */
  cloneTree(src: string, dst: string): CloneMethod;
  /** Copies one file. `dst` must not exist. */
  cloneFile(src: string, dst: string): CloneMethod;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface SandboxOptions {
  /** The only folder the command may write to. */
  workspace: string;
  tmp: string;
  timeoutMs: number;
  env?: Record<string, string>;
}

export interface Sandbox {
  exec(argv: string[], opts: SandboxOptions): Promise<ExecResult>; // M3
}

export interface SecretStore {
  get(id: string): Promise<string | null>; // Phase 2
  put(id: string, value: string): Promise<void>;
}

export interface PresenceAuth {
  confirm(reason: string): Promise<boolean>; // Phase 2
}

export function cloner(): WorkspaceCloner {
  if (process.platform === "darwin") return macCloner;
  throw new Error(`Coworker doesn't support ${process.platform} yet`);
}

export { macCloner };
