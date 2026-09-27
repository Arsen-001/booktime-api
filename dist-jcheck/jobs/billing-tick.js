import { isLocale, t } from '../common/i18n/i18n.js';
import { createPaymentProvider } from '../modules/billing/billing-payments.js';
import { billingTick } from '../modules/billing/subscription.js';
import { enqueueOutbox } from '../modules/notify/outbox.js';
/**
 * Ход подписки (06 §3.3): 03:00 по Еревану — предупреждения, списания, отсрочка, заморозка; каждые 5 минут —
 * повтор неудачных списаний, срок которых подошёл. Уведомление — владельцу пушем (кабинет бизнеса), всегда
 * включено (это не тип уведомлений бизнеса, который можно выключить — поэтому businessId в очередь не ставим).
 */
export async function billingDispatch(prisma) {
    const payments = createPaymentProvider();
    return billingTick(prisma, payments, async (businessId, key, params, dedupe) => {
        const owners = await prisma.staff.findMany({ where: { businessId, role: 'owner', deletedAt: null, userId: { not: null } }, select: { userId: true } });
        for (const o of owners) {
            const user = await prisma.user.findUnique({ where: { id: o.userId }, select: { locale: true } });
            const locale = user && isLocale(user.locale) ? user.locale : 'ru';
            await enqueueOutbox(prisma, {
                businessId: null,
                app: 'business',
                kind: key === 'billing.endingSoon' ? 'billing_ending' : key === 'billing.paymentFailed' ? 'billing_failed' : 'billing_frozen',
                recipientUserId: o.userId,
                title: 'BookTime',
                body: t(locale, key, params),
                url: '/biz/billing',
                dedupeKey: `${dedupe}:${o.userId}`,
                meta: { businessId },
            });
        }
    });
}
//# sourceMappingURL=billing-tick.js.map