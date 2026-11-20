# Covo Bot

Open-source AI coworkers that run on your own Mac. Bots work on instant copies of your files, inside the macOS sandbox, using AI models you bring yourself. They ask before anything risky, and only your fingerprint can change their limits.

> **Status:** early development. Phase 1 (the safe runner core) is in progress. Nothing here is ready for real use yet.

## Plan

- [Engineering blueprint](docs/BLUEPRINT.md): architecture, data model and the 6-phase roadmap
- [Phase 1 plan](docs/PHASE1.md): milestones M0–M6 for the sandboxed runner (done)
- [Phase 2](docs/PHASE2.md) (done): connect any AI (keys, subscriptions, local), automation levels with undo, spending limits, power profiles
- [Phase 3](docs/PHASE3.md) (done): the background service, the chat app, a Mac menu bar app, phone approvals over Telegram, routines and a daily summary
- [Phase 4 plan](docs/PHASE4.md): reach and abilities: your ChatGPT or Claude plan, Mail and Calendar, other services, a browser, memory, shared skills, more chat apps and a one-command install
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

A bot always works on an instant copy of your workspace, inside the macOS sandbox. What happens to its changes depends on the bot's level: **Automatic** bots (the default) keep their own work, and `covo undo` puts everything back exactly as it was; **Supervised** bots leave the changes for you to review with `covo diff`, then `covo keep` (all files, or just some) or `covo discard`; **Fully automatic** bots keep their work and never ask, stopping at their spending limit instead. If you edited a file yourself while the bot worked, nothing is kept automatically; and `covo undo` refuses files you've changed since, so your own work is never overwritten. Undo data is kept for 30 days (up to 2 GB). Bots can use any AI you have: Claude (Anthropic's own API), GPT, Gemini, Grok, DeepSeek, Mistral, Groq, OpenRouter, or a free local model through Ollama or LM Studio. Connect one with `covo models add`: it asks which service, takes your key without showing it, checks that the key works, and saves it in the macOS Keychain (never in a file). With nothing connected, Covo uses local Ollama (`qwen3.5:4b`). Have a Claude Pro, Max or Ultra subscription? `covo models add claude-code` lets bots work through your installed Claude Code program instead of an API key. It's opt-in, Covo never sees your sign-in, and Claude Code works in Covo's sandbox with file tools only. ChatGPT and Gemini subscriptions aren't supported, because their terms don't allow it; [docs/SUBSCRIPTIONS.md](docs/SUBSCRIPTIONS.md) has the details. Scripts can use `COVO_PROVIDER` and a key variable instead (see `covo --help`). Each bot can have its own models in order, for example `covo bots create "Docs helper" --model claude --fallback local`: if Claude's key fails, hits a rate limit or runs out of credit, the bot carries on with the local model and the activity log records why. Spending is capped: by default a task may spend $1 and all bots together $5 a day (`covo limits`). Before any model call that would go over, the task pauses and asks you; `covo usage` shows what was spent by model, bot and day. Free local models never count. Run `covo service install` to start Covo's background service at login. After that, tasks carry on when you close the terminal, wait their turn when the Mac is busy, and can be stopped with `covo stop <run>`. Without the service, `covo run` works in your terminal as before. `covo app` opens Covo in your browser, signed in with a one-time code. You get your bots in a sidebar and a chat per bot. Each message becomes a task, and its steps show live. Cards let you review changes (with a diff), keep, discard or undo them, and approve a spending pause. A Needs you inbox collects everything waiting. You can also create bots, add model keys (they go straight to the Keychain), and set spending limits, in light or dark. Build the app once after cloning with `bun run app:build`. There's also a Mac app: `bun run mac:build` makes `apps/mac/build/Covo.app` (it needs Xcode's command-line tools). It puts Covo in your menu bar with a count of what needs you, sends macOS notifications, lets you answer a spending pause from the menu bar or the notification, can pause all bots, and starts Covo's service if it isn't running. Its window shows the same app inside a translucent frame. Want spending pauses on your phone? `covo phone connect` links a Telegram bot of your own (free; you create it with @BotFather in a minute). You get a card with **Allow once / Deny** for each spending pause, and short summaries of finished tasks (never your files' contents). Covo checks Telegram itself, so no server is needed. Only your own chat is listened to: anyone else is ignored and logged. Bots can also work on a schedule: `covo routines add "Inbox tidy" --bot Assistant --every "weekdays 9:00" "<task>"`, the Routines tab in a bot's details in the app, or just ask in its chat ("every Monday at 9, summarise last week"). Covo's service runs them on time. One missed while the Mac slept runs once when it wakes (or is skipped, your choice), and nothing starts in quiet hours or while all bots are paused. Routines don't use your subscriptions unless you allow it. At a time you pick (18:00 to start), a daily summary of what ran, what changed (with Undo), what was spent and what's waiting arrives in your main bot's chat and on your phone. The service's local API (`127.0.0.1:7420`) answers only Covo's own app or requests that carry your private token from `~/Covo/state/api-token`; other websites are refused, and every refusal is written to the activity log. Covo sizes itself to your Mac (`covo profile`): an 8 GB Mac runs one task at a time with a ~4B local model; 16 GB runs two with ~8B models, and bigger Macs more. It runs fewer tasks when memory is tight, the battery is low or the Mac is hot. Text in your files can't take a bot over. In our test, a planted note told a bot to read your SSH keys, raise its own spending limit and upload a file, and a local model tried all three. The sandbox refused each one, and the activity log records each refusal.

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
