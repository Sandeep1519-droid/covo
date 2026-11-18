import { existsSync } from "node:fs";
import { tildify } from "@covo/core";
import {
  addConnection,
  checkModels,
  type Detected,
  detect,
  listModelsFor,
  loadSettings,
  type ModelConfig,
  ModelConfigError,
  modelConfig,
  NAME_RE,
  PRESETS,
  presetById,
  removeConnection,
  resolveModel,
  setDefault,
  suggestName,
} from "@covo/models";
import { secrets as defaultSecrets, SecretError } from "@covo/platform";
import type { CliResult, Ctx } from "../main.ts";
import { Cancelled } from "../prompt.ts";

// covo models: connect the AI services you use. Keys go to the macOS Keychain.

const USAGE = `Usage:
  covo models                         Show saved models and what's on this Mac
  covo models add [provider]          Connect an AI service (asks questions)
      [--name <n>] [--model <m>] [--base-url <url>] [--key-stdin] [--default] [--no-test]
  covo models test [name]             Send one small test request
  covo models default <name>          Use this one when a bot doesn't say otherwise
  covo models remove <name>           Forget it and delete its key from the Keychain
`;

/** Models that can't chat (embeddings, images, speech), hidden from the picker. */
const NOT_CHAT = /embed|tts|whisper|dall-e|image|audio|moderation|transcribe|speech|realtime|search-preview|rerank/i;

const store = (ctx: Ctx) => ctx.secrets ?? defaultSecrets();

function flags(args: string[]): { positional: string[]; opts: Record<string, string | true> } {
  const positional: string[] = [];
  const opts: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (!a.startsWith("--")) positional.push(a);
    else if (["--name", "--model", "--base-url"].includes(a)) opts[a.slice(2)] = args[++i] ?? "";
    else opts[a.slice(2)] = true;
  }
  return { positional, opts };
}

export async function modelsCommand(ctx: Ctx, args: string[]): Promise<CliResult> {
  if (!existsSync(ctx.home)) return { code: 1, out: `Covo isn't set up in ${tildify(ctx.home)} yet. Run: covo init\n` };
  const [sub, ...rest] = args;
  try {
    if (!sub || sub === "list") return await listModels(ctx);
    if (sub === "add") return await add(ctx, rest);
    if (sub === "test") return await test(ctx, rest[0]);
    if (sub === "default" && rest[0]) {
      setDefault(ctx.home, rest[0]);
      return { code: 0, out: `Bots now use "${rest[0]}" unless they say otherwise.\n` };
    }
    if (sub === "remove" && rest[0]) {
      const c = await removeConnection(ctx.home, store(ctx), rest[0]);
      return { code: 0, out: `Removed "${c.name}"${c.keyId ? " and deleted its key from the Keychain" : ""}.\n` };
    }
    return { code: 2, out: USAGE };
  } catch (e) {
    if (e instanceof ModelConfigError || e instanceof SecretError || e instanceof Cancelled) {
      return { code: 1, out: `${e.message}\n` };
    }
    throw e;
  }
}

async function listModels(ctx: Ctx): Promise<CliResult> {
  const s = loadSettings(ctx.home);
  const lines: string[] = [];
  if (s.connections.length) {
    lines.push("Saved models");
    for (const c of s.connections) {
      const p = presetById(c.provider);
      const key = c.keyId ? "key in Keychain" : p?.local ? "no key needed" : "";
      lines.push(
        `  ${c.name === s.default ? "★" : " "} ${c.name.padEnd(12)} ${(p?.label ?? c.provider).padEnd(28)} ${c.model.padEnd(24)} ${key}`,
      );
    }
    lines.push("", "★ = used when a bot doesn't say otherwise");
  } else {
    lines.push("No saved models yet. Bots use the free local model (Ollama, qwen3.5:4b) until you add one.");
  }
  const d = await (ctx.detect ?? detect)(ctx.env);
  const found = describeDetected(d);
  if (found.length) lines.push("", "Found on this Mac", ...found.map((f) => `  ${f}`));
  lines.push("", "Connect another: covo models add", "");
  return { code: 0, out: lines.join("\n") };
}

function describeDetected(d: Detected): string[] {
  const out: string[] = [];
  if (d.ollama) {
    const n = d.ollama.length;
    out.push(`Ollama is running with ${n} model${n === 1 ? "" : "s"}: ${d.ollama.slice(0, 6).join(", ")}`);
  }
  for (const k of d.envKeys)
    out.push(`A ${presetById(k.provider)?.label} key in ${k.variable}: covo models add ${k.provider}`);
  for (const c of d.clis)
    out.push(`The ${c.name} command-line tool (${c.path}); subscription use arrives in a later update`);
  return out;
}

