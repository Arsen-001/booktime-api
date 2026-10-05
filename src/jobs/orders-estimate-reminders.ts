import type { BusinessMessenger } from '../adapters/business-sms/business-sms.js';
import { env } from '../common/config/env.js';
import { logger } from '../common/logging/logger.js';
import type { PrismaService } from '../common/prisma.service.js';
import { inQuietHours } from '../modules/notify/quiet-hours.js';
import { notifyOrderEstimateReminder } from '../modules/orders/order-notify.js';
import { ESTIMATE_ORDER_STATUSES, ESTIMATE_REMINDER_AFTER_MS, estimateReminderDue, type OrderEstimateData, type OrderRow } from '../modules/orders/order-rules.js';

const BATCH = 1000;

export interface EstimateRemindersResult {
  sent: number;
  undelivered: number;
  quiet: boolean;
}

/**
 * ⭐ «Ждём ответа по смете» (05.10.2026): клиент сутки не ответил на смету — одно напоминание на версию сметы (новая
 * смета — новый отсчёт). Тот же приём, что «Заказ ждёт вас» (jobs/orders-pickup-reminders.ts):
 *  · только смета «ждём ответа» у заказа «Принят» / «В работе»;
 *  · тихие часы 21:00–10:00 по Еревану — пропуск, утром проход подхватит всё наступившее;
 *  · сначала захват строки условным UPDATE (та же версия сметы, ещё без напоминания), потом отправка — не больше
 *    одного раза при повторе задачи или двух воркерах;
 *  · вид order_estimate_reminder выключен бизнесом — отправитель ничего не шлёт, отметка всё равно ставится.
 */
export async function ordersEstimateReminders(db: PrismaService, messenger: BusinessMessenger, now: Date = new Date()): Promise<EstimateRemindersResult> {
  const res: EstimateRemindersResult = { sent: 0, undelivered: 0, quiet: false };
  if (inQuietHours(now)) return { ...res, quiet: true };

  const rows = (await db.order.findMany({
    where: {
      estimateStatus: 'pending',
      estimateRemindedAt: null,
      status: { in: [...ESTIMATE_ORDER_STATUSES] },
      estimateSentAt: { lte: new Date(now.getTime() - ESTIMATE_REMINDER_AFTER_MS) },
    },
    orderBy: { estimateSentAt: 'asc' },
    take: BATCH,
  })) as OrderRow[];
  if (!rows.length) return res;

  const businessIds = [...new Set(rows.map((r) => r.businessId))];
  const businesses = await db.business.findMany({ where: { id: { in: businessIds } }, select: { id: true, name: true, brandName: true, leftAt: true } });
  const byId = new Map(businesses.map((b) => [b.id, b]));

  for (const order of rows) {
    const biz = byId.get(order.businessId);
    if (!biz || biz.leftAt) continue;
    if (!estimateReminderDue(order, now)) continue;
    const claimed = await db.order.updateMany({
      where: { id: order.id, estimateStatus: 'pending', estimateRemindedAt: null, estimateSentAt: order.estimateSentAt ?? null },
      data: { estimateRemindedAt: now },
    });
    if (claimed.count !== 1) continue;
    try {
      const out = await notifyOrderEstimateReminder(db, messenger, {
        order,
        businessName: biz.brandName || biz.name || 'BookTime',
        siteUrl: env.PUBLIC_SITE_URL,
        now,
        total: (order.estimate as OrderEstimateData | null)?.total ?? 0,
      });
      if (out.channels.length) res.sent++;
      else res.undelivered++;
    } catch (err) {
      logger.error({ err, orderId: order.id }, 'orders: напоминание «ждём ответа по смете» упало');
    }
  }
  return res;
}
