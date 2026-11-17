import type { ChatRequest, ModelEvent, ModelProvider } from "./types.ts";

/**
 * A scripted model for tests: each call to chat() plays the next reply in the script.
 * Records every request so tests can check what the engine sent. Costs nothing, never flaky.
 */
export class MockProvider implements ModelProvider {
  readonly id = "mock:scripted";
  readonly requests: ChatRequest[] = [];
  private turn = 0;

  constructor(private readonly script: ModelEvent[][]) {}

  async *chat(req: ChatRequest): AsyncIterable<ModelEvent> {
    this.requests.push(structuredClone(req));
    const reply = this.script[this.turn++];
    if (!reply) {
      yield { type: "done", stop: "error", error: `MockProvider: no scripted reply for turn ${this.turn}` };
      return;
    }
    yield* reply;
  }

  /** Helpers for writing scripts. */
  static text(text: string): ModelEvent[] {
    return [
      { type: "text", delta: text },
      { type: "done", stop: "end" },
    ];
  }

  static tool(name: string, args: Record<string, unknown>, id = `call_${name}`): ModelEvent[] {
    return [
      { type: "tool_call", call: { id, name, arguments: JSON.stringify(args) }, args },
      { type: "done", stop: "tool" },
    ];
  }
}
