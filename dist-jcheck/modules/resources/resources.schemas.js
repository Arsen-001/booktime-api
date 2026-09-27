import { z } from 'zod';
import { localized } from '../businesses/business.schemas.js';
const id32 = z.string().min(1).max(32);
export const resourceKind = z.enum(['chair', 'room', 'device', 'box', 'hall', 'other']);
export const resourceCreateBody = z.object({
    locationId: id32,
    name: localized,
    description: z.string().max(2000).optional(),
    kind: resourceKind,
    serviceIds: z.array(id32).max(500).default([]),
});
export const resourceUpdateBody = z
    .object({
    name: localized,
    kind: resourceKind,
    serviceIds: z.array(id32).max(500),
    description: z.string().max(2000),
    active: z.boolean(),
})
    .partial();
/** «Отменить» удаление ресурса (F-00-061) — снимок держит экран, восстанавливает тем же id */
export const restoreResourceBody = z.object({
    resource: z
        .object({
        id: id32,
        locationId: id32,
        name: localized,
        kind: resourceKind,
        instances: z.array(z.object({ id: z.string().max(40), name: z.string().max(60) })).max(50).default([]),
        serviceIds: z.array(id32).max(500).default([]),
        active: z.boolean().default(true),
    })
        .catchall(z.unknown()),
    description: z.string().max(2000).optional(),
});
export const instanceBody = z.object({ name: z.string().max(60) });
export const resourceServicesBody = z.object({ serviceIds: z.array(id32).max(500) });
export const toggleServiceBody = z.object({ linked: z.boolean() });
export const splitByResourceBody = z.object({ value: z.boolean() });
// ─────────── пакеты — см. services.schemas.ts (пакет — та же таблица services) ───────────
// ─────────── ответы (OpenAPI) ───────────
export const resourceOut = z.object({
    id: z.string(),
    businessId: z.string(),
    locationId: z.string(),
    name: localized,
    kind: resourceKind,
    instances: z.array(z.object({ id: z.string(), name: z.string() })),
    serviceIds: z.array(z.string()),
    active: z.boolean(),
    description: z.string(),
    version: z.number(),
});
export const changeLogEntryOut = z.object({
    id: z.string(),
    businessId: z.string(),
    entity: z.enum(['resource', 'package', 'event', 'waitlist']),
    entityId: z.string(),
    action: z.enum(['create', 'update', 'delete', 'restore']),
    actorName: z.string(),
    at: z.string(),
    summary: z.string(),
});
// ─────────── stage 21: аудит фасадов — окно записи, ассистенты, шаблоны/категории событий, «места» ───────────
export const freeInstancesBody = z.object({
    serviceIds: z.array(id32).max(50),
    start: z.string(),
    durationMin: z.number().int().min(0).max(1440),
    excludeBookingId: id32.optional(),
});
export const checkInstancesFreeBody = z.object({
    instanceIds: z.array(z.string().max(40)).max(50),
    start: z.string(),
    durationMin: z.number().int().min(0).max(1440),
    excludeBookingId: id32.optional(),
});
export const resourceOptionsBody = z.object({
    start: z.string(),
    durationMin: z.number().int().min(0).max(1440),
    excludeBookingId: id32.optional(),
});
export const assistantSettingsBody = z
    .object({
    compensationEnabled: z.boolean(),
    allowMultiple: z.boolean(),
    shareRule: z.enum(['full', 'split']),
})
    .partial();
export const staffEligibleBody = z.object({ value: z.boolean() });
export const fineRightsBody = z
    .object({
    viewResources: z.boolean(),
    editServiceResources: z.boolean(),
    viewWaitlist: z.boolean(),
    addAssistants: z.boolean(),
    editAssistantShare: z.boolean(),
})
    .partial();
export const groupSeatsSettingsBody = z.object({ allowMultiSeat: z.boolean(), maxSeats: z.number().int().min(1).max(50) });
export const eventTemplateBody = z.object({
    name: z.string().min(1).max(120),
    freq: z.enum(['daily', 'weekdays', 'monWedFri', 'tueThu', 'weekly', 'monthly', 'yearly']),
    weekIntervalWeeks: z.number().int().min(1).max(52).optional(),
});
export const eventCategoryBody = z.object({ name: z.string().min(1).max(80), colorIndex: z.number().int().min(1).max(8) });
export const groupServicePaymentBody = z
    .object({ onlinePrepaymentEnabled: z.boolean(), membershipBookingEnabled: z.boolean() })
    .partial();
export const createAssistantBody = z.object({ locationId: id32, name: z.string().min(1).max(160), phone: z.string().min(1).max(20) });
//# sourceMappingURL=resources.schemas.js.map