# Using an AI subscription with Covo Bot

Phase 2, M6. ADR-009 says: **terms first.** Before Covo runs anything on someone's Claude, ChatGPT or Gemini subscription, we record what each company's terms say right now. We build only what they allow, keep it opt-in, and never copy or reuse login tokens.

Checked on **18 November 2026**. Terms change, so check again before each release. The "Re-check" column says where to look.

## Summary

| Subscription | Official tool | What the terms say | Covo |
|---|---|---|---|
| Claude Pro, Max or Ultra | Claude Code (`claude`) | Allowed, with conditions: you sign in to the **unmodified** Claude Code program yourself, through Anthropic's own sign-in. Other apps may not take, store or pass along your sign-in. | **Built (opt-in):** Covo runs your installed `claude` program in its sandbox. Covo never sees your sign-in. In the app: Settings → AI models → Connect (Phase 4 M1), after `claude auth status` says you signed in with your Claude account, not an API key. |
| ChatGPT Plus or Pro | Sign in with ChatGPT (OpenAI's sign-in for apps); Codex CLI (`codex`) | **Allowed for open-source apps on your own computer** (a preview, checked 20 Nov 2026): you approve on OpenAI's page, and use counts against your plan. Paid or hosted apps need OpenAI's approval. Driving the Codex program on its own sign-in is still not covered. | **Built (opt-in, Phase 4 M1):** Settings → AI models → Continue with ChatGPT, or `covo models add chatgpt`. Covo signs in itself and keeps its own tokens in the Keychain; it never reads Codex's sign-in file. |
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

## Rules for any future engine

1. Read the provider's current terms and record them here, with dates and links.
2. Run only the provider's official program, unmodified, which the user installed and signed into themselves.
3. Never read, copy, store or send the user's login or tokens.
4. Make it opt-in and say plainly what happens.
5. Run it in Covo's sandbox, on a workspace copy, with the fewest tools that do the job.
6. Log its usage and fall back down the bot's chain when it hits a limit.
