# Covo Bot

**AI coworkers that run on your own Mac, safe by design.** Bots do real work on your files with the AI you already have: your ChatGPT or Claude plan, an API key, or a free local model. Every task runs on an instant copy of your files inside the macOS sandbox. One click undoes it, a planted instruction can't take a bot over, and an activity log that can't be quietly edited records everything.

[![CI](https://github.com/Sandeep1519-droid/covo/actions/workflows/ci.yml/badge.svg)](https://github.com/Sandeep1519-droid/covo/actions/workflows/ci.yml)
![macOS](https://img.shields.io/badge/macOS-Apple%20Silicon-black)
![Bun](https://img.shields.io/badge/Bun-1.4-f9f1e1)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

![A bot's chat: a task kept with Undo, and a task where Covo stopped 4 steps a planted instruction asked for](docs/images/chat.png)

## See it in a minute

No account, no API key, nothing on your Mac touched:

```bash
git clone https://github.com/Sandeep1519-droid/covo && cd covo
bun install && bun run demo
```

In a throwaway folder, with a stand-in model, the demo shows five things:

1. **A task on a copy.** A bot turns messy notes into a README. The change is kept automatically.
2. **Undo.** One command puts the file back exactly as it was.
3. **An attack.** An email hides instructions telling AI assistants to read your SSH key, raise their own spending limit and upload the key. The stand-in obeys every word, the worst case. Covo stops all 4 attempts.
4. **A spending pause.** The bot stops and asks before going over its limit.
5. **A tamper check.** `covo audit verify` checks the hash-chained log.

Then `bun run setup && bun run demo --app` opens the same results in the app.

## Why Covo

- **Safe by design.**
  - Bots work on an instant APFS clone of your workspace, inside a deny-by-default macOS Seatbelt sandbox.
  - Their commands get no network. Engines that need one reach only their maker's servers, through Covo's filter.
  - Changes are kept with one-click Undo, or wait for your review.
  - Spending limits live outside the bot's reach.
- **Uses the AI you already pay for.**
  - **Codex** (any ChatGPT plan, Free included), **Claude Code** (Claude Pro or Max) and **Sign in with ChatGPT**: get, sign in to and connect each one from Settings. Covo never sees these sign-ins.
  - API keys for Claude, GPT, Gemini, Grok, DeepSeek, Mistral, Groq and OpenRouter, kept in the macOS Keychain.
  - Free local models through Ollama or LM Studio.
  - Bots fall back to their next model when one hits a limit.
- **Works while you're away.**
  - Routines on a schedule, and a daily summary.
  - Spending pauses you can answer from the app, the menu bar or your phone (Telegram).
  - A background service sized to your Mac's memory, battery and heat.
- **Shows its work.** The Library shows every step in plain words, flags everything Covo stopped, and proves the log is intact.

| The Library: tamper-checked activity          | What happened in the attack                        |
| --------------------------------------------- | -------------------------------------------------- |
| ![Library](docs/images/library.png)           | ![Stopped steps](docs/images/attack.png)           |
| **Your AI plans: Get, Sign in, Connect**      | **Light theme**                                    |
| ![AI models and keys](docs/images/models.png) | ![Chat in light theme](docs/images/chat-light.png) |

## Security model

| A bot, or a file it reads, tries to…             | What stops it                                                                                                                                              |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| read your SSH keys, documents or Covo's own data | A Seatbelt profile that denies everything but the run's workspace copy                                                                                     |
| change your real files                           | It only ever changes a clone; Covo keeps the result with Undo, or holds it for your review                                                                 |
| send your files somewhere                        | Bots' commands have no network. Codex, which has a shell, reaches only OpenAI's servers through Covo's filter; DNS and every other connection are blocked. |
| raise its own spending limit                     | Limits live outside the sandbox; going over pauses the task until you answer                                                                               |
| hide what it did                                 | Every step goes into an append-only, hash-chained activity log (`covo audit verify`)                                                                       |
| use your API keys or sign-ins                    | Keys live in the macOS Keychain; Covo's engines never handle plan sign-ins                                                                                 |
| reach Covo through a website                     | The local API answers only Covo's app or your private token; refusals are logged                                                                           |
| message you from someone else's chat             | The phone link listens only to your paired Telegram chat                                                                                                   |

These are tested, not just claimed. [packages/engine/src/injection.test.ts](packages/engine/src/injection.test.ts) and [apps/cli/src/service/attacks.test.ts](apps/cli/src/service/attacks.test.ts) run the attacks in the real sandbox on every CI run.

## How it works

```mermaid
flowchart LR
  subgraph you[You]
    app["Covo app<br/>(browser or Mac menu bar app)"]
    cli["covo command"]
    phone["Telegram on your phone"]
  end
  subgraph mac[Your Mac]
    svc["covod service<br/>local API · scheduler · phone link"]
    eng["Run engine<br/>tool loop · budgets · fallbacks"]
    box["Seatbelt sandbox<br/>on an APFS clone of your files"]
    filt["Network filter<br/>(OpenAI's servers only)"]
    db[("SQLite<br/>runs · undo · hash-chained log")]
    kc[("macOS Keychain<br/>API keys")]
  end
  ai["Your AI<br/>Codex · Claude Code · ChatGPT · API keys · Ollama"]
  app --> svc
  cli --> svc
  phone <--> svc
  svc --> eng --> box
  eng --> ai
  box --> filt --> ai
  eng --> db
  eng -.-> kc
```

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) has the components, a task's lifecycle and the data model.

## Use it for real

You need macOS on Apple Silicon and [Bun](https://bun.sh) 1.4+. Optional: [Ollama](https://ollama.com) for free local models, and Xcode's command-line tools for the menu bar app.

```bash
bun install
bun run setup                  # builds the app and creates ~/Covo
bun run covo models add        # an API key, Claude Code, Codex, ChatGPT, or a local model
bun run covo service install   # start Covo's background service at login
bun run covo app               # open the app, signed in
```

To use your plan without Terminal: `covo app`, then Settings → AI models, then Get Codex (or Claude Code), Sign in, and Connect.

| Command                                                                 | What it does                                                                 |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `covo run "<task>"`                                                     | Give a bot a task on a safe copy (`--bot`, `--model`)                        |
| `covo undo last` · `covo diff last` · `covo keep last`                  | Put a task's changes back, see them, or keep them                            |
| `covo bots create "<name>" --model <m> --fallback local`                | A bot with its own models and level (supervised, automatic, full)            |
| `covo routines add "<name>" --bot <b> --every "weekdays 9:00" "<task>"` | A task on a schedule                                                         |
| `covo limits --task 1 --day 5`                                          | Spending limits per task and per day                                         |
| `covo phone connect`                                                    | Spending pauses and summaries on your phone (Telegram)                       |
| `covo audit verify`                                                     | Check the activity log for tampering                                         |
| `covo demo files`                                                       | Put the demo's sample files in your workspace, to show Covo with your own AI |

The Mac app (`bun run mac:build`, then open `apps/mac/build/Covo.app`) puts Covo in the menu bar. It shows how many things need you, sends notifications, lets you answer spending pauses, and starts the service if it isn't running.

## Built with

- **Bun and strict TypeScript**, in a monorepo: the `covo` command and service, eight packages, and a React app built by Bun's bundler.
- **SQLite** for runs, chats, routines and the hash-chained activity log.
- **macOS pieces:** Seatbelt (`sandbox-exec`), APFS `clonefile`, the Keychain, and launchd.
- **A Swift menu bar app** with a WKWebView.
- **About 30,000 lines** of TypeScript, TSX and Swift.
- **Tests:** 340 tests across 52 files, run on macOS in CI together with the Swift app's build and tests. They cover the real sandbox, stand-ins for OpenAI and Telegram, and end-to-end acceptance demos.
- **Design:** the app was designed in Figma first; [design/screen-map.html](design/screen-map.html) maps its screens.

## Status and roadmap

| Phase               | What it covers                                                                                                                                                                          | Status      |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| [1](docs/PHASE1.md) | Sandboxed runner: instant copies, the sandbox, tools, the run loop, review and keep                                                                                                     | Done        |
| [2](docs/PHASE2.md) | Any AI (keys, subscriptions, local), fallbacks, spending limits, automation levels with undo, power profiles                                                                            | Done        |
| [3](docs/PHASE3.md) | Background service, the chat app, the Mac menu bar app, phone approvals, routines, the daily summary                                                                                    | Done        |
| [4](docs/PHASE4.md) | Your plans in the app (Codex, Claude Code, ChatGPT), the Library and the demo. Next: Mail and Calendar, MCP connections, a browser, memory, skills, more chat apps, one-command install | In progress |

The full design is in [docs/BLUEPRINT.md](docs/BLUEPRINT.md), and the subscription terms we checked are in [docs/SUBSCRIPTIONS.md](docs/SUBSCRIPTIONS.md). To record a demo of your own, follow [docs/DEMO.md](docs/DEMO.md).

## Development

```bash
bun run check        # lint (Biome) + type-check + all tests
bun run app:dev      # rebuild the app on change
bun run mac:test     # the Swift app's tests
```

## License

Apache-2.0. See [LICENSE](LICENSE).
