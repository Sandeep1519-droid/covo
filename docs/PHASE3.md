# Phase 3 Plan: The App and Your Phone

> Status: **in progress** (M0–M2 done), 19 Nov 2026. Planned 18 Nov 2026. Follows [BLUEPRINT.md](BLUEPRINT.md) §5 "Revised roadmap" and ADR-006 (chat-first UI) and ADR-012 (phase order). Phase 2 is done ([PHASE2.md](PHASE2.md)). Anything here can change later. The decisions in §7 need your OK before M0 starts.

## 1. Goal

By the end of Phase 3, Covo is something people use every day, not just a command line:

```
Covo.app in the menu bar   ●  1 needs you
  └─ open → chat with "Docs helper": "tidy the docs folder"
       → steps stream in → "Kept 3 files" card with Undo
Your phone (Telegram)      "Docs helper wants to spend up to $0.06 more. [Approve] [Deny]"
Every weekday at 9:00      "Inbox tidy" runs by itself; at 18:00 a daily summary arrives
```

1. **A background service (`covod`)** runs bots. The app, the phone and schedules all use it, and `covo` commands still work.
2. **The chat app** from the Figma design. It has a sidebar of bots and a chat per bot. Results appear as cards in the chat: file changes, Undo, spending approvals and "needs you" items. It also has screens for new bots, models, limits and the power profile.
3. **A Mac app** (`Covo.app`) with a menu bar icon, a window for the chat, and notifications.
4. **Phone approvals** through a Telegram bot that you create. It needs no server and costs nothing.
5. **Routines.** Tasks run on a schedule, and a daily summary says what happened.

Covo stays local. Nothing listens beyond your own Mac, and every request to the service needs a secret token.

## 2. Zero-cost testing

- The service, API and app are tested with the mock model, as in Phase 2. UI tests run headless Chromium against the built app (Playwright, free).
- Telegram is free. Tests use a stand-in Telegram server that records the bot's messages. Live tests use a bot you create with @BotFather.
- The Mac app builds with the Xcode already installed and a free Apple ID (ADR-002). Paying for an Apple Developer account is only needed to give the app to other people.
- Live checks use the local model (qwen3.5:4b), so they cost nothing.

## 3. Milestones

