import { z } from 'zod';
import { businessOut, localized, locationOut, staffOut } from '../businesses/business.schemas.js';
import { categoryOut, serviceOut } from '../services/services.schemas.js';

/** Схемы раздела «online» (docs/backend/02 §3, PLAN §6 №8): публичная страница, виджет, ссылки, правила. */

const id32 = z.string().min(1).max(32);
export const workplace = z.enum(['salon', 'home', 'visit', 'hall', 'online']);
export const bookingSource = z.enum(['link', 'widget']);
export const bookingDevice = z.enum(['mobile', 'desktop']);
export const codeChannel = z.enum(['telegram', 'whatsapp', 'sms']);

// ─────────────────────────── публичная страница (F-03-134) ───────────────────────────

export const publicBusinessOut = z.object({
  business: businessOut,
  location: locationOut.optional(),
  categories: z.array(categoryOut),
  services: z.array(serviceOut),
  staff: z.array(staffOut),
  link: z.record(z.string(), z.unknown()).optional(),
  regularsCount: z.number(),
  serviceConfigs: z.record(z.string(), z.unknown()),
  staffServiceOnline: z.record(z.string(), z.boolean()),
  linkStaffGone: z.boolean(),
  promoBlocks: z.array(z.unknown()),
  businessStars: z.number(),
  networkBranches: z.array(businessOut).optional(),
  packages: z.array(z.unknown()),
  hourCycle: z.enum(['24', '12']),
  addressHidden: z.boolean(),
});

// ─────────────────────────── окна виджета ───────────────────────────

export const freeSlotOut = z.object({ staffId: z.string(), locationId: z.string(), workplace: z.string(), start: z.string(), end: z.string(), extra: z.boolean().optional() });

export const monthAvailabilityOut = z.record(z.string(), z.boolean());

// ─────────────────────────── код перед записью (F-00-007, B2) ───────────────────────────

export const sendBookingCodeBody = z.object({ phone: z.string().min(8).max(24), channel: codeChannel.default('telegram'), locale: z.enum(['ru', 'hy', 'en']).optional() });
export const codeSentOut = z.object({ challengeId: z.string(), resendAfter: z.number(), expiresIn: z.number(), channel: codeChannel });

// ─────────────────────────── создание записи (F-03-091…098) ───────────────────────────

export const createOnlineBookingBody = z.object({
  businessId: id32,
  locationId: id32,
  staffId: id32,
  start: z.string(),
  services: z.array(z.object({ serviceId: id32 })).min(1),
  clientName: z.string().min(1).max(160),
  clientPhone: z.string().min(8).max(24),
  /** Код, отправленный `/code` на этот же номер (purpose=booking) — сервер проверяет его сам, а не поле ниже */
  code: z.string().regex(/^\d{4}$/, 'four_digits'),
  comment: z.string().max(2000).optional(),
  forWhom: z.enum(['self', 'child', 'pet', 'other']).optional(),
  linkId: id32.optional(),
  formId: z.string().max(20).optional(),
  source: bookingSource,
  device: bookingDevice,
  workplace: workplace.optional(),
  visitDistrict: z.string().max(40).optional(),
  visitAddress: z.string().max(300).optional(),
  reminderMinutesBefore: z.number().int().min(0).optional(),
  anySpecialist: z.boolean().optional(),
  email: z.string().max(160).optional(),
  lastName: z.string().max(120).optional(),
  patronymic: z.string().max(120).optional(),
  customFieldValues: z.record(z.string(), z.string()).optional(),
});

export const onlineBookingResultOut = z.object({ booking: z.record(z.string(), z.unknown()), client: z.record(z.string(), z.unknown()), accessHash: z.string() });

// ─────────────────────────── запись по хэшу без входа (B8, B19) ───────────────────────────

export const onlineBookingViewOut = z.object({
  booking: z.record(z.string(), z.unknown()),
  business: businessOut,
  location: locationOut.optional(),
  staff: staffOut.optional(),
  services: z.array(serviceOut),
  meta: z.record(z.string(), z.unknown()).optional(),
  hourCycle: z.enum(['24', '12']),
});

export const cancelWindowOut = z.object({ canCancelFree: z.boolean(), canReschedule: z.boolean(), cancelWindowHours: z.number(), rescheduleWindowHours: z.number() });

// ─────────────────────────── ссылки (F-03-003…037) ───────────────────────────

