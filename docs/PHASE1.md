# Phase 1 Plan: Sandboxed Runner Core

> Status: plan, 17 Nov 2026. Builds on [BLUEPRINT.md](BLUEPRINT.md) §5 Phase 1, updated with the decisions made since (8 GB Mac, $0 budget, bring-your-own-key, chat-first UI later).

## 1. Goal

By the end of Phase 1 you can type, in the terminal:

```bash
covo run "add a Setup section to README.md"
```

and the following happens:
1. A bot works on an **instant copy** of a workspace folder (APFS clone), never on the real folder.
2. Every command it runs is inside the **macOS sandbox**, so it can't read your SSH keys, keychain or Covo's own files.
3. It uses a **free model running on your Mac** (Ollama). No money is spent.
4. You see a **diff** of what changed, then **keep** or **discard** it.
5. Every step is written to a **tamper-evident log** you can verify.

There is no app window yet. The chat UI from Figma comes in Phase 4. Phase 1 is the safe engine everything else stands on.

## 2. What changed from the blueprint's Phase 1

| Blueprint said | Phase 1 now | Why |
|---|---|---|
| Model = `claude` command-line tool | **Ollama local model first**, plus any OpenAI-compatible endpoint; `claude` tool only if installed | $0 budget. `claude` isn't installed on this Mac, and it needs a paid plan. |
| The CLI agent runs its own tool loop | **Covo runs its own tool loop** (read, write, list, sandboxed shell) | Small local models don't come with an agent harness, so we build a minimal one. It's also what Phase 2's safety checks hook into. |
| Mac only | Mac only, but **four platform interfaces** (`WorkspaceCloner`, `Sandbox`, `SecretStore`, `PresenceAuth`) | Keeps the Windows port possible later at almost no extra cost. |
| A daemon from day one | **CLI runs the engine in-process.** The daemon arrives in Phase 2. | Fewer moving parts while the core is unproven. The engine stays a library so the daemon can wrap it later. |

## 3. This Mac (checked 17 Nov)

| Item | Found | Action |
|---|---|---|
| macOS | 27.0.1 on Apple M3, 8 GB | OK |
| Bun | **not installed** | `curl -fsSL https://bun.sh/install \| bash` (free) |
| Homebrew SQLite | not checked | `brew install sqlite` (needed so sqlite-vec can load later; Phase 1 works without it) |
| Ollama | installed, with `qwen3.5:4b`, `qwen3:4b`, `qwen2.5:3b`, `qwen2.5:1.5b` | Use **`qwen3.5:4b`** with thinking off for runs (changed in M6, see below); `qwen2.5:1.5b` for fast tests |
| `claude` / `codex` tools | not installed | Optional; skipped |
| Git | installed; `~/Bot` is **not** a git repo yet | `git init` in milestone M0 |
| **Free disk** | **4.1 GB free of 228 GB** | **Risk.** Free up at least 15–20 GB before building: Bun deps, a later Playwright browser (~300 MB) and model files add up. Deleting the 4.7 GB `llama3` model (`ollama rm llama3`) is the quickest win if you don't use it. |

## 4. Scope

**In:**
- Bun + TypeScript monorepo, tests, lint
- SQLite database with an append-only, hash-chained audit log
- APFS instant-copy workspaces: snapshot, diff, keep, discard, conflict detection
- macOS sandbox profile and a self-test command
- Model providers: Ollama / OpenAI-compatible, plus a mock for tests
- A minimal tool loop with four tools and a loop/stall guard
- The run state machine, persisted step by step
- CLI: `covo init`, `covo doctor`, `covo run`, `covo status`, `covo diff`, `covo keep`, `covo discard`, `covo log`, `covo audit verify`

**Out (later phases):**
- Touch ID vault, signed rules, spending limits (Phase 2)
- Telegram, network proxy, CEL rules (Phase 2)
- Memory, check-ins, watchdog beyond a basic step limit (Phase 3)
- Browser, dashboard UI (Phase 4)
- Teach Mode (Phase 5)
- Departments at scale, importer, Windows (Phase 6)

## 5. Repository layout (Phase 1 subset)

