import { z } from 'zod';

/** LocalizedText {ru, hy?, en?} (+ пометки автоперевода) */
export const localized = z.object({ ru: z.string().max(4000), hy: z.string().max(4000).optional(), en: z.string().max(4000).optional() }).catchall(z.unknown());
const sphereIds = z.array(z.string().min(1).max(40)).max(20);

export const registerBusinessBody = z.object({
  kind: z.enum(['individual', 'salon']),
  name: z.string().max(160),
  sphereIds,
  phone: z.string().max(40),
  ownerName: z.string().max(120).optional(),
  promoCode: z.string().max(40).optional(),
  /** Индивидуал выбирает режим календаря (F-00-051); салон — «всё свободно» */
  calendarMode: z.enum(['free', 'busy']).optional(),
  district: z.string().max(40).optional(),
  address: z.string().max(300).optional(),
});
export type RegisterBusinessBody = z.infer<typeof registerBusinessBody>;

export const patchBusinessBody = z.object({
  name: z.string().max(160).optional(),
  phone: z.string().max(40).optional(),
  sphereIds: sphereIds.optional(),
  description: localized.nullable().optional(),
  logoUrl: z.string().max(4_000_000).nullable().optional(),
  photos: z.array(z.string().max(4_000_000)).max(6).optional(),
  socials: z.record(z.string(), z.unknown()).nullable().optional(),
  bookingRules: z.record(z.string(), z.unknown()).nullable().optional(),
  brandName: z.string().max(160).nullable().optional(),
  forbidHomeBookingsDuringShift: z.boolean().optional(),
  adsOptIn: z.boolean().optional(),
  /** Раздел «Заказы» (03.10.2026); null — снова по сфере */
  ordersEnabled: z.boolean().nullable().optional(),
  /** «Заказ ждёт вас» (04.10.2026): off | 3 | 3_7 дней после «Готов»; null — снова по умолчанию (3_7) */
  orderPickupReminders: z.enum(['off', '3', '3_7']).nullable().optional(),
});
export type PatchBusinessBody = z.infer<typeof patchBusinessBody>;

export const locationBody = z.object({
  name: localized,
  address: localized.optional(),
  district: z.string().max(40).optional(),
  phone: z.string().max(40).optional(),
  hoursText: z.string().max(200).optional(),
  timezone: z.string().max(40).optional(),
});
export type LocationBody = z.infer<typeof locationBody>;

export const patchLocationBody = z.object({
  name: localized.optional(),
  address: localized.optional(),
  district: z.string().max(40).optional(),
  yandexMapsUrl: z.string().max(1000).optional(),
  phone: z.string().max(40).optional(),
  extraPhones: z.array(z.string().max(40)).max(10).optional(),
  hoursText: z.string().max(200).optional(),
  openHours: z.record(z.string(), z.unknown()).nullable().optional(),
  journalKind: z.enum(['individual', 'mixed', 'group']).optional(),
  timezone: z.string().max(40).optional(),
});
export type PatchLocationBody = z.infer<typeof patchLocationBody>;

export const hereBody = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });
export const settingBody = z.object({ data: z.record(z.string(), z.unknown()) });
export const securityBody = z.object({ blockHomeVisitDuringShift: z.boolean() });

// ─────────── ответы (OpenAPI) ───────────

export const businessOut = z.object({
  id: z.string(),
  kind: z.enum(['individual', 'salon']),
  name: z.string(),
  slug: z.string(),
  sphereIds: z.array(z.string()),
  networkId: z.string().optional(),
  ownerStaffId: z.string(),
  locationIds: z.array(z.string()),
  phone: z.string(),
  description: localized.optional(),
  logoUrl: z.string().optional(),
  photos: z.array(z.string()),
  status: z.enum(['active', 'frozen', 'moderation', 'draft']),
  createdAt: z.string(),
  forbidHomeBookingsDuringShift: z.boolean(),
  socials: z.record(z.string(), z.unknown()).optional(),
  bookingRules: z.record(z.string(), z.unknown()).optional(),
  brandName: z.string().optional(),
  ordersEnabled: z.boolean(),
  orderPickupReminders: z.enum(['off', '3', '3_7']),
  version: z.number(),
});

export const locationOut = z.object({
  id: z.string(),
  businessId: z.string(),
  name: localized,
  address: localized,
  district: z.string(),
  yandexMapsUrl: z.string().optional(),
  coords: z.object({ lat: z.number(), lng: z.number() }).optional(),
  phone: z.string().optional(),
  extraPhones: z.array(z.string()).optional(),
  hoursText: z.string().optional(),
  openHours: z.record(z.string(), z.unknown()).optional(),
  journalKind: z.enum(['individual', 'mixed', 'group']).optional(),
  timezone: z.string(),
  version: z.number(),
});

export const networkOut = z.object({
  id: z.string(),
  name: z.string(),
  ownerStaffId: z.string(),
  businessIds: z.array(z.string()),
  createdAt: z.string(),
  mainBusinessId: z.string().optional(),
  version: z.number(),
});

export const staffOut = z
  .object({
    id: z.string(),
    businessId: z.string(),
    locationIds: z.array(z.string()),
    name: z.string(),
    phone: z.string(),
    role: z.enum(['owner', 'admin', 'master']),
    status: z.enum(['active', 'invited', 'disabled', 'fired']),
    sphereIds: z.array(z.string()),
    workplaces: z.array(z.string()),
    serviceIds: z.array(z.string()),
    hiredAt: z.string(),
    version: z.number(),
  })
  .catchall(z.unknown());

export const coreOut = z.object({
  businesses: z.array(businessOut),
  locations: z.array(locationOut),
  staff: z.array(staffOut),
  networks: z.array(networkOut),
  // Каталог (этап 4) — см. src/modules/services/services.views.ts, src/modules/resources/resources.views.ts
  serviceCategories: z.array(z.unknown()),
  services: z.array(z.unknown()),
  resources: z.array(z.unknown()),
});

export const registerOut = z.object({
  businessId: z.string(),
  persona: z.enum(['individual', 'owner']),
  promoApplied: z.boolean(),
  membership: z.unknown(),
  core: coreOut,
});

export const settingOut = z.object({ area: z.string(), data: z.record(z.string(), z.unknown()), version: z.number() });
export const securityOut = z.object({ blockHomeVisitDuringShift: z.boolean() });
