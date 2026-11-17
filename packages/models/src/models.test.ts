import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { modelConfig, providerFromConfig } from "./config.ts";
import { checkModels } from "./doctor.ts";
import { MockProvider } from "./mock.ts";
import { OllamaProvider, ollamaRoot, parseOllamaStream, toOllamaWire } from "./ollama.ts";
import { OpenAICompatibleProvider, parseStream, toWire } from "./openai-compatible.ts";
import { collect } from "./types.ts";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "..", "fixtures", name), "utf8");
async function* chunks(...parts: string[]) {
  for (const p of parts) yield p;
}
const sse = (...objs: unknown[]) => `${objs.map((o) => `data: ${JSON.stringify(o)}\n\n`).join("")}data: [DONE]\n\n`;
const delta = (d: unknown, finish: string | null = null) => ({
  choices: [{ index: 0, delta: d, finish_reason: finish }],
});

describe("parseStream with recorded Ollama replies", () => {
  test("plain text from qwen2.5:1.5b", async () => {
    const r = await collect(parseStream(chunks(fixture("ollama-qwen25-text.sse"))));
    expect(r).toMatchObject({ text: "ok", stop: "end", usage: { tokensIn: 36, tokensOut: 2 } });
    expect(r.toolCalls).toEqual([]);
  });

  test("tool call from qwen3:4b, with its thinking kept separate", async () => {
    const r = await collect(parseStream(chunks(fixture("ollama-qwen3-tool.sse"))));
    expect(r.stop).toBe("tool");
    expect(r.text).toBe("");
    expect(r.reasoning.length).toBeGreaterThan(100);
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0]?.call.name).toBe("write_file");
    expect(r.toolCalls[0]?.args).toEqual({ path: "notes.txt", text: "hello." });
    expect(r.usage.tokensOut).toBe(540);
  });

  test("survives the stream being cut at any byte", async () => {
    const text = fixture("ollama-qwen25-text.sse");
    const r = await collect(parseStream(chunks(...text.split(""))));
    expect(r.text).toBe("ok");
  });
});

describe("parseStream edge cases", () => {
  test("joins tool-call arguments sent in pieces, for several calls", async () => {
    const s = sse(
      delta({ tool_calls: [{ index: 0, id: "a", function: { name: "read_file", arguments: '{"pa' } }] }),
      delta({ tool_calls: [{ index: 1, id: "b", function: { name: "list_files", arguments: "{}" } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: 'th":"x"}' } }] }, "tool_calls"),
    );
    const r = await collect(parseStream(chunks(s)));
    expect(r.toolCalls.map((t) => [t.call.id, t.call.name, t.args])).toEqual([
      ["a", "read_file", { path: "x" }],
      ["b", "list_files", {}],
    ]);
  });

  test('counts tool calls even when the model says "stop"', async () => {
    const s = sse(
      delta({ tool_calls: [{ index: 0, id: "a", function: { name: "finish", arguments: "{}" } }] }, "stop"),
    );
    expect((await collect(parseStream(chunks(s)))).stop).toBe("tool");
  });

  test("reports broken tool arguments instead of throwing", async () => {
    const s = sse(
      delta(
        { tool_calls: [{ index: 0, id: "a", function: { name: "write_file", arguments: "{oops" } }] },
        "tool_calls",
      ),
    );
    const r = await collect(parseStream(chunks(s)));
    expect(r.toolCalls[0]?.args).toBeUndefined();
    expect(r.toolCalls[0]?.argsError).toContain("not valid JSON");
  });

  test("passes on server errors", async () => {
    const r = await collect(parseStream(chunks(sse({ error: { message: "model not found" } }))));
    expect(r).toMatchObject({ stop: "error", error: "model not found" });
  });

  test("notices a reply that ends early", async () => {
    const r = await collect(parseStream(chunks(`data: ${JSON.stringify(delta({ content: "hal" }))}\n\n`)));
    expect(r).toMatchObject({ text: "hal", stop: "error" });
  });

  test("maps the length limit", async () => {
    expect((await collect(parseStream(chunks(sse(delta({ content: "x" }, "length")))))).stop).toBe("length");
  });
});

