import Anthropic from "@anthropic-ai/sdk";
import type { ChatMessage, ChatRequest, ErrorKind, ModelEvent, ModelProvider, StopReason } from "./types.ts";

// Claude through Anthropic's own Messages API, using the official SDK.
//
// Notes that shape this provider:
// - Claude's reply blocks (thinking, text, tool calls, fallback markers) are replayed unchanged on
//   the next request. Current models tie thinking blocks to the conversation and drop or reject
//   edited history, so Covo stores the raw content (`raw`) and sends it back as-is.
// - Thinking is left at the model's default (adaptive on current models).
// - Tool inputs are not streamed eagerly: Covo's tools write whole files, and the API's own JSON
//   validation guards against a silently truncated write. A reply cut off at max_tokens never runs
//   its tools.
// - Server-side fallbacks are on for the models that support them: if a model declines a request,
//   Anthropic re-runs it on a fallback model inside the same call ("default" routing).
// - All tool results for one turn go back in a single user message, so Claude keeps making
//   parallel calls.

export const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
/** Models that accept the server-side `fallbacks` parameter. */
const FALLBACK_MODELS = new Set([
  "claude-fable-5-2",
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-sonnet-5-5",
]);
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
/** Room for a long tool call (a whole file) plus thinking; within every current model's limit. */
const DEFAULT_MAX_TOKENS = 32_000;

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  /** Override for tests or a proxy; defaults to Anthropic's API. */
  baseUrl?: string;
  /** low | medium | high | xhigh | max. Left unset, the model's own default applies. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  maxRetries?: number;
}

type Param = Anthropic.Beta.BetaMessageParam;
type Block = Anthropic.Beta.BetaContentBlockParam;

/** Converts Covo's provider-neutral history to Claude's message format. */
export function toAnthropic(messages: ChatMessage[]): { system?: string; messages: Param[] } {
  const system: string[] = [];
  const out: Param[] = [];
  let toolResults: Block[] = [];
  const flush = () => {
    if (toolResults.length) out.push({ role: "user", content: toolResults });
    toolResults = [];
  };
  for (const m of messages) {
    if (m.role === "tool") {
      toolResults.push({ type: "tool_result", tool_use_id: m.toolCallId, content: m.content });
      continue;
    }
    flush();
    if (m.role === "system") system.push(m.content);
    else if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (m.raw?.provider === "anthropic" && Array.isArray(m.raw.content)) {
      out.push({ role: "assistant", content: m.raw.content as Block[] });
    } else {
      // History from another provider (or a recovered call): rebuild it from text and calls.
      const blocks: Block[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const c of m.toolCalls ?? []) {
        let input: unknown = {};
        try {
          input = JSON.parse(c.arguments);
        } catch {}
        blocks.push({ type: "tool_use", id: c.id, name: c.name, input });
      }
      out.push({ role: "assistant", content: blocks.length ? blocks : [{ type: "text", text: "(no reply)" }] });
    }
  }
  flush();
  return { ...(system.length ? { system: system.join("\n\n") } : {}), messages: out };
}

function errorOf(e: unknown): { kind: ErrorKind; message: string } {
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
    return { kind: "auth", message: "Anthropic rejected the API key. Check it with: covo models test" };
  }
  if (e instanceof Anthropic.RateLimitError) {
    return { kind: "rate_limit", message: "Anthropic's rate limit was reached. Try again shortly." };
  }
  if (e instanceof Anthropic.BadRequestError) {
    const msg = e.message;
    return /credit|billing|balance/i.test(msg)
      ? { kind: "quota", message: `Anthropic account has no credit left: ${msg}` }
      : { kind: "bad_request", message: `Anthropic refused the request: ${msg}` };
  }
  if (e instanceof Anthropic.NotFoundError) {
    return { kind: "bad_request", message: `Anthropic doesn't know that model or endpoint: ${e.message}` };
  }
  if (e instanceof Anthropic.InternalServerError) {
    return { kind: "unavailable", message: `Anthropic is having trouble (${e.status}). Try again later.` };
  }
  if (e instanceof Anthropic.APIConnectionError) {
    return { kind: "unavailable", message: `Can't reach Anthropic: ${e.message}` };
  }
  if (e instanceof Anthropic.APIError) return { kind: "other", message: `Anthropic error ${e.status}: ${e.message}` };
  return { kind: "other", message: (e as Error)?.message ?? String(e) };
}

