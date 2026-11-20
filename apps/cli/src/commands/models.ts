import { existsSync } from "node:fs";
import { tildify } from "@covo/core";
import {
  addConnection,
  beginChatGPTSignIn,
  type ChatGPTOptions,
  chatgptModels,
  checkModels,
  type Detected,
  detect,
  ENGINES,
  type EngineInfo,
  engineById,
  listModelsFor,
  loadSettings,
  type ModelConfig,
  ModelConfigError,
  markWelcomed,
  modelConfig,
  NAME_RE,
  PRESETS,
  presetById,
  removeConnection,
  resolveModel,
  type SignIn,
  saveSettings,
  setDefault,
  signOutChatGPT,
  suggestName,
} from "@covo/models";
import { secrets as defaultSecrets, SecretError } from "@covo/platform";
import type { CliResult, Ctx } from "../main.ts";
import { Cancelled } from "../prompt.ts";
import { checkEngine, findProgram } from "./engines.ts";

// covo models: connect the AI services you use. Keys go to the macOS Keychain.

const USAGE = `Usage:
  covo models                         Show saved models and what's on this Mac
  covo models add [provider]          Connect an AI service (asks questions)
      [--name <n>] [--model <m>] [--base-url <url>] [--key-stdin] [--default] [--no-test]
  covo models add claude-code         Use your Claude subscription through Claude Code
      [--name <n>] [--model default|sonnet|opus|haiku|fable] [--default] [--yes]
  covo models add chatgpt             Use your ChatGPT Plus or Pro plan (Sign in with ChatGPT)
      [--model <m>] [--default]
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
      const was = loadSettings(ctx.home).connections.find((x) => x.name === rest[0]);
      if (was?.provider === "chatgpt") {
        await signOutChatGPT(chatgptOptions(ctx));
        await removeConnection(ctx.home, store(ctx), was.name);
        return { code: 0, out: `Signed out of ChatGPT and removed "${was.name}".\n` };
      }
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
      const en = engineById(c.provider);
      const plan = c.provider === "chatgpt";
      const key = c.keyId
        ? "key in Keychain"
        : plan
          ? "your ChatGPT plan"
          : en
            ? "your subscription"
            : p?.local
              ? "no key needed"
              : "";
      const label = plan ? "ChatGPT (Sign in with ChatGPT)" : (p?.label ?? en?.label ?? c.provider);
      lines.push(
        `  ${c.name === s.default ? "★" : " "} ${c.name.padEnd(12)} ${label.padEnd(28)} ${c.model.padEnd(24)} ${key}`,
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
  for (const c of d.clis) {
    const en = ENGINES.find((e) => e.command === c.name);
    out.push(
      en
        ? `${en.label} (${c.path}): use ${en.plan} with: covo models add ${en.id}`
        : c.name === "codex"
          ? `Codex (${c.path}): Covo doesn't use the Codex program's sign-in, but you can use your ChatGPT plan with: covo models add chatgpt`
          : `The ${c.name} command-line tool (${c.path}): its terms don't allow other apps to use the subscription (see docs/SUBSCRIPTIONS.md); connect an API key instead`,
    );
  }
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
    ENGINES.forEach((en, i) => {
      const hint = d.clis.some((c) => c.name === en.command) ? "installed" : "not installed";
      print(`  ${String(PRESETS.length + i + 1).padStart(2)}. ${`${en.label}: ${en.plan}`.padEnd(46)} ${hint}\n`);
    });
    print(
      `  ${String(PRESETS.length + ENGINES.length + 1).padStart(2)}. ${"ChatGPT: your ChatGPT Plus or Pro plan".padEnd(46)} sign in with ChatGPT\n`,
    );
    const a = await ask.ask("\nNumber or name:", "1");
    const all = [...PRESETS.map((p) => p.id), ...ENGINES.map((e) => e.id), "chatgpt"];
    provider = /^\d+$/.test(a) ? all[Number(a) - 1] : a.toLowerCase();
  }
  if (provider === "chatgpt") return addChatGPT(ctx, opts);
  const engine = provider ? engineById(provider) : undefined;
  if (engine) return addEngine(ctx, engine, opts);
  const preset = provider ? presetById(provider) : undefined;
  if (!preset)
    return {
      code: 1,
      out: `Unknown service "${provider}". Choose from: ${[...PRESETS, ...ENGINES].map((p) => p.id).join(", ")}\n`,
    };

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
  if (cfg.engine) {
    const c = await checkEngine(ctx, cfg.engine, cfg.model);
    const lines = [
      `Testing ${cfg.connection} (${cfg.label})`,
      `  ${c.ok ? "✓" : "✗"} ${"Program".padEnd(24)} ${c.detail}`,
      `  ${"·"} ${"Sign-in".padEnd(24)} checked by ${engineById(cfg.engine)?.label} on the first task (testing it would use your plan)`,
    ];
    return { code: c.ok ? 0 : 1, out: `${lines.join("\n")}\n` };
  }
  const checks = await checkModels(cfg, { provider: ctx.provider, listModels: ctx.listModels });
  const mark = { pass: "✓", fail: "✗", warn: "!" } as const;
  const lines = [`Testing ${cfg.connection ?? cfg.name} (${cfg.model} via ${cfg.label})`];
  for (const c of checks) lines.push(`  ${mark[c.status]} ${c.name.padEnd(24)} ${c.detail}`);
  const failed = checks.some((c) => c.status === "fail");
  return { code: failed ? 1 : 0, out: `${lines.join("\n")}\n` };
}

