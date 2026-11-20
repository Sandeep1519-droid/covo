import {
  type ChatMessage,
  type ChatRequest,
  type ErrorKind,
  kindForStatus,
  type ModelEvent,
  type ModelProvider,
} from "./types.ts";

// OpenAI's Responses API, the only one "Sign in with ChatGPT" plan usage accepts (Phase 4 M1;
// developers.openai.com/siwc, a preview, checked 20 Nov 2026). Following its rules:
//   • store: false and stream: true on every request; the whole conversation goes in `input`
//     (no previous_response_id);
//   • system text goes in `instructions`, never as a system message;
//   • none of the fields the preview rejects (temperature, max_output_tokens, metadata, user…);
//   • function tools only;
//   • a reply counts only when `response.completed` arrives.

export interface ResponsesOptions {
  /** Short label for ids and messages, e.g. "chatgpt". */
  name: string;
  baseUrl: string;
  model: string;
  /** A fresh access token for each request; it may refresh the sign-in first. */
  token: () => Promise<string>;
  fetch?: typeof fetch;
}

/** Turns Covo's conversation into the Responses API's `instructions` and `input`. */
export function toResponsesInput(messages: ChatMessage[]): { instructions: string; input: Record<string, unknown>[] } {
  const instructions: string[] = [];
  const input: Record<string, unknown>[] = [];
  for (const m of messages) {
    if (m.role === "system") instructions.push(m.content);
    else if (m.role === "user") input.push({ role: "user", content: m.content });
    else if (m.role === "assistant") {
      if (m.content) input.push({ role: "assistant", content: m.content });
      for (const c of m.toolCalls ?? [])
        input.push({ type: "function_call", call_id: c.id, name: c.name, arguments: c.arguments || "{}" });
    } else input.push({ type: "function_call_output", call_id: m.toolCallId, output: m.content });
  }
  return { instructions: instructions.join("\n\n"), input };
}

/** What OpenAI's plan-usage error codes mean, in plain words (siwc errors-and-recovery). */
const PLAN_ERRORS: Record<string, { kind: ErrorKind; text: string }> = {
  subscription_sharing_usage_limit_exceeded: {
    kind: "quota",
    text: "Usage limit reached on your ChatGPT plan. Review your plan or this app's limit in ChatGPT settings: https://chatgpt.com/settings/usage",
  },
  subscription_sharing_usage_unavailable: {
    kind: "unavailable",
    text: "ChatGPT plan usage isn't available right now. Try again in a little while.",
  },
  subscription_sharing_user_unavailable: {
    kind: "unavailable",
    text: "ChatGPT plan usage isn't available for your account right now. Try again later.",
  },
  subscription_sharing_invalid_user: {
    kind: "auth",
    text: "OpenAI no longer accepts Covo's ChatGPT sign-in. Sign in again: Settings → AI models → Continue with ChatGPT.",
  },
  subscription_sharing_user_not_eligible: {
    kind: "auth",
    text: "This ChatGPT account can't use its plan in other apps.",
  },
  subscription_sharing_route_not_supported: {
    kind: "refused",
    text: "OpenAI doesn't allow this request on a ChatGPT plan.",
  },
  subscription_sharing_unsupported_capability: {
    kind: "bad_request",
    text: "This request uses something ChatGPT plan usage doesn't support yet",
  },
};

interface ErrorBody {
  error?: { code?: string; message?: string; param?: string } | string;
  detail?: string;
  code?: string;
  message?: string;
}

/** An error from OpenAI, as Covo's error kind and a plain message. */
export function planError(status: number | null, body: ErrorBody | null, raw = ""): { kind: ErrorKind; text: string } {
  const err = typeof body?.error === "object" ? body.error : undefined;
  const code = err?.code ?? body?.code;
  const known = code ? PLAN_ERRORS[code] : undefined;
  if (known) {
    const param = err?.param ? ` (${err.param})` : "";
    return {
      kind: known.kind,
      text: code === "subscription_sharing_unsupported_capability" ? `${known.text}${param}.` : known.text,
    };
  }
  const message =
    err?.message ?? (typeof body?.error === "string" ? body.error : undefined) ?? body?.detail ?? body?.message ?? raw;
  return {
    kind: status === null ? "other" : kindForStatus(status, raw),
    text: `OpenAI answered${status === null ? "" : ` ${status}`}: ${(message || "no details").slice(0, 300)}`,
  };
}

function toolEvent(callId: string, name: string, args: string): ModelEvent {
  const call = { id: callId, name, arguments: args || "{}" };
  try {
    const parsed = JSON.parse(call.arguments);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      return { type: "tool_call", call, argsError: "Arguments must be a JSON object" };
    return { type: "tool_call", call, args: parsed as Record<string, unknown> };
  } catch (e) {
    return { type: "tool_call", call, argsError: `Arguments are not valid JSON: ${(e as Error).message}` };
  }
}