export const linkKind = z.enum(['normal', 'network']);
export const linkBookingType = z.enum(['individual', 'group', 'mixed']);

export const createLinkBody = z.object({
  locationId: id32.optional(),
  name: z.string().min(1).max(160),
  description: z.string().max(2000).optional(),
  kind: linkKind,
  bookingType: linkBookingType,
  defaultLocale: z.enum(['ru', 'hy', 'en']),
  staffId: id32.optional(),
  primary: z.boolean().optional(),
});
export type CreateLinkBody = z.infer<typeof createLinkBody>;

/** Остальные поля BookingLink фронта — правятся все вместе, как config (docs/backend PLAN §4.1: JSON на строке) */
export const updateLinkBody = z
  .object({
    locationId: id32.nullable(),
    name: z.string().min(1).max(160),
    description: z.string().max(2000).nullable(),
    defaultLocale: z.enum(['ru', 'hy', 'en']),
    staffId: id32.nullable(),
  })
  .catchall(z.unknown())
  .partial();
export type UpdateLinkBody = z.infer<typeof updateLinkBody>;

export const bookingLinkOut = z
  .object({
    id: z.string(),
    businessId: z.string(),
    locationId: z.string().optional(),
    networkId: z.string().optional(),
    name: z.string(),
    kind: linkKind,
    bookingType: linkBookingType,
    defaultLocale: z.string(),
    staffId: z.string().optional(),
    primary: z.boolean(),
    formId: z.string(),
    createdAt: z.string(),
    version: z.number(),
  })
  .catchall(z.unknown());

// ─────────────────────────── правила мастера для клиента (F-00-066) ───────────────────────────

export const staffClientRulesBody = z
  .object({
    rescheduleWindowHours: z.number().min(0).max(720),
    cancelWindowHours: z.number().min(0).max(720),
    allowReschedule: z.boolean(),
    allowCancel: z.boolean(),
    allowReschedulePrepaid: z.boolean(),
    allowCancelPrepaid: z.boolean(),
    keepPrepaymentOnLateCancel: z.boolean(),
    travelFee: z.number().min(0),
    travelTimeMin: z.number().min(0).max(240),
    vacationUntil: z.string().nullable(),
    allowAnyStaffAssignment: z.boolean(),
    depositPolicyKind: z.enum(['deposit', 'cardGuarantee']).nullable(),
    depositAmount: z.number().min(0),
    noShowPenalty: z.number().min(0),
    addClaimLinkToMessage: z.boolean(),
  })
  .partial();
export type StaffClientRulesBody = z.infer<typeof staffClientRulesBody>;

export const staffClientRulesOut = z.object({
  staffId: z.string(),
  rescheduleWindowHours: z.number(),
  cancelWindowHours: z.number(),
  allowReschedule: z.boolean(),
  allowCancel: z.boolean(),
  allowReschedulePrepaid: z.boolean(),
  allowCancelPrepaid: z.boolean(),
  keepPrepaymentOnLateCancel: z.boolean(),
  travelFee: z.number().optional(),
  travelTimeMin: z.number().optional(),
  vacationUntil: z.string().optional(),
  allowAnyStaffAssignment: z.boolean().optional(),
  depositPolicyKind: z.enum(['deposit', 'cardGuarantee']).optional(),
  depositAmount: z.number().optional(),
  noShowPenalty: z.number().optional(),
  addClaimLinkToMessage: z.boolean().optional(),
});

// ─────────────────────────── правила бизнеса (F-03-079, F-03-116, В-24) ───────────────────────────

export const businessOnlineRulesBody = z
  .object({
    consentText: localized,
    pauseUntil: z.string().nullable(),
    allowAnyStaffForAllLinks: z.boolean(),
    hourCycle: z.enum(['24', '12']),
    reviewMode: z.enum(['star', 'text']),
  })
  .partial();
export type BusinessOnlineRulesBody = z.infer<typeof businessOnlineRulesBody>;

export const businessOnlineRulesOut = z.object({
  businessId: z.string(),
  consentText: localized,
  pauseUntil: z.string().optional(),
  allowAnyStaffForAllLinks: z.boolean().optional(),
  hourCycle: z.enum(['24', '12']).optional(),
  reviewMode: z.enum(['star', 'text']).optional(),
});

// ─────────────────────────── источник записи для кабинета (F-03-123) ───────────────────────────

export const onlineMetaOut = z.object({ bookingId: z.string(), source: z.string() }).catchall(z.unknown());