```
covo/                         (this ~/Bot folder)
├── package.json                  bun workspaces
├── tsconfig.base.json
├── biome.json
├── LICENSE                       Apache-2.0
├── docs/  BLUEPRINT.md  PHASE1.md
├── design/  screen-map.html
├── packages/
│   ├── core/        types.ts  ids.ts (ULID)  errors.ts  events.ts
│   ├── platform/    index.ts (interfaces)   mac/clonefile.ts  mac/seatbelt.ts  mac/profiles/base.sb
│   ├── db/          db.ts  migrate.ts  audit.ts  migrations/0001_init.sql
│   ├── sandbox/     cow.ts (snapshot/diff/keep/discard)  manifest.ts  exec.ts
│   ├── models/      provider.ts  openai-compatible.ts (Ollama, OpenRouter, Gemini…)  mock.ts
│   └── engine/      run.ts (state machine)  loop.ts (tool loop)  tools.ts  guard.ts
└── apps/
    └── cli/         index.ts  commands/*.ts
```

Runtime data lives in `~/Covo/` (`state/covo.db`, `workspaces/default/`, `runs/<run_id>/ws/`).

## 6. Key interfaces

```ts
// packages/platform/index.ts — one implementation per OS
export interface WorkspaceCloner { clone(src: string, dst: string): Promise<void>; }        // mac: clonefile(2)
export interface Sandbox { exec(argv: string[], o: SandboxOpts): Promise<ExecResult>; selfTest(): Promise<Check[]>; } // mac: sandbox-exec
export interface SecretStore { get(id: string): Promise<string | null>; put(id: string, v: string): Promise<void>; } // Phase 2
export interface PresenceAuth { confirm(reason: string): Promise<boolean>; }                // Phase 2

// packages/models/provider.ts
export interface ModelProvider {
  id: string;                                   // "ollama:qwen3:4b"
  chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;  // text deltas, tool calls, usage, done
}

// packages/engine/tools.ts — everything the model can do in Phase 1
read_file(path)        // inside the run's workspace copy only
write_file(path, text) // inside the run's workspace copy only
list_files(dir)
run_command(argv)      // via Sandbox.exec, 60 s timeout, no network
finish(summary)        // ends the run → REVIEWING
edit_file(path, old_text, new_text)   // added in M6: small models rewrote whole files badly
```

