import {
  type ChatMessage,
  type ChatRequest,
  kindForStatus,
  type ModelEvent,
  type ModelProvider,
  type StopReason,
  type ToolCall,
} from "./types.ts";

// Ollama's own chat API (/api/chat). Used instead of its OpenAI-compatible endpoint because only the
// native API lets us set the context window and turn thinking off:
//
//   num_ctx  Ollama's default is 4,096 tokens. A thinking model writes 3,000–5,500 tokens per step,
//            overflows that, and Ollama silently drops the start of the conversation, tool
//            definitions included. The model then types tool calls as text. 8,192 fits on 8 GB.
//   think    Off by default: on an 8 GB Mac, thinking turns a 30 s step into 3–5 minutes.

export const DEFAULT_CONTEXT = 8192;

export interface OllamaOptions {
  /** Server root, e.g. http://127.0.0.1:11434 (a trailing /v1 is ignored). */
  baseUrl: string;
  model: string;
  /** Context window in tokens. */
  numCtx?: number;
  /** Let thinking models think. Ignored by models that can't switch it off. */
  think?: boolean;
  /** How long Ollama keeps the model loaded after a request, e.g. "5m". */
  keepAlive?: string;
}

export const ollamaRoot = (baseUrl: string) => baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");

type Wire = Record<string, unknown>;

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export function toOllamaWire(messages: ChatMessage[]): Wire[] {
  const names = new Map<string, string>();
  return messages.map((m) => {
    if (m.role === "assistant" && m.toolCalls?.length) {
      for (const c of m.toolCalls) names.set(c.id, c.name);
      return {
        role: "assistant",
        content: m.content,
        tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: parseArgs(c.arguments) } })),
      };
    }
    if (m.role === "tool") {
      const name = names.get(m.toolCallId);
      return { role: "tool", content: m.content, ...(name ? { tool_name: name } : {}) };
    }
    return { role: m.role, content: m.content };
  });
}

interface Chunk {
  error?: string;
  message?: {
    content?: string;
    thinking?: string;
    tool_calls?: { id?: string; function?: { name?: string; arguments?: unknown } }[];
  };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

/** Turns Ollama's newline-delimited JSON stream into ModelEvents. */
export async function* parseOllamaStream(chunks: AsyncIterable<string>): AsyncIterable<ModelEvent> {
  let buffer = "";
  let n = 0;
  let calls = 0;
  let done: Chunk | undefined;

  const handle = function* (line: string): Generator<ModelEvent> {
    let c: Chunk;
    try {
      c = JSON.parse(line);
    } catch {
      return;
    }
    if (c.error) {
      done = c;
      yield { type: "done", stop: "error", error: c.error };
      return;
    }
    const m = c.message ?? {};
    if (m.thinking) yield { type: "reasoning", delta: m.thinking };
    if (m.content) yield { type: "text", delta: m.content };
    for (const tc of m.tool_calls ?? []) {
      const name = tc.function?.name ?? "";
      if (!name) continue;
      const a = tc.function?.arguments ?? {};
      const raw = typeof a === "string" ? a : JSON.stringify(a);
      const call: ToolCall = { id: tc.id || `call_${n++}`, name, arguments: raw };
      calls++;
      let parsed: unknown = a;
      if (typeof a === "string") {
        try {
          parsed = JSON.parse(a);
        } catch (e) {
          yield { type: "tool_call", call, argsError: `Arguments are not valid JSON: ${(e as Error).message}` };
          continue;
        }
      }
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        yield { type: "tool_call", call, args: parsed as Record<string, unknown> };
      } else yield { type: "tool_call", call, argsError: "Arguments must be a JSON object" };
    }
    if (c.done) done = c;
  };

  for await (const text of chunks) {
    buffer += text;
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf("\n");
      if (line) yield* handle(line);
      if (done?.error) return;
    }
  }
  if (buffer.trim()) yield* handle(buffer.trim());
  if (done?.error) return;
  if (!done) {
    yield { type: "done", stop: "error", error: "The model's reply ended unexpectedly." };
    return;
  }
  yield { type: "usage", tokensIn: done.prompt_eval_count ?? 0, tokensOut: done.eval_count ?? 0 };
  const stop: StopReason = calls ? "tool" : done.done_reason === "length" ? "length" : "end";
  yield { type: "done", stop };
}

async function* decode(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  for await (const bytes of body) yield decoder.decode(bytes, { stream: true });
}

export class OllamaProvider implements ModelProvider {
  readonly id: string;
  constructor(private readonly o: OllamaOptions) {
    this.id = `ollama:${o.model}`;
  }

  async *chat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
    const options: Record<string, unknown> = { num_ctx: this.o.numCtx ?? DEFAULT_CONTEXT };
    if (req.maxTokens) options.num_predict = req.maxTokens;
    if (req.temperature !== undefined) options.temperature = req.temperature;
    const body: Record<string, unknown> = {
      model: this.o.model,
      messages: toOllamaWire(req.messages),
      stream: true,
      think: this.o.think ?? false,
      options,
    };
    if (this.o.keepAlive) body.keep_alive = this.o.keepAlive;
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }
    const url = `${ollamaRoot(this.o.baseUrl)}/api/chat`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
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
        error: `Can't reach ${this.o.baseUrl}. Is Ollama running? Start it with: ollama serve (${(e as Error).message})`,
        errorKind: "unavailable",
      };
      return;
    }
    if (!res.ok || !res.body) {
      const detail = (await res.text().catch(() => "")).slice(0, 500);
      let msg = detail;
      try {
        msg = (JSON.parse(detail) as { error?: string }).error ?? detail;
      } catch {}
      // A model that can't switch thinking off: retry once with thinking allowed.
      if (res.status === 400 && /think/i.test(msg) && body.think === false) {
        yield* new OllamaProvider({ ...this.o, think: true }).chat(req, signal);
        return;
      }
      yield {
        type: "done",
        stop: "error",
        error: `ollama answered ${res.status}: ${msg || res.statusText}`,
        errorKind: kindForStatus(res.status, msg),
      };
      return;
    }
    yield* parseOllamaStream(decode(res.body));
  }
}
