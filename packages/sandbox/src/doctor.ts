import { closeSync, fsyncSync, mkdirSync, openSync, rmSync, statfsSync, writeSync } from "node:fs";
import { join } from "node:path";
import { type CloneMethod, cloner, type WorkspaceCloner } from "@covo/platform";

export interface CloneCheck {
  ok: boolean;
  method: CloneMethod;
  sizeMB: number;
  ms: number;
  /** Free space used by the copy, in MB. Near zero means a real clone. */
  extraMB: number;
  problem?: string;
}

const MB = 1024 * 1024;

const freeBytes = (dir: string) => {
  const s = statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
};

/**
 * Writes a test folder of `sizeMB`, copies it, and measures time and disk use.
 * Runs inside `scratchDir` (on the same disk as the workspaces) and removes everything afterwards.
 */
export function checkClone(scratchDir: string, sizeMB = 200, clone: WorkspaceCloner = cloner()): CloneCheck {
  const root = join(scratchDir, `clone-check-${process.pid}-${Date.now()}`);
  const src = join(root, "src");
  mkdirSync(src, { recursive: true });
  try {
    const chunk = crypto.getRandomValues(new Uint8Array(MB));
    const fd = openSync(join(src, "big.bin"), "w");
    for (let i = 0; i < sizeMB; i++) {
      chunk[0] = i & 255; // keep chunks distinct so the disk can't deduplicate them
      writeSync(fd, chunk);
    }
    fsyncSync(fd);
    closeSync(fd);

    const before = freeBytes(root);
    const t0 = performance.now();
    const method = clone.cloneTree(src, join(root, "copy"));
    const ms = performance.now() - t0;
    const extraMB = Math.max(0, (before - freeBytes(root)) / MB);

    let problem: string | undefined;
    if (method !== "clonefile")
      problem = "The disk doesn't support instant copies (APFS clones), so files were copied in full.";
    else if (extraMB > sizeMB * 0.1)
      problem = `The copy used ${extraMB.toFixed(0)} MB of disk space; it should use almost none.`;
    else if (ms > 1000) problem = `The copy took ${ms.toFixed(0)} ms; it should take a few milliseconds.`;
    return { ok: !problem, method, sizeMB, ms, extraMB, problem };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
