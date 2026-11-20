import { afterAll, expect, test } from "bun:test";
import { macKeychain, memorySecrets, SecretError } from "./keychain.ts";

// Uses a separate service name so it never touches Covo's real items, and cleans up after itself.
const kc = macKeychain("Covo Bot Tests");
const id = `test-${process.pid}`;
afterAll(() => kc.delete(id));

test("saves, reads, replaces and deletes a key in the macOS Keychain", async () => {
  expect(await kc.get(id)).toBeNull();
  await kc.put(id, "sk-test-123", "test key");
  expect(await kc.get(id)).toBe("sk-test-123");
  await kc.put(id, "sk-test-456");
  expect(await kc.get(id)).toBe("sk-test-456");
  await kc.delete(id);
  expect(await kc.get(id)).toBeNull();
  await kc.delete(id); // deleting twice is fine
});

test("a long secret (a sign-in token) is saved in parts, read back whole, and fully removed", async () => {
  const long = `eyJ${"A".repeat(9_500)}.sig`;
  await kc.put(id, long, "test token");
  expect(await kc.get(id)).toBe(long);
  expect(await kc.get(`${id}.p1`)).toHaveLength(3_000);
  await kc.put(id, "short-again"); // replacing it removes the old parts
  expect(await kc.get(id)).toBe("short-again");
  expect(await kc.get(`${id}.p1`)).toBeNull();
  await kc.put(id, long);
  await kc.delete(id);
  expect(await kc.get(id)).toBeNull();
  expect(await kc.get(`${id}.p4`)).toBeNull();
});

test("refuses values that can't be keys and ids that could inject commands", async () => {
  expect(kc.put(id, 'abc" -w "x')).rejects.toThrow(SecretError);
  expect(kc.put(id, "two words")).rejects.toThrow(SecretError);
  expect(kc.get('x" -a "y')).rejects.toThrow(SecretError);
});

test("the in-memory store behaves the same", async () => {
  const m = memorySecrets({ a: "1" });
  expect(await m.get("a")).toBe("1");
  await m.put("b", "2");
  await m.delete("a");
  expect([...m.items.keys()]).toEqual(["b"]);
});
