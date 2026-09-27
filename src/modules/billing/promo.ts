import dayjs from 'dayjs';
import { Prisma } from '../../generated/prisma/client.js';
import { ApiError } from '../../common/errors/api-error.js';
import { newId } from '../../common/ids/ids.js';
import type { PrismaService } from '../../common/prisma.service.js';
import { DEFAULT_TZ, utcToLocal, utcToLocalDate } from '../../common/time/time.js';
import { DEFAULT_PROMO_TIERS, loadPrices, type PromoTier } from './billing-prices.js';

type Db = PrismaService | Prisma.TransactionClient;
type PromoRow = Prisma.PromoCodeGetPayload<object>;

export type PromoStatus = 'new' | 'issued' | 'used' | 'expired' | 'revoked';
export type PromoFailReason = 'notFound' | 'used' | 'expired' | 'revoked' | 'personal';

/** Код промокода всегда в верхнем регистре (06 §4.2: `code UNIQUE ci`) */
export const normalizeCode = (code: string) => code.trim().toUpperCase();
export const CODE_RE = /^[A-Z0-9-]{3,24}$/;

const today = () => utcToLocalDate(new Date());

function statusOf(p: PromoRow, used: boolean): PromoStatus {
  if (p.revokedAt) return 'revoked';
  if (used) return 'used';
  if (p.validUntil && p.validUntil < today()) return 'expired';
  if (p.issuedTo) return 'issued';
  return 'new';
}

/** PromoView фронта (src/domain/platform/types/promo.ts) */
export async function promoViews(db: Db, rows: PromoRow[]) {
  const redemptions = await db.promoRedemption.findMany({ where: { promoCodeId: { in: rows.map((r) => r.id) } } });
  const byPromo = new Map(redemptions.map((r) => [r.promoCodeId, r]));
  const issuedBiz = rows.map((r) => (r.issuedTo as { businessId?: string } | null)?.businessId).filter((x): x is string => Boolean(x));
  const bizIds = [...new Set([...issuedBiz, ...redemptions.map((r) => r.businessId)])];
  const names = new Map((await db.business.findMany({ where: { id: { in: bizIds } }, select: { id: true, name: true } })).map((b) => [b.id, b.name]));
  return rows.map((p) => {
    const red = byPromo.get(p.id);
    const issuedTo = (p.issuedTo ?? undefined) as { name: string; phone?: string; visitId?: string; businessId?: string } | undefined;
    return {
      id: p.id,
      code: p.code,
      kind: p.kind as 'discount' | 'freeMonth',
      tiers: p.tiers as unknown as PromoTier[],
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
export async function checkPromo(db: Db, code: string, businessId?: string): Promise<{ ok: true; promo: PromoRow } | { ok: false; reason: PromoFailReason }> {
  const promo = await db.promoCode.findUnique({ where: { code: normalizeCode(code) } });
  if (!promo) return { ok: false, reason: 'notFound' };
  const used = (await db.promoRedemption.count({ where: { promoCodeId: promo.id } })) > 0;
  const status = statusOf(promo, used);
  if (status === 'used' || status === 'expired' || status === 'revoked') return { ok: false, reason: status };
  const issuedBiz = (promo.issuedTo as { businessId?: string } | null)?.businessId;
  if (businessId && promo.personal && issuedBiz && issuedBiz !== businessId) return { ok: false, reason: 'personal' };
  return { ok: true, promo };
}

const REASON_CODE = {
  notFound: 'promo_not_found',
  used: 'promo_used',
  expired: 'promo_expired',
  revoked: 'promo_revoked',
  personal: 'promo_personal',
} as const;

/**
 * Применить код к бизнесу (06 §4.2). «Одноразовый» держит уникальный индекс `promo_redemptions.promo_code_id`:
 * два салона с одним кодом в одну секунду — второй получает `promo_used` (P2002), а не двойную скидку.
 */
export async function redeemPromo(tx: Prisma.TransactionClient, code: string, businessId: string) {
  const check = await checkPromo(tx, code, businessId);
  if (!check.ok) throw new ApiError(REASON_CODE[check.reason], `Promo ${check.reason}`);
  try {
    const redemption = await tx.promoRedemption.create({ data: { id: newId('promoRedemption'), promoCodeId: check.promo.id, businessId } });
    return { promo: check.promo, redemption };
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') throw new ApiError('promo_used', 'Promo already used');
    throw err;
  }
}

export interface PromoInput {
  code: string;
  kind: 'discount' | 'freeMonth';
  tiers?: PromoTier[];
  freeDays?: number;
  personal?: boolean;
  validUntil?: string;
  note?: string;
  issuedTo?: { name: string; phone?: string; visitId?: string; businessId?: string };
}

/** Создать код (наша панель, F-00-178). Срок по умолчанию — promoValidDays (В-13: 30 дней), ступени — В-13 */
export async function createPromo(db: Db, input: PromoInput, by: string) {
  const code = normalizeCode(input.code);
  if (!CODE_RE.test(code)) throw new ApiError('validation', 'Bad code', { code: 'format' });
  const prices = await loadPrices(db);
  const validUntil = input.validUntil ?? dayjs().tz(DEFAULT_TZ).add(prices.promoValidDays, 'day').format('YYYY-MM-DD');
  try {
    return await db.promoCode.create({
      data: {
        id: newId('promoCode'),
        code,
        kind: input.kind,
        tiers: (input.kind === 'discount' ? (input.tiers?.length ? input.tiers : DEFAULT_PROMO_TIERS) : []) as unknown as Prisma.InputJsonValue,
        freeDays: input.kind === 'freeMonth' ? (input.freeDays ?? prices.freeMonthDays) : null,
        personal: input.personal ?? true,
        issuedTo: input.issuedTo ? (input.issuedTo as Prisma.InputJsonValue) : Prisma.DbNull,
        issuedAt: input.issuedTo ? new Date() : null,
        validUntil,
        note: input.note ?? null,
        createdBy: by,
      },
    });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') throw new ApiError('conflict', 'Code exists', { code: 'taken' });
    throw err;
  }
}
