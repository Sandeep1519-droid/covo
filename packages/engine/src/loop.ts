import { canonicalJson, sha256Hex } from "@covo/core";
import { type ChatMessage, collect, type ModelProvider, type ToolCall, type ToolSpec } from "@covo/models";
import { toolCallsFromText } from "./text-tools.ts";
import type { ToolResult } from "./tools.ts";

// The agent loop: ask the model, run the tools it asks for, send back the results, repeat until it
// calls `finish`. Guards stop runaway runs: too many steps, the same action repeated with the same
// result, or too much time.

export interface LoopLimits {
  maxSteps: number;
  /** Stop after this many identical tool calls (same tool, arguments and result) in a row. */
  maxRepeats: number;
  maxMs: number;
  /** How many times to remind a model that answers in text instead of using tools. */
  maxNudges: number;
}

export const DEFAULT_LIMITS: LoopLimits = { maxSteps: 40, maxRepeats: 3, maxMs: 10 * 60_000, maxNudges: 1 };

export type LoopOutcome =
  | { kind: "finished"; summary: string; via: "finish" | "text" }
  | { kind: "stopped"; reason: string }
  | { kind: "failed"; error: string };

export interface ModelTurn {
  turn: number;
  secs: number;
  tokensIn: number;
  tokensOut: number;
  text: string;
  reasoning: string;
  toolCalls: number;
}

export interface ToolStep {
  call: ToolCall;
  args?: Record<string, unknown>;
  result: ToolResult;
  secs: number;
  fingerprint: string;
}

export interface LoopHooks {
  /** Runs before each model call; returning a reason stops the run (e.g. a spending limit you declined). */
  beforeModel?(messages: ChatMessage[]): Promise<string | undefined> | string | undefined;
  onModel?(t: ModelTurn): void | Promise<void>;
  onTool?(s: ToolStep): void | Promise<void>;
  /** Tool calls were recovered from the reply's text. */
  onRecovered?(count: number): void | Promise<void>;
}

export interface LoopInput {
  provider: ModelProvider;
  messages: ChatMessage[];
  tools: ToolSpec[];
  exec(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  limits?: Partial<LoopLimits>;
  hooks?: LoopHooks;
  signal?: AbortSignal;
  now?: () => number;
}

export interface LoopResult {
  outcome: LoopOutcome;
  messages: ChatMessage[];
  steps: number;
  tokensIn: number;
  tokensOut: number;
}

export const NUDGE =
  "Please keep going using the tools. When the task is done, call finish with a one-sentence summary.";

export async function runLoop(input: LoopInput): Promise<LoopResult> {
  const limits = { ...DEFAULT_LIMITS, ...input.limits };
  const now = input.now ?? Date.now;
  const started = now();
  const messages = [...input.messages];
  let steps = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let nudges = 0;
  let turn = 0;
  let lastPrint = "";
  let repeats = 0;
  const done = (outcome: LoopOutcome): LoopResult => ({ outcome, messages, steps, tokensIn, tokensOut });

  for (;;) {
    if (input.signal?.aborted) return done({ kind: "stopped", reason: "Stopped by you." });
    if (now() - started > limits.maxMs) {
      return done({ kind: "stopped", reason: `Time limit reached (${Math.round(limits.maxMs / 60_000)} min).` });
    }

    const stopReason = await input.hooks?.beforeModel?.(messages);
    if (stopReason) return done({ kind: "stopped", reason: stopReason });
    if (input.signal?.aborted) return done({ kind: "stopped", reason: "Stopped by you." });

    const t0 = now();
    const r = await collect(input.provider.chat({ messages, tools: input.tools }, input.signal));
    turn++;
    tokensIn += r.usage.tokensIn;
    tokensOut += r.usage.tokensOut;
    // No real calls? A small model may have typed them as JSON; use those instead.
    const toolCalls: typeof r.toolCalls = r.toolCalls.length
      ? r.toolCalls
      : toolCallsFromText(
          r.text,
          input.tools.map((t) => t.name),
        ).map((c) => ({ type: "tool_call" as const, ...c }));
    if (!r.toolCalls.length && toolCalls.length) await input.hooks?.onRecovered?.(toolCalls.length);
    await input.hooks?.onModel?.({
      turn,
      secs: (now() - t0) / 1000,
      tokensIn: r.usage.tokensIn,
      tokensOut: r.usage.tokensOut,
      text: r.text,
      reasoning: r.reasoning,
      toolCalls: toolCalls.length,
    });
    if (r.stop === "error") {
      if (input.signal?.aborted) return done({ kind: "stopped", reason: "Stopped by you." });
      return done({ kind: "failed", error: r.error ?? "The model returned an error." });
    }

    const calls = toolCalls.map((t) => t.call);
    // Keep the provider's own reply for replay, unless the calls were recovered from text (then
    // the raw reply has no matching tool calls and would confuse the provider).
    const raw = r.raw && toolCalls === r.toolCalls ? { raw: r.raw } : {};
    messages.push({ role: "assistant", content: r.text, ...(calls.length ? { toolCalls: calls } : {}), ...raw });

    if (calls.length === 0) {
      if (nudges < limits.maxNudges) {
        nudges++;
        messages.push({ role: "user", content: NUDGE });
        continue;
      }
      return done({ kind: "finished", summary: r.text.trim() || "The bot stopped without a summary.", via: "text" });
    }

    for (const tc of toolCalls) {
      steps++;
      if (steps > limits.maxSteps) return done({ kind: "stopped", reason: `Step limit reached (${limits.maxSteps}).` });
      const s0 = now();
      const result: ToolResult = tc.argsError
        ? {
            ok: false,
            output: `${tc.argsError}. Send the arguments as a JSON object.`,
            label: "bad arguments",
            mutating: false,
          }
        : await input.exec(tc.call.name, tc.args ?? {});
      const fingerprint = sha256Hex(
        `${tc.call.name}\n${canonicalJson(tc.args ?? tc.call.arguments)}\n${sha256Hex(result.output)}`,
      );
      messages.push({ role: "tool", toolCallId: tc.call.id, content: result.output });
      await input.hooks?.onTool?.({ call: tc.call, args: tc.args, result, secs: (now() - s0) / 1000, fingerprint });

      repeats = fingerprint === lastPrint ? repeats + 1 : 1;
      lastPrint = fingerprint;
      if (result.finished !== undefined) return done({ kind: "finished", summary: result.finished, via: "finish" });
      if (repeats >= limits.maxRepeats) {
        return done({
          kind: "stopped",
          reason: `The bot repeated the same action ${repeats} times with the same result (${tc.call.name}).`,
        });
      }
    }
  }
}
