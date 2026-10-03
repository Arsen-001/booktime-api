import type { BusinessMessenger } from '../../adapters/business-sms/business-sms.js';
import { isLocale, LOCALES, t, type Locale } from '../../common/i18n/i18n.js';
import { newId } from '../../common/ids/ids.js';
import { logger } from '../../common/logging/logger.js';
import type { PrismaService } from '../../common/prisma.service.js';
import { costOf } from '../notify/notify-log-derive.js';
import { isKindEnabled } from '../notify/notify-types.service.js';
import { enqueueClientNotification, enqueueOutbox } from '../notify/outbox.js';
import { tgLocale } from '../telegram/telegram-links.js';
import { orderStatusUrl, type OrderRow } from './order-rules.js';

/** Вид в очереди и реестре типов (notify/kinds.ts, код 11) */
export const ORDER_READY_KIND = 'order_ready';
const TYPE_LABEL = { ru: 'Заказ готов', en: 'Order ready', hy: 'Պատվերը պատրաստ է' };

export type OrderNotifyChannel = 'push' | 'telegram' | 'sms' | 'whatsapp';

export interface OrderReadyInput {
  order: Pick<OrderRow, 'id' | 'businessId' | 'number' | 'code' | 'clientId' | 'clientPhone' | 'staffId'>;
  businessName: string;
  siteUrl: string;
  now?: Date;
}

export interface OrderReadyResult {
  /** Куда сообщение поставлено в очередь / ушло; пусто — у клиента нет доступного канала (это не ошибка) */
  channels: OrderNotifyChannel[];
}

function textOf(locale: Locale, input: OrderReadyInput): string {
  return t(locale, 'order.ready', { number: input.order.number, business: input.businessName, url: orderStatusUrl(input.siteUrl, input.order.code) });
}

function allTexts(input: OrderReadyInput): Record<Locale, string> {
  return Object.fromEntries(LOCALES.map((l) => [l, textOf(l, input)])) as Record<Locale, string>;
}

/**
 * «Ваш заказ №N в «Салон» готов. Статус: https://booktime.am/o/<code>» — тем же путём, что остальные уведомления
 * клиенту (очередь notify_outbox, её разбирает воркер — NotifyDispatchService):
 *  · клиент с нашим приложением (живой push-токен app='client') — пуш, тап открывает /o/<code>;
 *  · номер привязан к Telegram-боту — сообщение в чат (на языке чата);
 *  · ни того ни другого — SMS/WhatsApp через провайдера бизнеса, если он подключён (настройка notify-sms, В-08);
 *  · совсем некуда — успех без отправки, строка «Не доставлено» в журнале отправок бизнеса.
 * Каждая попытка пишется в журнал отправок (notify_log_entries). Тип «order_ready» выключен бизнесом — ничего не шлём.
 * Ключ дубля включает метку вызова: повторное «Напомнить, что готов» — новое сообщение.
 */
export async function notifyOrderReady(db: PrismaService, messenger: BusinessMessenger, input: OrderReadyInput): Promise<OrderReadyResult> {
  const { order } = input;
  const now = input.now ?? new Date();
  if (!(await isKindEnabled(db, order.businessId, ORDER_READY_KIND))) return { channels: [] };

  // Своя метка на каждый вызов (ULID): повторное «напомнить» — новое сообщение, а не дубль по ключу
  const stamp = newId('order').slice(4);
  const channels: OrderNotifyChannel[] = [];
  const url = `/o/${order.code}`;
  const texts = allTexts(input);
  const log = async (channel: string, status: 'sent' | 'notDelivered', sentLanguage?: Locale) => {
    const cost = status === 'sent' ? costOf(channel, texts[sentLanguage ?? 'ru']) : { costAmd: 0, smsParts: undefined };
    await db.notifyLogEntry.createMany({
      skipDuplicates: true,
      data: [
        {
          id: newId('notifyLogEntry'),
          businessId: order.businessId,
          dedupeKey: `order:ready:${order.id}:${stamp}:${channel}`,
          sentAt: now,
          typeCode: null,
          typeLabel: TYPE_LABEL,
          channel,
          status,
          contact: order.clientPhone.slice(0, 160),
          text: texts,
          clientId: order.clientId ?? null,
          staffId: order.staffId ?? null,
          bookingId: null,
          sentLanguage: sentLanguage ?? null,
          costAmd: cost.costAmd,
          smsParts: cost.smsParts ?? null,
          source: 'service',
        },
      ],
    });
  };

  // 1. Человек нашего приложения: по клиенту бизнеса, иначе по номеру
  let appUserId: string | null = null;
  if (order.clientId) {
    const client = await db.client.findUnique({ where: { id: order.clientId }, select: { appUserId: true } });
    appUserId = client?.appUserId ?? null;
  }
  const user = appUserId
    ? await db.user.findUnique({ where: { id: appUserId }, select: { id: true, locale: true } })
    : await db.user.findUnique({ where: { phone: order.clientPhone }, select: { id: true, locale: true } });
  if (user) {
    const token = await db.pushToken.findFirst({ where: { userId: user.id, app: 'client', invalidAt: null }, select: { id: true } });
    if (token) {
      const locale: Locale = isLocale(user.locale) ? user.locale : 'ru';
      await enqueueClientNotification(db, {
        businessId: order.businessId,
        kind: ORDER_READY_KIND,
        appUserId: user.id,
        title: input.businessName,
        body: texts[locale],
        url,
        dedupeKey: `order:ready:${order.id}:${stamp}:push`,
        meta: { orderId: order.id },
      });
      channels.push('push');
      await log('push', 'sent', locale);
    }
  }

  // 2. Telegram-бот на этом номере
  const links = await db.telegramLink.findMany({ where: { phone: order.clientPhone, blockedAt: null } });
  for (const link of links) {
    const locale = tgLocale(link.languageCode);
    await enqueueOutbox(db, {
      businessId: order.businessId,
      app: 'telegram',
      kind: ORDER_READY_KIND,
      recipientUserId: link.chatId,
      title: input.businessName,
      body: texts[locale],
      url,
      dedupeKey: `order:ready:${order.id}:${stamp}:tg:${link.chatId}`,
      meta: { orderId: order.id },
    });
    if (!channels.includes('telegram')) {
      channels.push('telegram');
      await log('telegram', 'sent', locale);
    }
  }

  // 3. Ни приложения, ни бота — SMS/WhatsApp провайдера бизнеса, если подключён
  if (!channels.length) {
    const sms = await db.businessSetting.findUnique({ where: { businessId_area: { businessId: order.businessId, area: 'notify-sms' } } });
    const conn = sms?.data as { connected?: boolean; channel?: 'sms' | 'whatsapp' } | undefined;
    if (conn?.connected) {
      const channel = conn.channel === 'whatsapp' ? 'whatsapp' : 'sms';
      let delivered = false;
      try {
        delivered = (await messenger.send({ businessId: order.businessId, to: order.clientPhone, text: texts.ru, channel })).delivered;
      } catch (err) {
        logger.warn({ err, orderId: order.id }, 'orders: SMS/WhatsApp «заказ готов» не отправлен');
      }
      await log(channel, delivered ? 'sent' : 'notDelivered', 'ru');
      if (delivered) channels.push(channel);
    } else {
      await log('push', 'notDelivered');
    }
  }
  return { channels };
}
