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
  socials: z.record(z.string(), z.string().max(300).optional()),
});
export const galleryBody = z.object({ photos: z.array(z.string().max(4_000_000)).max(6) });
export const categoryBody = z.object({ name: z.string().max(80), colorIndex: z.number().int().min(1).max(8), icon: z.string().max(40).optional() });
export const changeLogQuery = z.object({ section: z.enum(['brand', 'contacts', 'gallery', 'legal', 'system', 'categories']).optional() });
export const onboardingBody = z.object({ goals: z.array(z.string().max(40)).max(20).optional(), tourSeen: z.boolean().optional() });
export const helpBody = z.object({ topic: z.enum(['billing', 'settings', 'staff', 'bug', 'other']), message: z.string().min(1).max(4000) });
export const sphereBody = z.object({ name: z.string().min(1).max(160), message: z.string().max(4000).optional() });
export const prefsBody = z.object({
  notificationPrefs: z.object({ news: z.boolean(), marketing: z.boolean(), system: z.boolean() }).optional(),
  startPage: z.enum(['journal', 'clients', 'analytics', 'settings']).nullable().optional(),
  startLocationId: z.string().max(32).nullable().optional(),
});
