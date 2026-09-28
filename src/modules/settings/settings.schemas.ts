import { z } from 'zod';

export const legalBody = z.object({
  entityType: z.enum(['legalEntity', 'soleProprietor']).optional(),
  companyName: z.string().max(200).optional(),
  taxId: z.string().max(20).optional(),
  legalAddress: z.string().max(300).optional(),
  billingAddress: z.string().max(300).optional(),
  bankName: z.string().max(160).optional(),
  bankAccount: z.string().max(40).optional(),
  correspondentAccount: z.string().max(40).optional(),
  payerTax: z.record(z.string(), z.unknown()).optional(),
});
export const billingAddressBody = z.object({ billingAddress: z.string().max(300) });
export const systemBody = z.object({
  city: z.string().min(1).max(80),
  dateTimeFormat: z.enum(['24', '12']),
  messageLanguage: z.enum(['ru', 'hy', 'en']),
  sphereSubtype: z.string().max(120).optional(),
  internalName: z.string().max(160).optional(),
});
export const brandBody = z.object({ brandName: z.string().max(160), descriptionRu: z.string().max(4000), logoUrl: z.string().max(4_000_000).optional() });
export const contactsBody = z.object({
  addressRu: z.string().max(300),
  yandexMapsUrl: z.string().max(1000).optional(),
  hoursText: z.string().max(200).optional(),
  phones: z.array(z.string().max(40)).max(10),
  socials: z.record(z.string(), z.union([z.string().max(300), z.boolean()]).optional()),
});
export const galleryBody = z.object({ photos: z.array(z.string().max(4_000_000)).max(6) });
export const categoryBody = z.object({ name: z.string().max(80), colorIndex: z.number().int().min(1).max(8), icon: z.string().max(40).optional() });
export const changeLogQuery = z.object({ section: z.enum(['brand', 'contacts', 'gallery', 'legal', 'system', 'categories']).optional() });
/** «Для разработчиков» — вебхуки (F-15-119, этап 21 «Сдача», лейн rest): форма демо-интерфейса, см. settings.service.ts */
export const webhookBody = z.object({
  enabled: z.boolean(),
  url: z.string().max(500).optional(),
  entities: z.array(z.enum(['location', 'staff', 'goods', 'services', 'serviceCategories', 'clients', 'bookings', 'loyaltyEvents', 'goodsSales'])).max(20),
});
export const emailConfirmBody = z.object({ email: z.string().email().max(160).optional() });
export const onboardingBody = z.object({ goals: z.array(z.string().max(40)).max(20).optional(), tourSeen: z.boolean().optional() });
export const helpBody = z.object({ topic: z.enum(['billing', 'settings', 'staff', 'bug', 'other']), message: z.string().min(1).max(4000) });
export const sphereBody = z.object({ name: z.string().min(1).max(160), message: z.string().max(4000).optional() });
export const prefsBody = z.object({
  notificationPrefs: z.object({ news: z.boolean(), marketing: z.boolean(), system: z.boolean() }).optional(),
  startPage: z.enum(['journal', 'clients', 'analytics', 'settings']).nullable().optional(),
  startLocationId: z.string().max(32).nullable().optional(),
});

// ─────────────────────────── b06: своё приложение салона (F-14-142…170, В-29) — этап 21, лейн client+online ───────────────────────────

export const brandedAppMaterialsBody = z
  .object({
    splashUrl: z.string().max(4_000_000),
    logoUrl: z.string().max(4_000_000),
    featuredImageUrl: z.string().max(4_000_000),
    fullName: z.string().max(30),
    shortName: z.string().max(11),
    shortDescription: z.string().max(80),
    longDescription: z.string().max(4000),
    keywords: z.string().max(100),
  })
  .partial();
export const brandedAppLinksBody = z.object({ iosLink: z.string().max(2000).optional(), androidLink: z.string().max(2000).optional() });
export const brandedAppOwnerTypeBody = z.object({ ownerType: z.enum(['organization', 'individual']) });
export const brandedAppAccessMethodBody = z.object({ method: z.enum(['portal_invite', 'password_shared']) });
export const brandedAppExtraLocationsBody = z.object({ extraLocations: z.number().int().min(0).max(1000) });
export const brandedAppDocKey = z.enum(['appleDeveloperAccess', 'googlePlayAccess', 'registrationDoc', 'trademarkDoc']);
export const brandedAppDocBody = z.object({ key: brandedAppDocKey, value: z.boolean() });
export const brandedAppSubmitBody = z.object({ name: z.string().min(1).max(160), phone: z.string().max(24).optional() });
export const brandedAppRequestOut = z
  .object({
    businessId: z.string(),
    stage: z.enum(['draft', 'submitted', 'in_development', 'published']),
    ownerType: z.enum(['organization', 'individual']).optional(),
    accessMethod: z.enum(['portal_invite', 'password_shared']).optional(),
    materials: z.record(z.string(), z.unknown()),
    docs: z.record(z.string(), z.boolean()),
    iosLink: z.string().optional(),
    androidLink: z.string().optional(),
    extraLocations: z.number(),
    submittedAt: z.string().optional(),
  })
  .catchall(z.unknown());
