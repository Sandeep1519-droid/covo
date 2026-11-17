import type { ChatMessage, ChatRequest, ModelEvent, ModelProvider, StopReason, ToolCall } from "./types.ts";

// One provider for every service that speaks the OpenAI chat-completions format:
// local Ollama (the free default), OpenRouter, Google Gemini's compatible endpoint, Groq,
// LM Studio, or a user's own OpenAI key. Streaming is always on.

export interface OpenAICompatibleOptions {
  /** Short label for logs, e.g. "ollama". */
  name: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

type WireMessage = Record<string, unknown>;

export function toWire(messages: ChatMessage[]): WireMessage[] {
  return messages.map((m) => {
    if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant",
        content: m.content,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.arguments },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

const STOP: Record<string, StopReason> = { stop: "end", tool_calls: "tool", function_call: "tool", length: "length" };

interface PendingCall {
  id: string;
  name: string;
  args: string;
}

function toolEvent(p: PendingCall, i: number): ModelEvent {
  const call: ToolCall = { id: p.id || `call_${i}`, name: p.name, arguments: p.args || "{}" };
  try {
    const parsed = JSON.parse(call.arguments);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { type: "tool_call", call, argsError: "Arguments must be a JSON object" };
    }
    return { type: "tool_call", call, args: parsed as Record<string, unknown> };
  } catch (e) {
    return { type: "tool_call", call, argsError: `Arguments are not valid JSON: ${(e as Error).message}` };
  }
}

/**
 * Turns a server-sent-events stream of chat-completion chunks into ModelEvents.
 * Tool-call pieces are gathered by index and emitted whole once the reply finishes.
 */
export async function* parseStream(chunks: AsyncIterable<string>): AsyncIterable<ModelEvent> {
  const pending = new Map<number, PendingCall>();
  let stop: StopReason | undefined;
  let buffer = "";
  let finished = false;

  const handle = function* (data: string): Generator<ModelEvent> {
    if (data === "[DONE]") {
      finished = true;
      return;
    }
    let chunk: {
      error?: { message?: string } | string;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      choices?: {
        index?: number;
        finish_reason?: string | null;
        delta?: {
          content?: string | null;
          reasoning?: string;
          reasoning_content?: string;
          tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
        };
      }[];
    };
    try {
      chunk = JSON.parse(data);
    } catch {
      return; // ignore keep-alive or malformed lines
    }
    if (chunk.error) {
      stop = "error";
      const msg = typeof chunk.error === "string" ? chunk.error : (chunk.error.message ?? "unknown error");
      yield { type: "done", stop: "error", error: msg };
      finished = true;
      return;
    }
    if (chunk.usage) {
      yield { type: "usage", tokensIn: chunk.usage.prompt_tokens ?? 0, tokensOut: chunk.usage.completion_tokens ?? 0 };
    }
    for (const choice of chunk.choices ?? []) {
      const d = choice.delta ?? {};
      const thinking = d.reasoning ?? d.reasoning_content;
      if (thinking) yield { type: "reasoning", delta: thinking };
      if (d.content) yield { type: "text", delta: d.content };
      for (const tc of d.tool_calls ?? []) {
        const i = tc.index ?? 0;
        const p = pending.get(i) ?? { id: "", name: "", args: "" };
        if (tc.id) p.id = tc.id;
        if (tc.function?.name) p.name = tc.function.name;
        if (tc.function?.arguments) p.args += tc.function.arguments;
        pending.set(i, p);
      }
      if (choice.finish_reason) stop = STOP[choice.finish_reason] ?? "end";
    }
  };

  for await (const text of chunks) {
    buffer += text;
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf("\n");
      if (line.startsWith("data:")) yield* handle(line.slice(5).trim());
      if (finished && stop === "error") return;
    }
  }
  const tail = buffer.trim();
  if (tail.startsWith("data:")) yield* handle(tail.slice(5).trim());
  if (stop === "error") return;

  // Some models send tool calls but finish with "stop"; the calls still count.
  const calls = [...pending.entries()].sort(([a], [b]) => a - b).map(([, p]) => p);
  for (const [i, p] of calls.entries()) if (p.name) yield toolEvent(p, i);
  if (!finished && stop === undefined) {
    yield { type: "done", stop: "error", error: "The model's reply ended unexpectedly." };
    return;
  }
  yield { type: "done", stop: calls.some((c) => c.name) ? "tool" : (stop ?? "end") };
}

async function* decode(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  for await (const bytes of body) yield decoder.decode(bytes, { stream: true });
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string;
  constructor(private readonly o: OpenAICompatibleOptions) {
    this.id = `${o.name}:${o.model}`;
  }

  async *chat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
    const body: Record<string, unknown> = {
      model: this.o.model,
      messages: toWire(req.messages),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }
    if (req.maxTokens) body.max_tokens = req.maxTokens;
    if (req.temperature !== undefined) body.temperature = req.temperature;

    let res: Response;
    try {
      res = await fetch(`${this.o.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.o.apiKey ? { authorization: `Bearer ${this.o.apiKey}` } : {}),
          ...this.o.headers,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (signal?.aborted) {
        yield { type: "done", stop: "error", error: "Stopped." };
        return;
      }
      yield {
        type: "done",
        stop: "error",
        error: `Can't reach ${this.o.baseUrl}. ${hint(this.o)}(${(e as Error).message})`,
      };
      return;
    }
    if (!res.ok || !res.body) {
      const detail = (await res.text().catch(() => "")).slice(0, 500);
      yield {
        type: "done",
        stop: "error",
        error: `${this.o.name} answered ${res.status}: ${detail || res.statusText}`,
      };
      return;
    }
    yield* parseStream(decode(res.body));
  }
}

function hint(o: OpenAICompatibleOptions): string {
  return o.name === "ollama" ? "Is Ollama running? Start it with: ollama serve " : "";
}

/** Model names the server offers (GET /models). */
export async function listModels(baseUrl: string, apiKey?: string, signal?: AbortSignal): Promise<string[]> {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    signal,
  });
  if (!res.ok) throw new Error(`GET /models answered ${res.status}`);
  const json = (await res.json()) as { data?: { id: string }[] };
  return (json.data ?? []).map((m) => m.id).sort();
}
