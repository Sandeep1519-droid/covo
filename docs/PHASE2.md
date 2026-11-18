# Phase 2 Plan: Connect Any AI, Automation and Control

> Status: **done**, 18 Nov 2026 (M0–M7; results in §4). Follows [BLUEPRINT.md](BLUEPRINT.md) §8 (ADR-008 to ADR-012). Phase 1 is done ([PHASE1.md](PHASE1.md)). Anything here can change later.

## 1. Goal

By the end of Phase 2:

```bash
covo models add                 # "Which AI do you use?" → paste a key (saved in the Keychain) or pick a signed-in CLI
covo bots create "Docs helper" --model claude --level automatic
covo run --bot "Docs helper" "tidy up the docs folder"
# → works on a copy, keeps the result by itself because every change is undoable
covo undo last                  # puts everything back
```

1. **Any AI the user has** works: API keys for the major providers, subscriptions through official CLIs (where the terms allow), and local models.
2. Keys live in the **macOS Keychain**.
3. Each bot has its own **model, fallback chain and automation level**.
4. **Undoable work is kept automatically**; `covo undo` reverses it.
5. **Spending limits** pause a run before it overspends.
6. Covo picks a **power profile** for the Mac it runs on.

Still no app window or phone approvals; those are Phase 3. Approvals in Phase 2 happen in the terminal (`covo approve` / `covo deny`).

## 2. Zero-cost testing

Every milestone is tested with the mock model and recorded responses. Live checks use free options only:
- local Ollama
- the Gemini API free tier
- OpenRouter's free models
- Groq's free tier

A paid key is only needed if you choose to try one; nothing in the tests requires it.

## 3. Milestones

