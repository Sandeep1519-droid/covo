import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { AnthropicProvider, toAnthropic } from "./anthropic.ts";
import { collect, type ToolSpec } from "./types.ts";

// A fake Anthropic API that streams replies in the Messages API's server-sent-events format.

type Reply = { status?: number; error?: { type: string; message: string }; events?: unknown[] };
let replies: Reply[] = [];
let requests: { headers: Headers; body: Record<string, unknown> }[] = [];
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      requests.push({ headers: req.headers, body: (await req.json()) as Record<string, unknown> });
      const r = replies.shift() ?? { status: 500, error: { type: "api_error", message: "no reply scripted" } };
      if (r.error) return Response.json({ type: "error", error: r.error }, { status: r.status ?? 400 });
      const body = (r.events ?? [])
        .map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`)
        .join("");
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    },
  });
});
afterAll(() => server.stop(true));
beforeEach(() => {
  replies = [];
  requests = [];
});

const provider = (model = "claude-opus-5-5") =>
  new AnthropicProvider({ apiKey: "sk-ant-test", model, baseUrl: `http://127.0.0.1:${server.port}`, maxRetries: 0 });

const start = (model = "claude-opus-5-5", input = 40) => ({
  type: "message_start",
  message: {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: input, output_tokens: 1 },
  },
});
const blockStart = (index: number, content_block: unknown) => ({ type: "content_block_start", index, content_block });
const delta = (index: number, d: unknown) => ({ type: "content_block_delta", index, delta: d });
const stop = (index: number) => ({ type: "content_block_stop", index });
const end = (stop_reason: string, output = 20, extra: Record<string, unknown> = {}) => [
  { type: "message_delta", delta: { stop_reason, stop_sequence: null, ...extra }, usage: { output_tokens: output } },
  { type: "message_stop" },
];

/** Thinking, a sentence, then a tool call whose arguments arrive in pieces. */
const toolTurn = () => [
  start(),
  blockStart(0, { type: "thinking", thinking: "", signature: "" }),
  delta(0, { type: "thinking_delta", thinking: "Read it first." }),
  delta(0, { type: "signature_delta", signature: "sig-abc" }),
  stop(0),
  blockStart(1, { type: "text", text: "" }),
  delta(1, { type: "text_delta", text: "Reading the file." }),
  stop(1),
  blockStart(2, { type: "tool_use", id: "toolu_1", name: "read_file", input: {} }),
  delta(2, { type: "input_json_delta", partial_json: '{"pa' }),
  delta(2, { type: "input_json_delta", partial_json: 'th": "README.md"}' }),
  stop(2),
  ...end("tool_use", 25),
];

const tools: ToolSpec[] = [
  {
    name: "read_file",
    description: "Read a file",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
];

test("streams text, keeps thinking separate, and assembles the tool call", async () => {
  replies.push({ events: toolTurn() });
  const r = await collect(provider().chat({ messages: [{ role: "user", content: "go" }], tools }));
  expect(r).toMatchObject({ text: "Reading the file.", reasoning: "Read it first.", stop: "tool" });
  expect(r.toolCalls).toHaveLength(1);
  expect(r.toolCalls[0]).toMatchObject({ call: { id: "toolu_1", name: "read_file" }, args: { path: "README.md" } });
  expect(r.usage).toEqual({ tokensIn: 40, tokensOut: 25 });
  // The whole reply is kept for replay, thinking signature included.
  expect(r.raw?.provider).toBe("anthropic");
  expect(JSON.stringify(r.raw?.content)).toContain("sig-abc");
});

test("sends the key, tools and server-side fallbacks for models that support them", async () => {
  replies.push({ events: toolTurn() }, { events: toolTurn() });
  await collect(provider().chat({ messages: [{ role: "user", content: "go" }], tools }));
  const first = requests[0];
  // SDK 1.x sends the key as a bearer token
  expect(first?.headers.get("authorization") ?? first?.headers.get("x-api-key")).toContain("sk-ant-test");
  expect(first?.headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
  expect(first?.body).toMatchObject({
    model: "claude-opus-5-5",
    stream: true,
    fallbacks: "default",
    tools: [{ name: "read_file", input_schema: { type: "object" } }],
  });
  expect(first?.body.thinking).toBeUndefined(); // the model's default (adaptive) applies

  await collect(provider("claude-haiku-5-5").chat({ messages: [{ role: "user", content: "go" }], tools }));
  expect(requests[1]?.body.fallbacks).toBeUndefined();
  expect(requests[1]?.headers.get("anthropic-beta") ?? "").not.toContain("server-side-fallback");
});

test("history: replays Claude's own blocks and groups tool results into one message", () => {
  const raw = { provider: "anthropic", content: [{ type: "thinking", thinking: "", signature: "s" }] };
  const { system, messages } = toAnthropic([
    { role: "system", content: "Be careful." },
    { role: "user", content: "go" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "a", name: "read_file", arguments: '{"path":"x"}' },
        { id: "b", name: "read_file", arguments: '{"path":"y"}' },
      ],
      raw,
    },
    { role: "tool", toolCallId: "a", content: "X" },
    { role: "tool", toolCallId: "b", content: "Y" },
    { role: "assistant", content: "From another model", toolCalls: [{ id: "c", name: "finish", arguments: "{}" }] },
    { role: "tool", toolCallId: "c", content: "Finished." },
  ]);
  expect(system).toBe("Be careful.");
  expect(messages).toEqual([
    { role: "user", content: "go" },
    { role: "assistant", content: raw.content as never },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "a", content: "X" },
        { type: "tool_result", tool_use_id: "b", content: "Y" },
      ],
    },
    {
      role: "assistant",
      content: [
        { type: "text", text: "From another model" },
        { type: "tool_use", id: "c", name: "finish", input: {} },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "c", content: "Finished." }] },
  ]);
});

test("a reply cut off at max_tokens never runs its tool call", async () => {
  replies.push({
    events: [
      start(),
      blockStart(0, { type: "tool_use", id: "toolu_2", name: "read_file", input: {} }),
      delta(0, { type: "input_json_delta", partial_json: '{"path": "REA' }),
      stop(0),
      ...end("max_tokens"),
    ],
  });
  const r = await collect(provider().chat({ messages: [{ role: "user", content: "go" }], tools }));
  expect(r.toolCalls[0]?.args).toBeUndefined();
  expect(r.toolCalls[0]?.argsError).toContain("cut off");
});

test("a refusal is reported, not treated as an answer", async () => {
  replies.push({
    events: [start(), ...end("refusal", 0, { stop_details: { type: "refusal", category: "cyber", explanation: "" } })],
  });
  const r = await collect(provider().chat({ messages: [{ role: "user", content: "go" }] }));
  expect(r).toMatchObject({ stop: "error", errorKind: "refused" });
});

test("API errors say what went wrong and what kind they are", async () => {
  replies.push(
    { status: 401, error: { type: "authentication_error", message: "invalid x-api-key" } },
    { status: 429, error: { type: "rate_limit_error", message: "slow down" } },
    { status: 400, error: { type: "invalid_request_error", message: "Your credit balance is too low" } },
  );
  const p = provider();
  const ask = () => collect(p.chat({ messages: [{ role: "user", content: "go" }] }));
  expect(await ask()).toMatchObject({ stop: "error", errorKind: "auth" });
  expect(await ask()).toMatchObject({ stop: "error", errorKind: "rate_limit" });
  expect(await ask()).toMatchObject({ stop: "error", errorKind: "quota" });
});
