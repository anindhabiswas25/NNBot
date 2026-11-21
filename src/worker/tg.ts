import type { Rendered } from "../shared/render";

export class TelegramError extends Error {
  constructor(public code: number, public description: string, public retryAfter?: number) {
    super(`telegram ${code}: ${description}`);
  }
}

/** Thin Bot API client (works in Workers and Node). Honours retry_after once on 429. */
export class Telegram {
  constructor(private token: string) {}

  async call<T = any>(method: string, params: Record<string, unknown> = {}, retries = 1): Promise<T> {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    const body: any = await res.json().catch(() => ({ ok: false, error_code: res.status, description: res.statusText }));
    if (body.ok) return body.result as T;
    const retryAfter = body.parameters?.retry_after;
    if (body.error_code === 429 && retryAfter && retries > 0 && retryAfter <= 30) {
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      return this.call(method, params, retries - 1);
    }
    throw new TelegramError(body.error_code, body.description, retryAfter);
  }

  send(chatId: number, r: Rendered | string, extra: Record<string, unknown> = {}) {
    const m = typeof r === "string" ? { text: r } : r;
    return this.call<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...m,
      ...extra,
    });
  }

  async edit(chatId: number, messageId: number, r: Rendered | string) {
    const m = typeof r === "string" ? { text: r } : r;
    try {
      return await this.call("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...m,
      });
    } catch (e) {
      // Editing with identical content is harmless
      if (e instanceof TelegramError && e.description.includes("message is not modified")) return;
      throw e;
    }
  }

  async editMarkup(chatId: number, messageId: number, reply_markup: Rendered["reply_markup"]) {
    try {
      return await this.call("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup });
    } catch (e) {
      if (e instanceof TelegramError && e.description.includes("message is not modified")) return;
      throw e;
    }
  }

  answer(callbackQueryId: string, text?: string, showAlert = false) {
    return this.call("answerCallbackQuery", { callback_query_id: callbackQueryId, text, show_alert: showAlert }).catch(() => {});
  }
}
