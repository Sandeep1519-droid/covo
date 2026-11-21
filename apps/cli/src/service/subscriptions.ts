import type { ApiSubscriptions } from "@covo/api";
import { covoPaths } from "@covo/core";
import { appendAudit, openDb } from "@covo/db";
import {
  addConnection,
  beginChatGPTSignIn,
  CHATGPT,
  type ChatGPTModel,
  chatgptModels,
  chatgptSignedIn,
  engineById,
  loadSettings,
  markWelcomed,
  readAccount,
  removeConnection,
  saveSettings,
  signOutChatGPT,
  suggestName,
} from "@covo/models";
import { secrets } from "@covo/platform";
import { engineSignIn } from "../commands/engines.ts";
import { chatgptOptions, saveChatGPT } from "../commands/models.ts";
import type { Ctx } from "../main.ts";
import { HttpError } from "./api.ts";
import type { Service } from "./server.ts";

// Your own AI plans, from the app (Phase 4 M1): ChatGPT Plus or Pro through Sign in with ChatGPT,
// and Claude Pro or Max through the Claude Code program you installed. docs/SUBSCRIPTIONS.md has
// the terms we checked. Keys and tokens never come back out of here.

const CLAUDE = "claude-code";

export class Subscriptions {
  private signIn: { url: string; cancel: () => void } | null = null;
  private lastError: string | null = null;
  private models: { at: number; list: ChatGPTModel[] } | null = null;
  private claude: { signedIn: boolean | null; method: string | null } | null = null;

  constructor(
    private readonly ctx: Ctx,
    private readonly service: Service,
  ) {}

  private store() {
    return this.ctx.secrets ?? secrets();
  }

  private log(action: string, detail: Record<string, unknown>, by: string): void {
    const db = openDb(covoPaths(this.ctx.home).db);
    try {
      appendAudit(
        db,
        { actor: by.startsWith("you") ? "user" : "system", action, detail: { ...detail, by } },
        this.ctx.now,
      );
    } finally {
      db.close();
    }
  }

  async status(): Promise<ApiSubscriptions> {
    const s = loadSettings(this.ctx.home);
    const o = chatgptOptions(this.ctx);
    const gpt = s.connections.find((c) => c.provider === "chatgpt");
    const connected = Boolean(gpt) && (await chatgptSignedIn(o));
    if (connected && (!this.models || this.ctx.now() - this.models.at > 10 * 60_000)) {
      try {
        this.models = { at: this.ctx.now(), list: await chatgptModels(o) };
      } catch {
        this.models = { at: this.ctx.now(), list: this.models?.list ?? [] };
      }
    }
    const account = readAccount(this.ctx.home);
    const info = engineById(CLAUDE);
    const claude = s.connections.find((c) => c.provider === CLAUDE);
    const found = await engineSignIn(
      { ...this.ctx, engineSignIn: async () => ({ signedIn: null, method: null }) },
      CLAUDE,
    );
    return {
      chatgpt: {
        connected,
        email: connected ? (account?.email ?? null) : null,
        connection: gpt?.name ?? null,
        model: gpt?.model ?? null,
        models: connected ? (this.models?.list ?? []) : [],
        welcomed: account?.welcomed === true,
        signingIn: this.signIn !== null,
        error: this.lastError,
        manageUsageUrl: CHATGPT.manageUsage,
      },
      claudeCode: {
        path: found.path,
        install: info?.install ?? "",
        signIn: info?.signIn ?? "",
        signedIn: found.path ? (this.claude?.signedIn ?? null) : null,
        method: found.path ? (this.claude?.method ?? null) : null,
        connected: Boolean(claude),
        connection: claude?.name ?? null,
      },
    };
  }

