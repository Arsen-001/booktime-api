import { z } from 'zod';
import { localized } from '../businesses/business.schemas.js';
const money = z.number().int().min(0).max(1_000_000_000_000);
const id32 = z.string().min(1).max(32);
export const categoryBody = z.object({
    name: localized,
    onlineNameEnabled: z.boolean().default(false),
    onlineName: localized.optional(),
});
export const techBreakMode = z.enum(['shared', 'none', 'custom']);
export const serviceBody = z.object({
    categoryId: id32,
    name: localized,
    description: localized.optional(),
    kind: z.enum(['individual', 'group']),
    capacity: z.number().int().min(1).max(500).optional(),
    durationMin: z.number().int().min(0).max(1440),
    durationMax: z.number().int().min(0).max(1440).optional(),
    priceMin: money,
    priceMax: money.optional(),
    techBreak: techBreakMode,
    techBreakMin: z.number().int().min(0).max(480).optional(),
    repeatIntervalDays: z.number().int().min(0).max(3650).optional(),
    photos: z.array(z.string().max(4_000_000)).max(30).default([]),
    onlineBookable: z.boolean(),
    shadeChoice: z.enum(['required', 'preferred']).optional(),
});
/** Создание: sphereId задаётся один раз, дальше не меняется (F-00-082…) */
export const createServiceBody = serviceBody.extend({ sphereId: z.string().min(1).max(40) });
export const activeBody = z.object({ active: z.boolean() });
export const orderBody = z.object({ ids: z.array(id32).max(2000) });
export const techBreakBody = z.object({ mode: techBreakMode, min: z.number().int().min(0).max(480).optional() });
export const techBreakImportRowBody = z.object({ id: id32, name: z.string().max(200), raw: z.string().max(50) });
export const techBreakImportBody = z.object({ rows: z.array(techBreakImportRowBody).max(500) });
export const assignableQuery = z.object({});
export const staffTermBody = z.object({
    price: money.optional(),
    durationMin: z.number().int().min(0).max(1440).optional(),
});
export const serviceExtraBody = z
    .object({
    autoTranslated: z.object({ hy: z.boolean().optional(), en: z.boolean().optional() }).optional(),
    receipt: z
        .object({
        receiptName: localized.optional(),
        taxSystem: z.enum(['general', 'simplified', 'patent', 'none']).optional(),
        taxRatePct: z.number().min(0).max(100).optional(),
    })
        .optional(),
    pickOptions: z
        .object({ mode: z.enum(['palette', 'manual']), manualOptions: z.array(localized).max(50).optional() })
        .optional(),
})
    .catchall(z.unknown());
/** Восстановление удалённой услуги тем же id (F-00-061 — «Отменить», токен держит сам экран 5 с) */
export const restoreServiceBody = z
    .object({
    id: id32,
    categoryId: id32,
    sphereId: z.string().min(1).max(40),
    name: localized,
    kind: z.enum(['individual', 'group']),
    durationMin: z.number().int().min(0).max(1440),
    priceMin: money,
})
    .catchall(z.unknown());
// ─────────── пакеты «Комплекс» (F-16-107…135) — та же таблица services ───────────
export const packageCreateBody = z.object({ categoryId: id32, sphereId: z.string().min(1).max(40), name: localized });
export const packageExtraPatchBody = z
    .object({
    pricingMethod: z.enum(['sumServices', 'manual', 'discountPercent']).optional(),
    manualPrice: money.optional(),
    discountPercent: z.number().min(0).max(100).optional(),
    availability: z
        .object({
        enabled: z.boolean(),
        dateFrom: z.string().max(10).optional(),
        dateTo: z.string().max(10).optional(),
        timeFrom: z.string().max(5).optional(),
        timeTo: z.string().max(5).optional(),
        days: z.enum(['any', 'weekdays', 'weekend', 'custom']),
        customDates: z.array(z.string().max(10)).max(60).optional(),
    })
        .optional(),
    prepaymentRequired: z.boolean().optional(),
    wholePackageResourceIds: z.array(id32).max(20).optional(),
})
    .partial();
