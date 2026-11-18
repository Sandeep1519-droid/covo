# Covo Bot

Open-source AI coworkers that run on your own Mac. Bots work on instant copies of your files, inside the macOS sandbox, using AI models you bring yourself. They ask before anything risky, and only your fingerprint can change their limits.

> **Status:** early development. Phase 1 (the safe runner core) is in progress. Nothing here is ready for real use yet.

## Plan

- [Engineering blueprint](docs/BLUEPRINT.md): architecture, data model and the 6-phase roadmap
- [Phase 1 plan](docs/PHASE1.md): milestones M0–M6 for the sandboxed runner (done)
- [Phase 2 plan](docs/PHASE2.md): connect any AI (keys, subscriptions, local), automation levels with undo, spending limits, power profiles
- [Screen map](design/screen-map.html): every screen in the app and where each button goes

## Development

Requirements: macOS on Apple Silicon, [Bun](https://bun.sh) 1.4+, and optionally [Ollama](https://ollama.com) for free local models.

```bash
bun install
bun run check     # lint + type-check + tests
bun run covo --help
```

| Command             | What it does                            |
| ------------------- | --------------------------------------- |
| `bun test`          | Run the tests                           |
| `bun run lint`      | Check formatting and lint rules (Biome) |
| `bun run format`    | Fix formatting                          |
| `bun run typecheck` | Type-check with TypeScript              |

## Layout

```
apps/cli         the `covo` command
packages/core    shared types, IDs, canonical JSON, data-folder paths
packages/db      SQLite schema, migrations, tamper-evident activity log
packages/platform  OS-specific pieces behind interfaces (macOS clonefile today)
packages/sandbox   instant workspace copies and the sandbox self-tests
packages/models    model providers: Ollama or any OpenAI-compatible service, plus a test mock
packages/engine    the bot: workspace tools, tool loop with guards, and the run lifecycle
```

A bot always works on an instant copy of your workspace. Nothing in your real files changes until you review the run with `covo diff` and choose `covo keep` (all files, or just some) or `covo discard`. If you edited a file yourself while the bot worked, `covo keep` refuses that file instead of overwriting your edit. Bots can use any AI you have: Claude (Anthropic's own API), GPT, Gemini, Grok, DeepSeek, Mistral, Groq, OpenRouter, or a free local model through Ollama or LM Studio. Connect one with `covo models add`: it asks which service, takes your key without showing it, checks that the key works, and saves it in the macOS Keychain (never in a file). With nothing connected, Covo uses local Ollama (`qwen3.5:4b`). Scripts can use `COVO_PROVIDER` and a key variable instead (see `covo --help`). Each bot can have its own models in order, for example `covo bots create "Docs helper" --model claude --fallback local`: if Claude's key fails, hits a rate limit or runs out of credit, the bot carries on with the local model and the activity log records why.

Try it with a throwaway data folder:

```bash
COVO_HOME=/tmp/covo-try bun run covo init
COVO_HOME=/tmp/covo-try bun run covo doctor
COVO_HOME=/tmp/covo-try bun run covo models add
COVO_HOME=/tmp/covo-try bun run covo run "add a Setup section to README.md"
COVO_HOME=/tmp/covo-try bun run covo diff last
COVO_HOME=/tmp/covo-try bun run covo keep last      # or: covo discard last
COVO_HOME=/tmp/covo-try bun run covo status
COVO_HOME=/tmp/covo-try bun run covo audit verify
```

## License

Apache-2.0. See [LICENSE](LICENSE).