  /** Starts Sign in with ChatGPT: the app opens the link; the result comes back here. */
  async startChatGPT(by: string): Promise<{ url: string }> {
    if (this.signIn) return { url: this.signIn.url };
    this.lastError = null;
    // What happens is written to Covo's log in plain words (never a code or a token).
    const o = { ...chatgptOptions(this.ctx), log: (line: string) => this.ctx.print(`chatgpt: ${line}\n`) };
    const s = await beginChatGPTSignIn(o);
    this.signIn = { url: s.url, cancel: s.cancel };
    void s.done
      .then(async (who) => {
        // The app shows the one-time welcome note itself, then marks it seen.
        await saveChatGPT({ ...this.ctx, prompt: undefined }, o, who, {}, { printWelcome: false });
        this.models = null;
        this.log("subscription.connected", { provider: "chatgpt" }, by);
      })
      .catch((e: Error) => {
        this.lastError = e.message;
      })
      .finally(() => {
        this.signIn = null;
        this.service.announce({ type: "changed", what: "models" });
      });
    return { url: s.url };
  }

  cancelChatGPT(): void {
    this.signIn?.cancel();
  }

  welcomed(): void {
    markWelcomed(this.ctx.home);
  }

  async setChatGPTModel(model: unknown): Promise<void> {
    if (typeof model !== "string" || !model) throw new HttpError(400, "Choose a model.");
    const s = loadSettings(this.ctx.home);
    const c = s.connections.find((x) => x.provider === "chatgpt");
    if (!c) throw new HttpError(409, "Sign in with ChatGPT first.");
    const list = this.models?.list ?? [];
    if (list.length && !list.some((m) => m.slug === model))
      throw new HttpError(400, `Your ChatGPT account doesn't list "${model}".`);
    c.model = model;
    saveSettings(this.ctx.home, s);
  }

  async signOutChatGPT(by: string): Promise<void> {
    this.cancelChatGPT();
    await signOutChatGPT(chatgptOptions(this.ctx));
    const s = loadSettings(this.ctx.home);
    for (const c of s.connections.filter((x) => x.provider === "chatgpt"))
      await removeConnection(this.ctx.home, this.store(), c.name);
    this.models = null;
    this.lastError = null;
    this.log("subscription.removed", { provider: "chatgpt" }, by);
  }

  /** Asks Claude Code whether you're signed in (`claude auth status`), in its sandbox. */
  async checkClaude(): Promise<void> {
    const r = await engineSignIn(this.ctx, CLAUDE);
    this.claude = { signedIn: r.signedIn, method: r.method };
  }

  /** Uses your Claude plan through Claude Code; you agreed to the notice in the app. */
  async connectClaude(b: Record<string, unknown>, by: string): Promise<void> {
    if (b.accept !== true) throw new HttpError(400, "Read the notice and agree to it first.");
    await this.checkClaude();
    if (!this.claude || this.claude.signedIn === null)
      throw new HttpError(409, "Claude Code isn't installed on this Mac, or didn't answer.");
    if (!this.claude.signedIn) throw new HttpError(409, "Sign in to Claude Code first: claude auth login");
    if (this.claude.method === "api_key")
      throw new HttpError(
        409,
        "Claude Code is signed in with an API key, so tasks would bill that key, not your subscription. Sign in with your Claude account: claude auth login",
      );
    const s = loadSettings(this.ctx.home);
    if (s.connections.some((c) => c.provider === CLAUDE)) return;
    await addConnection(this.ctx.home, this.store(), {
      name: suggestName(s, CLAUDE),
      provider: CLAUDE,
      model: "default",
      makeDefault: s.connections.length === 0,
    });
    this.log("subscription.connected", { provider: CLAUDE }, by);
  }

  async disconnectClaude(by: string): Promise<void> {
    const s = loadSettings(this.ctx.home);
    for (const c of s.connections.filter((x) => x.provider === CLAUDE))
      await removeConnection(this.ctx.home, this.store(), c.name);
    this.log("subscription.removed", { provider: CLAUDE }, by);
  }
}
