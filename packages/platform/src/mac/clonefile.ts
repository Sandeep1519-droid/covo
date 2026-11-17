import { dlopen, FFIType } from "bun:ffi";
import type { CloneMethod, WorkspaceCloner } from "../index.ts";

// clonefile(2) copies a file or a whole folder tree in one system call. On APFS the copy shares
// storage with the original until either side changes, so it is instant and uses no extra space.
// If it fails (different volume, non-APFS disk), we fall back to `cp -c`, which still clones where
// it can and copies otherwise.

const CLONE_NOFOLLOW = 0x0001; // copy symlinks as links, don't follow them

let clonefileFn: ((src: Buffer, dst: Buffer, flags: number) => number) | null | undefined;

function native(): typeof clonefileFn {
  if (clonefileFn !== undefined) return clonefileFn;
  try {
    const lib = dlopen("/usr/lib/libSystem.B.dylib", {
      clonefile: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    });
    clonefileFn = (s, d, f) => lib.symbols.clonefile(s, d, f) as number;
  } catch {
    clonefileFn = null;
  }
  return clonefileFn;
}

const cstr = (s: string) => Buffer.from(`${s}\0`, "utf8");

function tryNative(src: string, dst: string): boolean {
  const fn = native();
  if (!fn) return false;
  return fn(cstr(src), cstr(dst), CLONE_NOFOLLOW) === 0;
}

function copyFallback(src: string, dst: string, recursive: boolean): void {
  const args = recursive ? ["-cRp", src, dst] : ["-cp", src, dst];
  const r = Bun.spawnSync(["/bin/cp", ...args], { stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`Couldn't copy ${src} to ${dst}: ${r.stderr.toString().trim()}`);
}

export const macCloner: WorkspaceCloner = {
  cloneTree(src, dst): CloneMethod {
    if (tryNative(src, dst)) return "clonefile";
    copyFallback(src, dst, true);
    return "copy";
  },
  cloneFile(src, dst): CloneMethod {
    if (tryNative(src, dst)) return "clonefile";
    copyFallback(src, dst, false);
    return "copy";
  },
};