test("toWire converts tool calls and results to the OpenAI format", () => {
  expect(
    toWire([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: '{"path":"a"}' }] },
      { role: "tool", toolCallId: "c1", content: "file text" },
    ]),
  ).toEqual([
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } }],
    },
    { role: "tool", tool_call_id: "c1", content: "file text" },
  ]);
});

describe("OpenAICompatibleProvider against a fake server", () => {
  let server: ReturnType<typeof Bun.serve>;
  let lastBody: Record<string, unknown> = {};
  let lastAuth: string | null = null;
  const finishCall = sse(
    delta(
      { tool_calls: [{ index: 0, id: "f", function: { name: "finish", arguments: '{"summary":"ok"}' } }] },
      "tool_calls",
    ),
    { choices: [], usage: { prompt_tokens: 20, completion_tokens: 8 } },
  );

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "tiny:1b" }, { id: "qwen3:4b" }] });
        if (url.pathname === "/v1/chat/completions") {
          lastBody = (await req.json()) as Record<string, unknown>;
          lastAuth = req.headers.get("authorization");
          if (lastBody.model === "broken") return new Response("model crashed", { status: 500 });
          return new Response(finishCall, { headers: { "content-type": "text/event-stream" } });
        }
        return new Response("not found", { status: 404 });
      },
    });
  });
  afterAll(() => server.stop(true));
  const base = () => `http://127.0.0.1:${server.port}/v1`;

  test("sends model, tools, streaming flag and key", async () => {
    const p = new OpenAICompatibleProvider({ name: "test", baseUrl: base(), model: "qwen3:4b", apiKey: "sk-test" });
    const r = await collect(
      p.chat({
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "finish", description: "d", parameters: {} }],
      }),
    );
    expect(r.toolCalls[0]?.args).toEqual({ summary: "ok" });
    expect(lastBody).toMatchObject({
      model: "qwen3:4b",
      stream: true,
      tools: [{ type: "function", function: { name: "finish" } }],
    });
    expect(lastAuth).toBe("Bearer sk-test");
  });

  test("turns HTTP errors into an error event", async () => {
    const p = new OpenAICompatibleProvider({ name: "test", baseUrl: base(), model: "broken" });
    expect(await collect(p.chat({ messages: [] }))).toMatchObject({
      stop: "error",
      error: "test answered 500: model crashed",
    });
  });

  test("explains when Ollama isn't running", async () => {
    const p = new OpenAICompatibleProvider({ name: "ollama", baseUrl: "http://127.0.0.1:9/v1", model: "x" });
    const r = await collect(p.chat({ messages: [] }));
    expect(r.stop).toBe("error");
    expect(r.error).toContain("ollama serve");
  });

  test("checkModels passes when the model exists and calls the tool", async () => {
    const checks = await checkModels({ name: "test", baseUrl: base(), model: "qwen3:4b" });
    expect(checks.map((c) => c.status)).toEqual(["pass", "pass", "pass"]);
  });

  test("checkModels says how to download a missing Ollama model", async () => {
    const checks = await checkModels({ name: "ollama", baseUrl: base(), model: "llama9:70b" });
    expect(checks.at(-1)).toMatchObject({ status: "fail" });
    expect(checks.at(-1)?.detail).toContain("ollama pull llama9:70b");
  });
});

test("MockProvider plays its script and records requests", async () => {
  const m = new MockProvider([MockProvider.tool("read_file", { path: "a" }), MockProvider.text("done")]);
  expect((await collect(m.chat({ messages: [{ role: "user", content: "1" }] }))).toolCalls[0]?.args).toEqual({
    path: "a",
  });
  expect((await collect(m.chat({ messages: [] }))).text).toBe("done");
  expect((await collect(m.chat({ messages: [] }))).stop).toBe("error");
  expect(m.requests).toHaveLength(3);
});

