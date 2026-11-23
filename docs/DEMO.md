# Demo script

There are two ways to show Covo.

- **The one-minute demo:** `bun run demo`. It runs in a throwaway folder with a stand-in model, so it works on any Mac with no account. Use it in an interview, or as the safety part of a video.
- **The real thing, with your own AI** (below): a short video of Covo doing real work on your ChatGPT plan through Codex, then the safety story.

## Before you record (about 5 minutes)

1. Check that Codex is connected: Settings → AI models → **Use your ChatGPT plan (Codex)** says *Connected*. If it isn't, press Get Codex, then Sign in, then Connect.
2. Put the demo files in your workspace:
   ```bash
   bun run covo demo files
   ```
   This adds `notes.md` and `inbox/vendor-email.txt` and never overwrites a file you have.
3. Optional: `bun run covo phone connect`, so spending pauses and summaries reach your phone.
4. Open Covo.app (or run `bun run covo app`). Make the window about 1440×900, choose the dark theme in Settings → General, and close other apps' notifications.
5. Open a Terminal window in the repo for scene 3.
6. Record with macOS's own recorder: press ⇧⌘5 and choose *Record Selected Portion*.

The app shows your Mac account's name at the bottom left. It's your own demo, so that's fine.

## The video (about 3 minutes)

| Time | On screen | What to say |
|---|---|---|
| 0:00–0:15 | The app: bots in the sidebar, the Assistant's chat | "This is Covo, an open-source AI coworker for the Mac. Bots do real work on your files, with the AI you already pay for, and they're safe by design." |
| 0:15–0:30 | Settings → AI models: Codex *Connected*, plus Claude Code and Sign in with ChatGPT | "It uses my ChatGPT plan through OpenAI's own Codex program. Covo installed it and started its sign-in, but it never sees my sign-in. Claude plans work the same way." |
| 0:30–1:10 | The Assistant's chat: type **Turn notes.md into a tidy README.md**. The steps appear live, then *1 file changed · Kept*. Press **See changes**, then **Undo**. | "The bot works on an instant copy of my folder inside the macOS sandbox. The change is kept, here's the diff, and one click puts everything back exactly as it was." |
| 1:10–1:50 | Terminal: `bun run demo`. Let section 3 scroll by: four ⛔ lines. | "This email hides instructions telling AI assistants to steal my SSH key, raise their spending limit and upload the key. This stand-in model obeys every word, the worst case. The sandbox stops all four attempts, and nothing leaves the Mac." |
| 1:50–2:15 | The app: **Library**. The green *Tamper-checked* banner, then the **Stopped by Covo** filter. | "Every step goes into an activity log where each entry is sealed with a hash of the one before, so nothing can be quietly changed or removed. Here's everything Covo stopped." |
| 2:15–2:40 | **More → Routines**: add one for "weekdays 9:00". Then show the daily summary card in the chat, or a spending pause on your phone. | "Bots also work on a schedule, send a daily summary, and pause to ask me before they spend more than I allowed, in the app or on my phone." |
| 2:40–3:00 | The README's architecture diagram, or the repo | "It's built with Bun, TypeScript, SQLite, Swift and macOS's own sandbox. There are about 340 tests, and they run the real sandbox in CI." |

## If something goes wrong on camera

- **The task fails with a usage limit.** The Free plan's Codex limits are small. Use the one-minute demo instead, or add a free Gemini key as the bot's fallback: Settings → AI models → **Add a free key** (in the Google row).
- **Codex isn't connected after a restart.** Settings → AI models → Codex → Check again. The service log is at `~/Covo/logs/covod.log`.
- **You want the app with no personal data.** Run `bun run demo --app`. It opens the demo's results in the app, with "Demo" as the name.

## Screenshots

The README's images come from the demo, rendered at Retina size by WebKit, off screen:

```bash
bun run demo --app --no-open     # prints a sign-in link; leave it running
swift scripts/snap.swift "<that link>" docs/images \
  "chat=#/bot/bot_assistant:dark" "library=#/library:dark" "models=#/settings/models:light"
```