export const packageSaveBody = z.object({
    name: localized.optional(),
    categoryId: id32.optional(),
    items: z.array(z.object({ serviceId: id32, order: z.number().int().min(0) })).max(10).optional(),
    mode: z.enum(['parallel', 'sequentialSame', 'sequentialAny']).optional(),
    onlineBookable: z.boolean().optional(),
    description: localized.optional(),
    photos: z.array(z.string().max(4_000_000)).max(30).optional(),
    extra: packageExtraPatchBody.optional(),
});
// ─────────── ответы (OpenAPI) ───────────
export const categoryOut = z.object({ id: z.string(), businessId: z.string(), name: localized, order: z.number(), version: z.number() });
export const serviceOut = z
    .object({
    id: z.string(),
    businessId: z.string(),
    categoryId: z.string(),
    sphereId: z.string(),
    name: localized,
    kind: z.enum(['individual', 'group']),
    durationMin: z.number(),
    priceMin: z.number(),
    photos: z.array(z.string()),
    staffIds: z.array(z.string()),
    onlineBookable: z.boolean(),
    active: z.boolean(),
    order: z.number(),
    version: z.number(),
})
    .catchall(z.unknown());
export const serviceRowOut = z.object({ service: serviceOut, extra: z.record(z.string(), z.unknown()).optional(), staffTerms: z.array(z.unknown()) });
export const packageOut = serviceOut.and(z.object({ extra: z.record(z.string(), z.unknown()) }));
export const deleteImpactOut = z.object({ staffCount: z.number(), futureBookings: z.number(), futureEvents: z.number(), packagesUsing: z.number() });
export const categoryDeleteImpactOut = z.object({ serviceCount: z.number() });
export const techBreakExportRowOut = z.object({ id: z.string(), name: z.string(), seconds: z.union([z.number(), z.literal('Default')]) });
export const techBreakImportResultOut = z.object({ applied: z.number(), failed: z.array(z.object({ name: z.string(), reason: z.string() })) });
// ─────────── стадия 21 (лейн services+rest): фото мастера (свободные места, привязка к услуге), дипломы,
// материалы/стерилизация, порядок категорий, сводка контента (F-00-085…091, У28) ───────────
export const photoProfileBody = z.object({
    photos: z.array(z.string().max(4_000_000)).max(30),
    links: z.record(z.string(), z.string().max(32).nullable()),
});
export const staffDocumentBody = z.object({
    imageUrl: z.string().max(4_000_000),
    fileName: z.string().max(255).optional(),
    moderationId: id32.optional(),
});
export const staffDocumentOut = z.object({
    id: z.string(),
    staffId: z.string(),
    businessId: z.string(),
    imageUrl: z.string(),
    fileName: z.string().optional(),
    uploadedAt: z.string(),
    moderationId: z.string().optional(),
});
/** «Отменить» после удаления диплома (У26) — пересоздаёт ту же строку, что вернул GET/POST */
export const staffDocumentRestoreBody = staffDocumentOut;
export const materialsProfileBody = z.object({
    materials: z.object({
        presetIds: z.array(z.string().max(40)).max(20),
        custom: z.array(z.string().max(200)).max(50),
    }),
    sterilization: z.object({
        methods: z.array(z.enum(['autoclave', 'craftBags', 'disposable'])),
        note: z.string().max(500).optional(),
    }),
});
export const photoSlotsOut = z.object({ used: z.number(), base: z.number(), extra: z.number(), total: z.number(), priceCoins: z.number() });
export const serviceMaterialsOut = z.object({
    staffLabels: z.array(z.string()),
    staffCustom: z.array(z.string()),
    stockItems: z.array(z.object({ id: z.string(), name: z.string(), brand: z.string().optional() })),
});
export const staffContentCountsOut = z.record(z.string(), z.object({ photos: z.number(), documents: z.number(), materials: z.number() }));
//# sourceMappingURL=services.schemas.js.map