import { expect, test } from "bun:test";
import { diffLines, unifiedDiff } from "./textdiff.ts";

const render = (a: string, b: string) =>
  unifiedDiff(a, b)
    .flatMap((h) => [h.header, ...h.lines])
    .join("\n");

test("equal texts have no hunks", () => {
  expect(unifiedDiff("a\nb\n", "a\nb\n")).toEqual([]);
  expect(unifiedDiff("", "")).toEqual([]);
});

test("finds the shortest edit", () => {
  const ops = diffLines(["a", "b", "c", "d"], ["a", "c", "d", "e"]);
  expect(ops.map((o) => `${o.kind[0]}${o.line}`)).toEqual(["sa", "db", "sc", "sd", "ae"]);
});

test("a change in the middle, with context", () => {
  const before = "1\n2\n3\n4\n5\n6\n7\n8\n9\n";
  const after = "1\n2\n3\n4\nFIVE\n6\n7\n8\n9\n";
  expect(render(before, after)).toBe("@@ -2,7 +2,7 @@\n 2\n 3\n 4\n-5\n+FIVE\n 6\n 7\n 8");
});

test("far-apart changes make separate hunks", () => {
  const lines = Array.from({ length: 30 }, (_, i) => String(i + 1));
  const after = [...lines];
  after[1] = "two";
  after[27] = "twenty-eight";
  const hunks = unifiedDiff(`${lines.join("\n")}\n`, `${after.join("\n")}\n`);
  expect(hunks.map((h) => h.header)).toEqual(["@@ -1,5 +1,5 @@", "@@ -25,6 +25,6 @@"]);
});

test("new and deleted files", () => {
  expect(render("", "a\nb\n")).toBe("@@ -0,0 +1,2 @@\n+a\n+b");
  expect(render("a\n", "")).toBe("@@ -1 +0,0 @@\n-a");
});

test("shows a dropped final newline, like the real qwen3 run did", () => {
  expect(render("# T\n\nend\n", "# T\n\nend")).toBe(
    "@@ -1,3 +1,3 @@\n # T\n \n-end\n+end\n\\ No newline at end of file",
  );
});
