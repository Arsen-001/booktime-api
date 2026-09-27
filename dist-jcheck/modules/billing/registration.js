import { redeemPromo } from './promo.js';
import { ensureSubscription, grantFreeDays } from './subscription.js';
/**
 * Подписка нового бизнеса (В-02) и промокод регистрации (06 §4.2: код применяется только в `POST /v1/biz` или
 * первой оплате — отдельного «ввести промокод» нет). Зовётся из той же транзакции, что создаёт бизнес:
 * неверный код → `promo_*`, бизнес не создаётся (как `registerBusiness` мока).
 * - discount — ступени кода (В-13) копируются в подписку: отзыв кода потом скидку не отнимает;
 * - freeMonth — бесплатные дни сразу, бизнес опубликован (промокод с визита, В-02).
 */
export async function onBusinessRegistered(tx, businessId, promoCode, by) {
    await ensureSubscription(tx, businessId);
    const code = promoCode?.trim();
    if (!code)
        return false;
    const { promo, redemption } = await redeemPromo(tx, code, businessId);
    if (promo.kind === 'freeMonth') {
        await grantFreeDays(tx, { businessId, days: promo.freeDays ?? 30, reason: 'promo', by, note: promo.code });
        await tx.subscription.update({ where: { businessId }, data: { promoCode: promo.code, promoRedemptionId: redemption.id } });
    }
    else {
        await tx.subscription.update({
            where: { businessId },
            data: { promoCode: promo.code, promoRedemptionId: redemption.id, promoTiers: promo.tiers },
        });
    }
    return true;
}
//# sourceMappingURL=registration.js.map