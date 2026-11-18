import { createInterface } from "node:readline/promises";

// Questions in the terminal. Keys are typed (or pasted) without being shown on screen.

export interface Prompter {
  /** Asks a question; an empty answer returns `def`. */
  ask(question: string, def?: string): Promise<string>;
  /** Asks for a secret without echoing it. */
  secret(question: string): Promise<string>;
}

export class Cancelled extends Error {}

export function terminalPrompter(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): Prompter {
  return {
    async ask(question, def) {
      const rl = createInterface({ input, output });
      try {
        const a = (await rl.question(`${question}${def ? ` [${def}]` : ""} `)).trim();
        return a || def || "";
      } finally {
        rl.close();
      }
    },
    secret(question) {
      output.write(`${question} `);
      return new Promise((resolve, reject) => {
        let value = "";
        const wasRaw = input.isRaw;
        input.setRawMode?.(true);
        input.resume();
        input.setEncoding("utf8");
        const done = (err?: Error) => {
          input.off("data", onData);
          input.setRawMode?.(wasRaw ?? false);
          input.pause();
          output.write(err ? "\n" : ` (${value.length} characters received)\n`);
          if (err) reject(err);
          else resolve(value.trim());
        };
        const onData = (chunk: string) => {
          for (const ch of chunk) {
            if (ch === "\r" || ch === "\n") return done();
            if (ch === "\u0003") return done(new Cancelled("Cancelled."));
            if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
            else if (ch >= " ") value += ch;
          }
        };
        input.on("data", onData);
      });
    },
  };
}

/** Scripted answers, for tests. Throws if asked more than it was given. */
export function scriptedPrompter(answers: string[]): Prompter & { asked: string[] } {
  const asked: string[] = [];
  const next = (q: string, def?: string) => {
    asked.push(q);
    if (!answers.length) throw new Error(`Unexpected question: ${q}`);
    const a = answers.shift() as string;
    return Promise.resolve(a === "" && def ? def : a);
  };
  return { asked, ask: next, secret: (q) => next(q) };
}