/** Opt in to a subscription engine (docs/SUBSCRIPTIONS.md). Covo never sees the sign-in. */
async function addEngine(ctx: Ctx, en: EngineInfo, opts: Record<string, string | true>): Promise<CliResult> {
  const ask = ctx.prompt;
  const print = ctx.print;
  const settings = loadSettings(ctx.home);
  const path = findProgram(ctx, en.command, en.knownPaths);
  if (!path) {
    return {
      code: 1,
      out: `${en.label} isn't installed (no "${en.command}" on your PATH). Install it from ${en.installUrl}, sign in by running "${en.command}", then try again. Nothing was saved.\n`,
    };
  }
  print(
    [
      `${en.label} found at ${path}.`,
      "",
      `Covo will run your ${en.label} program to do tasks, using ${en.plan}.`,
      `  • You sign in with ${en.label} itself (run: ${en.command}). Covo never sees, copies or stores your sign-in.`,
      "  • Tasks count toward your plan's usage limits. When you hit one, the bot's next model takes over.",
      `  • ${en.label} works on Covo's copy of your files, with file tools only (no shell, no web).`,
      "  • Covo's spending limits don't apply: a subscription is a flat fee.",
      "  Details and the terms we checked: docs/SUBSCRIPTIONS.md",
      "",
    ].join("\n"),
  );
  if (ask && opts.yes !== true && !/^y/i.test(await ask.ask(`Use ${en.label} with your subscription? (y/N)`, "n"))) {
    return { code: 1, out: "Nothing was saved.\n" };
  }

  let model = opts.model as string | undefined;
  if (!model && ask) {
    model = await ask.ask(
      `Which model? ${en.models.join(", ")} ("default" uses ${en.label}'s own setting):`,
      "default",
    );
  }
  model = (model ?? "default").trim() || "default";
  if (!/^[a-z0-9][a-z0-9.\-[\]]*$/i.test(model))
    return { code: 1, out: `"${model}" isn't a model name. Nothing was saved.\n` };

  let name = (opts.name as string | undefined) ?? suggestName(settings, en.id);
  if (ask && !opts.name) name = await ask.ask("Name for this model (letters, digits, dashes):", name);
  if (!NAME_RE.test(name))
    return { code: 1, out: `"${name}" can't be a name. Use lowercase letters, digits and dashes.\n` };
  const makeDefault =
    settings.connections.length === 0 ||
    opts.default === true ||
    (ask !== undefined && /^y/i.test(await ask.ask(`Use "${name}" by default for bots? (y/N)`, "n")));
  const c = await addConnection(ctx.home, store(ctx), { name, provider: en.id, model, makeDefault });

  const check = await checkEngine(ctx, en.id, model);
  const lines = [
    "",
    `Saved "${c.name}": ${en.label}, ${model === "default" ? `${en.label}'s own model setting` : model}. No key is stored.`,
    makeDefault ? "Bots use it by default." : `Use it in a bot: covo bots set <bot> --model ${c.name} --fallback local`,
    `${check.ok ? "✓" : "✗"} ${check.detail}`,
    "",
  ];
  return { code: check.ok ? 0 : 1, out: lines.join("\n") };
}

