import { listAnthropicModels } from "./anthropic.ts";
import { type ModelConfig, missingKey, providerFromConfig } from "./config.ts";
import { ollamaRoot } from "./ollama.ts";
import { listModels } from "./openai-compatible.ts";
import { collect, type ModelProvider } from "./types.ts";

export interface ModelCheck {
  name: string;
  status: "pass" | "fail" | "warn";
  detail: string;
}

export interface CheckModelsOptions {
  /** Skip the live test call (for quick runs). */
  live?: boolean;
  timeoutMs?: number;
  provider?: ModelProvider;
  /** Tests replace the model listing. */
  listModels?: (c: ModelConfig, signal?: AbortSignal) => Promise<string[]>;
}

/** Model names the configured service offers. */
export function listModelsFor(c: ModelConfig, signal?: AbortSignal): Promise<string[]> {
  if (c.kind === "anthropic") return listAnthropicModels(c.apiKey ?? "", c.baseUrl, signal);
  if (c.kind === "ollama") return listModels(`${ollamaRoot(c.baseUrl)}/v1`, undefined, signal);
  return listModels(c.baseUrl, c.apiKey, signal);
}

/** Checks that the configured model service answers, has the model, and can call tools. */
export async function checkModels(c: ModelConfig, o: CheckModelsOptions = {}): Promise<ModelCheck[]> {
  const checks: ModelCheck[] = [];
  const noKey = missingKey(c);
  if (noKey) return [{ name: "API key", status: "fail", detail: noKey }];
  if (c.keySource) checks.push({ name: "API key", status: "pass", detail: `from ${c.keySource}` });
  let models: string[];
  try {
    models = await (o.listModels ?? listModelsFor)(c, AbortSignal.timeout(10_000));
    checks.push({
      name: "Model service answers",
      status: "pass",
      detail: `${c.label} at ${c.baseUrl}, ${models.length} models`,
    });
  } catch (e) {
    const how = c.name === "ollama" ? " Start Ollama with: ollama serve" : "";
    checks.push({
      name: "Model service answers",
      status: "fail",
      detail: `Can't reach ${c.baseUrl} (${(e as Error).message}).${how}`,
    });
    return checks;
  }

  if (!c.model) {
    const shown = models.slice(0, 12).join(", ");
    checks.push({
      name: "Model chosen",
      status: "fail",
      detail: `Pick one with COVO_MODEL=<name>. Available: ${shown || "none"}${models.length > 12 ? `, … (${models.length - 12} more)` : ""}`,
    });
    return checks;
  }
  const has = models.includes(c.model) || models.includes(`${c.model}:latest`);
  if (!has) {
    const how = c.kind === "ollama" ? ` Download it with: ollama pull ${c.model}.` : "";
    const shown = models.slice(0, 12).join(", ");
    const more = models.length > 12 ? `, … (${models.length - 12} more)` : "";
    checks.push({
      name: c.local ? "Model is installed" : "Model is available",
      status: "fail",
      detail: `${c.model} not found.${how} ${c.local ? "Installed" : "Available"}: ${shown || "none"}${more}`,
    });
    return checks;
  }
  checks.push({ name: c.local ? "Model is installed" : "Model is available", status: "pass", detail: c.model });
  if (o.live === false) return checks;

  // A real round trip: the model must call a tool with the right argument.
  const provider = o.provider ?? providerFromConfig(c);
  const t0 = performance.now();
  const r = await collect(
    provider.chat(
      {
        messages: [
          { role: "system", content: "You are a test. Always answer by calling a tool." },
          { role: "user", content: 'Call the finish tool with summary set to "ok".' },
        ],
        tools: [
          {
            name: "finish",
            description: "End the task with a short summary.",
            parameters: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
          },
        ],
      },
      AbortSignal.timeout(o.timeoutMs ?? 180_000),
    ),
  );
  const secs = (performance.now() - t0) / 1000;
  // Time includes loading the model into memory, which dominates the first call; so no tokens/s figure.
  const timing = `${secs.toFixed(1)} s${c.local ? " including model loading" : ""}, ${r.usage.tokensOut} tokens`;
  if (r.stop === "error") {
    checks.push({ name: "Model can use tools", status: "fail", detail: r.error ?? "Unknown error" });
  } else if (r.toolCalls.some((t) => t.call.name === "finish" && typeof t.args?.summary === "string")) {
    checks.push({ name: "Model can use tools", status: "pass", detail: `Called the test tool correctly (${timing})` });
  } else {
    checks.push({
      name: "Model can use tools",
      status: "warn",
      detail: `Answered but didn't call the tool (${timing}). Bots need a model that supports tool calling.`,
    });
  }
  return checks;
}
