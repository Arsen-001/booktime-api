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
/** «Заказ ждёт вас» — авто-напоминание, если клиент не забрал готовый заказ (notify/kinds.ts, код 12; 04.10.2026) */
export const ORDER_PICKUP_REMINDER_KIND = 'order_pickup_reminder';

/** ⭐ «Смета по заказу» — мастерская просит согласовать цену (notify/kinds.ts, код 13; 05.10.2026) */
export const ORDER_ESTIMATE_KIND = 'order_estimate';
/** «Ждём ответа по смете» — клиент не ответил за сутки (notify/kinds.ts, код 14; 05.10.2026) */
export const ORDER_ESTIMATE_REMINDER_KIND = 'order_estimate_reminder';

/** Чем различаются сообщения о заказе: вид (включатель бизнеса), текст, подпись в журнале, ключ дубля */
interface OrderMessageSpec {
  kind: string;
  messageKey: 'order.ready' | 'order.pickupReminder' | 'order.estimate' | 'order.estimateReminder';
  typeLabel: { ru: string; en: string; hy: string };
  /** Часть ключа дубля: order:<dedupe>:<orderId>:<stamp>:<канал> */
  dedupe: string;
}

const READY_SPEC: OrderMessageSpec = {
  kind: ORDER_READY_KIND,
  messageKey: 'order.ready',
  typeLabel: { ru: 'Заказ готов', en: 'Order ready', hy: 'Պատվերը պատրաստ է' },
  dedupe: 'ready',
};

const PICKUP_SPEC: OrderMessageSpec = {
  kind: ORDER_PICKUP_REMINDER_KIND,
  messageKey: 'order.pickupReminder',
  typeLabel: { ru: 'Заказ ждёт клиента', en: 'Order awaiting pickup', hy: 'Պատվերը սպասում է հաճախորդին' },
  dedupe: 'pickup',
};

const ESTIMATE_SPEC: OrderMessageSpec = {
  kind: ORDER_ESTIMATE_KIND,
  messageKey: 'order.estimate',
  typeLabel: { ru: 'Смета по заказу', en: 'Order estimate', hy: 'Պատվերի նախահաշիվ' },
  dedupe: 'estimate',
};

const ESTIMATE_REMINDER_SPEC: OrderMessageSpec = {
  kind: ORDER_ESTIMATE_REMINDER_KIND,
  messageKey: 'order.estimateReminder',
  typeLabel: { ru: 'Ждём ответа по смете', en: 'Estimate awaiting reply', hy: 'Սպասում ենք նախահաշվի պատասխանին' },
  dedupe: 'estimate-reminder',
};

export type OrderNotifyChannel = 'push' | 'telegram' | 'sms' | 'whatsapp';

export interface OrderReadyInput {
  order: Pick<OrderRow, 'id' | 'businessId' | 'number' | 'code' | 'clientId' | 'clientPhone' | 'staffId'>;
  businessName: string;
  siteUrl: string;
  now?: Date;
  /** Сумма сметы, ֏ — для «Смета по заказу» */
  total?: number;
}

export interface OrderReadyResult {
  /** Куда сообщение поставлено в очередь / ушло; пусто — у клиента нет доступного канала (это не ошибка) */
  channels: OrderNotifyChannel[];
}

/** «52 000 ֏» — неразрывный пробел между тысячами и перед знаком */
export function amdText(amount: number): string {
  return `${Math.round(amount).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0')}\u00a0֏`;
}

function textOf(locale: Locale, input: OrderReadyInput, spec: OrderMessageSpec): string {
  return t(locale, spec.messageKey, {
    number: input.order.number,
    business: input.businessName,
    url: orderStatusUrl(input.siteUrl, input.order.code),
    total: amdText(input.total ?? 0),
  });
}

