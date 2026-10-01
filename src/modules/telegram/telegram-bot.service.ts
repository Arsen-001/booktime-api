import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Booking as BookingRow } from '../../generated/prisma/client.js';
import { TELEGRAM_BOT } from '../../adapters/adapters.js';
import { TelegramBlockedError, type InlineKeyboard, type ReplyMarkup, type TelegramBot, type TgMessage, type TgUpdate } from '../../adapters/telegram-bot/telegram-bot.js';
import { ApiError } from '../../common/errors/api-error.js';
import { t, type Locale } from '../../common/i18n/i18n.js';
import type { MessageKey } from '../../common/i18n/messages.js';
import { newId } from '../../common/ids/ids.js';
import { logger } from '../../common/logging/logger.js';
import { normalizePhone } from '../../common/phone.js';
import { PrismaService } from '../../common/prisma.service.js';
import { REDIS } from '../../common/tokens.js';
import { BookingsService, clientActor } from '../journal/bookings.service.js';
import { bookingPhone, consumeLinkCode, tgLocale, UPCOMING_STATUSES } from './telegram-links.js';
import { bookingCard, bookingKeyboard, cardText } from './telegram-texts.js';

const NO_BUTTONS: InlineKeyboard = { inline_keyboard: [] };
/** Одно обновление обрабатываем один раз: Telegram повторяет вебхук, если ответ задержался */
const UPDATE_SEEN_TTL_SEC = 24 * 3600;

type LinkRow = { chatId: string; phone: string; languageCode: string | null; blockedAt: Date | null };

/**
 * Telegram-бот напоминаний (решение владельца 30.09.2026). Один вход — `handleUpdate` — для вебхука
 * (`POST /v1/telegram/webhook`) и для опроса getUpdates в воркере (TELEGRAM_BOT_POLLING=1).
 *
 *  - `/start <код>` — связать чат с номером из кода ссылки (сайт/приложение); `/start` без кода — «Поделиться номером»;
 *    контакт принимается только свой (contact.user_id = отправитель); `/stop` — больше не писать (blockedAt).
 *  - Кнопки под напоминанием: `c:<id>` «Приду», `x:<id>` «Отменить» → вопрос с последствиями для предоплаты,
 *    `xy:<id>` «Да, отменить», `xn:<id>` «Нет». Любое действие — только над записью, чей номер клиента совпадает с
 *    номером этого чата; сами переходы — те же пути журнала (`changeStatus` как `confirmByClient`, `cancelByClient`),
 *    поэтому refundDue / cancelledLate / +1 неявка считаются ровно как в приложении и по ссылке.
 */
