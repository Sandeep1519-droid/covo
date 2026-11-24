# Changelog

## Unreleased

- **Pick any model, per message.** The picker lists every model you can use:
  - Codex's models for your account (GPT-6-Luna, GPT-5.6-Terra, GPT-5.6-Luna…);
  - Claude Code's (Sonnet, Opus, Haiku, Fable);
  - your ChatGPT plan's;
  - your keys';
  - the models on your Mac.

  In Settings → Your models, choose each one's usual model.
- **Eight more services** for API keys: Cerebras, Together AI, Fireworks, Hugging Face, NVIDIA NIM, Moonshot (Kimi), Alibaba Qwen and SambaNova. Paste a key and the service's own model list appears, so you don't need to know model names.
- **Codex can search the web** with its own tool, which runs on OpenAI's servers. Bots now answer questions like "what's the weather today".
- **Claude Code's sign-in:** if the sign-in page shows a code instead of finishing by itself, paste it in the app and it goes to Claude Code's own prompt.

## 1.0.0 (23 November 2026)

The first release: AI coworkers that run on your own Mac, safe by design. Try it in a minute with no account: `bun install && bun run demo`.

### Safe by design

- Every task runs on an instant APFS clone of your workspace, inside a deny-by-default macOS Seatbelt sandbox. Bots' commands get no network.
- Three levels per bot:
  - _Supervised:_ you review changes;
  - _Automatic:_ changes are kept, with one-click Undo;
  - _Fully automatic:_ the bot never asks and stops at its limit.
- Undo never overwrites a file you've changed since.
- Spending limits per task and per day. Going over pauses the task until you answer, in the app, the menu bar, your phone or the terminal.
- An append-only, hash-chained activity log. `covo audit verify` and the Library show it hasn't been changed.
- Attack tests in CI: a planted instruction can't read your SSH key, raise limits, change Covo's data or send anything out.

### Your AI

- **Codex** works with any ChatGPT plan, Free included. **Claude Code** works with Claude Pro or Max. In both cases, Get runs the maker's own installer, Sign in starts the program's own sign-in, and Covo never sees it.
- **Codex runs in a sandbox of its own.** It has its own Codex folder, and its network reaches only OpenAI's servers through Covo's filter.
- **Sign in with ChatGPT** works for ChatGPT Go, Plus, Pro and Business.
- **API keys** for Claude, GPT, Gemini, Grok, DeepSeek, Mistral, Groq and OpenRouter, kept in the macOS Keychain.
- **Local models** through Ollama or LM Studio.
- **Fallbacks:** each bot has its models in order, and the next one takes over when one hits a limit or fails.
- **Terms first:** the provider terms we checked are recorded in [docs/SUBSCRIPTIONS.md](docs/SUBSCRIPTIONS.md).

### The app

- **Chat:** a chat per bot, with live steps, the changes made (with a diff), Keep, Undo and spending pauses. It also shows when Covo stopped a step.
- **Needs you:** everything waiting on you, in one place.
- **Library:**
  - the activity log in plain words, with a tamper check and a "Stopped by Covo" filter;
  - every task;
  - your files.
- **Settings:** your AI plans and keys, spending, and this Mac's capacity, in light or dark.
- **Covo.app:** a SwiftUI menu bar app with notifications, approvals from the menu bar, pause all, and a window around the app.

### Working while you're away

- **The background service:** `covo service install` starts it at login with launchd. It runs a queue sized to your Mac's memory, battery and heat, behind a local API that answers only Covo's app or your token.
- **Routines:** tasks on a schedule ("weekdays 9:00", or just ask in a chat), with quiet hours and missed-run handling.
- **A daily summary** of what ran, what changed, what was spent and what's waiting.
- **Your phone:** a Telegram bot of your own brings spending pauses with Allow and Deny, and short summaries. It listens only to your chat.

### Showing it

- **`covo demo`:** a task, Undo, an attack stopped, a spending pause and the tamper check, in a throwaway folder.
- **`covo demo --app`:** the demo's results in the app.
- **`covo demo files`:** the demo's sample files in your workspace, to show Covo with your own AI.
- **Docs:** [ARCHITECTURE.md](docs/ARCHITECTURE.md) explains how Covo works, and [DEMO.md](docs/DEMO.md) is a 3-minute recording script.

### Requirements

- macOS on Apple Silicon and Bun 1.4+. Ollama is optional, and so are Xcode's command-line tools (only for Covo.app).

### Next

- Phase 4 continues with Mail, Calendar and other Mac apps; MCP connections; a browser for bots; memory; shared skills; Slack, Discord and iMessage; and a one-command install. See [docs/PHASE4.md](docs/PHASE4.md).
