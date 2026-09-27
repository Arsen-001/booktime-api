import dayjs from 'dayjs';
import { Prisma } from '../../generated/prisma/client.js';
import { ApiError } from '../../common/errors/api-error.js';
import { newId } from '../../common/ids/ids.js';
import { DEFAULT_TZ, utcToLocal, utcToLocalDate } from '../../common/time/time.js';
import { DEFAULT_PROMO_TIERS, loadPrices } from './billing-prices.js';
/** Код промокода всегда в верхнем регистре (06 §4.2: `code UNIQUE ci`) */
export const normalizeCode = (code) => code.trim().toUpperCase();
export const CODE_RE = /^[A-Z0-9-]{3,24}$/;
const today = () => utcToLocalDate(new Date());
function statusOf(p, used) {
    if (p.revokedAt)
        return 'revoked';
    if (used)
        return 'used';
    if (p.validUntil && p.validUntil < today())
        return 'expired';
    if (p.issuedTo)
        return 'issued';
    return 'new';
}
/** PromoView фронта (src/domain/platform/types/promo.ts) */
export async function promoViews(db, rows) {
    const redemptions = await db.promoRedemption.findMany({ where: { promoCodeId: { in: rows.map((r) => r.id) } } });
    const byPromo = new Map(redemptions.map((r) => [r.promoCodeId, r]));
    const issuedBiz = rows.map((r) => r.issuedTo?.businessId).filter((x) => Boolean(x));
    const bizIds = [...new Set([...issuedBiz, ...redemptions.map((r) => r.businessId)])];
    const names = new Map((await db.business.findMany({ where: { id: { in: bizIds } }, select: { id: true, name: true } })).map((b) => [b.id, b.name]));
    return rows.map((p) => {
        const red = byPromo.get(p.id);
        const issuedTo = (p.issuedTo ?? undefined);
        return {
            id: p.id,
            code: p.code,
            kind: p.kind,
            tiers: p.tiers,
            freeDays: p.freeDays ?? undefined,
            personal: p.personal,
            validUntil: p.validUntil ?? undefined,
            issuedTo,
            issuedAt: p.issuedAt ? utcToLocal(p.issuedAt) : undefined,
            usedAt: red ? utcToLocal(red.redeemedAt) : undefined,
            usedByBusinessId: red?.businessId,
            revokedAt: p.revokedAt ? utcToLocal(p.revokedAt) : undefined,
            note: p.note ?? undefined,
            createdAt: utcToLocal(p.createdAt),
            status: statusOf(p, Boolean(red)),
            issuedToBusinessName: issuedTo?.businessId ? names.get(issuedTo.businessId) : undefined,
            usedByBusinessName: red ? names.get(red.businessId) : undefined,
        };
    });
}
/** Проверка без применения (ответы как PromoCheck мока: notFound | used | expired | revoked | personal) */
export async function checkPromo(db, code, businessId) {
    const promo = await db.promoCode.findUnique({ where: { code: normalizeCode(code) } });
    if (!promo)
        return { ok: false, reason: 'notFound' };
    const used = (await db.promoRedemption.count({ where: { promoCodeId: promo.id } })) > 0;
    const status = statusOf(promo, used);
    if (status === 'used' || status === 'expired' || status === 'revoked')
        return { ok: false, reason: status };
    const issuedBiz = promo.issuedTo?.businessId;
    if (businessId && promo.personal && issuedBiz && issuedBiz !== businessId)
        return { ok: false, reason: 'personal' };
    return { ok: true, promo };
}
const REASON_CODE = {
    notFound: 'promo_not_found',
    used: 'promo_used',
    expired: 'promo_expired',
    revoked: 'promo_revoked',
    personal: 'promo_personal',
};
/**
 * Применить код к бизнесу (06 §4.2). «Одноразовый» держит уникальный индекс `promo_redemptions.promo_code_id`:
 * два салона с одним кодом в одну секунду — второй получает `promo_used` (P2002), а не двойную скидку.
 */
export async function redeemPromo(tx, code, businessId) {
    const check = await checkPromo(tx, code, businessId);
    if (!check.ok)
        throw new ApiError(REASON_CODE[check.reason], `Promo ${check.reason}`);
    try {
        const redemption = await tx.promoRedemption.create({ data: { id: newId('promoRedemption'), promoCodeId: check.promo.id, businessId } });
        return { promo: check.promo, redemption };
    }
    catch (err) {
        if (err.code === 'P2002')
            throw new ApiError('promo_used', 'Promo already used');
        throw err;
    }
}
/** Создать код (наша панель, F-00-178). Срок по умолчанию — promoValidDays (В-13: 30 дней), ступени — В-13 */
export async function createPromo(db, input, by) {
    const code = normalizeCode(input.code);
    if (!CODE_RE.test(code))
        throw new ApiError('validation', 'Bad code', { code: 'format' });
    const prices = await loadPrices(db);
    const validUntil = input.validUntil ?? dayjs().tz(DEFAULT_TZ).add(prices.promoValidDays, 'day').format('YYYY-MM-DD');
    try {
        return await db.promoCode.create({
            data: {
                id: newId('promoCode'),
                code,
                kind: input.kind,
                tiers: (input.kind === 'discount' ? (input.tiers?.length ? input.tiers : DEFAULT_PROMO_TIERS) : []),
                freeDays: input.kind === 'freeMonth' ? (input.freeDays ?? prices.freeMonthDays) : null,
                personal: input.personal ?? true,
                issuedTo: input.issuedTo ? input.issuedTo : Prisma.DbNull,
                issuedAt: input.issuedTo ? new Date() : null,
                validUntil,
                note: input.note ?? null,
                createdBy: by,
            },
        });
    }
    catch (err) {
        if (err.code === 'P2002')
            throw new ApiError('conflict', 'Code exists', { code: 'taken' });
        throw err;
    }
}
//# sourceMappingURL=promo.js.map