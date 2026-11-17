import { type ModelConfig, providerFromConfig } from "./config.ts";
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
}

/** Checks that the configured model service answers, has the model, and can call tools. */
export async function checkModels(c: ModelConfig, o: CheckModelsOptions = {}): Promise<ModelCheck[]> {
  const checks: ModelCheck[] = [];
  let models: string[];
  try {
    models = await listModels(c.baseUrl, c.apiKey, AbortSignal.timeout(5_000));
    checks.push({
      name: "Model service answers",
      status: "pass",
      detail: `${c.name} at ${c.baseUrl}, ${models.length} models`,
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

  const has = models.includes(c.model) || models.includes(`${c.model}:latest`);
  if (!has) {
    const how = c.name === "ollama" ? ` Download it with: ollama pull ${c.model}` : "";
    checks.push({
      name: "Model is installed",
      status: "fail",
      detail: `${c.model} not found.${how}. Installed: ${models.join(", ") || "none"}`,
    });
    return checks;
  }
  checks.push({ name: "Model is installed", status: "pass", detail: c.model });
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
  const timing = `${secs.toFixed(1)} s including model loading, ${r.usage.tokensOut} tokens`;
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
