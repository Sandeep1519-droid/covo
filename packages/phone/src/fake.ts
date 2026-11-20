import type { Button, TelegramApi, TgMessage, TgUpdate, TgUser } from "./telegram.ts";

/** A stand-in for Telegram, for tests: records what Covo sends and plays back what "people" send. */
export class FakeTelegram implements TelegramApi {
  me: TgUser = { id: 4242, is_bot: true, first_name: "Covo", username: "CovoTestBot" };
  sent: { chatId: number; text: string; buttons?: Button[][]; messageId: number }[] = [];
  edits: { chatId: number; messageId: number; text: string }[] = [];
  answers: { id: string; text?: string }[] = [];
  /** Called when Covo asks for updates and none are waiting (tests can push one then). */
  onIdle?: () => void;
  private queue: TgUpdate[] = [];
  private nextUpdate = 1;
  private nextMessage = 100;

  push(u: Omit<TgUpdate, "update_id">): void {
    this.queue.push({ update_id: this.nextUpdate++, ...u });
  }

  /** A message typed by `from` in chat `chatId`. */
  say(from: TgUser, chatId: number, text: string): void {
    this.push({
      message: { message_id: this.nextMessage++, chat: { id: chatId, type: "private" }, from, text, date: 0 },
    });
  }

  /** A tap on a button under one of Covo's messages. */
  tap(from: TgUser, chatId: number, data: string, message?: TgMessage): void {
    this.push({
      callback_query: {
        id: `cb${this.nextUpdate}`,
        from,
        data,
        message: message ?? { message_id: 1, chat: { id: chatId, type: "private" }, text: "card", date: 0 },
      },
    });
  }

  async getMe(): Promise<TgUser> {
    return this.me;
  }

  async getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal): Promise<TgUpdate[]> {
    // Like Telegram: asking with an offset confirms everything before it.
    this.queue = this.queue.filter((u) => u.update_id >= offset);
    if (this.queue.length === 0 && timeoutSec > 0) {
      this.onIdle?.();
      if (this.queue.length === 0) {
        await new Promise((r) => setTimeout(r, 10));
        if (signal?.aborted) throw new Error("aborted");
      }
    }
    return [...this.queue];
  }

  async sendMessage(chatId: number, text: string, buttons?: Button[][]): Promise<TgMessage> {
    const messageId = this.nextMessage++;
    this.sent.push({ chatId, text, ...(buttons ? { buttons } : {}), messageId });
    return { message_id: messageId, chat: { id: chatId, type: "private" }, text, date: 0 };
  }

  async editMessage(chatId: number, messageId: number, text: string): Promise<void> {
    this.edits.push({ chatId, messageId, text });
  }

  async answerCallback(id: string, text?: string): Promise<void> {
    this.answers.push({ id, ...(text ? { text } : {}) });
  }
}
