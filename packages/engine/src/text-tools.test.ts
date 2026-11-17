import { expect, test } from "bun:test";
import { toolCallsFromText } from "./text-tools.ts";

const names = ["read_file", "write_file", "finish"];
const pick = (t: string) => toolCallsFromText(t, names).map((c) => [c.call.name, c.args]);

test("understands the shapes small models write", () => {
  expect(pick('{"name": "read_file", "arguments": {"path": "a"}}')).toEqual([["read_file", { path: "a" }]]);
  expect(pick('<tool_call>\n{"name": "finish", "parameters": {"summary": "x"}}\n</tool_call>')).toEqual([
    ["finish", { summary: "x" }],
  ]);
  expect(pick('{"function": {"name": "read_file", "arguments": "{\\"path\\": \\"b\\"}"}}')).toEqual([
    ["read_file", { path: "b" }],
  ]);
  expect(pick('{"command": "write_file", "arguments": {"path": "c", "content": "} { \\" }"}}')).toEqual([
    ["write_file", { path: "c", content: '} { " }' }],
  ]);
});

test("finds several calls and skips broken or unknown ones", () => {
  const t =
    'First {"name":"read_file","arguments":{"path":"a"}} then {"name":"rm_rf"} and {bad json} {"name":"finish"}';
  expect(pick(t)).toEqual([
    ["read_file", { path: "a" }],
    ["finish", {}],
  ]);
  expect(pick("no json here")).toEqual([]);
});