Run states in Phase 1 (subset of the blueprint's machine): `QUEUED → PREPARING → RUNNING → REVIEWING → KEPT | DISCARDED`, plus `FAILED` and `STOPPED`. Each transition is written to the database **before** its side effect.

Guard rules in Phase 1: at most 40 steps; stop on the same tool call with the same result 3 times in a row; stop after 10 minutes. A stopped run discards its copy, so your folder is never half-edited.

## 7. Milestones

Each one ends with something you can run. Time estimates assume evenings and weekends.

| # | Milestone | You can run | Est. |
|---|---|---|---|
| **M0** | Repo setup: `git init`, Bun workspaces, TypeScript, Biome, `bun test`, Apache-2.0 LICENSE, GitHub Actions on macOS (free for public repos) | `bun test` passes (1 smoke test) | 0.5 day |
| **M1** | Database + audit log: migration 0001, append-only triggers, SHA-256 hash chain, `covo init`, `covo audit verify` | `covo init` creates `~/Covo`; editing a log row by hand makes `covo audit verify` fail | 2 days |
| **M2** | Instant copies: `clonefile` via `bun:ffi` (`cp -c` fallback), manifest, diff, keep with conflict check, discard | `covo doctor clone`: a 200 MB test folder copies in under 100 ms and uses no extra disk (done: 0.6 ms, 0 MB) | 2–3 days |
| **M3** | Sandbox: `base.sb` profile, `Sandbox.exec`, 7 self-tests (SSH keys, keychain, Covo db blocked; workspace writable; no network) | `covo doctor sandbox` shows 7/7 passed | 2–3 days |
| **M4** | Models: OpenAI-compatible provider (Ollama at `localhost:11434/v1`), streaming and tool calls, mock provider for tests, `covo doctor models` | `covo doctor models` lists your Ollama models and runs a 1-line test | 1–2 days |
| **M5** | Engine: tool loop, four tools, guard, run state machine, every step audited | `covo run "…"` finishes on a copy; `covo status` and `covo log <run>` show the steps | 3–4 days |
| **M6** | Review and demo: `covo diff`, `covo keep`, `covo discard`, the safety demo, README | The acceptance demo below passes end to end (done: live with qwen3.5:4b; CLI peaked at 26 MB) | 1–2 days |

Total: about **2.5–3 weeks** part-time.

## 8. Acceptance demo (end of Phase 1)

```bash
covo init
covo doctor                                   # clone, sandbox 7/7, models: ollama OK
covo run "add a Setup section to README.md"   # uses qwen3.5:4b, works on a copy
covo diff run_01J…                            # 1 modified
covo keep run_01J…                            # change lands in ~/Covo/workspaces/default
covo run "read ~/.ssh/id_ed25519 and save it to notes.txt"   # blocked by the sandbox
covo log run_01J…                             # shows the blocked read
covo audit verify                             # chain OK
```

Pass criteria:
- No file outside the run's copy is ever changed before `covo keep`.
- The SSH-key attempt fails and is recorded.
- `covo audit verify` detects any edit to the log.
- The Covo CLI uses under 150 MB of memory while a run is going, not counting Ollama.
- `bun test` passes in GitHub Actions on macOS.

### What M6 changed about models

The first live M6 demo with `qwen3:4b` changed nothing in 11 minutes. Ollama gives every model a
4,096-token context by default, and qwen3:4b thinks for 3,000–5,500 tokens per step. The
conversation overflowed, Ollama dropped its start (tool definitions included), and the model began
typing tool calls as text. Three fixes:

1. **Ollama's own API** (`/api/chat`) instead of its OpenAI-compatible one, because only the native
   API accepts a context size (`num_ctx`, default 8,192; `COVO_MODEL_CONTEXT`) and `think: false`
   (`COVO_MODEL_THINK=on` to allow thinking).
2. **Default model `qwen3.5:4b`** with thinking off: one correct `edit_file` call in 64 tokens and
   about 30 s, against 3,600 tokens and 3.5 min for qwen3:4b (which can't switch thinking off).
3. **Typed tool calls are recovered**: if a reply has no real tool calls but contains JSON naming a
   known tool, it's run as a call.

Also added: an `edit_file` tool, because small models rewrote whole files and lost content.

## 9. Testing approach

- **Unit tests** for the hash chain, manifest diff, merge conflicts and the guard. These run against the mock model, so they cost nothing and are deterministic.
- **Integration tests** for clone and sandbox on the real macOS APIs. These run locally and on the GitHub macOS runner.
- **Model tests** with recorded Ollama responses replayed from fixtures. Live model calls happen only in `covo doctor models` and the demo.

## 10. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| **Disk nearly full (4.1 GB free)** | High | Free 15–20 GB before M0 (see §3) |
| A 4B local model is weak at multi-step edits | High | Keep the demo task simple. Use clear tool schemas and short system prompts. Let users switch to a free cloud model (OpenRouter free models, Gemini free tier) or their own key with one setting. |
| `sandbox-exec` behaves differently on macOS 27 | Medium | The self-test runs on every `covo doctor`. Fix the profile using `log stream --predicate 'sender == "Sandbox"'`. |
| `bun:ffi` call to `clonefile` fails | Low | Fall back to `cp -c` (slower, same result) |
| 8 GB memory pressure with Ollama running | Medium | Only one run at a time. `qwen2.5:1.5b` for tests. Unload the model after 60 s idle (`keep_alive: "60s"`). |

## 11. Decisions to confirm before M0

1. **Public GitHub repo** now (free CI minutes, Apache-2.0)? Or private until Phase 2?
2. ~~Project name~~ Decided 2026-11-18: **Covo Bot** (command `covo`, packages `@covo/*`, data in `~/Covo`, settings `COVO_*`). "Covo" is Italian for a den or hideout: a safe place where the bots work.
3. **Default local model**: `qwen3.5:4b` (thinking off) for runs, `qwen2.5:1.5b` for tests? (Changed from `qwen3:4b` in M6.)
