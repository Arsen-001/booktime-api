import { z } from 'zod';
const id32 = z.string().min(1).max(32);
const money = z.number().int().min(0).max(1_000_000_000_000);
const name160 = z.string().min(1).max(160);
// ─────────────────────────── Программа локации (F-04-114…122) ───────────────────────────
const discountTierBody = z.object({ id: z.string().max(40), basis: z.enum(['sold', 'paid', 'visits']), from: z.number().min(0), percent: z.number().min(0).max(100) });
const classTierBody = z.object({ minSold: z.number().min(0).optional(), minPaid: z.number().min(0).optional(), minVisits: z.number().min(0).optional() }).partial();
const categoryRuleBody = z.object({
    id: z.string().max(40),
    trigger: z.enum(['sold', 'paid', 'visits', 'inactiveDays', 'statusArrived', 'statusNoShow']),
    threshold: z.number().min(0).optional(),
    category: z.string().max(80),
});
export const loyaltyProgramBody = z.object({
    enabled: z.boolean(),
    discountTiers: z.array(discountTierBody).max(20),
    classRules: z.object({ bronze: classTierBody, silver: classTierBody, gold: classTierBody }),
    addRules: z.array(categoryRuleBody).max(50),
    removeRules: z.array(categoryRuleBody).max(50),
    settings: z.object({
        cancelDiscountAfterDays: z.number().int().min(0).max(3650),
        cancelClassAfterDays: z.number().int().min(0).max(3650),
        discountEndWarnDays: z.number().int().min(1).max(15).nullable(),
    }),
});
export const loyaltyProgramOut = loyaltyProgramBody;
export const recalcChangeOut = z.object({
    clientId: z.string(),
    discountBefore: z.number(),
    discountAfter: z.number(),
    classBefore: z.enum(['gold', 'silver', 'bronze']).optional(),
    classAfter: z.enum(['gold', 'silver', 'bronze']).optional(),
    categoriesAdded: z.array(z.string()),
    categoriesRemoved: z.array(z.string()),
});
// ─────────────────────────── Типы карт (F-06-020…030) ───────────────────────────
export const cardTypeBody = z.object({
    name: name160,
    networkWide: z.boolean().default(false),
    paymentLimitPercent: z.number().int().min(0).max(100).default(0),
    paymentLimitFixed: money.default(0),
    cashbackVisibleInApp: z.boolean().default(true),
    burnDays: z.number().int().min(1).max(3650).nullable().default(null),
});
export const cardTypePatchBody = cardTypeBody.partial();
export const archiveBody = z.object({ archived: z.boolean() });
export const cardTypeOut = z.object({
    id: z.string(),
    ownerId: z.string(),
    businessId: z.string(),
    name: z.string(),
    networkWide: z.boolean(),
    paymentLimitPercent: z.number(),
    paymentLimitFixed: z.number(),
    cashbackVisibleInApp: z.boolean(),
    burnDays: z.number().nullable(),
    archived: z.boolean(),
    issuedCount: z.number(),
    version: z.number(),
});
// ─────────────────────────── Карты клиентов (F-06-051…060) ───────────────────────────
export const issueCardBody = z.object({ cardTypeId: id32, clientId: id32.optional(), appUserId: id32.optional(), number: z.string().max(40).optional() });
export const bonusBody = z.object({ kind: z.enum(['accrual', 'charge']), amount: money.min(1), note: z.string().max(400).optional() });
export const cardOut = z.object({
    id: z.string(),
    cardTypeId: z.string(),
    businessId: z.string(),
    clientId: z.string().nullable(),
    appUserId: z.string().nullable(),
    number: z.string(),
    balance: z.number(),
    networkWide: z.boolean(),
    cashbackVisibleInApp: z.boolean(),
    createdAt: z.string(),
    version: z.number(),
});
// ─────────────────────────── Акции (F-06-031…050) ───────────────────────────
export const promotionKind = z.enum(['discountFixed', 'discountAccumVisits', 'discountAccumSum', 'discountConditional', 'cashbackFixed', 'cashbackAccumVisits', 'cashbackAccumSum', 'cashbackVisit']);
export const promotionBody = z.object({
    name: name160,
    kind: promotionKind,
    cardTypeIds: z.array(id32).max(50),
    valueType: z.enum(['percent', 'fixed']),
    value: z.number().int().min(0).max(1_000_000),
    thresholds: z.array(z.object({ from: z.number().min(0), value: z.number().min(0) })).max(20).optional(),
    serviceScope: z.object({ categoryIds: z.array(id32), serviceIds: z.array(id32) }).optional(),
    active: z.boolean().default(true),
});
export const promotionPatchBody = promotionBody.partial();
export const promotionOut = z.object({
    id: z.string(),
    ownerId: z.string(),
    businessId: z.string(),
    name: z.string(),
    kind: promotionKind,
    cardTypeIds: z.array(z.string()),
    valueType: z.enum(['percent', 'fixed']),
    value: z.number(),
    thresholds: z.array(z.object({ from: z.number(), value: z.number() })).optional(),
    active: z.boolean(),
    version: z.number(),
});
// ─────────────────────────── Реферальная программа (F-06-081…085) ───────────────────────────
export const referralBody = z.object({ enabled: z.boolean(), giverReward: money, receiverReward: money });
export const referralOut = referralBody.extend({ ownerId: z.string(), version: z.number() });
// ─────────────────────────── Транзакции (F-06-076/077) ───────────────────────────
export const loyaltyTxOut = z.object({
    id: z.string(),
    businessId: z.string(),
    clientId: z.string().nullable(),
    source: z.enum(['card', 'certificate', 'membership', 'account']),
    refId: z.string(),
    kind: z.string(),
    amount: z.number(),
    bookingId: z.string().nullable(),
    note: z.string().nullable(),
    staffId: z.string().nullable(),
    createdAt: z.string(),
});
// ─────────────────────────── Сертификаты (F-06-086…104) ───────────────────────────
export const certTypeBody = z.object({ name: name160, faceValue: money.min(1), validDays: z.number().int().min(1).max(3650), networkWide: z.boolean().default(false) });
export const certTypePatchBody = certTypeBody.partial();
export const certTypeOut = z.object({
    id: z.string(),
    ownerId: z.string(),
    businessId: z.string(),
    name: z.string(),
    faceValue: z.number(),
    validDays: z.number(),
    networkWide: z.boolean(),
    archived: z.boolean(),
    issuedCount: z.number(),
    version: z.number(),
});
export const sellCertificateBody = z.object({ typeId: id32, clientId: id32.optional(), appUserId: id32.optional(), total: money.optional() });
export const requestCertificateBody = z.object({ businessId: id32, typeId: id32 });
export const confirmCertificateBody = z.object({ clientId: id32.optional() });
export const certificateOut = z.object({
    id: z.string(),
    typeId: z.string(),
    businessId: z.string(),
    clientId: z.string().nullable(),
    appUserId: z.string().nullable(),
    code: z.string(),
    total: z.number(),
    balance: z.number(),
    status: z.enum(['active', 'pending_confirmation', 'rejected', 'refunded']),
    soldAt: z.string(),
    expiresAt: z.string(),
    version: z.number(),
});
// ─────────────────────────── Абонементы (F-06-105…134) ───────────────────────────
export const membershipTypeBody = z.object({
    name: name160,
    totalVisits: z.number().int().min(1).max(1000).nullable().default(null),
    price: money.min(1),
    validDays: z.number().int().min(1).max(3650),
    serviceIds: z.array(id32).max(500).default([]),
    networkWide: z.boolean().default(false),
});
export const membershipTypePatchBody = membershipTypeBody.partial();
export const membershipTypeOut = z.object({
    id: z.string(),
    ownerId: z.string(),
    businessId: z.string(),
    name: z.string(),
    totalVisits: z.number().nullable(),
    price: z.number(),
    validDays: z.number(),
    serviceIds: z.array(z.string()),
    networkWide: z.boolean(),
    archived: z.boolean(),
    issuedCount: z.number(),
    version: z.number(),
});
export const sellMembershipBody = z.object({ typeId: id32, clientId: id32.optional(), appUserId: id32.optional() });
export const requestMembershipBody = z.object({ businessId: id32, typeId: id32 });
export const confirmMembershipBody = z.object({ clientId: id32.optional() });
export const freezeMembershipBody = z.object({ toAt: z.string().min(8).max(30) });
export const membershipOut = z.object({
    id: z.string(),
    typeId: z.string(),
    businessId: z.string(),
    clientId: z.string().nullable(),
    appUserId: z.string().nullable(),
    code: z.string(),
    totalVisits: z.number().nullable(),
    remainingVisits: z.number().nullable(),
    status: z.enum(['active', 'pending_confirmation', 'rejected', 'frozen', 'expired', 'refunded']),
    soldAt: z.string(),
    expiresAt: z.string(),
    frozenUntil: z.string().nullable(),
    version: z.number(),
});
// ─────────────────────────── Счета клиентов (F-06-135…146) ───────────────────────────
export const accountTypeBody = z.object({ name: name160, networkWide: z.boolean().default(false) });
export const accountTypePatchBody = accountTypeBody.partial();
export const accountTypeOut = z.object({ id: z.string(), ownerId: z.string(), businessId: z.string(), name: z.string(), networkWide: z.boolean(), archived: z.boolean(), version: z.number() });
export const openAccountBody = z.object({ clientId: id32, typeId: id32 });
export const accountOpBody = z.object({ amount: money.min(1), note: z.string().max(400).optional(), bookingId: id32.optional() });
export const clientAccountOut = z.object({
    id: z.string(),
    typeId: z.string(),
    businessId: z.string(),
    clientId: z.string(),
    balance: z.number(),
    version: z.number(),
});
// ─────────────────────────── Применение при оплате визита (F-06-061…075) ───────────────────────────
export const applyLineBody = z.object({ method: z.enum(['card_bonus', 'certificate', 'membership', 'personal_account']), refId: id32, amount: money.min(1) });
export const applyBody = z.object({ lines: z.array(applyLineBody).min(1).max(10) });
// ─────────────────────────── Видимость клиенту (В-06) ───────────────────────────
export const clientVisibilityBody = z.object({ showToClient: z.boolean() });
export const clientVisibilityOut = clientVisibilityBody;
// ─────────────────────────── Клиенту: GET /v1/me/loyalty (F-06-156…163) ───────────────────────────
export const myLoyaltyOut = z.object({
    cards: z.array(z.object({ id: z.string(), businessId: z.string(), businessName: z.string(), cardTypeName: z.string(), number: z.string(), balance: z.number(), cashbackVisibleInApp: z.boolean() })),
    certificates: z.array(z.object({ id: z.string(), businessId: z.string(), businessName: z.string(), typeName: z.string(), code: z.string(), balance: z.number(), total: z.number(), status: z.string(), expiresAt: z.string() })),
    memberships: z.array(z.object({ id: z.string(), businessId: z.string(), businessName: z.string(), typeName: z.string(), code: z.string(), remainingVisits: z.number().nullable(), totalVisits: z.number().nullable(), status: z.string(), expiresAt: z.string() })),
    accounts: z.array(z.object({ id: z.string(), businessId: z.string(), businessName: z.string(), typeName: z.string(), balance: z.number() })),
});
//# sourceMappingURL=loyalty.schemas.js.map