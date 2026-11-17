import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ToolSpec } from "@cw/models";
import type { Sandbox } from "@cw/platform";

// The only things a Phase 1 bot can do. File tools work inside the run's workspace copy and refuse
// any path that leads outside it (absolute paths, "..", "~", or symlinks pointing out). Commands run
// in the macOS sandbox, which enforces the same boundary at the operating-system level.

export const MAX_READ_BYTES = 100_000;
export const MAX_RESULT_CHARS = 8_000;
const MAX_LIST = 200;

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: "list_files",
    description: "List files and folders in the workspace. Paths are relative to the workspace root.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: 'Folder to list, default "."' } },
    },
  },
  {
    name: "read_file",
    description: "Read a text file from the workspace.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "edit_file",
    description:
      "Change part of an existing text file: replaces old_text with new_text. old_text must match the file exactly, including spaces, and appear only once. Prefer this over write_file for existing files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_text: { type: "string", description: "Exact text to replace, copied from read_file" },
        new_text: { type: "string", description: "Text to put in its place" },
      },
      required: ["path", "old_text", "new_text"],
    },
  },
  {
    name: "write_file",
    description: "Create a new text file, or replace a whole file, with the full content.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string", description: "The complete file content" } },
      required: ["path", "content"],
    },
  },
  {
    name: "run_command",
    description:
      "Run a shell command in the workspace (no internet, nothing outside the workspace). Returns exit code and output.",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  },
  {
    name: "finish",
    description: "Call this when the task is done, with a one-sentence summary of what you did.",
    parameters: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
  },
];

export interface ToolResult {
  ok: boolean;
  /** Text sent back to the model. */
  output: string;
  /** Short line for people: "12 lines", "+6 lines", "exit 0". */
  label: string;
  /** Changes files in the workspace copy. */
  mutating: boolean;
  /** Refused by Coworker's own path check or by the macOS sandbox. */
  blocked?: "path" | "sandbox";
  /** Set by finish. */
  finished?: string;
}

export class PathError extends Error {}

/** Resolves a model-supplied path inside the workspace, or throws PathError. */
export function insideWorkspace(ws: string, p: unknown): string {
  if (typeof p !== "string" || p.trim() === "") throw new PathError("A path is required.");
  const raw = p.trim();
  if (raw.startsWith("~"))
    throw new PathError(`"${raw}" is outside the workspace. Only workspace files are available.`);
  const abs = resolve(ws, raw);
  const rel = relative(ws, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new PathError(`"${raw}" is outside the workspace. Only workspace files are available.`);
  }
  // Follow symlinks for whatever part of the path already exists.
  let probe = abs;
  while (!existsSync(probe) && probe !== ws) probe = dirname(probe);
  const real = realpathSync(probe);
  const realRel = relative(ws, real);
  if (realRel.startsWith("..") || isAbsolute(realRel)) throw new PathError(`"${raw}" leads outside the workspace.`);
  return abs;
}

