import { expect, test } from "bun:test";
import { FallbackProvider } from "./fallback.ts";
import { MockProvider } from "./mock.ts";
import { collect, type ModelEvent, type ModelProvider } from "./types.ts";

const scripted = (id: string, events: ModelEvent[]): ModelProvider => ({
  id,
  async *chat() {
    yield* events;
  },
});

test("switches on a refusal reported after a usage line, and stays switched", async () => {
  const a = scripted("a:1", [
    { type: "usage", tokensIn: 5, tokensOut: 0 },
    { type: "done", stop: "error", error: "declined", errorKind: "refused" },
  ]);
  const b = new MockProvider([MockProvider.text("from b"), MockProvider.text("b again")]);
  const switches: string[] = [];
  const p = new FallbackProvider(
    [
      { label: "a", provider: a },
      { label: "b", provider: b },
    ],
    (s) => switches.push(`${s.from}->${s.to}:${s.kind}`),
  );
  expect((await collect(p.chat({ messages: [] }))).text).toBe("from b");
  expect((await collect(p.chat({ messages: [] }))).text).toBe("b again"); // a isn't asked again
  expect(switches).toEqual(["a->b:refused"]);
  expect(p.id).toBe("mock:scripted");
  expect(p.current).toBe("b");
});

test("doesn't retry once the model has started answering", async () => {
  const a = scripted("a:1", [
    { type: "text", delta: "half an ans" },
    { type: "done", stop: "error", error: "connection dropped", errorKind: "unavailable" },
  ]);
  const p = new FallbackProvider([
    { label: "a", provider: a },
    { label: "b", provider: new MockProvider([MockProvider.text("b")]) },
  ]);
  const r = await collect(p.chat({ messages: [] }));
  expect(r).toMatchObject({ text: "half an ans", stop: "error", errorKind: "unavailable" });
  expect(p.switches).toEqual([]);
});

test("the last model's failure is reported as it is", async () => {
  const fail = (id: string) =>
    scripted(id, [{ type: "done", stop: "error", error: `${id} down`, errorKind: "unavailable" }]);
  const p = new FallbackProvider([
    { label: "a", provider: fail("a:1") },
    { label: "b", provider: fail("b:1") },
  ]);
  expect(await collect(p.chat({ messages: [] }))).toMatchObject({ stop: "error", error: "b:1 down" });
  expect(p.switches.map((s) => s.to)).toEqual(["b"]);
});

test("stopping by hand doesn't trigger a switch", async () => {
  const ac = new AbortController();
  ac.abort();
  const p = new FallbackProvider([
    {
      label: "a",
      provider: scripted("a:1", [{ type: "done", stop: "error", error: "Stopped.", errorKind: "unavailable" }]),
    },
    { label: "b", provider: new MockProvider([MockProvider.text("b")]) },
  ]);
  expect((await collect(p.chat({ messages: [] }, ac.signal))).error).toBe("Stopped.");
  expect(p.switches).toEqual([]);
});

test("error kinds come from HTTP statuses", async () => {
  const { kindForStatus } = await import("./types.ts");
  expect([401, 402, 404, 429, 503, 400].map((s) => kindForStatus(s))).toEqual([
    "auth",
    "quota",
    "not_found",
    "rate_limit",
    "unavailable",
    "bad_request",
  ]);
  expect(kindForStatus(429, "You exceeded your current quota")).toBe("quota");
});