/** Sign-in settings for your ChatGPT plan (tests point COVO_CHATGPT_AUTH and _API at stand-ins). */
export function chatgptOptions(ctx: Ctx): ChatGPTOptions {
  return {
    home: ctx.home,
    store: store(ctx),
    now: ctx.now ?? Date.now,
    ...(ctx.env.COVO_CHATGPT_AUTH ? { authBase: ctx.env.COVO_CHATGPT_AUTH } : {}),
    ...(ctx.env.COVO_CHATGPT_API ? { apiBase: ctx.env.COVO_CHATGPT_API } : {}),
  };
}

export const CHATGPT_WELCOME =
  "You're using your ChatGPT plan. Eligible usage in this app uses your ChatGPT plan. Manage usage in your ChatGPT settings: https://chatgpt.com/settings/usage";

/** Your ChatGPT Plus or Pro plan, through Sign in with ChatGPT (docs/SUBSCRIPTIONS.md). */
async function addChatGPT(ctx: Ctx, opts: Record<string, string | true>): Promise<CliResult> {
  const o = chatgptOptions(ctx);
  ctx.print(
    [
      "Covo will use your ChatGPT Plus or Pro plan for your bots' AI requests.",
      "  • You sign in on OpenAI's own page, in your browser. Covo never sees your password.",
      "  • Covo keeps its own sign-in in the macOS Keychain. It never uses the Codex program's sign-in.",
      "  • Use counts toward your plan's limits, shared with ChatGPT and Codex: https://chatgpt.com/settings/usage",
      "  • Covo's spending limits don't apply: your plan is a flat fee.",
      "  • Routines use it only if you allow subscriptions for routines.",
      "  Details and the terms we checked: docs/SUBSCRIPTIONS.md",
      "",
    ].join("\n"),
  );
  let signIn: SignIn;
  try {
    signIn = await beginChatGPTSignIn(o);
  } catch (e) {
    return { code: 1, out: `${(e as Error).message}\n` };
  }
  const open = ctx.openUrl ?? ((u: string) => Bun.spawnSync(["/usr/bin/open", u]).exitCode === 0);
  ctx.print(
    open(signIn.url)
      ? "Your browser is open on OpenAI's sign-in page. Finish there; this waits for you.\n"
      : `Open this link in your browser to sign in:\n  ${signIn.url}\n`,
  );
  let who: { email: string | null; firstTime: boolean };
  try {
    who = await signIn.done;
  } catch (e) {
    return { code: 1, out: `${(e as Error).message} Nothing was saved.\n` };
  }
  return { code: 0, out: await saveChatGPT(ctx, o, who, opts) };
}

/** After signing in: pick a model, save the connection, show the one-time welcome. Shared with the app. */
export async function saveChatGPT(
  ctx: Ctx,
  o: ChatGPTOptions,
  who: { email: string | null; firstTime: boolean },
  opts: { model?: string | true; default?: string | true; name?: string | true } = {},
  how: { printWelcome?: boolean } = {},
): Promise<string> {
  const models = await chatgptModels(o).catch(() => []);
  let model = typeof opts.model === "string" ? opts.model : undefined;
  if (!model && ctx.prompt && models.length > 1) {
    for (const [i, m] of models.entries()) ctx.print(`  ${String(i + 1).padStart(2)}. ${m.name} (${m.slug})\n`);
    const a = await ctx.prompt.ask("Which model? (number)", "1");
    model = models[Number(a) - 1]?.slug;
  }
  model = model ?? models[0]?.slug;
  if (!model)
    throw new ModelConfigError(
      "You're signed in, but OpenAI didn't list any models for your account. Try again later: covo models add chatgpt",
    );
  const s = loadSettings(ctx.home);
  const name = typeof opts.name === "string" ? opts.name : "chatgpt";
  const existing = s.connections.find((c) => c.provider === "chatgpt");
  if (existing) {
    existing.model = model;
    if (opts.default === true) s.default = existing.name;
    saveSettings(ctx.home, s);
  } else {
    await addConnection(ctx.home, store(ctx), {
      name,
      provider: "chatgpt",
      model,
      makeDefault: s.connections.length === 0 || opts.default === true,
    });
  }
  const lines = [
    `Connected${who.email ? ` as ${who.email}` : ""}. Bots can use "${existing?.name ?? name}" (${model}) on your ChatGPT plan.`,
  ];
  if (who.firstTime && how.printWelcome !== false) {
    lines.push("", CHATGPT_WELCOME);
    markWelcomed(ctx.home);
  }
  return `${lines.join("\n")}\n`;
}
