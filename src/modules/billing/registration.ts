import type { Prisma } from '../../generated/prisma/client.js';
import { redeemPromo } from './promo.js';
import { ensureSubscription, grantFreeDays, startIntroTrial } from './subscription.js';

/**
 * Подписка нового бизнеса (В-02) и промокод регистрации (06 §4.2: код применяется только в `POST /v1/biz` или
 * первой оплате — отдельного «ввести промокод» нет). Зовётся из той же транзакции, что создаёт бизнес:
 * неверный код → `promo_*`, бизнес не создаётся (как `registerBusiness` мока).
 * - discount — ступени кода (В-13) копируются в подписку: отзыв кода потом скидку не отнимает;
 * - freeMonth — бесплатные дни сразу, бизнес опубликован (промокод с визита, В-02);
 * - иначе — пробный период 7 дней (F-00-019, решение владельца 01.10.2026), скидка кода — на первую оплату.
 */
export async function onBusinessRegistered(tx: Prisma.TransactionClient, businessId: string, promoCode: string | undefined, by: string): Promise<boolean> {
  await ensureSubscription(tx, businessId);
  const code = promoCode?.trim();
  if (!code) {
    await startIntroTrial(tx, businessId);
    return false;
  }
  const { promo, redemption } = await redeemPromo(tx, code, businessId);
  // Решение владельца 01.10.2026: 7 дней на знакомство; бесплатный месяц с визита — вместо них
  if (promo.kind !== 'freeMonth') await startIntroTrial(tx, businessId);
  if (promo.kind === 'freeMonth') {
    await grantFreeDays(tx, { businessId, days: promo.freeDays ?? 30, reason: 'promo', by, note: promo.code });
    await tx.subscription.update({ where: { businessId }, data: { promoCode: promo.code, promoRedemptionId: redemption.id } });
  } else {
    await tx.subscription.update({
      where: { businessId },
      data: { promoCode: promo.code, promoRedemptionId: redemption.id, promoTiers: promo.tiers as Prisma.InputJsonValue },
    });
  }
  return true;
}
