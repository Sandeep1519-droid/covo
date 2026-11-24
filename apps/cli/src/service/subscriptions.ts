import type { ApiEngine, ApiSubscriptions } from "@covo/api";
import { covoPaths } from "@covo/core";
import { appendAudit, openDb } from "@covo/db";
import {
  addConnection,
  beginChatGPTSignIn,
  CHATGPT,
  type ChatGPTModel,
  chatgptModels,
  chatgptSignedIn,
  ENGINES,
  type EngineInfo,
  engineById,
  engineNotice,
  loadSettings,
  markWelcomed,
  readAccount,
  removeConnection,
  saveSettings,
  signOutChatGPT,
  suggestName,
} from "@covo/models";
import { secrets } from "@covo/platform";
import {
  engineSignIn,
  findProgram,
  type SetupJob,
  signOutEngine,
  startInstall,
  startSignIn,
} from "../commands/engines.ts";
import { chatgptOptions, saveChatGPT } from "../commands/models.ts";
import type { Ctx } from "../main.ts";
import { HttpError } from "./api.ts";
import type { Service } from "./server.ts";

// Your own AI plans, from the app (Phase 4 M1; docs/SUBSCRIPTIONS.md):
// - ChatGPT Go, Plus, Pro or Business through Sign in with ChatGPT (Covo's own sign-in);
// - programs that use your plan, Claude Code and Codex: Get runs the maker's installer, Sign in
//   starts the program's own sign-in, Connect saves it as a model after you agree to the notice.
// Keys and tokens never come back out of here.

interface EngineState {
  /** What the program last said about your sign-in. */
  checked?: { signedIn: boolean | null; method: string | null };
  /** Get or Sign in, while it runs. */
  job?: { kind: "install" | "sign-in"; job: SetupJob };
  error?: string | null;
}

export class Subscriptions {
  private signIn: { url: string; cancel: () => void } | null = null;
  private lastError: string | null = null;
  private models: { at: number; list: ChatGPTModel[] } | null = null;
  private engines = new Map<string, EngineState>();

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

