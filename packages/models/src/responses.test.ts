import { afterEach, describe, expect, test } from "bun:test";
import { ChatGPTSignInEnded } from "./chatgpt.ts";
import { parseResponsesStream, ResponsesProvider, toResponsesInput } from "./responses.ts";
import { collect, type ModelEvent } from "./types.ts";

// Phase 4 M1: OpenAI's Responses API, as "Sign in with ChatGPT" plan usage requires it.

async function* chunks(...parts: string[]): AsyncIterable<string> {
  for (const p of parts) yield p;
}
const sse = (...events: Record<string, unknown>[]) =>
  events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
async function all(it: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => server?.stop(true));

function serve(reply: (body: Record<string, unknown>) => Response) {
  const seen: { auth: string | null; body: Record<string, unknown> }[] = [];
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as Record<string, unknown>;
      seen.push({ auth: req.headers.get("authorization"), body });
      return reply(body);
    },
  });
  return { seen, base: `http://127.0.0.1:${server.port}/v1` };
}

describe("the Responses API", () => {
  test("sends the conversation the way the plan route wants it", async () => {
    const { seen, base } = serve(
      () =>
        new Response(sse({ type: "response.completed", response: {} }), {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const p = new ResponsesProvider({ name: "chatgpt", baseUrl: base, model: "gpt-6.1-sol", token: async () => "tok" });
    await collect(
      p.chat({
        messages: [
          { role: "system", content: "You are Covo's bot." },
          { role: "user", content: "Tidy README.md" },
          {
            role: "assistant",
            content: "Looking.",
            toolCalls: [{ id: "call_1", name: "read_file", arguments: '{"path":"README.md"}' }],
          },
          { role: "tool", toolCallId: "call_1", content: "# Demo" },
        ],
        tools: [{ name: "read_file", description: "Read a file", parameters: { type: "object", properties: {} } }],
        maxTokens: 500,
        temperature: 0.2,
      }),
    );
    const sent = seen[0];
    expect(sent?.auth).toBe("Bearer tok");
    expect(sent?.body).toEqual({
      model: "gpt-6.1-sol",
      store: false,
      stream: true,
      instructions: "You are Covo's bot.",
      input: [
        { role: "user", content: "Tidy README.md" },
        { role: "assistant", content: "Looking." },
        { type: "function_call", call_id: "call_1", name: "read_file", arguments: '{"path":"README.md"}' },
        { type: "function_call_output", call_id: "call_1", output: "# Demo" },
      ],
      tools: [
        {
          type: "function",
          name: "read_file",
          description: "Read a file",
          parameters: { type: "object", properties: {} },
          strict: false,
        },
      ],
    });
    // Fields the preview rejects are never sent; there's no system message in the input.
    for (const f of ["temperature", "max_output_tokens", "previous_response_id", "metadata", "user"])
      expect(sent?.body).not.toHaveProperty(f);
  });

  test("streams text and tool calls; usage at the end; only response.completed counts", async () => {
    // One stream, cut into pieces at awkward places, as the network delivers it.
    const stream = sse(
      { type: "response.created", response: {} },
      { type: "response.output_text.delta", delta: "Reading " },
      { type: "response.output_text.delta", delta: "it." },
      { type: "response.output_item.added", item: { type: "function_call", call_id: "c1", name: "read_file" } },
      { type: "response.function_call_arguments.delta", delta: '{"path":' },
      {
        type: "response.output_item.done",
        item: { type: "function_call", call_id: "c1", name: "read_file", arguments: '{"path":"README.md"}' },
      },
      { type: "response.completed", response: { usage: { input_tokens: 30, output_tokens: 7 } } },
    );
    const events = await all(
      parseResponsesStream(chunks(stream.slice(0, 77), stream.slice(77, 301), stream.slice(301))),
    );
    expect(
      events
        .filter((e) => e.type === "text")
        .map((e) => (e as { delta: string }).delta)
        .join(""),
    ).toContain("Reading it.");
    expect(events).toContainEqual({ type: "usage", tokensIn: 30, tokensOut: 7 });
    expect(events).toContainEqual({
      type: "tool_call",
      call: { id: "c1", name: "read_file", arguments: '{"path":"README.md"}' },
      args: { path: "README.md" },
    });
    expect(events.at(-1)).toEqual({ type: "done", stop: "tool" });

    const cut = await all(parseResponsesStream(chunks(sse({ type: "response.output_text.delta", delta: "Hal" }))));
    expect(cut.at(-1)).toMatchObject({ type: "done", stop: "error", errorKind: "unavailable" });
  });

  test("plan errors in plain words: the usage limit, an ended sign-in, a refused capability", async () => {
    const { base } = serve(() =>
      Response.json(
        { error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" } },
        { status: 429 },
      ),
    );
    const p = new ResponsesProvider({ name: "chatgpt", baseUrl: base, model: "m", token: async () => "t" });
    const limit = await collect(p.chat({ messages: [{ role: "user", content: "x" }] }));
    expect(limit.errorKind).toBe("quota");
    expect(limit.error).toContain("Usage limit reached");
    expect(limit.error).toContain("https://chatgpt.com/settings/usage");

    const failed = await all(
      parseResponsesStream(
        chunks(
          sse({
            type: "response.failed",
            response: { error: { code: "subscription_sharing_invalid_user", message: "no" } },
          }),
        ),
      ),
    );
    expect(failed.at(-1)).toMatchObject({
      stop: "error",
      errorKind: "auth",
      error: expect.stringContaining("Sign in again"),
    });

    const ended = new ResponsesProvider({
      name: "chatgpt",
      baseUrl: base,
      model: "m",
      token: async () => {
        throw new ChatGPTSignInEnded("Your ChatGPT sign-in has ended. Sign in again.");
      },
    });
    const r = await collect(ended.chat({ messages: [{ role: "user", content: "x" }] }));
    expect(r).toMatchObject({
      stop: "error",
      errorKind: "auth",
      error: "Your ChatGPT sign-in has ended. Sign in again.",
    });

    expect(
      toResponsesInput([
        { role: "system", content: "a" },
        { role: "system", content: "b" },
      ]),
    ).toEqual({
      instructions: "a\n\nb",
      input: [],
    });
  });
});