/** Turns the Responses API's server-sent events into ModelEvents. */
export async function* parseResponsesStream(chunks: AsyncIterable<string>): AsyncIterable<ModelEvent> {
  let buffer = "";
  const calls: { callId: string; name: string; args: string }[] = [];
  let ended: ModelEvent | null = null;

  const handle = function* (data: string): Generator<ModelEvent> {
    let e: {
      type?: string;
      delta?: string;
      item?: { type?: string; call_id?: string; name?: string; arguments?: string };
      response?: {
        usage?: { input_tokens?: number; output_tokens?: number };
        error?: { code?: string; message?: string } | null;
        incomplete_details?: { reason?: string } | null;
      };
      code?: string;
      message?: string;
    };
    try {
      e = JSON.parse(data);
    } catch {
      return;
    }
    switch (e.type) {
      case "response.output_text.delta":
        if (e.delta) yield { type: "text", delta: e.delta };
        return;
      case "response.reasoning_summary_text.delta":
        if (e.delta) yield { type: "reasoning", delta: e.delta };
        return;
      case "response.output_item.done":
        if (e.item?.type === "function_call" && e.item.name)
          calls.push({
            callId: e.item.call_id ?? `call_${calls.length}`,
            name: e.item.name,
            args: e.item.arguments ?? "",
          });
        return;
      case "response.completed": {
        const u = e.response?.usage;
        if (u) yield { type: "usage", tokensIn: u.input_tokens ?? 0, tokensOut: u.output_tokens ?? 0 };
        for (const c of calls) yield toolEvent(c.callId, c.name, c.args);
        ended = { type: "done", stop: calls.length ? "tool" : "end" };
        return;
      }
      case "response.incomplete": {
        const reason = e.response?.incomplete_details?.reason ?? "unknown";
        ended =
          reason === "max_output_tokens"
            ? { type: "done", stop: "length" }
            : { type: "done", stop: "error", error: `The reply stopped early (${reason}).`, errorKind: "other" };
        return;
      }
      case "response.failed": {
        const p = planError(null, { error: e.response?.error ?? undefined });
        ended = { type: "done", stop: "error", error: p.text, errorKind: p.kind };
        return;
      }
      case "error": {
        const p = planError(null, { code: e.code, message: e.message });
        ended = { type: "done", stop: "error", error: p.text, errorKind: p.kind };
        return;
      }
      default:
        return;
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
      if (ended) {
        yield ended;
        return;
      }
    }
  }
  const tail = buffer.trim();
  if (tail.startsWith("data:")) yield* handle(tail.slice(5).trim());
  // Only response.completed counts: a stream that just stops is an error.
  yield ended ?? {
    type: "done",
    stop: "error",
    error: "The reply ended before it was complete.",
    errorKind: "unavailable",
  };
}

async function* decode(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  for await (const bytes of body) yield decoder.decode(bytes, { stream: true });
}

export class ResponsesProvider implements ModelProvider {
  readonly id: string;
  constructor(private readonly o: ResponsesOptions) {
    this.id = `${o.name}:${o.model}`;
  }

  async *chat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
    const { instructions, input } = toResponsesInput(req.messages);
    const body: Record<string, unknown> = { model: this.o.model, input, store: false, stream: true };
    if (instructions) body.instructions = instructions;
    if (req.tools?.length) {
      // Not strict: Covo's tool schemas have optional fields, which strict mode would reject.
      body.tools = req.tools.map((t) => ({
        type: "function",
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        strict: false,
      }));
    }

    let token: string;
    try {
      token = await this.o.token();
    } catch (e) {
      yield { type: "done", stop: "error", error: (e as Error).message, errorKind: "auth" };
      return;
    }
    let res: Response;
    try {
      res = await (this.o.fetch ?? fetch)(`${this.o.baseUrl.replace(/\/$/, "")}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
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
        error: `Can't reach OpenAI (${(e as Error).message}).`,
        errorKind: "unavailable",
      };
      return;
    }
    if (!res.ok || !res.body) {
      const raw = (await res.text().catch(() => "")).slice(0, 2_000);
      let parsed: ErrorBody | null = null;
      try {
        parsed = JSON.parse(raw) as ErrorBody;
      } catch {}
      const p = planError(res.status, parsed, raw);
      yield { type: "done", stop: "error", error: p.text, errorKind: p.kind };
      return;
    }
    yield* parseResponsesStream(decode(res.body));
  }
}