| # | Milestone | You can run | Est. |
|---|---|---|---|
| **M0** | **The service, `covod`.** One Bun process using Hono. It listens on `127.0.0.1:7420` (HTTP and live updates over SSE) and on a socket at `~/Covo/run/covod.sock`. `covo service install/uninstall/status` sets it up as a macOS login item (launchd). Runs move into the service: a queue that follows the power profile, and runs that survive closing the terminal. `covo run` hands work to the service when it's running, and works alone when it isn't. An event stream records each run's state, steps, approvals and results; it uses the AG-UI event names where they fit (the version is checked when building). | `covo service install` → `covo run …` → close the terminal; the run finishes, and `covo status` shows it (done:
- **Shape:** `covo service run` is the service, built into the same `covo` program with Bun's own server, so there's no Hono dependency. It listens only on `~/Covo/run/covod.sock`, in a folder only you can open; the network port and its token come in M1.
- **Commands:** `covo service install/uninstall/status` (a login item via launchd) and `covo stop <run>`. `covo run --here` skips the service.
- **Queue:** tasks wait their turn by power profile.
- **Recovery:** tasks left by a crash are marked failed, and their copies deleted, when the service starts (migration 0005 records which process runs each task).
- **Streaming:** progress streams to the terminal, with a keep-alive every 5 s.
- **Shutdown:** SIGTERM stops tasks safely.
- **Verified live:** idle memory 38 MB; a task finished after its terminal command was killed; SIGTERM cleaned up.
- **Not yet done:** installing the login item on this Mac, which waits for your OK) | 4–5 days |
| **M1** | **The API, locked to you.** Endpoints for everything the command line does: bots, models (keys go in, never out), runs (start, stop, log, diff, keep, discard, undo), approvals, usage, limits, profile, doctor. A random token (in `~/Covo/state/`, readable only by you) is required on every request. Requests from websites are refused (Host and Origin checks), which blocks DNS rebinding and cross-site attacks. Shared request and response types live in `packages/api`. | `curl` without the token → 401; a request carrying a website's Origin → 403; `covo app` opens the app already signed in (done:
- **Port:** `127.0.0.1:7420` inside the service. Routes cover bots, models (a key goes in and never comes out), runs (start, detail, review, keep, discard, undo, stop), approvals (the answer must carry the request's hash), usage, limits, profile, doctor, `audit/verify`, and live events (SSE). Types are in `packages/api`.
- **Gate:** every request needs the token (`~/Covo/state/api-token`, mode 600) or a session cookie (HttpOnly, SameSite=Strict). The Host and Origin are checked; there is no CORS. Bodies must be JSON, and a change signed only by the cookie must carry Covo's own Origin.
- **`covo app`:** gets a one-time code (2 minutes) over the private socket and opens `/ui/#code=…`. A small placeholder page signs in and lists bots and tasks.
- **Verified live:** no token gives 401; another site's Origin and a forged Host give 403; the browser signed in and showed real data) | 3 days |
| **M2** | **The app shell.** A web app in `apps/app` (React, TypeScript), built into the service and served at `/ui`. Colours and spacing come from the Figma variables (Dark and Light modes, ADR-006). The layout has an icon rail (Home, Needs you, Library, More, Settings), the bot sidebar, and a message box with a model picker. Light and dark themes, following the system by default. | `covo app` → the window looks like the Figma `Screens` page in both themes (done:
- **Build:** Bun's own bundler (`bun run app:build`) instead of Vite, so there are no extra build tools to trust. The app's only packages are React and React DOM. Inter is bundled (Latin only), so nothing loads from the internet.
- **From Figma:** tokens in `apps/app/src/tokens.css` match the Color and Radius variables one-to-one; the light theme also uses the Soft radii. Icons are the Figma exports, one set per theme. The 12 avatar shapes are drawn inline and coloured by overriding the Body fill, as the component's notes say. New bots now get those 12 shapes and 20 colours (`AVATAR_SHAPES`/`AVATAR_COLORS` in `packages/api`).
- **What works:** your real bots by department with the main bot pinned, each bot's last task and time, the Needs you count, today's spending, and your name (new `GET /api/me`). Sending a message starts a task with the chosen model. Updates arrive live, and the Needs you page can answer spending pauses. Back and forward move between screens. A theme switch is in Settings. Each task shows as your message and the bot's reply; the full chat and cards are M3.
- **Waiting for later milestones:** New bot, search, sections, attach, voice, Computer, Details and Share. Each shows "Arrives in a later update".
- **Service:** serves `apps/app/dist` with a strict content policy, and can't serve files outside that folder (tested). Before the app is built, the page explains how to build it. Live-update keep-alives now go every 5 s (Bun drops connections idle for 10 s).
- **Verified live:** your service shows your bot and its past task; a throwaway copy with five sample bots matched the H2 screen in both themes; a message started a task, which showed Working and then Stopped live; no console errors) | 4 days |
| **M3** | **Chat and cards.** Each bot has its own chat. A message becomes a task; recent messages go along as context (new tables `conversations` and `messages`). Steps stream in live. Cards:<br>• **File changes**, with a diff viewer and Keep, Discard or Undo<br>• **Spending pause**, with Approve and Deny<br>• **Failed or stopped**, with the reason<br>• **Needs you**, an inbox of everything waiting<br>Screens: New bot (avatar shape and colour, name, purpose, model, level), Models (add a key in a hidden field that goes straight to the Keychain), Limits, Power profile. | Create a bot in the app, give it a task, undo it, approve a spending pause; all of it shows in `covo audit verify` | 6–7 days |
| **M4** | **The Mac app.** `Covo.app` in SwiftUI:<br>• a **menu bar icon**: idle, working, or a count of things waiting for you<br>• **quick actions**: open Covo, pause all bots, the latest approval<br>• a **window** that shows the chat app (WKWebView, the system's own web engine; no copy of Chrome)<br>• **macOS notifications** when something needs you<br>• it **starts the service** if it isn't running.<br>Signed with your free Apple ID. | Quit Terminal; the menu bar shows "1 needs you" → click → approve | 4 days |
| **M5** | **Your phone (Telegram).** Run `covo phone connect`. You create a bot with @BotFather and paste its token, which goes to the Keychain. Then you send the pairing code from your phone. Covo checks Telegram for messages itself (long polling), so no server or public address is needed.<br>• **Messages:** a task finished (short summary), approval cards with **Approve and Deny buttons** tied to that exact request and expiring, and failures.<br>• **Accepted only from your paired chat.** The phone can approve spending pauses. Raising limits or levels stays on the Mac until Touch ID arrives in Phase 4.<br>• **Optional:** start a task by messaging the bot (off by default). | Your phone gets a spending pause → tap Approve → the run continues; a message from another Telegram account is ignored and logged | 4 days |
| **M6** | **Routines and the daily summary.** Commands: `covo routines add "Inbox tidy" --bot <name> --every "weekdays 9:00" "<task>"`, plus `list`, `pause` and `remove`, and the same in the app. The service runs them on time, and a run missed while the Mac slept happens once when it wakes (or is skipped, your choice). Quiet hours, and no new routine runs when memory is critically low (power profile). A daily summary at a time you pick, in the app and on your phone, covers what ran, what changed (with Undo), what was spent and what's waiting. | A routine set for 2 minutes from now runs by itself; the daily summary lists it | 3–4 days |
| **M7** | **Demo, docs and safety check.** The acceptance demo below and README updates. Attack tests:<br>• a web page tries to call the service (cross-site request, DNS rebinding)<br>• requests with a missing or wrong token<br>• a Telegram message from a stranger<br>• a replayed or edited approval<br>• a run that tries to read the service token.<br>All are refused and logged. | The acceptance demo passes end to end | 2–3 days |

Total: about **4–5 weeks** part-time.

## 4. Acceptance demo (end of Phase 3)

```bash
covo service install                  # the service starts at login
covo app                              # Covo.app opens, signed in, in your system theme
# In the app: New bot "Docs helper" (shape, colour, model local, Automatic)
# Chat: "add a Setup section to README.md" → steps stream → "Kept 1 file" card → Undo → restored
covo phone connect                    # create a Telegram bot, pair your phone
covo bots set "Docs helper" --task-limit 0.001
# Chat: "summarise every file in docs/" → pause → card in the app AND on the phone → Approve on the phone
covo routines add "Daily notes" --bot "Docs helper" --every "in 2 minutes" "summarise NOTES.md"
# Two minutes later it runs by itself; the daily summary lists both runs
curl http://127.0.0.1:7420/api/runs   # 401: no token
covo audit verify                     # chain OK, phone approval recorded as decided_by phone
```

Pass criteria:
- With no window open, the service uses at most 120 MB of memory. The Mac app's window adds at most 150 MB. (8 GB Mac, ADR-001.)
- Every action in the app or on the phone shows up in the activity log, just like the same action from `covo`.
- A key typed into the app reaches the Keychain and never appears in any file, log or response.
- No other website, local user or Telegram account can use the service.
- Closing the app or the terminal never stops a running task. Stopping the service does stop it safely, and the workspace copy is thrown away.

## 5. Design notes

- **One engine, three front doors.** The command line, the app and the phone all call the same API. The engine from Phases 1 and 2 doesn't change. The service adds a queue, live updates and the schedule.
- **Localhost is not safe by default.** Any website you visit can try to send requests to `127.0.0.1`. That's why every request needs the token, the service accepts only `Host: 127.0.0.1:7420`, and requests from other origins are refused. The app receives the token once, through `covo app` or the Mac app, never in a link you could share.
- **Approvals are bound to the request.** Each approval card carries a hash of the exact request and an expiry time. An edited or replayed approval is refused (BLUEPRINT §3.5).
- **The phone sees summaries, not files.** Telegram messages go through Telegram's servers. By default they contain the bot's name, a one-line summary, the amount and the buttons, never file contents or diffs. A setting can reduce this to "something needs you" only.
- **Chat is tasks with memory of the chat.** Each message starts a run, and the last few messages go along as context. Lasting memory (rules a bot learns) is Phase 4.
- **"Always allow" rules** (deferred in Phase 2 M4) stay in Phase 4. They come with signed rules and Touch ID, and Phase 3 adds no new irreversible actions.
- **Figma to code.** Screens are built from the "Covo App Design" Figma file through the Figma tools, using its variables as CSS variables (`var(--color-bg-app)` and so on). The `Screens` page (dark) and the `Screens · Light` page are the reference for each screen.

## 6. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| A website attacks the local service | Medium | A token on every request, Host and Origin checks, no CORS; covered by the M7 attack tests. |
| The app and service use too much memory on 8 GB | Medium | WKWebView instead of a bundled Chrome. The app's code is loaded only when a screen opens. Memory is measured in the demo, with limits in §4. |
| The Mac sleeps through a routine | High | Missed routines run once on wake (or are skipped, your choice). The daily summary says what was missed. |
| Telegram is down or blocked | Low | The app and notifications still work, and approvals still wait on the Mac. |
| Learning SwiftUI slows M4 | Medium | The Mac app is a thin shell: a menu bar, a window and notifications. All screens are web code. A browser tab works as a fallback. |
| Too many screens in the Figma design | High | Phase 3 builds only the screens in M2 and M3. The rest wait for the features they belong to. |

## 7. Decisions to confirm

1. **Mac app shell: SwiftUI with the system web view** (recommended). It's the smallest option, and Touch ID in Phase 4 also needs Swift. *Or* Tauri: one shell for Mac and the later Windows port, but it adds the Rust toolchain. *Or* no app yet, just a browser tab.
2. **Phone: Telegram first** (recommended): free, no server, buttons in messages. Slack or Discord could follow later. WhatsApp's business API costs money, and iMessage automation isn't reliable.
3. **What the phone may do:** approve or deny spending pauses and see results (recommended). Raising limits, changing levels and adding keys stay on the Mac until Phase 4 brings Touch ID.
4. **What goes to Telegram by default:** short summaries without file contents (recommended), or only "something needs you".
5. **Missed routines while the Mac slept:** run once on wake (recommended), or skip.