test("modelConfig defaults to local Ollama and reads overrides", () => {
  expect(modelConfig({})).toEqual({
    name: "ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "qwen3.5:4b",
    apiKey: undefined,
    numCtx: 8192,
    think: false,
  });
  expect(modelConfig({ COVO_MODEL_CONTEXT: "16384", COVO_MODEL_THINK: "on" })).toMatchObject({
    numCtx: 16384,
    think: true,
  });
  expect(providerFromConfig(modelConfig({})).id).toBe("ollama:qwen3.5:4b");
  expect(providerFromConfig(modelConfig({})) instanceof OllamaProvider).toBe(true);
  expect(
    modelConfig({
      COVO_MODEL_BASE_URL: "https://openrouter.ai/api/v1",
      COVO_MODEL: "x/y:free",
      COVO_MODEL_API_KEY: "k",
    }),
  ).toEqual({
    name: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "x/y:free",
    apiKey: "k",
  });
});

describe("Ollama's own API", () => {
  test("recorded tool call from qwen2.5:1.5b", async () => {
    const r = await collect(parseOllamaStream(chunks(fixture("ollama-native-tool.ndjson"))));
    expect(r.stop).toBe("tool");
    expect(r.toolCalls[0]).toMatchObject({ call: { name: "read_file" }, args: { path: "/path/to/README.md" } });
    expect(r.usage).toEqual({ tokensIn: 146, tokensOut: 24 });
  });

  test("recorded text, split at awkward places", async () => {
    const all = fixture("ollama-native-text.ndjson");
    const r = await collect(parseOllamaStream(chunks(all.slice(0, 37), all.slice(37, 400), all.slice(400))));
    expect(r.text.toLowerCase()).toContain("hello there");
    expect(r.stop).toBe("end");
  });

  test("thinking stays separate; errors and cut-off replies are reported", async () => {
    const line = (o: unknown) => `${JSON.stringify(o)}\n`;
    const r = await collect(
      parseOllamaStream(
        chunks(
          line({ message: { thinking: "hmm" } }),
          line({ message: { content: "hi" } }),
          line({ done: true, done_reason: "stop" }),
        ),
      ),
    );
    expect(r).toMatchObject({ text: "hi", reasoning: "hmm", stop: "end" });
    expect((await collect(parseOllamaStream(chunks(line({ error: "model 'x' not found" }))))).error).toBe(
      "model 'x' not found",
    );
    expect((await collect(parseOllamaStream(chunks(line({ message: { content: "par" } }))))).stop).toBe("error");
  });

  test("history goes out with argument objects and tool names", () => {
    expect(
      toOllamaWire([
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: '{"path":"a"}' }] },
        { role: "tool", toolCallId: "c1", content: "text" },
      ]),
    ).toEqual([
      { role: "assistant", content: "", tool_calls: [{ function: { name: "read_file", arguments: { path: "a" } } }] },
      { role: "tool", content: "text", tool_name: "read_file" },
    ]);
    expect(ollamaRoot("http://127.0.0.1:11434/v1/")).toBe("http://127.0.0.1:11434");
  });

  test("asks for an 8K context with thinking off, and retries with thinking for models that need it", async () => {
    const bodies: Record<string, unknown>[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const b = (await req.json()) as Record<string, unknown>;
        bodies.push(b);
        if (b.think === false && b.model === "always-thinks") {
          return Response.json({ error: "model does not support disabling thinking" }, { status: 400 });
        }
        return new Response(`${JSON.stringify({ message: { content: "ok" }, done: true, eval_count: 1 })}\n`);
      },
    });
    try {
      const baseUrl = `http://127.0.0.1:${server.port}/v1`;
      const r = await collect(new OllamaProvider({ baseUrl, model: "m" }).chat({ messages: [] }));
      expect(r.text).toBe("ok");
      expect(bodies[0]).toMatchObject({ model: "m", stream: true, think: false, options: { num_ctx: 8192 } });
      const t = await collect(new OllamaProvider({ baseUrl, model: "always-thinks" }).chat({ messages: [] }));
      expect(t.text).toBe("ok");
      expect(bodies.slice(1).map((b) => b.think)).toEqual([false, true]);
    } finally {
      server.stop(true);
    }
  });
});
