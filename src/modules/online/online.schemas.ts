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
  /** Раздел «Заказы» включён (мастерская: принимает вещи без записи по времени) */
  ordersEnabled: z.boolean(),
});

// ─────────────────────────── окна виджета ───────────────────────────

export const freeSlotOut = z.object({ staffId: z.string(), locationId: z.string(), workplace: z.string(), start: z.string(), end: z.string(), extra: z.boolean().optional() });

export const monthAvailabilityOut = z.record(z.string(), z.boolean());

// ─────────────────────────── код перед записью (F-00-007, B2) ───────────────────────────

export const sendBookingCodeBody = z.object({ phone: z.string().min(8).max(24), channel: codeChannel.default('telegram'), locale: z.enum(['ru', 'hy', 'en']).optional() });
export const codeSentOut = z.object({ challengeId: z.string(), resendAfter: z.number(), expiresIn: z.number(), channel: codeChannel, channels: z.array(codeChannel) });

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
  /** ⭐ «Оплатить всё сразу» вместо процента предоплаты мастера */
  payInFull: z.boolean().optional(),
  /** ⭐ Допродажа при записи: сопутствующие услуги и товары из карточки услуги (проверяет сервер) */
  addOns: z.object({ serviceIds: z.array(id32).max(12).optional(), productIds: z.array(id32).max(12).optional() }).optional(),
  /** «Пригласи подругу»: код из личной ссылки салона (привязку проверяет place()) */
  referralCode: z.string().max(16).optional(),
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
  /** ⭐ Допродажа: товары визита к оплате на месте */
  goods: z.array(z.object({ name: z.record(z.string(), z.string()), price: z.number(), qty: z.number() })).optional(),
});

export const cancelWindowOut = z.object({
  canCancelFree: z.boolean(),
  canReschedule: z.boolean(),
  cancelWindowHours: z.number(),
  rescheduleWindowHours: z.number(),
  prepaidAmount: z.number(),
  keepPrepaymentOnLateCancel: z.boolean(),
  allowCancelPrepaid: z.boolean(),
  canCancel: z.boolean(),
});

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

/** ID пикселя Meta — только цифры (Events Manager даёт 15–16; берём с запасом) */
export const META_PIXEL_ID_RE = /^\d{8,20}$/;
/** ID потока GA4 — G- и 6–12 латинских букв/цифр (как вводят из «Сведений о потоке») */
export const GA4_STREAM_ID_RE = /^G-[A-Z0-9]{6,12}$/;

