import type { ToolCall } from "@cw/models";

// Small local models sometimes write a tool call as JSON in their reply instead of making a real
// call, e.g. ```json {"command": "write_file", "arguments": {...}} ```. When a reply has no real
// calls, these are recovered so the run can continue. Only known tool names are accepted.

/** Every top-level {...} block in the text, respecting strings and escapes. */
function jsonObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"' && depth > 0) inString = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0) out.push(text.slice(start, i + 1));
    }
  }
  return out;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

export interface RecoveredCall {
  call: ToolCall;
  args: Record<string, unknown>;
}

export function toolCallsFromText(text: string, toolNames: string[]): RecoveredCall[] {
  const known = new Set(toolNames);
  const found: RecoveredCall[] = [];
  for (const raw of jsonObjects(text)) {
    let v: unknown;
    try {
      v = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isObject(v)) continue;
    const fn = isObject(v.function) ? v.function : v;
    const name = [
      fn.name,
      v.command,
      v.tool,
      v.tool_name,
      typeof v.function === "string" ? v.function : undefined,
    ].find((n): n is string => typeof n === "string" && known.has(n));
    if (!name) continue;
    let args: unknown = fn.arguments ?? fn.parameters ?? fn.args ?? v.arguments ?? v.parameters ?? v.args ?? {};
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        continue;
      }
    }
    if (!isObject(args)) continue;
    found.push({ call: { id: `text_${found.length}`, name, arguments: JSON.stringify(args) }, args });
  }
  return found;
}
