import type { BusinessMessenger } from '../adapters/business-sms/business-sms.js';
import { env } from '../common/config/env.js';
import { logger } from '../common/logging/logger.js';
import type { PrismaService } from '../common/prisma.service.js';
import { inQuietHours } from '../modules/notify/quiet-hours.js';
import { notifyOrderPickupReminder } from '../modules/orders/order-notify.js';
import { pickupReminderDue, pickupReminderModeOf, type OrderRow } from '../modules/orders/order-rules.js';

/** Сколько готовых заказов разбираем за один проход (готовых-невыданных у бизнеса единицы — с большим запасом) */
const BATCH = 1000;

export interface PickupRemindersResult {
  /** Напоминаний поставлено в очередь / отправлено (у клиента нашёлся канал) */
  sent: number;
  /** Срок наступил, но отправить некуда — «Не доставлено» в журнале, счётчик всё равно растёт */
  undelivered: number;
  /** Тихие часы 21:00–10:00 — проход пропущен целиком */
  quiet: boolean;
}

/**
 * ⭐ «Заказ ждёт вас» (04.10.2026): клиент не забрал готовый заказ — напомнить через 3 дня после «Готов» и ещё раз через 7
 * (настройка бизнеса Business.orderPickupReminders: off | 3 | 3_7, по умолчанию 3_7). Воркер зовёт раз в 15 минут.
 *  · только status = 'ready' — выданные и отменённые не трогаем никогда (в работе после «Готов» — тоже);
 *  · тихие часы 21:00–10:00 по Еревану — не шлём, проход утром подхватит всё наступившее;
 *  · идемпотентно: сначала «захват» строки условным UPDATE (status ready и прежний pickupReminderCount), потом отправка —
 *    два воркера / повтор задачи не пошлют одно напоминание дважды (не больше одного раза, а не «хотя бы раз»);
 *  · вид order_pickup_reminder выключен бизнесом — отправитель ничего не шлёт (isKindEnabled), счётчик растёт, чтобы не
 *    перебирать заказ каждый проход;
 *  · канал — как у «Заказ готов»: пуш → Telegram → SMS/WhatsApp провайдера бизнеса → «Не доставлено» в журнале.
 */
export async function ordersPickupReminders(db: PrismaService, messenger: BusinessMessenger, now: Date = new Date()): Promise<PickupRemindersResult> {
  const res: PickupRemindersResult = { sent: 0, undelivered: 0, quiet: false };
  if (inQuietHours(now)) return { ...res, quiet: true };

  const rows = (await db.order.findMany({
    where: { status: 'ready', pickupReminderCount: { lt: 2 } },
    orderBy: { readyNotifiedAt: 'asc' },
    take: BATCH,
  })) as (OrderRow & { pickupReminderCount: number })[];
  if (!rows.length) return res;

  const businessIds = [...new Set(rows.map((r) => r.businessId))];
  const businesses = await db.business.findMany({
    where: { id: { in: businessIds } },
    select: { id: true, name: true, brandName: true, orderPickupReminders: true, leftAt: true },
  });
  const byId = new Map(businesses.map((b) => [b.id, b]));

  for (const order of rows) {
    const biz = byId.get(order.businessId);
    if (!biz || biz.leftAt) continue; // ушёл с платформы — не пишем его клиентам
    const plan = pickupReminderDue(order, pickupReminderModeOf(biz.orderPickupReminders), now);
    if (!plan) continue;
    // Захват: ровно один проход переводит счётчик с прежнего значения — только он и отправляет
    const claimed = await db.order.updateMany({
      where: { id: order.id, status: 'ready', pickupReminderCount: order.pickupReminderCount ?? 0 },
      data: { pickupReminderCount: plan.nextCount, pickupRemindedAt: now },
    });
    if (claimed.count !== 1) continue;
    try {
      const out = await notifyOrderPickupReminder(db, messenger, {
        order,
        businessName: biz.brandName || biz.name || 'BookTime',
        siteUrl: env.PUBLIC_SITE_URL,
        now,
      });
      if (out.channels.length) res.sent++;
      else res.undelivered++;
    } catch (err) {
      logger.error({ err, orderId: order.id }, 'orders: напоминание «заказ ждёт вас» упало');
    }
  }
  return res;
}