/** Остальные поля BookingLink фронта — правятся все вместе, как config (docs/backend PLAN §4.1: JSON на строке) */
export const updateLinkBody = z
  .object({
    locationId: id32.nullable(),
    name: z.string().min(1).max(160),
    description: z.string().max(2000).nullable(),
    defaultLocale: z.enum(['ru', 'hy', 'en']),
    staffId: id32.nullable(),
    // Счётчики салона на его публичной странице (F-03-118/119): пусто или null — убрать. Скрипты грузит браузер
    // посетителя только после его согласия, поэтому мусор здесь недопустим — он попал бы в адрес скрипта
    metaPixelId: z.union([z.literal(''), z.string().trim().regex(META_PIXEL_ID_RE, 'invalid')]).nullable(),
    ga4StreamId: z.union([z.literal(''), z.string().trim().toUpperCase().regex(GA4_STREAM_ID_RE, 'invalid')]).nullable(),
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

// ─────────────────────────── стадия 21 (лейн client+online): кабинет заявок и настроек ───────────────────────────

export const customClientFieldBody = z.object({
  label: z.string().min(1).max(120),
  type: z.enum(['text', 'number', 'date', 'select']),
  target: z.enum(['client', 'booking']),
  required: z.boolean(),
  options: z.array(z.string()).optional(),
});
export type CustomClientFieldBody = z.infer<typeof customClientFieldBody>;

export const customClientFieldOut = customClientFieldBody.extend({ id: z.string(), order: z.number() });

export const clientFieldsConfigOut = z.object({
  businessId: z.string(),
  commentHidden: z.boolean(),
  commentRequired: z.boolean(),
  commentLabel: z.string(),
  emailHidden: z.boolean(),
  emailRequired: z.boolean(),
  lastNameEnabled: z.boolean(),
  lastNameRequired: z.boolean(),
  patronymicEnabled: z.boolean(),
  patronymicRequired: z.boolean(),
  customFields: z.array(customClientFieldOut),
  widgetText: localized,
  partnerBrands: z.array(z.string()),
});

export const clientFieldsConfigBody = z
  .object({
    commentHidden: z.boolean(),
    commentRequired: z.boolean(),
    commentLabel: z.string().max(60),
    emailHidden: z.boolean(),
    emailRequired: z.boolean(),
    lastNameEnabled: z.boolean(),
    lastNameRequired: z.boolean(),
    patronymicEnabled: z.boolean(),
    patronymicRequired: z.boolean(),
    widgetText: localized,
    partnerBrands: z.array(z.string()),
  })
  .partial();
export type ClientFieldsConfigBody = z.infer<typeof clientFieldsConfigBody>;

export const moveFieldBody = z.object({ direction: z.union([z.literal(-1), z.literal(1)]) });

export const listabilityOut = z.array(
  z.object({ staff: staffOut, check: z.object({ listable: z.boolean(), missing: z.array(z.enum(['services', 'photo', 'schedule'])) }) }),
);

export const onlineRequestOut = z
  .object({
    bookingId: z.string(),
    staffId: z.string(),
    clientId: z.string().optional(),
    clientName: z.string(),
    clientPhone: z.string(),
    clientNoShowCount: z.number(),
    clientBlocked: z.boolean(),
    start: z.string(),
    durationMin: z.number(),
    serviceNames: z.array(z.string()),
    workplace: z.string(),
    district: z.string().optional(),
    address: z.string().optional(),
    submittedAt: z.string().optional(),
    clientVisits: z.number(),
    comment: z.string().optional(),
  })
  .catchall(z.unknown());

export const respondBody = z.object({ action: z.enum(['confirm', 'decline']) });

export const offerTimesBody = z.object({ starts: z.array(z.string()).min(1) });

export const statusLogOut = z.array(z.object({ status: z.string(), at: z.string(), by: z.enum(['client', 'staff']) }));

export const placesDataOut = z.object({ staff: staffOut, location: locationOut.optional(), rules: z.record(z.string(), z.unknown()) });

// ─────────────────────────── стадия 21 (лейн client+online), попытка 2 ───────────────────────────

export const serviceOnlineConfigOut = z.object({ serviceId: z.string() }).catchall(z.unknown());
export const serviceOnlineConfigBody = z
  .object({ onlineName: localized, description: localized, imageUrl: z.string(), availability: z.unknown(), subscriptionOnly: z.boolean(), subscriptionPlanName: z.string() })
  .partial();

export const onlinePackageOut = z.object({ id: z.string(), businessId: z.string(), createdAt: z.string() }).catchall(z.unknown());
export const createOnlinePackageBody = z.object({ name: z.string().min(1).max(160), serviceIds: z.array(id32).min(2).max(10), mode: z.enum(['simultaneous', 'sequentialSame', 'sequentialMulti']) });
export const updateOnlinePackageBody = z.object({ name: localized, online: z.boolean(), onlineName: localized, description: localized, imageUrl: z.string(), availability: z.unknown(), serviceIds: z.array(id32).min(2).max(10), mode: z.enum(['simultaneous', 'sequentialSame', 'sequentialMulti']) }).partial();

export const staffServiceFlagsOut = z.record(z.string(), z.boolean());
export const setStaffServiceOnlineBody = z.object({ staffId: id32, serviceId: id32, online: z.boolean() });

export const promoBlockOut = z.object({ id: z.string(), businessId: z.string(), createdAt: z.string(), status: z.enum(['pending', 'approved', 'rejected']), enabled: z.boolean() }).catchall(z.unknown());
export const createPromoBlockBody = z.object({
  title: z.string().min(1).max(50),
  description: z.string().max(220).optional(),
  imageUrl: z.string().optional(),
  buttonText: z.string().max(20).optional(),
  buttonLink: z.string().optional(),
  screens: z.array(z.enum(['menu', 'service', 'staff', 'success'])).min(1),
});
export const updatePromoBlockBody = createPromoBlockBody.partial().extend({ enabled: z.boolean() }).partial();

export const reviewOut = z.object({ id: z.string(), businessId: z.string(), createdAt: z.string(), target: z.enum(['business', 'staff']), targetId: z.string(), bookingId: z.string(), clientId: z.string() });
export const addReviewBody = z.object({ target: z.enum(['business', 'staff']), targetId: id32, clientId: id32 });
/** ⭐ О28: окно из предложенных (onlineMeta.offeredStarts) — местное время YYYY-MM-DDTHH:mm */
export const alternativeTimeBody = z.object({ start: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/) });

export const trackWidgetEventBody = z.object({ linkId: id32.optional(), businessId: id32, type: z.string().min(1).max(60) });
export const widgetEventOut = z.object({ id: z.string(), linkId: z.string(), businessId: z.string(), type: z.string(), at: z.string() });

export const groupBookingRulesOut = z.object({ linkId: z.string(), allowExtraSeats: z.boolean(), maxSeatsPerBooking: z.number(), allowMultiEvent: z.boolean(), maxEventsPerBooking: z.number() });
export const groupBookingRulesBody = z.object({ allowExtraSeats: z.boolean(), maxSeatsPerBooking: z.number().int().min(1).max(50), allowMultiEvent: z.boolean(), maxEventsPerBooking: z.number().int().min(1).max(10) }).partial();

export const publicGroupEventOut = z.object({ event: z.record(z.string(), z.unknown()), service: serviceOut.optional(), staff: staffOut.optional(), seatsTaken: z.number(), seatsLeft: z.number() });
export const createGroupOnlineBookingBody = z.object({
  locationId: id32,
  groupEventId: id32,
  seats: z.number().int().min(1).max(50),
  clientName: z.string().min(1).max(160),
  clientPhone: z.string().min(8).max(24),
  comment: z.string().max(2000).optional(),
  linkId: id32.optional(),
  formId: z.string().max(20).optional(),
  source: bookingSource,
  device: bookingDevice,
  phoneVerified: z.boolean(),
  payByMembership: z.boolean().optional(),
});

export const mobileAppLinksOut = z.object({ businessId: z.string(), iosUrl: z.string().optional(), androidUrl: z.string().optional(), consultRequestedAt: z.string().optional() });
export const mobileAppLinksBody = z.object({ iosUrl: z.string().nullable(), androidUrl: z.string().nullable(), consultRequestedAt: z.string().nullable() }).partial();

export const integrationConnectionOut = z.object({ id: z.string(), connected: z.boolean(), connectedAt: z.string().optional() });
export const setIntegrationConnectedBody = z.object({ connected: z.boolean() });

export const apiCredentialsOut = z.object({ businessId: z.string(), apiKey: z.string().optional(), createdAt: z.string().optional() });

export const slotCandidateOut = z.object({ slotStart: z.string(), staffId: z.string(), clientId: z.string(), clientName: z.string(), clientPhone: z.string(), reason: z.enum(['regular', 'dueAgain']), serviceId: z.string().optional() });
export const inviteToSlotBody = z.object({ candidate: slotCandidateOut, message: z.string().min(1).max(2000) });
export const slotInviteOut = z.object({ id: z.string(), businessId: z.string(), staffId: z.string(), clientId: z.string(), clientName: z.string(), slotStart: z.string(), serviceId: z.string().optional(), message: z.string(), sentAt: z.string() });

export const joinWaitlistBody = z.object({ locationId: id32.optional(), staffId: id32, serviceId: id32, date: z.string(), clientName: z.string().min(1).max(160), clientPhone: z.string().min(8).max(24), comment: z.string().max(2000).optional() });
export const waitlistRequestOut = z.object({ id: z.string(), businessId: z.string(), locationId: z.string().optional(), staffId: z.string(), serviceId: z.string(), date: z.string(), clientName: z.string(), clientPhone: z.string(), comment: z.string().optional(), status: z.enum(['pending', 'notified', 'booked', 'cancelled']), createdAt: z.string() });

export const cabinetDataOut = z.object({
  client: z.record(z.string(), z.unknown()),
  upcoming: z.array(z.record(z.string(), z.unknown())),
  past: z.array(z.record(z.string(), z.unknown())),
  services: z.record(z.string(), z.unknown()),
  staffNames: z.record(z.string(), z.string()),
  loyalty: z.object({ certificates: z.array(z.unknown()), subscriptions: z.array(z.unknown()) }),
  accessHashes: z.record(z.string(), z.string()),
});