@Injectable()
export class TelegramBotService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(TELEGRAM_BOT) private readonly bot: TelegramBot,
    private readonly bookings: BookingsService,
  ) {}

  async handleUpdate(update: TgUpdate): Promise<void> {
    if (typeof update?.update_id !== 'number') return;
    const fresh = await this.redis.set(`booktime:tg:update:${update.update_id}`, '1', 'EX', UPDATE_SEEN_TTL_SEC, 'NX');
    if (!fresh) return;
    try {
      if (update.callback_query) await this.onCallback(update.callback_query);
      else if (update.message) await this.onMessage(update.message);
    } catch (err) {
      logger.error({ err, updateId: update.update_id }, 'telegram bot: обновление упало');
    }
  }

  // ─────────── сообщения ───────────

  private async onMessage(msg: TgMessage): Promise<void> {
    if (msg.chat.type !== 'private' || msg.from?.is_bot) return;
    const chatId = String(msg.chat.id);
    const existing = await this.prisma.telegramLink.findUnique({ where: { chatId } });
    const locale = tgLocale(msg.from?.language_code ?? existing?.languageCode);
    const text = msg.text?.trim() ?? '';

    if (msg.contact) {
      // Только свой номер: чужой контакт из записной книжки не даёт подписаться на чужие записи
      if (!msg.from || msg.contact.user_id !== msg.from.id) return void (await this.send(chatId, t(locale, 'tg.contactNotOwn'), this.shareKeyboard(locale)));
      const phone = normalizePhone(msg.contact.phone_number);
      if (!phone) return void (await this.send(chatId, t(locale, 'tg.contactNotArmenian'), { remove_keyboard: true }));
      await this.link(chatId, phone, locale, undefined, true);
      return;
    }

    const start = /^\/start(?:@\w+)?(?:\s+(\S+))?$/.exec(text);
    if (start) {
      const code = start[1];
      if (code) {
        const payload = await consumeLinkCode(this.redis, code);
        const phone = payload?.phone ? normalizePhone(payload.phone) : undefined;
        if (phone) return void (await this.link(chatId, phone, locale, payload?.appUserId, false));
        return void (await this.send(chatId, t(locale, 'tg.codeExpired'), this.shareKeyboard(locale)));
      }
      // Уже привязан и не остановлен — просто показать ближайшую запись; иначе — попросить номер
      if (existing && !existing.blockedAt) return void (await this.link(chatId, existing.phone, locale, undefined, false));
      return void (await this.send(chatId, t(locale, 'tg.sharePrompt'), this.shareKeyboard(locale)));
    }

    if (/^\/stop(?:@\w+)?$/.test(text)) {
      if (existing) await this.prisma.telegramLink.update({ where: { chatId }, data: { blockedAt: new Date() } });
      return void (await this.send(chatId, t(locale, 'tg.stopped'), { remove_keyboard: true }));
    }

    await this.send(chatId, t(locale, existing && !existing.blockedAt ? 'tg.help' : 'tg.sharePrompt'), existing && !existing.blockedAt ? undefined : this.shareKeyboard(locale));
  }

  private shareKeyboard(locale: Locale): ReplyMarkup {
    return { keyboard: [[{ text: t(locale, 'tg.shareButton'), request_contact: true }]], resize_keyboard: true, one_time_keyboard: true };
  }

  /** Связать чат с номером (или обновить связь) и показать ближайшую запись с кнопками */
  private async link(chatId: string, phone: string, locale: Locale, appUserId: string | undefined, fromContact: boolean): Promise<void> {
    const userId = appUserId ?? (await this.prisma.user.findUnique({ where: { phone }, select: { id: true } }))?.id ?? null;
    await this.prisma.telegramLink.upsert({
      where: { chatId },
      create: { id: newId('telegramLink'), chatId, phone, appUserId: userId, languageCode: locale },
      update: { phone, appUserId: userId, languageCode: locale, blockedAt: null },
    });
    await this.send(chatId, t(locale, 'tg.linked'), fromContact ? { remove_keyboard: true } : undefined);
    const next = await this.nextBooking(phone);
    if (next) {
      const card = await bookingCard(this.prisma, next, locale);
      await this.send(chatId, `${t(locale, 'tg.nextBooking')}\n\n${cardText(card)}`, bookingKeyboard(next, card, locale));
    }
  }

  private async nextBooking(phone: string): Promise<BookingRow | null> {
    const [clients, user] = await Promise.all([
      this.prisma.client.findMany({ where: { phone }, select: { id: true } }),
      this.prisma.user.findUnique({ where: { phone }, select: { id: true } }),
    ]);
    const or = [...(clients.length ? [{ clientId: { in: clients.map((c) => c.id) } }] : []), ...(user ? [{ appUserId: user.id }] : [])];
    if (!or.length) return null;
    return this.prisma.booking.findFirst({ where: { OR: or, deletedAt: null, status: { in: UPCOMING_STATUSES }, startAt: { gt: new Date() } }, orderBy: { startAt: 'asc' } });
  }

  // ─────────── кнопки ───────────

  private async onCallback(q: NonNullable<TgUpdate['callback_query']>): Promise<void> {
    const chatId = String(q.message?.chat.id ?? q.from.id);
    const messageId = q.message?.message_id;
    const link = (await this.prisma.telegramLink.findUnique({ where: { chatId } })) as LinkRow | null;
    const locale = tgLocale(link?.languageCode ?? q.from.language_code);
    const m = /^(c|x|xy|xn):([A-Za-z0-9_]{1,40})$/.exec(q.data ?? '');
    const booking = m && link ? await this.ownBooking(link, m[2]!) : null;
    if (!m || !booking) {
      await this.bot.answerCallbackQuery(q.id, t(locale, 'tg.notFound'));
      return;
    }
    const [, op] = m;
    await this.bot.answerCallbackQuery(q.id).catch(() => undefined);
    if (op === 'c') return this.confirm(chatId, messageId, booking, locale);
    if (op === 'x') return this.askCancel(chatId, booking, locale);
    if (op === 'xy') return this.cancel(chatId, messageId, booking, locale);
    if (messageId) await this.bot.editMessageReplyMarkup(chatId, messageId, NO_BUTTONS).catch(() => undefined);
    await this.send(chatId, t(locale, 'tg.cancelKept'));
  }

  /** Запись, только если номер её клиента — номер этого чата (callback_data сам по себе ничего не разрешает) */
  private async ownBooking(link: LinkRow, bookingId: string): Promise<BookingRow | null> {
    const b = await this.prisma.booking.findUnique({ where: { id: bookingId } });
    if (!b) return null;
    const phone = await bookingPhone(this.prisma, b);
    return phone && phone === link.phone ? b : null;
  }

  private async confirm(chatId: string, messageId: number | undefined, b: BookingRow, locale: Locale): Promise<void> {
    if (b.status !== 'client_confirmed') {
      try {
        // Тот же переход, что BookingsService.confirmByClient (там — поиск записи по appUserId; здесь — по номеру чата)
        await this.bookings.changeStatus(clientActor(null), [b.businessId], b.id, 'client_confirmed', 'client');
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        return void (await this.send(chatId, t(locale, 'tg.confirmFailed')));
      }
    }
    if (messageId) await this.bot.editMessageReplyMarkup(chatId, messageId, NO_BUTTONS).catch(() => undefined);
    await this.send(chatId, t(locale, 'tg.confirmed'));
  }

  private async askCancel(chatId: string, b: BookingRow, locale: Locale): Promise<void> {
    const { outcome, keepPrepaymentOnLateCancel, prepaidAmount } = await this.bookings.clientCancelPreview(b);
    const card = await bookingCard(this.prisma, b, locale);
    if (!outcome.allowed) return void (await this.send(chatId, this.deniedText(outcome.reason, card.phone, locale)));
    const amount = prepaidAmount.toLocaleString('ru-RU').replace(/ /g, ' ');
    let key: MessageKey = 'tg.cancelAsk';
    if (prepaidAmount > 0) key = outcome.late && keepPrepaymentOnLateCancel ? 'tg.cancelAskLateKeep' : 'tg.cancelAskRefund';
    else if (outcome.late) key = 'tg.cancelAskLate';
    await this.send(chatId, `${cardText(card)}\n\n${t(locale, key, { amount, when: card.when })}`, {
      inline_keyboard: [[{ text: t(locale, 'tg.btnYesCancel'), callback_data: `xy:${b.id}` }, { text: t(locale, 'tg.btnNo'), callback_data: `xn:${b.id}` }]],
    });
  }

  private async cancel(chatId: string, messageId: number | undefined, b: BookingRow, locale: Locale): Promise<void> {
    if (messageId) await this.bot.editMessageReplyMarkup(chatId, messageId, NO_BUTTONS).catch(() => undefined);
    try {
      await this.bookings.cancelByClient(clientActor(null), b.id, { booking: b });
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      const card = await bookingCard(this.prisma, b, locale);
      return void (await this.send(chatId, this.deniedText(err.code, card.phone, locale)));
    }
    // Итог читаем из самой записи — ровно то, что записал cancelByClient (refundDue при возврате)
    const saved = await this.prisma.booking.findUnique({ where: { id: b.id }, select: { prepayment: true } });
    const p = saved?.prepayment as { paid?: boolean; refundDue?: number } | null;
    const refund = Number(p?.refundDue ?? 0);
    const amount = refund.toLocaleString('ru-RU').replace(/ /g, ' ');
    const key: MessageKey = refund > 0 ? 'tg.cancelledRefund' : p?.paid ? 'tg.cancelledKept' : 'tg.cancelled';
    await this.send(chatId, t(locale, key, { amount }));
  }

  private deniedText(reason: string, phone: string | undefined, locale: Locale): string {
    if (reason === 'not_active') return t(locale, 'tg.notActive');
    if (reason === 'started') return t(locale, 'tg.started');
    if (reason === 'not_found') return t(locale, 'tg.notFound');
    return t(locale, 'tg.cancelDenied', { phone: phone ?? '—' });
  }

  private async send(chatId: string, text: string, markup?: ReplyMarkup): Promise<void> {
    try {
      await this.bot.sendMessage(chatId, text, markup);
    } catch (err) {
      // Человек заблокировал бота — отмечаем, чтобы очередь напоминаний больше не стучалась в этот чат
      if (err instanceof TelegramBlockedError) await this.prisma.telegramLink.updateMany({ where: { chatId }, data: { blockedAt: new Date() } });
      else throw err;
    }
  }
}
