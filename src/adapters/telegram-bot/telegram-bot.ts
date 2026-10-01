import { env } from '../../common/config/env.js';
import { logger } from '../../common/logging/logger.js';

/**
 * Telegram-бот напоминаний (решение владельца 30.09.2026: бесплатный канал для клиентов без нашего приложения,
 * WhatsApp-провайдер ещё не выбран). Настоящий — Bot API по fetch, если задан TELEGRAM_BOT_TOKEN; иначе заглушка
 * пишет в лог, тем же приёмом, что FakeCodeSender.
 */

/** Кнопка под сообщением: callback_data (≤ 64 байт) или ссылка */
export type InlineButton = { text: string; callback_data: string } | { text: string; url: string };
export interface InlineKeyboard {
  inline_keyboard: InlineButton[][];
}
/** Клавиатура под полем ввода — только для «Поделиться номером» */
export interface ReplyKeyboard {
  keyboard: { text: string; request_contact?: boolean }[][];
  resize_keyboard?: boolean;
  one_time_keyboard?: boolean;
}
export type ReplyMarkup = InlineKeyboard | ReplyKeyboard | { remove_keyboard: true };

/** Нужное нам подмножество Update Bot API (https://core.telegram.org/bots/api#update) */
export interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  language_code?: string;
}
export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: { id: number; type: string };
  text?: string;
  contact?: { phone_number: string; user_id?: number; first_name?: string };
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: { id: string; from: TgUser; message?: TgMessage; data?: string };
}

/** Бот заблокирован пользователем / чат недоступен (403) — дальше писать бесполезно */
export class TelegramBlockedError extends Error {}

export interface TelegramBot {
  readonly real: boolean;
  sendMessage(chatId: string, text: string, replyMarkup?: ReplyMarkup): Promise<{ messageId?: number }>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
  /** Снять/заменить кнопки под уже отправленным сообщением */
  editMessageReplyMarkup(chatId: string, messageId: number, replyMarkup?: InlineKeyboard): Promise<void>;
  /** Long-poll (разработка без публичного адреса); заглушка сразу отдаёт пусто */
  getUpdates(offset: number, timeoutSec: number): Promise<TgUpdate[]>;
}

function maskChat(chatId: string): string {
  return chatId.length > 4 ? `${chatId.slice(0, 2)}•••${chatId.slice(-2)}` : '•••';
}

/** Заглушка: пишет текст и кнопки в лог (номера в тексте маскируются) */
export class FakeTelegramBot implements TelegramBot {
  readonly real = false;
  async sendMessage(chatId: string, text: string, replyMarkup?: ReplyMarkup): Promise<{ messageId?: number }> {
    const safe = text.replace(/\+374\d{8}/g, (p) => `${p.slice(0, 6)}•••${p.slice(-2)}`);
    logger.info({ chat: maskChat(chatId), markup: replyMarkup }, `[fake telegram-bot] ${safe}`);
    return { messageId: Date.now() % 1_000_000 };
  }
  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    logger.info({ callbackQueryId }, `[fake telegram-bot] answerCallbackQuery ${text ?? ''}`);
  }
  async editMessageReplyMarkup(chatId: string, messageId: number, replyMarkup?: InlineKeyboard): Promise<void> {
    logger.info({ chat: maskChat(chatId), messageId, markup: replyMarkup ?? null }, '[fake telegram-bot] editMessageReplyMarkup');
  }
  async getUpdates(): Promise<TgUpdate[]> {
    return [];
  }
}

/** Telegram Bot API (https://core.telegram.org/bots/api) — без SDK, только нужные методы */
export class TelegramBotApi implements TelegramBot {
  readonly real = true;
  constructor(
    private readonly token: string,
    private readonly baseUrl = 'https://api.telegram.org',
  ) {}

  private async call<T>(method: string, payload: Record<string, unknown>, timeoutMs = 10_000): Promise<T> {
    const res = await fetch(`${this.baseUrl}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string; error_code?: number };
    if (!res.ok || !body.ok) {
      if (body.error_code === 403) throw new TelegramBlockedError(body.description ?? 'Forbidden');
      logger.warn({ method, status: res.status, error: body.description }, 'telegram bot: запрос не прошёл');
      throw new Error(`Telegram Bot API ${method}: ${body.description ?? res.status}`);
    }
    return body.result as T;
  }

  async sendMessage(chatId: string, text: string, replyMarkup?: ReplyMarkup): Promise<{ messageId?: number }> {
    const r = await this.call<{ message_id: number }>('sendMessage', { chat_id: chatId, text, reply_markup: replyMarkup, link_preview_options: { is_disabled: true } });
    return { messageId: r?.message_id };
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    await this.call('answerCallbackQuery', { callback_query_id: callbackQueryId, text });
  }

  async editMessageReplyMarkup(chatId: string, messageId: number, replyMarkup?: InlineKeyboard): Promise<void> {
    await this.call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: replyMarkup ?? { inline_keyboard: [] } });
  }

  async getUpdates(offset: number, timeoutSec: number): Promise<TgUpdate[]> {
    return this.call<TgUpdate[]>('getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['message', 'callback_query'] }, (timeoutSec + 10) * 1000);
  }
}

export function createTelegramBot(): TelegramBot {
  return env.TELEGRAM_BOT_TOKEN ? new TelegramBotApi(env.TELEGRAM_BOT_TOKEN) : new FakeTelegramBot();
}
