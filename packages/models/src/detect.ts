import { modelConfig } from "./config.ts";
import { listModelsFor } from "./doctor.ts";
import { PRESETS } from "./presets.ts";

// What this computer already has, so setup can suggest it: local models that are running, API
// keys already in the environment, and AI command-line tools that are signed in or installed
// (those become usable as "engines" in Phase 2 M6, after the terms check).

export interface Detected {
  /** Installed Ollama models, or null when Ollama isn't running. */
  ollama: string[] | null;
  /** Presets whose key variable is set, with the variable's name (never the key). */
  envKeys: { provider: string; variable: string }[];
  /** AI command-line tools found on the PATH. */
  clis: { name: string; path: string }[];
}

export async function detect(
  env: Record<string, string | undefined> = process.env,
  o: { listOllama?: () => Promise<string[]>; which?: (cmd: string) => string | null } = {},
): Promise<Detected> {
  let ollama: string[] | null = null;
  try {
    ollama = await (o.listOllama ?? (() => listModelsFor(modelConfig({}), AbortSignal.timeout(2_000))))();
  } catch {
    ollama = null;
  }
  const envKeys: Detected["envKeys"] = [];
  for (const p of PRESETS) {
    const v = p.keyEnv.find((k) => env[k]);
    if (v) envKeys.push({ provider: p.id, variable: v });
  }
  const which = o.which ?? ((cmd: string) => Bun.which(cmd));
  const clis: Detected["clis"] = [];
  for (const name of ["claude", "codex", "gemini"]) {
    const path = which(name);
    if (path) clis.push({ name, path });
  }
  return { ollama, envKeys, clis };
}
