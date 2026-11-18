// Provider-neutral chat types. Every model backend (local Ollama, OpenRouter, Gemini, a user's own
// API key, the claude command-line tool later) is adapted to these, so the engine never cares which
// one is in use.

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON text exactly as the model produced it. */
  arguments: string;
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string;
      toolCalls?: ToolCall[];
      /**
       * The provider's own reply, replayed unchanged on the next request by the same provider.
       * Claude needs this: its thinking blocks must be sent back exactly as they came.
       */
      raw?: RawReply;
    }
  | { role: "tool"; toolCallId: string; content: string };

export interface RawReply {
  provider: string;
  content: unknown;
}

/** Why a request failed, so a bot can switch to its fallback model (Phase 2, M2). */
export type ErrorKind = "auth" | "rate_limit" | "quota" | "unavailable" | "refused" | "bad_request" | "other";

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  maxTokens?: number;
  temperature?: number;
}

export type StopReason = "end" | "tool" | "length" | "error";

export type ModelEvent =
  | { type: "text"; delta: string }
  /** The model's private thinking (e.g. qwen3). Shown in logs, never treated as the answer. */
  | { type: "reasoning"; delta: string }
  | {
      type: "tool_call";
      call: ToolCall;
      /** Parsed arguments, or undefined when the JSON was invalid (see `argsError`). */
      args?: Record<string, unknown>;
      argsError?: string;
    }
  | { type: "usage"; tokensIn: number; tokensOut: number }
  | { type: "raw"; raw: RawReply }
  | { type: "done"; stop: StopReason; error?: string; errorKind?: ErrorKind };

export interface ModelProvider {
  /** e.g. "ollama:qwen3:4b" */
  readonly id: string;
  chat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ModelEvent>;
}

/** Collects a whole streamed reply. Handy for tests and simple callers. */
export interface ChatResult {
  text: string;
  reasoning: string;
  toolCalls: Extract<ModelEvent, { type: "tool_call" }>[];
  usage: { tokensIn: number; tokensOut: number };
  stop: StopReason;
  error?: string;
  errorKind?: ErrorKind;
  raw?: RawReply;
}

export async function collect(events: AsyncIterable<ModelEvent>): Promise<ChatResult> {
  const r: ChatResult = { text: "", reasoning: "", toolCalls: [], usage: { tokensIn: 0, tokensOut: 0 }, stop: "end" };
  for await (const e of events) {
    if (e.type === "text") r.text += e.delta;
    else if (e.type === "reasoning") r.reasoning += e.delta;
    else if (e.type === "tool_call") r.toolCalls.push(e);
    else if (e.type === "usage") r.usage = { tokensIn: e.tokensIn, tokensOut: e.tokensOut };
    else if (e.type === "raw") r.raw = e.raw;
    else {
      r.stop = e.stop;
      if (e.error) r.error = e.error;
      if (e.errorKind) r.errorKind = e.errorKind;
    }
  }
  return r;
}
