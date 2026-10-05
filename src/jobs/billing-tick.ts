import { isLocale, t, type Locale } from '../common/i18n/i18n.js';
import type { PrismaService } from '../common/prisma.service.js';
import { createPaymentProvider } from '../modules/billing/billing-payments.js';
import { billingTick } from '../modules/billing/subscription.js';
import { enqueueOutbox } from '../modules/notify/outbox.js';

/**
 * Ход подписки (06 §3.3): 03:00 по Еревану — предупреждения, списания, отсрочка, заморозка; каждые 5 минут —
 * повтор неудачных списаний, срок которых подошёл. Уведомление — владельцу пушем (кабинет бизнеса).
 * «Подписка скоро закончится» — тип 43 каталога (06.10.2026): выключатель и канал «Приложение администратора» действуют
 * (отправитель очереди, catalog-gate.ts), строка видна в журнале отправок салона. «Списание не прошло» и «Доступ
 * заморожен» — не типы каталога, выключить нельзя (без них салон молча теряет доступ), businessId в очередь не ставим.
 */
/** Тип каталога «Подписка скоро закончится» (notify-type-registry.ts) */
const ENDING_SOON_TYPE = 43;

export async function billingDispatch(prisma: PrismaService) {
  const payments = createPaymentProvider();
  return billingTick(prisma, payments, async (businessId, key, params, dedupe) => {
    const owners = await prisma.staff.findMany({ where: { businessId, role: 'owner', deletedAt: null, userId: { not: null } }, select: { userId: true } });
    for (const o of owners) {
      const user = await prisma.user.findUnique({ where: { id: o.userId! }, select: { locale: true } });
      const locale: Locale = user && isLocale(user.locale) ? user.locale : 'ru';
      await enqueueOutbox(prisma, {
        businessId: key === 'billing.endingSoon' ? businessId : null,
        app: 'business',
        kind: key === 'billing.endingSoon' ? 'billing_ending' : key === 'billing.paymentFailed' ? 'billing_failed' : 'billing_frozen',
        recipientUserId: o.userId!,
        title: 'BookTime',
        body: t(locale, key, params),
        url: '/biz/billing',
        dedupeKey: `${dedupe}:${o.userId}`,
        meta: key === 'billing.endingSoon' ? { businessId, typeCode: ENDING_SOON_TYPE } : { businessId },
      });
    }
  });
}