const clip = (s: string, n = MAX_RESULT_CHARS) =>
  s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters cut)` : s;
const countOf = (hay: string, needle: string) => hay.split(needle).length - 1;
const lines = (s: string) => (s === "" ? 0 : s.split("\n").length - (s.endsWith("\n") ? 1 : 0));

export interface ToolContext {
  /** Real path of the run's workspace copy. */
  ws: string;
  tmp: string;
  sandbox: Sandbox;
  commandTimeoutMs: number;
}

export async function runTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try {
    switch (name) {
      case "list_files": {
        const dir = insideWorkspace(ctx.ws, args.path ?? ".");
        if (!existsSync(dir) || !statSync(dir).isDirectory()) {
          return { ok: false, output: `Not a folder: ${args.path ?? "."}`, label: "not a folder", mutating: false };
        }
        const out: string[] = [];
        const walk = (d: string, depth: number) => {
          for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            if (out.length >= MAX_LIST || e.name === ".git" || e.name === ".DS_Store") continue;
            const rel = relative(ctx.ws, join(d, e.name));
            out.push(e.isDirectory() ? `${rel}/` : rel);
            if (e.isDirectory() && depth < 3) walk(join(d, e.name), depth + 1);
          }
        };
        walk(dir, 0);
        const more = out.length >= MAX_LIST ? `\n… (stopped at ${MAX_LIST} entries)` : "";
        return {
          ok: true,
          output: out.length ? out.join("\n") + more : "(empty)",
          label: `${out.length} entries`,
          mutating: false,
        };
      }
      case "read_file": {
        const f = insideWorkspace(ctx.ws, args.path);
        if (!existsSync(f) || !statSync(f).isFile()) {
          return { ok: false, output: `File not found: ${args.path}`, label: "not found", mutating: false };
        }
        const buf = readFileSync(f);
        if (buf.includes(0))
          return { ok: false, output: "That file is binary, not text.", label: "binary", mutating: false };
        const text = buf.subarray(0, MAX_READ_BYTES).toString("utf8");
        const cut =
          buf.length > MAX_READ_BYTES ? `\n… (file is ${buf.length} bytes; showing the first ${MAX_READ_BYTES})` : "";
        return { ok: true, output: text + cut, label: `${lines(text)} lines`, mutating: false };
      }
      case "write_file": {
        const f = insideWorkspace(ctx.ws, args.path);
        if (typeof args.content !== "string") {
          return { ok: false, output: "content must be a string", label: "bad input", mutating: false };
        }
        const before = existsSync(f) ? readFileSync(f, "utf8") : null;
        mkdirSync(dirname(f), { recursive: true });
        writeFileSync(f, args.content);
        const delta = lines(args.content) - (before === null ? 0 : lines(before));
        const label = before === null ? `new, ${lines(args.content)} lines` : `${delta >= 0 ? "+" : ""}${delta} lines`;
        return { ok: true, output: `Wrote ${args.path} (${args.content.length} characters).`, label, mutating: true };
      }
      case "edit_file": {
        const f = insideWorkspace(ctx.ws, args.path);
        if (typeof args.old_text !== "string" || typeof args.new_text !== "string") {
          return { ok: false, output: "old_text and new_text must be strings", label: "bad input", mutating: false };
        }
        if (!existsSync(f) || !statSync(f).isFile()) {
          return {
            ok: false,
            output: `File not found: ${args.path}. Use write_file to create a new file.`,
            label: "not found",
            mutating: false,
          };
        }
        if (args.old_text === "") {
          return {
            ok: false,
            output: "old_text is empty. Copy the exact text to replace from read_file.",
            label: "bad input",
            mutating: false,
          };
        }
        const buf = readFileSync(f);
        if (buf.includes(0))
          return { ok: false, output: "That file is binary, not text.", label: "binary", mutating: false };
        const before = buf.toString("utf8");
        const found = countOf(before, args.old_text);
        if (found !== 1) {
          return {
            ok: false,
            output:
              found === 0
                ? `old_text was not found in ${args.path}. Read the file again and copy the exact text, including spaces and line breaks.`
                : `old_text appears ${found} times in ${args.path}. Include more of the surrounding text so it matches only once.`,
            label: found === 0 ? "text not found" : `matches ${found} times`,
            mutating: false,
          };
        }
        const after = before.replace(args.old_text, () => args.new_text as string);
        writeFileSync(f, after);
        const delta = lines(after) - lines(before);
        return {
          ok: true,
          output: `Edited ${args.path}.`,
          label: `${delta >= 0 ? "+" : ""}${delta} lines`,
          mutating: true,
        };
      }
      case "run_command": {
        if (typeof args.command !== "string" || !args.command.trim()) {
          return { ok: false, output: "command must be a non-empty string", label: "bad input", mutating: false };
        }
        const r = await ctx.sandbox.exec(["/bin/sh", "-c", args.command], {
          workspace: ctx.ws,
          tmp: ctx.tmp,
          timeoutMs: ctx.commandTimeoutMs,
        });
        const blocked = /Operation not permitted|sandbox|Could not resolve host/i.test(r.stderr);
        const parts = [`exit code ${r.code}${r.timedOut ? " (stopped: took too long)" : ""}`];
        if (r.stdout) parts.push(`stdout:\n${clip(r.stdout, 6_000)}`);
        if (r.stderr) parts.push(`stderr:\n${clip(r.stderr, 2_000)}`);
        return {
          ok: r.code === 0,
          output: parts.join("\n"),
          label: r.timedOut ? "timed out" : blocked && r.code !== 0 ? "blocked by sandbox" : `exit ${r.code}`,
          mutating: true, // a command may change files; the diff shows what actually changed
          blocked: blocked && r.code !== 0 ? "sandbox" : undefined,
        };
      }
      case "finish": {
        const summary = typeof args.summary === "string" && args.summary.trim() ? args.summary.trim() : "Done.";
        return { ok: true, output: "Finished.", label: "done", mutating: false, finished: summary };
      }
      default:
        return {
          ok: false,
          output: `Unknown tool "${name}". Available: ${TOOL_SPECS.map((t) => t.name).join(", ")}`,
          label: "unknown tool",
          mutating: false,
        };
    }
  } catch (e) {
    if (e instanceof PathError)
      return { ok: false, output: e.message, label: "outside workspace", mutating: false, blocked: "path" };
    return { ok: false, output: `Error: ${(e as Error).message}`, label: "error", mutating: false };
  }
}
