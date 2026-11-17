import { expect, test } from "bun:test";
import { canonicalJson, sha256Hex } from "./json.ts";

test("sorts keys at every level", () => {
  expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe(
    '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}',
  );
});

test("drops undefined fields and turns undefined array items into null", () => {
  expect(canonicalJson({ a: undefined, b: [undefined, 1] })).toBe('{"b":[null,1]}');
});

test("rejects values JSON can't represent", () => {
  expect(() => canonicalJson({ n: Number.NaN })).toThrow();
  expect(() => canonicalJson({ f: () => 1 })).toThrow();
});

test("sha256Hex matches a known vector", () => {
  expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
