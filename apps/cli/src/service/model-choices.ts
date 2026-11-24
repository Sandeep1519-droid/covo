import type { ApiModelGroup } from "@covo/api";
import { type ChatGPTModel, engineById, listOllamaModels, loadSettings, presetById } from "@covo/models";
import { engineModels } from "../commands/engines.ts";
import type { Ctx } from "../main.ts";

// Every model you can pick for a message, grouped by where it comes from: your plans (Codex, Claude
// Code, Sign in with ChatGPT) with each of their models, your keys, and the models on this Mac.
// A choice's value is what the task runs with: a saved model's name, "<name>:<model>" for another
// of its models, or "local:<model>" for a local one (packages/models/src/connections.ts).

const localModels = async (ctx: Ctx) =>
  (await (ctx.ollamaModels ?? (() => listOllamaModels(undefined, AbortSignal.timeout(2_000))))()).map((m) => ({
    slug: m.name,
    name: m.parameterSize ? `${m.name} · ${m.parameterSize}` : m.name,
  }));

export async function modelChoices(ctx: Ctx, chatgpt: () => Promise<ChatGPTModel[]>): Promise<ApiModelGroup[]> {
  const s = loadSettings(ctx.home);
  const groups: ApiModelGroup[] = [];
  for (const c of s.connections) {
    const isDefault = s.default === c.name;
    const info = engineById(c.provider);
    const preset = presetById(c.provider);
    if (info) {
      const list = await engineModels(ctx, info);
      groups.push({
        connection: c.name,
        label: info.id === "codex" ? "Your ChatGPT plan · Codex" : "Your Claude plan · Claude Code",
        subscription: info.id,
        isDefault,
        options: [
          { value: c.name, label: `${info.label}'s choice`, current: !c.model || c.model === "default" },
          ...list.map((m) => ({ value: `${c.name}:${m.slug}`, label: m.name, current: c.model === m.slug })),
        ],
      });
    } else if (c.provider === "chatgpt") {
      const list = await chatgpt().catch(() => []);
      const all = list.some((m) => m.slug === c.model) ? list : [{ slug: c.model, name: c.model }, ...list];
      groups.push({
        connection: c.name,
        label: "Your ChatGPT plan",
        subscription: "chatgpt",
        isDefault,
        options: all.map((m) => ({
          value: m.slug === c.model ? c.name : `${c.name}:${m.slug}`,
          label: m.name,
          current: m.slug === c.model,
        })),
      });
    } else if (preset?.id === "ollama") {
      const list = await localModels(ctx).catch(() => []);
      const all = list.some((m) => m.slug === c.model) ? list : [{ slug: c.model, name: c.model }, ...list];
      groups.push({
        connection: c.name,
        label: "On this Mac (free)",
        subscription: null,
        isDefault,
        options: all.map((m) => ({
          value: m.slug === c.model ? c.name : `${c.name}:${m.slug}`,
          label: m.name,
          current: m.slug === c.model,
        })),
      });
    } else {
      groups.push({
        connection: c.name,
        label: preset?.label ?? c.provider,
        subscription: null,
        isDefault,
        options: [{ value: c.name, label: c.model, current: true }],
      });
    }
  }
  // Your local models are always there to pick, even when none is saved.
  if (!s.connections.some((c) => presetById(c.provider)?.id === "ollama")) {
    const list = await localModels(ctx).catch(() => []);
    if (list.length)
      groups.push({
        connection: "local",
        label: "On this Mac (free)",
        subscription: null,
        isDefault: s.connections.length === 0,
        options: list.map((m) => ({ value: `local:${m.slug}`, label: m.name, current: false })),
      });
  }
  return groups;
}
