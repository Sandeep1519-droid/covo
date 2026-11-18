import { type ChatRequest, type ErrorKind, FALLBACK_KINDS, type ModelEvent, type ModelProvider } from "./types.ts";

// A bot's models in order: "claude → gemini → local". Each request goes to the current model. If
// it fails before saying anything, for a reason another model might not have (a bad key, a rate
// limit, no credit left, the service is down, the model is missing, or a refusal), the next model
// takes over and stays in charge for the rest of the run. Mixing models turn by turn would confuse
// them.
//
// A failure after the model has started answering is not retried: part of the reply has already
// been streamed, and retrying could act twice.

export interface ChainEntry {
  /** What people call it: the saved model name, e.g. "claude". */
  label: string;
  provider: ModelProvider;
}

export interface FallbackSwitch {
  from: string;
  to: string;
  kind: ErrorKind;
  error: string;
}

export class FallbackProvider implements ModelProvider {
  private index = 0;
  readonly switches: FallbackSwitch[] = [];

  constructor(
    private readonly chain: ChainEntry[],
    private readonly onSwitch?: (s: FallbackSwitch) => void,
  ) {
    if (!chain.length) throw new Error("A model chain needs at least one model.");
  }

  /** The model answering now, e.g. "anthropic:claude-opus-5-5". */
  get id(): string {
    return (this.chain[this.index] as ChainEntry).provider.id;
  }

  get current(): string {
    return (this.chain[this.index] as ChainEntry).label;
  }

  async *chat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
    for (;;) {
      const entry = this.chain[this.index] as ChainEntry;
      const it = entry.provider.chat(req, signal)[Symbol.asyncIterator]();
      // Hold back usage reports until we know whether the model actually answered.
      const held: ModelEvent[] = [];
      let r = await it.next();
      while (!r.done && r.value.type === "usage") {
        held.push(r.value);
        r = await it.next();
      }
      if (r.done) {
        yield* held;
        return;
      }
      const e = r.value;
      const next = this.chain[this.index + 1];
      if (
        e.type === "done" &&
        e.stop === "error" &&
        e.errorKind &&
        FALLBACK_KINDS.has(e.errorKind) &&
        next &&
        !signal?.aborted
      ) {
        const s = { from: entry.label, to: next.label, kind: e.errorKind, error: e.error ?? "" };
        this.switches.push(s);
        this.index++;
        this.onSwitch?.(s);
        continue;
      }
      yield* held;
      yield e;
      for (let n = await it.next(); !n.done; n = await it.next()) yield n.value;
      return;
    }
  }
}
