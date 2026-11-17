// Line-based unified diff (Myers' O(ND) algorithm), so `covo diff` needs no external tools and works
// the same on macOS and, later, Windows.

export type Op = { kind: "same" | "del" | "add"; line: string };

export interface Hunk {
  header: string;
  lines: string[];
}

const NO_EOL = "\u0000no-eol";
const NO_EOL_NOTE = "\\ No newline at end of file";

/** Splits into lines. A last line without "\n" is tagged so that adding or removing it shows up. */
function splitLines(s: string): string[] {
  if (s === "") return [];
  const parts = s.split("\n");
  if (parts.at(-1) === "") parts.pop();
  else parts[parts.length - 1] += NO_EOL;
  return parts;
}

/** Shortest edit script between two line lists. */
export function diffLines(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const at = (arr: Int32Array, k: number) => arr[off + k] as number;
  const down = (arr: Int32Array, k: number, d: number) => k === -d || (k !== d && at(arr, k - 1) < at(arr, k + 1));
  const trace: Int32Array[] = [];
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = down(v, k, d) ? at(v, k + 1) : at(v, k - 1) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) break outer;
    }
  }
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d] as Int32Array;
    const k = x - y;
    const prevK = down(vd, k, d) ? k + 1 : k - 1;
    const prevX = at(vd, prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ kind: "same", line: a[x] as string });
    }
    if (d === 0) break;
    if (x === prevX) ops.push({ kind: "add", line: b[--y] as string });
    else ops.push({ kind: "del", line: a[--x] as string });
  }
  return ops.reverse();
}

/** Unified diff hunks with `context` lines around each change. Empty when the texts are equal. */
export function unifiedDiff(before: string, after: string, context = 3): Hunk[] {
  const ops = diffLines(splitLines(before), splitLines(after));
  const posA: number[] = [];
  const posB: number[] = [];
  let ai = 0;
  let bi = 0;
  for (const op of ops) {
    posA.push(ai);
    posB.push(bi);
    if (op.kind !== "add") ai++;
    if (op.kind !== "del") bi++;
  }

  const hunks: Hunk[] = [];
  let i = 0;
  while (i < ops.length) {
    while (i < ops.length && ops[i]?.kind === "same") i++;
    if (i >= ops.length) break;
    const start = Math.max(0, i - context);
    let end = i;
    for (;;) {
      while (end < ops.length && ops[end]?.kind !== "same") end++;
      let next = end;
      while (next < ops.length && ops[next]?.kind === "same") next++;
      if (next < ops.length && next - end <= context * 2) end = next;
      else {
        end = Math.min(ops.length, end + context);
        break;
      }
    }
    const slice = ops.slice(start, end);
    const aCount = slice.filter((o) => o.kind !== "add").length;
    const bCount = slice.filter((o) => o.kind !== "del").length;
    const range = (s: number, c: number) => (c === 1 ? `${s + 1}` : `${c === 0 ? s : s + 1},${c}`);
    const lines: string[] = [];
    for (const o of slice) {
      const mark = o.kind === "same" ? " " : o.kind === "del" ? "-" : "+";
      if (o.line.endsWith(NO_EOL)) lines.push(`${mark}${o.line.slice(0, -NO_EOL.length)}`, NO_EOL_NOTE);
      else lines.push(`${mark}${o.line}`);
    }
    hunks.push({
      header: `@@ -${range(posA[start] as number, aCount)} +${range(posB[start] as number, bCount)} @@`,
      lines,
    });
    i = end;
  }
  return hunks;
}