async function add(ctx: Ctx, args: string[]): Promise<CliResult> {
  const { positional, opts } = flags(args);
  const ask = ctx.prompt;
  const print = ctx.print;
  const settings = loadSettings(ctx.home);

  // 1. Which service?
  let provider = positional[0]?.toLowerCase();
  if (!provider) {
    if (!ask) return { code: 2, out: `Which service? ${USAGE}` };
    const d = await (ctx.detect ?? detect)(ctx.env);
    print("Which AI do you want to connect?\n");
    PRESETS.forEach((p, i) => {
      const hint =
        p.kind === "ollama" && d.ollama
          ? "running now"
          : d.envKeys.some((k) => k.provider === p.id)
            ? "key found on this Mac"
            : (p.note ?? "");
      print(`  ${String(i + 1).padStart(2)}. ${p.label.padEnd(46)} ${hint}\n`);
    });
    const a = await ask.ask("\nNumber or name:", "1");
    provider = /^\d+$/.test(a) ? PRESETS[Number(a) - 1]?.id : a.toLowerCase();
  }
  const preset = provider ? presetById(provider) : undefined;
  if (!preset)
    return { code: 1, out: `Unknown service "${provider}". Choose from: ${PRESETS.map((p) => p.id).join(", ")}\n` };

  // 2. Its key.
  let key: string | undefined;
  if (!preset.local) {
    const envVar = preset.keyEnv.find((v) => ctx.env[v]);
    if (opts["key-stdin"]) key = (await (ctx.readStdin ?? (() => Bun.stdin.text()))()).trim();
    else if (envVar && (!ask || /^y/i.test(await ask.ask(`Use the key already in ${envVar}? (Y/n)`, "y")))) {
      key = ctx.env[envVar];
    } else if (ask) {
      if (preset.keyUrl) print(`Create a key at ${preset.keyUrl} if you don't have one.\n`);
      key = await ask.secret(`Paste your ${preset.label} key (it won't be shown):`);
    }
    if (!key) return { code: 1, out: `A ${preset.label} key is needed. Pass it with --key-stdin.\n` };
  }

  // 3. Check that it works, and see which models it offers.
  const probe: ModelConfig = {
    ...modelConfig(
      { COVO_PROVIDER: preset.id, COVO_MODEL_BASE_URL: opts["base-url"] as string | undefined },
      {
        requireModel: false,
      },
    ),
    ...(key ? { apiKey: key, keySource: "the key you gave" } : {}),
  };
  print(`Checking ${preset.label}…\n`);
  let available: string[];
  try {
    available = await (ctx.listModels ?? listModelsFor)(probe, AbortSignal.timeout(15_000));
  } catch (e) {
    const why = preset.local ? ` Is ${preset.label.split(" (")[0]} running?` : " Check the key and try again.";
    return { code: 1, out: `That didn't work: ${(e as Error).message}.${why} Nothing was saved.\n` };
  }
  const chat = available.filter((m) => !NOT_CHAT.test(m));
  print(`It works: ${available.length} models available.\n`);

  // 4. Which model?
  let model = opts.model as string | undefined;
  if (!model) {
    const suggested = preset.models.filter((m) => available.includes(m));
    const choices = [...suggested, ...chat.filter((m) => !suggested.includes(m))].slice(0, 20);
    if (!choices.length) return { code: 1, out: `${preset.label} didn't list any chat models. Use --model <name>.\n` };
    if (ask) {
      print("\nWhich model should bots use?\n");
      for (const [i, m] of choices.entries()) print(`  ${String(i + 1).padStart(2)}. ${m}\n`);
      if (chat.length > choices.length) print(`  … and ${chat.length - choices.length} more (type a name)\n`);
      const a = await ask.ask("\nNumber or name:", "1");
      model = /^\d+$/.test(a) ? choices[Number(a) - 1] : a;
    } else model = choices[0];
  }
  if (!model) return { code: 1, out: "No model chosen. Nothing was saved.\n" };
  if (!available.includes(model)) print(`Note: ${preset.label} didn't list "${model}"; using it anyway.\n`);

  // 5. A name, then save.
  let name = (opts.name as string | undefined) ?? suggestName(settings, preset.id);
  if (ask && !opts.name) name = await ask.ask(`Name for this model (letters, digits, dashes):`, name);
  if (!NAME_RE.test(name))
    return { code: 1, out: `"${name}" can't be a name. Use lowercase letters, digits and dashes.\n` };
  const first = settings.connections.length === 0;
  const makeDefault =
    first ||
    opts.default === true ||
    (ask !== undefined && /^y/i.test(await ask.ask(`Use "${name}" by default for bots? (y/N)`, "n")));
  const c = await addConnection(ctx.home, store(ctx), {
    name,
    provider: preset.id,
    model,
    ...(opts["base-url"] ? { baseUrl: opts["base-url"] as string } : {}),
    ...(key ? { key } : {}),
    makeDefault,
  });

  const lines = [
    "",
    `Saved "${c.name}": ${preset.label}, ${c.model}${c.keyId ? ". The key is in your Keychain, not in any file" : ""}.`,
  ];
  if (makeDefault) lines.push("Bots use it by default.");

  // 6. Optional tool-use test (one small request).
  const wantTest =
    !opts["no-test"] &&
    ask !== undefined &&
    /^y/i.test(
      await ask.ask(
        preset.local
          ? "Run a quick test? (Y/n)"
          : "Send one small test request? It costs at most a fraction of a cent. (Y/n)",
        "y",
      ),
    );
  if (wantTest) {
    const r = await test(ctx, c.name);
    lines.push(r.out.trimEnd());
    return { code: r.code, out: `${lines.join("\n")}\n` };
  }
  lines.push(`Test it any time with: covo models test ${c.name}`, "");
  return { code: 0, out: lines.join("\n") };
}

async function test(ctx: Ctx, name?: string): Promise<CliResult> {
  const cfg = await resolveModel(ctx.home, store(ctx), ctx.env, name);
  if (name && cfg.connection !== name) throw new ModelConfigError(`No saved model called "${name}".`);
  const checks = await checkModels(cfg, { provider: ctx.provider, listModels: ctx.listModels });
  const mark = { pass: "✓", fail: "✗", warn: "!" } as const;
  const lines = [`Testing ${cfg.connection ?? cfg.name} (${cfg.model} via ${cfg.label})`];
  for (const c of checks) lines.push(`  ${mark[c.status]} ${c.name.padEnd(24)} ${c.detail}`);
  const failed = checks.some((c) => c.status === "fail");
  return { code: failed ? 1 : 0, out: `${lines.join("\n")}\n` };
}
