import { z } from 'zod';
export const monthsQuery = z.object({ months: z.coerce.number().int().refine((v) => [1, 3, 6, 12].includes(v), 'months must be 1|3|6|12').default(1) });
export const payBody = z.object({
    months: z.number().int().refine((v) => [1, 3, 6, 12].includes(v), 'months must be 1|3|6|12'),
    method: z.enum(['card', 'idram', 'telcell', 'invoice']),
});
export const autoRenewBody = z.object({ autoRenew: z.boolean() });
export const docsEmailBody = z.object({ value: z.boolean() });
export const cardBody = z.object({ method: z.enum(['card', 'idram', 'telcell']), label: z.string().max(40).optional() });
export const previewBody = z.object({ masters: z.number().int().min(-50).max(50).optional(), admins: z.number().int().min(-50).max(50).optional() });
export const invoicesQuery = z.object({ purpose: z.enum(['subscription', 'coins', 'ads']).optional() });
export const coinEntriesQuery = z.object({ area: z.string().max(20).optional(), kinds: z.string().max(60).optional() });
export const buyCoinsBody = z.object({ packageId: z.string().min(1).max(20) });
export const spendBody = z.object({ amount: z.number().int().min(1).max(1_000_000), reason: z.string().min(1).max(40), area: z.string().min(1).max(20), refId: z.string().max(32).optional() });
export const photoSlotBody = z.object({ staffId: z.string().min(1).max(32) });
export const planQuery = z.object({
    kind: z.enum(['individual', 'salon']),
    masters: z.coerce.number().int().min(0).max(500).default(0),
    admins: z.coerce.number().int().min(0).max(100).default(0),
    months: z.coerce.number().int().min(1).max(36).default(1),
});
// наша панель
const tier = z.object({ months: z.number().int().refine((v) => [1, 3, 6, 12].includes(v)), percent: z.number().int().min(1).max(90) });
export const promoCreateBody = z.object({
    code: z.string().min(3).max(24),
    kind: z.enum(['discount', 'freeMonth']),
    tiers: z.array(tier).max(4).optional(),
    freeDays: z.number().int().min(1).max(366).optional(),
    personal: z.boolean().optional(),
    validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    note: z.string().max(300).optional(),
    issuedTo: z.object({ name: z.string().min(1).max(160), phone: z.string().max(20).optional(), visitId: z.string().max(32).optional(), businessId: z.string().max(32).optional() }).optional(),
});
export const promoCheckQuery = z.object({ code: z.string().min(1).max(40), businessId: z.string().max(32).optional() });
export const freeMonthsBody = z.object({
    businessId: z.string().min(1).max(32),
    days: z.number().int().min(1).max(366),
    reason: z.enum(['visit', 'first', 'promo', 'manual']),
    note: z.string().max(300).optional(),
});
export const pricesBody = z.object({ values: z.record(z.string(), z.number().int().min(0).max(10_000_000)) });
export const grantCoinsBody = z.object({ businessId: z.string().min(1).max(32), amount: z.number().int().min(1).max(1_000_000), reason: z.enum(['firstAward', 'promo', 'referralSalon', 'manual']), note: z.string().max(300).optional() });
//# sourceMappingURL=billing.schemas.js.map