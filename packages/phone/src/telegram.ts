// A small client for Telegram's Bot API (https://core.telegram.org/bots/api): only the calls Covo
// needs. Covo asks Telegram for new messages itself ("long polling"), so no server or public address
// is needed. The bot's token is part of every request's address, so it never appears in errors.

export interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: string;
}

export interface TgMessage {
  message_id: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  date: number;
}

export interface TgCallback {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallback;
}

/** A button under a message; `data` comes back when it's tapped (at most 64 bytes). */
export interface Button {
  text: string;
  data: string;
}

/** What Covo uses of the Bot API. Tests pass a fake with the same shape. */
export interface TelegramApi {
  getMe(): Promise<TgUser>;
  getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal): Promise<TgUpdate[]>;
  sendMessage(chatId: number, text: string, buttons?: Button[][]): Promise<TgMessage>;
  /** Replaces a message's text; its buttons go away. */
  editMessage(chatId: number, messageId: number, text: string): Promise<void>;
  /** Stops the spinner on a tapped button, with an optional short note. */
  answerCallback(id: string, text?: string): Promise<void>;
}

export class TelegramError extends Error {
  constructor(
    readonly code: number,
    message: string,
    /** Seconds to wait, when Telegram asks Covo to slow down. */
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

/** What a bot token from @BotFather looks like: digits, a colon, then letters, digits, - and _. */
export const TOKEN_PATTERN = /^\d{5,15}:[A-Za-z0-9_-]{30,60}$/;

export class Telegram implements TelegramApi {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly base = "https://api.telegram.org",
  ) {}

  private async call<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    let r: Response;
    try {
      r = await this.fetchImpl(`${this.base}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new TelegramError(0, "Couldn't reach Telegram. Check this Mac's internet connection.");
    }
    type Reply = {
      ok?: boolean;
      result?: T;
      description?: string;
      error_code?: number;
      parameters?: { retry_after?: number };
    };
    const data = (await r.json().catch(() => null)) as Reply | null;
    if (!data?.ok) {
      throw new TelegramError(
        data?.error_code ?? r.status,
        data?.description ?? `Telegram answered ${r.status}.`,
        data?.parameters?.retry_after,
      );
    }
    return data.result as T;
  }

  getMe(): Promise<TgUser> {
    return this.call("getMe", {});
  }

  getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal): Promise<TgUpdate[]> {
    return this.call(
      "getUpdates",
      { offset, timeout: timeoutSec, allowed_updates: ["message", "callback_query"] },
      signal,
    );
  }

  sendMessage(chatId: number, text: string, buttons?: Button[][]): Promise<TgMessage> {
    return this.call("sendMessage", {
      chat_id: chatId,
      text,
      link_preview_options: { is_disabled: true },
      ...(buttons
        ? {
            reply_markup: {
              inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))),
            },
          }
        : {}),
    });
  }

  async editMessage(chatId: number, messageId: number, text: string): Promise<void> {
    await this.call("editMessageText", { chat_id: chatId, message_id: messageId, text });
  }

  async answerCallback(id: string, text?: string): Promise<void> {
    await this.call("answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) });
  }
}
