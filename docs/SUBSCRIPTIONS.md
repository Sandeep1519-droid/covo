# Using an AI subscription with Covo Bot

Phase 2, M6. ADR-009 says: **terms first.** Before Covo runs anything on someone's Claude, ChatGPT or Gemini subscription, we record what each company's terms say right now. We build only what they allow, keep it opt-in, and never copy or reuse login tokens.

First checked on **18 November 2026**, last on **22 November 2026** (see the update at the end). Terms change, so check again before each release. The "Re-check" lines say where to look.

## Summary

| Subscription | Official tool | What the terms say | Covo |
|---|---|---|---|
| Claude Pro, Max or Ultra | Claude Code (`claude`) | Allowed, with conditions: you sign in to the **unmodified** Claude Code program yourself, through Anthropic's own sign-in. Products may install or run Claude Code. Other apps may not take, store or pass along your sign-in. | **Built (opt-in):** Covo runs Claude Code in its sandbox and never sees your sign-in. In the app (Settings → AI models): **Get** runs Anthropic's installer, **Sign in** starts Claude Code's own sign-in, then **Connect**. |
| ChatGPT, any plan, including Free | Codex (`codex`) | **Allowed** (checked 22 Nov 2026): OpenAI's Codex SDK docs describe running Codex inside your own app, and Codex comes with every ChatGPT plan. | **Built (opt-in):** **Get**, **Sign in** (Codex's own ChatGPT sign-in), **Connect**. Covo's Codex has its own Codex folder, and its network reaches only OpenAI. |
| ChatGPT Go, Plus, Pro or Business | Sign in with ChatGPT (OpenAI's sign-in for apps) | **Allowed for open-source apps on your own computer** (a preview, checked 20 Nov 2026): you approve on OpenAI's page, and use counts against your plan. Free accounts can't share their plan this way. | **Built (opt-in, Phase 4 M1):** Settings → AI models → Continue with ChatGPT, or `covo models add chatgpt`. Covo signs in itself and keeps its own tokens in the Keychain. |
| Google AI Pro or Ultra | Gemini CLI (`gemini`), now Antigravity CLI (`agy`) | Gemini CLI's "Login with Google" stopped working for these plans on 18 June 2026. Antigravity's terms forbid accessing the service through third-party software, and Google has suspended accounts for it. | **Not built.** Use a Gemini API key (free tier available: `covo models add gemini`). |

## Claude (Anthropic)

**Sources**
- Claude Code docs, [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance), read 18 Nov 2026.
- Claude Code docs, [Run Claude Code programmatically](https://code.claude.com/docs/en/headless), read 18 Nov 2026.
- Background: [The Register, 20 Feb 2026](https://www.theregister.com/software/2026/02/20/anthropic-clarifies-ban-on-third-party-tool-access-to-claude/5014546) on the clarification that banned subscription sign-ins in third-party apps.

**What the terms say** (from the legal and compliance page):
- Claude Code on Free, Pro, Max and Ultra plans falls under the Consumer Terms.
- Subscription (OAuth) sign-in "is designed to support ordinary use of Claude Code and other native Anthropic applications."
- Developers may not "offer Claude.ai login into their own applications," may not "route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users," and may not "collect, store, or intermediate Claude.ai credentials or session tokens." Sign-in must complete through Anthropic's own flow.
- The same page says this does not prevent "an end user from signing in to the unmodified Claude Code binary with their own Claude subscription," including when a platform runs Claude Code.
- Products that run Claude Code must not modify the program or remove its sign-in options, and may not "pay for, resell, or intermediate Claude usage" for their users.
- Plan limits "assume ordinary, individual usage of Claude Code and the Agent SDK."
- Claude Code's own docs describe `claude -p` as the supported way to run it from scripts.

**What Covo does, and why it fits the terms**
- **Your program, your sign-in.** Covo runs the `claude` program you installed, unmodified, with `claude -p`. You sign in with `claude` yourself; Covo has no sign-in screen.
- **Covo never sees your sign-in.** It never reads, copies or stores your Claude login or tokens. Claude Code reads its own sign-in from your Keychain, as it always does.
- **Nothing is resold or shared.** Covo has no servers and no accounts. The usage is yours, on your own Mac, for your own tasks.
- **Opt-in.** Nothing changes until you choose it in `covo models add` (choice "Claude Code") and confirm.
- **Ordinary, individual use.** Covo runs at most one Claude Code task at a time per Mac. It never runs Claude Code in a loop or for anyone else.
- We don't use the Claude Code name in Covo's own name or logo, and we don't suggest Anthropic endorses Covo.

**How it runs** (the `cli-agent` sandbox profile)
- Claude Code works on Covo's copy of your workspace, just like a Covo model does. Its changes go through the usual review, keep and undo.
- It can use only file tools (`Read`, `Edit`, `Write`, `Glob`, `Grep`). There's no shell and no web tool, so a bad instruction in a file can't make it run commands.
- Covo turns off your MCP servers and slash commands, and ignores the workspace's `.claude` settings, because a workspace could plant hooks there. Your own `~/.claude` settings still apply.
- The macOS sandbox lets it write only to the workspace copy, a temporary folder and Claude Code's own folders (`~/.claude`, `~/.claude.json`, its cache). It may reach the network, which it needs to talk to Anthropic, and the Keychain, which it needs to read its own sign-in.
- **Trade-off:** Covo's own API keys also sit in your login Keychain. With no shell available, Claude Code can't run the `security` command to read them. Phase 4 moves Covo's keys into its own vault, with Touch ID.

**Usage and limits**
- Each run records Claude Code's token counts and turns in `covo usage`, under the tier `cli`, at $0. A subscription is a flat fee, so Covo's spending limits don't count it.
- Claude Code also reports what the run would have cost on the API. Covo saves that in the activity log for your information only.
- If you signed Claude Code in with a Console **API key** instead of a subscription, Anthropic bills that key. Those charges show in the Claude Console, not in Covo.
- **Cap hit:** when Claude Code reports a usage limit, a sign-in problem or an overload, the bot's next model takes over in the same workspace copy (for example claude-sub → gemini → local). The new model is told that another engine stopped partway, so it checks the files first.

**Re-check:** the [legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) page, the [Consumer Terms](https://www.anthropic.com/legal/consumer-terms), and [authentication](https://code.claude.com/docs/en/authentication).

## ChatGPT (OpenAI)

**Sources**
- Codex docs, [Authentication](https://learn.chatgpt.com/docs/auth), formerly developers.openai.com/codex/auth, read 18 Nov 2026.
- OpenAI Help, [Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan). The page refused automated reading (HTTP 403); search summaries say ChatGPT's Terms of Use apply and plan limits apply.
- The [ChatGPT Terms of Use](https://openai.com/policies/row-terms-of-use/) also refused automated reading (HTTP 403), so we could not quote them.

**What we found**
- Codex supports "Sign in with ChatGPT for subscription access" and API keys for usage-based billing.
- The docs say: "Use API key authentication for programmatic Codex CLI workflows, such as CI/CD jobs" and "API keys are still the recommended default for automation."
- They also say: "Treat `~/.codex/auth.json` like a password."
- Nothing we read says that another app may run Codex on someone's ChatGPT sign-in, and nothing clearly forbids it either.

**Decision:** not built. OpenAI points automation to API keys, and we couldn't read the governing terms ourselves. Covo already supports OpenAI API keys. We'll revisit if OpenAI publishes clear guidance; a person should read the Terms of Use in a browser before then.

**Re-check:** [Codex authentication](https://learn.chatgpt.com/docs/auth), the [ChatGPT Terms of Use](https://openai.com/policies/row-terms-of-use/), and the [Codex plan help page](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan).

**Update, 20 Nov 2026: Sign in with ChatGPT**

Sources, read 20 Nov 2026:
- OpenAI's developer docs: [plan usage for open-source and local apps](https://developers.openai.com/siwc/token-sharing-open-source), [the sign-in flow](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) and [client IDs for commercial partners](https://developers.openai.com/siwc/request-client-id).
- The help page [Using your ChatGPT plan in other apps and sites](https://help.openai.com/en/articles/11369540-using-your-chatgpt-plan-in-other-apps-and-sites) refused automated reading (HTTP 403). A person should read it in a browser.

What we found:
- "Sign in with ChatGPT" lets an app use the user's ChatGPT plan after the user agrees on OpenAI's own page. The docs cover "open-source and locally hosted apps" directly.
- For those apps the sign-in needs no client secret and no partner key, and the docs describe no application step. Paid or hosted apps go through an interest form for commercial partners.
- It's a preview. Requests go to OpenAI's Responses API, some request settings aren't supported, and the button must say "Continue with ChatGPT".
- The docs say nothing about scheduled, unattended use of a plan.
- Driving the Codex program on its own ChatGPT sign-in still isn't covered.

**Decision:** built in Phase 4 M1 as an opt-in connection. Covo signs in through OpenAI's page, keeps its own sign-in in the Keychain, and never reads `~/.codex/auth.json`. Routines don't use it unless you allow subscriptions for routines (`covo routines subscriptions on`).

**How Covo follows the rules** (`packages/models/src/chatgpt.ts`, `responses.ts`):
- Sign-in: OAuth with PKCE and no client secret, through OpenAI's own page in your browser. The answer comes back to a one-time page on `127.0.0.1` (port 1455, or another free one). Covo checks the `state`, checks OpenAI's signature on the ID token (issuer, audience, expiry, nonce), and checks that you granted `chatgpt.tokens.use.direct` before saving anything.
- This Mac gets an opaque id once (`urn:uuid:…`); OpenAI's id for Covo on your account (`oaiapp_…`) is kept for signing in again. Neither is a secret.
- Tokens: in the macOS Keychain only, never in a file, URL or log. The access token lasts an hour. Covo renews it one renewal at a time, because the refresh token changes each time. A renewal OpenAI refuses for good ends the sign-in and asks you to sign in again; a network problem doesn't.
- Requests: OpenAI's Responses API with `store: false` and `stream: true`; system text as `instructions`; none of the fields the preview rejects. Only `response.completed` counts as a finished reply.
- Errors: the plan's usage limit says so, with OpenAI's usage page (https://chatgpt.com/settings/usage). Covo never switches you to paid API use behind your back. Your bot's next model takes over only if you gave it one.
- Wording: the button says "Continue with ChatGPT". The app shows "Using ChatGPT plan" next to the model picker, with "Manage usage", and a one-time welcome note.
- Sign-out revokes the sign-in at OpenAI, then forgets the tokens.

## Gemini (Google)

**Sources**
- Google, [Gemini Code Assist consumer accounts deprecation](https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals), read 18 Nov 2026.
- Gemini CLI, [Terms of service and privacy notice](https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/tos-privacy.md), read 18 Nov 2026.
- Gemini CLI discussion [#22970, "Service update: mitigating abuse and prioritizing traffic"](https://github.com/google-gemini/gemini-cli/discussions/22970), 18 Mar 2026.
- Google AI developer forum threads on running `agy` from other tools, for example [this one](https://discuss.ai.google.dev/t/is-it-allowed-for-an-open-source-tool-to-call-the-official-agy-cli-in-headless-mode/183429). These are not official statements, and the answers conflict.

**What the terms say**
- Since 18 June 2026, the free individual tier and the Google AI Pro and Ultra tiers no longer work with Gemini CLI. "Login with Google" no longer works for them. Google points these users to Antigravity CLI.
- Gemini CLI's terms say that directly accessing its services "using third-party software, tools, or services … is a violation of applicable terms and policies" and "may be grounds for suspension or termination of your account."
- Antigravity's terms say much the same, and news reports say Google suspended accounts that used third-party tools. Forum replies disagree on whether running the official `agy` program from another app counts. Some say the Google AI Pro quota is only for direct use in Google's own tools.

**Decision:** not built. Gemini CLI no longer serves these plans, and the Antigravity terms are at best unclear while the risk is account suspension. Covo already supports Gemini API keys, including the free tier.

**Re-check:** the [deprecation page](https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals), Antigravity's terms and FAQ, and the [Gemini API terms](https://ai.google.dev/gemini-api/terms).

## Update, 22 November 2026: get and sign in from the app, and Codex

The user asked for what other bots offer: get the AI programs and sign in from inside the app, with no Terminal. We checked the terms again and looked at how other bots do it.

**What other bots do** (their own docs, read 22 Nov 2026)
- **OpenClaw** runs your installed Claude Code, which keeps its own sign-in. You install it and run `claude auth login` yourself. For ChatGPT, OpenClaw runs Codex's sign-in with its own code (browser or device code), or Sign in with ChatGPT. For Gemini it now uses an API key and no longer creates Google sign-ins. Sources: [OpenAI sign-in](https://docs.openclaw.ai/providers/openai/authentication), [CLI backends](https://docs.openclaw.ai/gateway/cli-backends).
- **Hermes Agent** signs in to Codex itself with a device code, and has an experimental plugin that runs Claude Code. Source: [providers](https://hermes-agent.nousresearch.com/docs/integrations/providers).
- **Zed** installs Claude, Codex and Gemini CLI from its own agent list. Each program then signs you in with its own flow, and Zed never sees the tokens. Source: [external agents](https://zed.dev/docs/ai/external-agents).

**Claude (Anthropic)**

Sources, read 22 Nov 2026: [legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) and [Using the Agent SDK with your plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).
- The legal page covers products that preinstall or run Claude Code. Its conditions:
  - the program stays unmodified, with none of its sign-in options removed or restricted;
  - each person signs in with their own account, through Anthropic's own flow;
  - the product doesn't resell or intermediate usage;
  - Anthropic's names and logos stay out of the product's name and logo. Saying in plain text that it runs Claude Code is fine.
- Developers still may not collect, store or pass along Claude sign-ins, or route requests through plan credentials on their users' behalf. Products built on the Agent SDK should use API keys.
- The help article has updates from 15 June and 7 October 2026. When you're signed in with your plan, `claude -p` and the Agent SDK draw from your plan's limits. The monthly API credits included with Max, Ultra and Team plans cover API-key use only.

**Decision:** built.
- **Get** runs Anthropic's official installer.
- **Sign in** starts Claude Code's own sign-in (`claude auth login --claudeai`). Your browser opens Anthropic's page, and Claude Code keeps the sign-in in your Keychain; Covo never sees it. The app shows the link Claude Code prints, in case the browser doesn't open.

**ChatGPT (OpenAI)**

Sources, read 22 Nov 2026: [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk), [Codex pricing](https://learn.chatgpt.com/docs/pricing), [Codex CLI](https://learn.chatgpt.com/docs/cli), [authentication](https://learn.chatgpt.com/docs/auth), [Sign in with ChatGPT](https://learn.chatgpt.com/docs/sign-in-with-chatgpt).
- The Codex SDK page lists running Codex inside your own application as a use. It also describes Codex's app server for building your own clients, including their sign-in. That settles the question we left open on 18 November: another app may run the official Codex program.
- Codex comes with every ChatGPT plan: Free, Go, Plus, Pro, Business, Edu and Enterprise. Free and Go are meant for lighter use.
- Sign in with ChatGPT lets an app use only Go, Plus, Pro and Business plans. A Free account can't grant it, which is why OpenAI's page told our user "a required permission is unavailable".
- The authentication page still recommends API keys for automation, and says to treat Codex's `auth.json` like a password.
- Official installer: `curl -fsSL https://chatgpt.com/codex/install.sh | sh`. It puts `codex` in `~/.local/bin`, and the program itself in `~/.codex/packages`.

**Decision:** built, as a second engine (opt-in). How Covo follows the rules:
- **Get and sign-in:** **Get** runs OpenAI's official installer. **Sign in** starts Codex's own Sign in with ChatGPT (`codex login`). Codex handles the sign-in and keeps it; Covo never reads it.
- **Its own Codex folder:** Covo's Codex uses `~/Covo/engines/codex` instead of `~/.codex`. It never sees your own Codex settings, sign-in or history, and the `codex` you use in Terminal isn't affected. Covo tells Codex to keep its sign-in in that folder (`auth.json`) rather than the Keychain, so the sandbox needs no Keychain access.
- **How tasks run:**
  - The command is `codex exec --json --ephemeral --ignore-user-config --ignore-rules`, with approvals, web search, ChatGPT apps, plugins and OpenAI's analytics all off.
  - Codex checks OpenAI's certificates against the Mac's own list in `/etc/ssl/cert.pem` (`CODEX_CA_CERTIFICATE`), because its sandbox has no Keychain access.
  - It works on Covo's copy of your files, in Covo's sandbox.
  - Codex's own sandbox is off, because macOS can't put one sandbox inside another.
- **Network limited to OpenAI:** Codex reads files by running commands, so unlike Claude Code in Covo it has a shell. Its network goes only through a small filter inside Covo, which lets it reach OpenAI's servers (`*.openai.com`, `*.chatgpt.com`, port 443) and nothing else. The sandbox blocks DNS and every other connection. So a bad instruction in a file can't send your files anywhere.
- **Trade-off:** inside the sandbox, Codex, and any command it runs, can read Codex's own sign-in file. With the network limited to OpenAI, the file can't be sent anywhere else.
- **Routines:** they don't use Codex unless you allow subscriptions for routines. OpenAI recommends API keys for automation, so this stays off by default.

**Google**

Sources, read 22 Nov 2026: the [deprecation page](https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals), and a [reply on Google's developer forum](https://discuss.ai.google.dev/t/supported-gemini-subscription-access-for-a-third-party-vs-code-extension/189889) saying other apps have no supported way to use Google AI Plus, Pro or Ultra, or the Antigravity sign-in.

**Decision:** unchanged. The app says so and links to a free Gemini API key.

**Re-check:** the Codex SDK and pricing pages, Anthropic's legal and compliance page, and the Sign in with ChatGPT page.

## Rules for any future engine

1. Read the provider's current terms and record them here, with dates and links.
2. Run only the provider's official program, unmodified. The user signs in to it through the program's own sign-in.
3. Never read, copy, store or send the user's login or tokens.
4. Make it opt-in and say plainly what happens.
5. Run it in Covo's sandbox, on a workspace copy, with the fewest tools that do the job. If it needs a shell, its network reaches only its maker's servers.
6. Log its usage and fall back down the bot's chain when it hits a limit.
7. Install only with the maker's official installer, from the maker's own site, and only when the user presses Get.
8. Start the program's own sign-in, and show only the link it prints. Never handle the token.