  private engine(id: string): { info: EngineInfo; st: EngineState } {
    const info = engineById(id);
    if (!info) throw new HttpError(404, "Not found.");
    let st = this.engines.get(id);
    if (!st) {
      st = {};
      this.engines.set(id, st);
    }
    return { info, st };
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
    const engines: ApiEngine[] = ENGINES.map((info) => {
      const { st } = this.engine(info.id);
      const conn = s.connections.find((c) => c.provider === info.id);
      const path = findProgram(this.ctx, info.command, info.knownPaths);
      const job = st.job;
      return {
        id: info.id,
        label: info.label,
        maker: info.maker,
        plan: info.plan,
        path,
        install: info.install,
        signIn: info.signIn,
        downloadMb: info.downloadMb,
        signedIn: path ? (st.checked?.signedIn ?? null) : null,
        method: path ? (st.checked?.method ?? null) : null,
        connected: Boolean(conn),
        connection: conn?.name ?? null,
        installing: job?.kind === "install",
        signingIn: job?.kind === "sign-in",
        step: job ? job.job.step() : null,
        url: job?.kind === "sign-in" ? job.job.url() : null,
        codePrompt: job?.kind === "sign-in" ? (job.job.wantsCode?.() ?? false) : false,
        error: st.error ?? null,
        notice: engineNotice(info),
      };
    });
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
      engines,
    };
  }

  /** The models your ChatGPT account lists (Sign in with ChatGPT), from a 10-minute cache. */
  async chatgptModelList(): Promise<ChatGPTModel[]> {
    const o = chatgptOptions(this.ctx);
    if (!(await chatgptSignedIn(o))) return [];
    if (!this.models || this.ctx.now() - this.models.at > 10 * 60_000) {
      try {
        this.models = { at: this.ctx.now(), list: await chatgptModels(o) };
      } catch {
        this.models = { at: this.ctx.now(), list: this.models?.list ?? [] };
      }
    }
    return this.models.list;
  }

  /** Starts Sign in with ChatGPT: the app opens the link; the result comes back here. */
  async startChatGPT(by: string): Promise<{ url: string }> {
    if (this.signIn) return { url: this.signIn.url };
    this.lastError = null;
    // Codex's own sign-in uses the same port on this Mac, so only one can wait at a time.
    this.cancel("codex", "sign-in");
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

  /** Follows a running Get or Sign in to its end, then asks the program how you're signed in. */
  private follow(id: string, kind: "install" | "sign-in", job: SetupJob, by: string): void {
    const { info, st } = this.engine(id);
    st.job = { kind, job };
    st.error = null;
    this.ctx.print(
      kind === "install"
        ? `${id}: getting ${info.label} from ${info.maker}\n`
        : `${id}: sign-in started; it finishes in your browser\n`,
    );
    void job.done
      .then(async () => {
        this.ctx.print(`${id}: ${kind === "install" ? "installed" : "signed in"}\n`);
        this.log(kind === "install" ? "engine.installed" : "engine.signed-in", { engine: id }, by);
        if (st.job?.job === job) st.job = undefined;
        await this.check(id).catch(() => {});
      })
      .catch((e: Error) => {
        this.ctx.print(`${id}: ${kind} stopped: ${e.message}\n`);
        st.error = e.message === "Cancelled." ? null : e.message;
      })
      .finally(() => {
        if (st.job?.job === job) st.job = undefined;
        this.service.announce({ type: "changed", what: "models" });
      });
  }

  /** Get: runs the maker's official installer (docs/SUBSCRIPTIONS.md rule 7). */
  install(id: string, by: string): void {
    const { info, st } = this.engine(id);
    if (st.job) throw new HttpError(409, `${info.label} is busy: wait for it, or cancel.`);
    this.follow(id, "install", startInstall(this.ctx, info), by);
  }

  /** Sign in: starts the program's own sign-in, which opens your browser (rule 8). */
  startSignIn(id: string, by: string): void {
    const { info, st } = this.engine(id);
    if (st.job) throw new HttpError(409, `${info.label} is busy: wait for it, or cancel.`);
    const path = findProgram(this.ctx, info.command, info.knownPaths);
    if (!path) throw new HttpError(409, `Get ${info.label} first.`);
    // Codex's sign-in and Sign in with ChatGPT use the same port on this Mac.
    if (id === "codex") this.cancelChatGPT();
    this.follow(id, "sign-in", startSignIn(this.ctx, info, path), by);
  }

  /**
   * The code a sign-in page shows when it can't hand it to the program itself: it goes straight into
   * the program's own prompt. Covo doesn't keep it.
   */
  sendCode(id: string, code: unknown): void {
    const { info, st } = this.engine(id);
    if (st.job?.kind !== "sign-in" || !st.job.job.answer) throw new HttpError(409, `${info.label} isn't signing in.`);
    if (typeof code !== "string" || !/^[\w#.~-]{6,600}$/.test(code.trim()))
      throw new HttpError(400, "That doesn't look like a sign-in code. Copy it again from the page.");
    st.job.job.answer(code.trim());
    this.ctx.print(`${id}: sign-in code passed to ${info.label}\n`);
  }

  cancel(id: string, kind?: "install" | "sign-in"): void {
    const st = this.engines.get(id);
    if (st?.job && (!kind || st.job.kind === kind)) st.job.job.cancel();
  }

  /** Asks the program whether you're signed in, in its sandbox. */
  async check(id: string): Promise<void> {
    const { st } = this.engine(id);
    const r = await engineSignIn(this.ctx, id);
    st.checked = { signedIn: r.signedIn, method: r.method };
  }

  /** Uses your plan through the program; you agreed to the notice in the app. */
  async connect(id: string, b: Record<string, unknown>, by: string): Promise<void> {
    const { info, st } = this.engine(id);
    if (b.accept !== true) throw new HttpError(400, "Read the notice and agree to it first.");
    await this.check(id);
    const c = st.checked;
    if (!c || c.signedIn === null) throw new HttpError(409, `${info.label} isn't on this Mac, or didn't answer.`);
    if (!c.signedIn) throw new HttpError(409, `Sign in to ${info.label} first.`);
    if (c.method === "api_key")
      throw new HttpError(
        409,
        `${info.label} is signed in with an API key, so tasks would bill that key, not your plan. Press Sign in and use your ${info.maker === "OpenAI" ? "ChatGPT" : "Claude"} account.`,
      );
    const s = loadSettings(this.ctx.home);
    if (s.connections.some((x) => x.provider === id)) return;
    await addConnection(this.ctx.home, this.store(), {
      name: suggestName(s, id),
      provider: id,
      model: "default",
      makeDefault: s.connections.length === 0,
    });
    this.log("subscription.connected", { provider: id }, by);
  }

  /** Removes it from your models. Covo's own Codex sign-in is also signed out (and revoked). */
  async disconnect(id: string, by: string): Promise<void> {
    const { info, st } = this.engine(id);
    const s = loadSettings(this.ctx.home);
    for (const c of s.connections.filter((x) => x.provider === id))
      await removeConnection(this.ctx.home, this.store(), c.name);
    if (info.ownHome) {
      await signOutEngine(this.ctx, info);
      st.checked = undefined;
    }
    this.log("subscription.removed", { provider: id }, by);
  }
}
