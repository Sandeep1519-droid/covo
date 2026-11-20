import { statSync } from "node:fs";
import { DEFAULT_AGENT_ID } from "@covo/db";
import { loadPhone, PhoneLink, phonePath, Telegram, TOKEN_ID } from "@covo/phone";
import { secrets } from "@covo/platform";
import type { Ctx } from "../main.ts";
import { sendMessage } from "./api.ts";
import type { Service } from "./server.ts";

// Runs the phone link (packages/phone) while a phone is connected. `covo phone connect` and
// `covo phone disconnect` change state/phone.json; the service notices within a few seconds.

const CHECK_MS = 5_000;

export class PhoneManager {
  private link?: PhoneLink;
  private seen = -1;
  private timer?: ReturnType<typeof setInterval>;
  private checking = false;

  constructor(
    private readonly ctx: Ctx,
    private readonly service: Service,
  ) {}

  start(): void {
    void this.check();
    this.timer = setInterval(() => void this.check(), CHECK_MS);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.link?.stop();
    this.link = undefined;
  }

  private async check(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      let mtime = 0;
      try {
        mtime = statSync(phonePath(this.ctx.home)).mtimeMs;
      } catch {}
      if (mtime === this.seen) return;
      this.seen = mtime;
      await this.link?.stop();
      this.link = undefined;
      const config = loadPhone(this.ctx.home);
      if (!config) return;
      const token = await (this.ctx.secrets ?? secrets()).get(TOKEN_ID);
      if (!token) {
        this.ctx.print("phone: connected, but the bot's token isn't in the Keychain. Run: covo phone connect\n");
        return;
      }
      const telegram = this.ctx.telegram?.(token) ?? new Telegram(token);
      this.link = new PhoneLink({
        home: this.ctx.home,
        telegram,
        config,
        now: this.ctx.now,
        log: (s) => this.ctx.print(`${s}\n`),
        // Only when you turned it on (covo phone tasks on): your message goes to your main bot's chat.
        startTask: async (text) => {
          const m = await sendMessage(this.ctx, this.service, DEFAULT_AGENT_ID, { text }, "token", "phone");
          return m.error
            ? `Couldn't start it: ${m.error}`
            : "On it. I'll message you here when it's done. You can follow it in Covo on your Mac.";
        },
      });
      this.link.start();
      this.ctx.print(`phone: listening to Telegram for ${config.name}\n`);
    } finally {
      this.checking = false;
    }
  }
}