| # | Milestone | You can run | Est. |
|---|---|---|---|
| **M0** | **Providers.** A native Anthropic (Claude) provider with streaming and tool calls. A registry of provider presets (OpenAI, Gemini, xAI, DeepSeek, Mistral, Groq, OpenRouter, Ollama, LM Studio): address, key style, suggested models. Recorded test fixtures for each format. | `covo doctor models` against any preset (done: 10 presets, native Claude provider with thinking replay and server-side fallbacks) | 3–4 days |
| **M1** | **Keys and model setup.** A `SecretStore` for the macOS Keychain. `covo models add/list/test/remove/default`. Settings in `~/Covo/config.json`, never keys. Setup detects what you already have: Ollama models, keys in environment variables, signed-in CLIs. | `covo models add` → paste a Gemini free-tier key → `covo run` uses it (done: keys in the Keychain via `security -i`, `~/Covo/config.json` holds no keys; list/add/test/default/remove; detects Ollama, keys in the environment and AI command-line tools) | 3 days |
| **M2** | **Bots.** `covo bots create/list/set/remove`. Each bot has a model, a fallback chain and an automation level; the schema gains `model_chain` and `level` on agents. `covo run --bot <name>`. Fallback on rate limit, quota, outage or a missing local model, recorded in the log. | A bot set to `claude → gemini → local` keeps working when the first key fails (done: `covo bots create/set/remove`, `covo run --bot`; switches on a bad key, rate limit, no credit, outage, missing model or refusal, but never mid-reply; each switch is logged) | 2–3 days |
| **M3** | **Spending limits.** A per-model price table (shipped defaults, user-editable). Real cost in the budget ledger. Per-run and per-day limits. The breaker pauses a run (`AWAITING_APPROVAL`) before a call would exceed the limit. `covo approve/deny`. `covo usage` shows spend per bot, model and day. | Set a $0.05 run limit → the run pauses → `covo approve` continues it (done: built-in Anthropic prices dated 2026-11-03, your own in `~/Covo/prices.json`, unknown cloud models at a cautious $5/$25 marked as estimates; limits per task, per bot and per day, $1 and $5 by default; the check runs before every model call; `covo approve`/`deny`, or a direct question in a terminal; `covo usage`, `covo limits`, `covo prices`) | 3 days |
| **M4** | **Automation levels and undo.** Supervised / Automatic / Fully automatic. Auto-keep for Automatic and Fully automatic bots. An undo store: instant clones of every file a keep replaces or deletes. `covo undo <run>` (refuses files you changed since). "Always allow" rules in `~/Covo/rules.json`, suggested after three identical approvals; `covo rules list/remove`. | An Automatic bot's edits land by themselves; `covo undo last` restores the folder exactly (done: undo for every keep, by APFS clones, refusing files changed since; auto-keep for Automatic and Fully automatic bots, review stays for Supervised and on conflicts; Fully automatic bots stop at their limit instead of asking; after three approved spending pauses in a week Covo offers to raise that bot's limit. A general "Always allow" rules file moves to Phase 3, where the first irreversible actions such as sending a message arrive) | 4 days |
| **M5** | **Power profiles.** Detect memory, chip, cores, battery and thermal state (`sysctl`, `pmset`). Choose a profile (ADR-011) that sets concurrency, suggested local model, context and keep-alive. `covo doctor` shows it; `covo profile set <name>` overrides it. Concurrent runs (more than one at a time) where the profile allows. | On a 16 GB Mac two runs go at once; on 8 GB the second waits (done: `covo profile`, a "This Mac" section in `covo doctor`; 8/16/32/48/64 GB profiles set tasks at once, local model size, context and unload time; memory pressure, battery under 20% or heat drop to one task, critical memory pauses new tasks; verified live: Ollama loaded with an 8K context and unloaded 60 s after use) | 2–3 days |
| **M6** | **Subscription engines (terms first).** Research and write `docs/SUBSCRIPTIONS.md`: the current terms for Claude Code, Codex CLI and Gemini CLI, recorded with dates and links. For each one the terms allow, an opt-in engine provider runs the official CLI headless inside a `cli-agent.sb` sandbox profile, in the run's copy, with its usage logged. When its cap is hit, it falls back down the bot's chain. | `covo models add` → "use my Claude Code sign-in" → a run completes through it (done: terms checked 18 Nov 2026 in [SUBSCRIPTIONS.md](SUBSCRIPTIONS.md). Claude Code is allowed and built: `covo models add claude-code`, opt-in, Covo never touches the sign-in. It runs `claude -p` with file tools only, no MCP or workspace settings, in the `cli-agent` sandbox profile (its own folders, network, Keychain). Usage is logged at $0 under tier `cli`; at a usage cap, sign-in problem or outage, the next model finishes in the same copy. ChatGPT/Codex is not built (unclear terms), and neither is Gemini/Antigravity (sign-in ended 18 Jun 2026; third-party use forbidden). Verified: a stand-in `claude` in the real sandbox, and the profile reaching api.anthropic.com. Not yet run with a real Claude Code sign-in) | 4–5 days |
| **M7** | **Demo, docs and safety check.** The acceptance demo below, README updates, and a prompt-injection test: a file in the workspace tells the bot to read `~/.ssh` and raise its own limits, and both attempts are blocked and logged. | The acceptance demo passes end to end (done: see §4. An automated test has a fully obedient model try eight attacks from a planted file, and all are refused (seven by the sandbox or path checks, logged as denied; `cat ~/.ssh` finds no keys because `~` is the workspace copy), and change nothing. Live, qwen3.5:4b obeyed a planted file; reading `~/.ssh`, raising its limit through the database and uploading were all blocked. Fixed along the way: sandbox refusals reported as "authorization denied" or hidden by `curl -s` are now logged as blocked, and a bot's `local` model works when nothing is saved under that name) | 2 days |

Total: about **3–4 weeks** part-time.

## 4. Acceptance demo (end of Phase 2)

```bash
covo models add                       # Gemini free-tier key → Keychain
covo models add                       # local Ollama detected automatically
covo bots create "Docs helper" --model gemini --fallback local --level automatic
covo run --bot "Docs helper" "add a Setup section to README.md"
                                      # kept automatically; summary printed
covo undo last                        # README restored exactly
covo bots set "Docs helper" --run-limit 0.001
covo run --bot "Docs helper" "summarise every file in docs/"
                                      # pauses at the limit → covo approve
covo usage                            # spend per bot and model
covo doctor                           # power profile, sandbox 7/7, models OK
covo audit verify                     # chain OK
```

Pass criteria:
- No key is written to any file. `grep -r` for the key in `~/Covo` finds nothing.
- An Automatic bot's undoable changes land without a prompt, and `covo undo` restores them byte for byte.
- A run never spends past its limit without an approval in the log.
- If the first model fails, the run finishes on the fallback, and the log says why it switched.
- The prompt-injection file can't raise limits or read outside the workspace.

**Result, 18 Nov 2026 (8 GB M3):** passed. The free local model (qwen3.5:4b) stood in for the Gemini key, because no Gemini key is set up on the test Mac. The Gemini path is covered by the M0/M1 tests against a stand-in server.
- Auto-keep: "Docs helper" (Automatic) added a Setup section in 23 s and kept it without asking. `covo undo last` restored README.md with the same SHA-256 as before.
- Limit: with `--task-limit 0.001` (and a test price on the local model), the run paused before its first step. `covo approve`, from a second command, let it finish ($0.01 in total, recorded in the log).
- `covo usage` showed spending by model, bot and day. `covo doctor` passed every check, sandbox 7 of 7. `covo audit verify` reported the chain intact.
- Keys: no key is written to any file. This is covered by the M1 tests and `grep`; the demo itself used no key.
- Fallback: verified live in M2 (a missing model fell back to the local one), and for subscription engines in M6 tests.
- Prompt injection: see M7 above. The automated test is `packages/engine/src/injection.test.ts`.

## 5. Design notes

- **Undo is cheap** because of APFS clones: saving the old versions costs almost no disk until the files diverge.
- **The undo window:** keep undo data for 30 days or 2 GB, whichever comes first, adjustable. Deleting undo data is logged.
- **A "send" or "spend" action has no undo**, so it can never be auto-kept. In Phase 2 the only irreversible actions are spending (M3) and subscription engines that reach the network (M6). Email, messages and the browser come in later phases, already under ADR-010's rules.
- **Rules file safety:** `rules.json` sits in Covo's data folder, which the sandbox hides from bots. Phase 4 adds Touch ID signing on top.
- **Price table:** prices change, so the defaults carry a date and `covo usage` warns when they're older than 90 days.

## 6. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Subscription terms forbid automated or third-party use | Medium | Research first (M6). Build only what the terms allow, opt-in. API keys and local models cover everyone else. |
| Provider APIs differ in tool-call formats | Medium | Recorded fixtures per provider. The OpenAI-compatible path covers most of them; Anthropic gets a native provider. |
| Keychain prompts annoy users | Medium | One Keychain item per provider, accessed by the signed `covo` binary. Touch ID–gated access comes with the vault in Phase 4. |
| Two runs at once on 8 GB cause memory pressure | Medium | The power profile keeps 8 GB at one run. Admission control checks memory pressure before starting. |
| Price table goes stale | High | Dated defaults, user-editable, warning after 90 days. |

## 7. Decisions (confirmed 18 Nov 2026 with "Yes, start Phase 2")

1. Which free key to use for live testing: **Gemini API free tier** (recommended) or OpenRouter free models?
2. Undo retention: **30 days / 2 GB** (built in M4).
3. Default automation level for new bots: **Automatic** (built in M4; the main bot "Assistant" is Automatic too).