function allTexts(input: OrderReadyInput, spec: OrderMessageSpec): Record<Locale, string> {
  return Object.fromEntries(LOCALES.map((l) => [l, textOf(l, input, spec)])) as Record<Locale, string>;
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
export function notifyOrderReady(db: PrismaService, messenger: BusinessMessenger, input: OrderReadyInput): Promise<OrderReadyResult> {
  return sendOrderMessage(db, messenger, input, READY_SPEC);
}

/**
 * «Напоминаем: заказ №N в «Салон» готов и ждёт вас. Статус: …» — клиент не забрал готовый заказ (04.10.2026). Тот же
 * путь, что «Заказ готов» (пуш → Telegram → SMS/WhatsApp бизнеса → «Не доставлено»), свой вид order_pickup_reminder:
 * бизнес выключает его отдельно от «Заказ готов». Когда слать — решает задача воркера (jobs/orders-pickup-reminders.ts).
 */
export function notifyOrderPickupReminder(db: PrismaService, messenger: BusinessMessenger, input: OrderReadyInput): Promise<OrderReadyResult> {
  return sendOrderMessage(db, messenger, input, PICKUP_SPEC);
}

/**
 * ⭐ «Смета по заказу №N в «Салон»: 52 000 ֏. Согласуйте или откажитесь: https://booktime.am/o/<code>» (05.10.2026) —
 * мастерская после диагностики просит согласовать цену; тот же путь, что «Заказ готов». Каждая отправка (в том числе
 * «Отправить ещё раз» и новая версия сметы) — новое сообщение.
 */
export function notifyOrderEstimate(db: PrismaService, messenger: BusinessMessenger, input: OrderReadyInput): Promise<OrderReadyResult> {
  return sendOrderMessage(db, messenger, input, ESTIMATE_SPEC);
}

/** «Ждём вашего ответа по смете…» — клиент не ответил за сутки (задача воркера jobs/orders-estimate-reminders.ts) */
export function notifyOrderEstimateReminder(db: PrismaService, messenger: BusinessMessenger, input: OrderReadyInput): Promise<OrderReadyResult> {
  return sendOrderMessage(db, messenger, input, ESTIMATE_REMINDER_SPEC);
}

async function sendOrderMessage(db: PrismaService, messenger: BusinessMessenger, input: OrderReadyInput, spec: OrderMessageSpec): Promise<OrderReadyResult> {
  const { order } = input;
  const now = input.now ?? new Date();
  if (!(await isKindEnabled(db, order.businessId, spec.kind))) return { channels: [] };

  // Своя метка на каждый вызов (ULID): повторное «напомнить» — новое сообщение, а не дубль по ключу
  const stamp = newId('order').slice(4);
  const channels: OrderNotifyChannel[] = [];
  const url = `/o/${order.code}`;
  const texts = allTexts(input, spec);
  const log = async (channel: string, status: 'sent' | 'notDelivered', sentLanguage?: Locale) => {
    const cost = status === 'sent' ? costOf(channel, texts[sentLanguage ?? 'ru']) : { costAmd: 0, smsParts: undefined };
    await db.notifyLogEntry.createMany({
      skipDuplicates: true,
      data: [
        {
          id: newId('notifyLogEntry'),
          businessId: order.businessId,
          dedupeKey: `order:${spec.dedupe}:${order.id}:${stamp}:${channel}`,
          sentAt: now,
          typeCode: null,
          typeLabel: spec.typeLabel,
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
        kind: spec.kind,
        appUserId: user.id,
        title: input.businessName,
        body: texts[locale],
        url,
        dedupeKey: `order:${spec.dedupe}:${order.id}:${stamp}:push`,
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
      kind: spec.kind,
      recipientUserId: link.chatId,
      title: input.businessName,
      body: texts[locale],
      url,
      dedupeKey: `order:${spec.dedupe}:${order.id}:${stamp}:tg:${link.chatId}`,
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
        logger.warn({ err, orderId: order.id }, `orders: SMS/WhatsApp (${spec.kind}) не отправлен`);
      }
      await log(channel, delivered ? 'sent' : 'notDelivered', 'ru');
      if (delivered) channels.push(channel);
    } else {
      await log('push', 'notDelivered');
    }
  }
  return { channels };
}