const STOP: Partial<Record<Anthropic.Beta.BetaStopReason, StopReason>> = {
  end_turn: "end",
  stop_sequence: "end",
  tool_use: "tool",
  max_tokens: "length",
  model_context_window_exceeded: "length",
};

export class AnthropicProvider implements ModelProvider {
  readonly id: string;
  private readonly client: Anthropic;
  constructor(private readonly o: AnthropicOptions) {
    this.id = `anthropic:${o.model}`;
    this.client = new Anthropic({
      apiKey: o.apiKey,
      ...(o.baseUrl ? { baseURL: o.baseUrl } : {}),
      maxRetries: o.maxRetries ?? 2,
    });
  }

  async *chat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
    const { system, messages } = toAnthropic(req.messages);
    const fallbacks = FALLBACK_MODELS.has(this.o.model);
    const body: Parameters<Anthropic["beta"]["messages"]["stream"]>[0] = {
      model: this.o.model,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages,
      ...(system ? { system } : {}),
      ...(req.tools?.length
        ? {
            tools: req.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.parameters as Anthropic.Beta.BetaTool.InputSchema,
            })),
          }
        : {}),
      ...(this.o.effort ? { output_config: { effort: this.o.effort } } : {}),
      ...(fallbacks ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
    };

    let final: Anthropic.Beta.BetaMessage;
    try {
      const stream = this.client.beta.messages.stream(body, { signal });
      for await (const ev of stream) {
        if (ev.type !== "content_block_delta") continue;
        if (ev.delta.type === "text_delta") yield { type: "text", delta: ev.delta.text };
        else if (ev.delta.type === "thinking_delta" && ev.delta.thinking) {
          yield { type: "reasoning", delta: ev.delta.thinking };
        }
      }
      final = await stream.finalMessage();
    } catch (e) {
      if (signal?.aborted) {
        yield { type: "done", stop: "error", error: "Stopped." };
        return;
      }
      const err = errorOf(e);
      yield { type: "done", stop: "error", error: err.message, errorKind: err.kind };
      return;
    }

    yield {
      type: "usage",
      tokensIn:
        final.usage.input_tokens +
        (final.usage.cache_read_input_tokens ?? 0) +
        (final.usage.cache_creation_input_tokens ?? 0),
      tokensOut: final.usage.output_tokens,
    };

    if (final.stop_reason === "refusal") {
      const why = final.stop_details?.category ? ` (${final.stop_details.category})` : "";
      yield { type: "done", stop: "error", error: `Claude declined this request${why}.`, errorKind: "refused" };
      return;
    }

    const truncated = final.stop_reason === "max_tokens" || final.stop_reason === "model_context_window_exceeded";
    for (const b of final.content) {
      if (b.type !== "tool_use") continue;
      const call = { id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) };
      if (truncated) {
        yield {
          type: "tool_call",
          call,
          argsError: "The reply was cut off before this call was complete. Try again with smaller steps",
        };
      } else if (b.input && typeof b.input === "object" && !Array.isArray(b.input)) {
        yield { type: "tool_call", call, args: b.input as Record<string, unknown> };
      } else {
        yield { type: "tool_call", call, argsError: "Arguments must be a JSON object" };
      }
    }
    yield { type: "raw", raw: { provider: "anthropic", content: final.content } };
    const hasCalls = final.content.some((b) => b.type === "tool_use");
    yield { type: "done", stop: hasCalls ? "tool" : (STOP[final.stop_reason ?? "end_turn"] ?? "end") };
  }
}

/** Model ids the key can use (GET /v1/models). */
export async function listAnthropicModels(apiKey: string, baseUrl?: string, signal?: AbortSignal): Promise<string[]> {
  const client = new Anthropic({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}), maxRetries: 0 });
  const ids: string[] = [];
  for await (const m of client.models.list({}, { signal })) ids.push(m.id);
  return ids.sort();
}
