import { z } from 'zod';

/** Схемы раздела «client» (docs/backend/02 §2, PLAN §6 №9): каталог, карточки, мои записи, лист ожидания, избранное… */

const id32 = z.string().min(1).max(32);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'YYYY-MM-DDTHH:mm');

// ─────────────────────────── публичное ───────────────────────────

export const demandBody = z.object({
  query: z.string().min(1).max(200),
  sphereId: z.string().max(20).optional(),
  district: z.string().max(20).optional(),
  phone: z.string().max(24).optional(),
  // «Сообщить, когда появится» (F-00-180, этап 19 продолжение — поле не хватало при первой постройке демо)
  notify: z.boolean().optional(),
});

export const callbackBody = z.object({
  staffId: id32,
  phone: z.string().min(8).max(24),
  name: z.string().max(160).optional(),
});

// ─────────────────────────── мои записи (F-00-031, F-14-011) ───────────────────────────

export const createMyBookingBody = z.object({
  staffId: id32,
  serviceId: id32,
  start: localDateTime,
  locationId: id32.optional(),
  workplace: z.enum(['salon', 'home', 'visit', 'hall', 'online']).optional(),
  visitAddress: z.string().max(400).optional(),
  forWhom: z.enum(['self', 'child', 'pet', 'other']).optional(),
  visitorName: z.string().max(160).optional(),
  seats: z.number().int().min(1).max(20).optional(),
  groupEventId: id32.optional(),
  comment: z.string().max(2000).optional(),
});

// ─────────────────────────── лист ожидания «от себя» (F-00-101/102) ───────────────────────────

export const myWaitlistBody = z.object({
  staffId: id32,
  serviceId: id32,
  date: z.union([isoDate, z.literal('any')]),
});

// ─────────────────────────── избранное (F-00-113/115) ───────────────────────────

export const favoriteTargetType = z.enum(['staff', 'business']);
export const favoriteBody = z.object({ targetType: favoriteTargetType, targetId: id32 });
export const favoriteMuteBody = z.object({ muted: z.boolean() });

// ─────────────────────────── ★ звёздочка (F-00-116) ───────────────────────────

export const rateStaffBody = z.object({ bookingId: id32 });

// ─────────────────────────── дневник (F-00-122) ───────────────────────────

export const diaryEntryBody = z.object({
  serviceName: z.string().min(1).max(200),
  masterName: z.string().min(1).max(160),
  date: isoDate,
  amount: z.number().int().min(0),
});

// ─────────────────────────── обращение к нам (F-00-182) ───────────────────────────

export const supportBody = z.object({
  subject: z.string().min(1).max(200),
  message: z.string().min(1).max(4000),
  phone: z.string().max(24).optional(),
});

// ─────────────────────────── лояльность (В-17, этап 11) ───────────────────────────

export const buyRequestBody = z.object({ businessId: id32, typeId: id32 });

// ─────────────────────────── отзывы (В-24, F-14-013/014) — этап 21, лейн client ───────────────────────────

export const staffReviewBody = z.object({
  businessId: id32,
  bookingId: id32,
  rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
  text: z.string().max(2000).optional(),
});

export const locationReviewBody = z.object({
  businessId: id32,
  text: z.string().min(1).max(2000),
});

// ─────────────────────────── «Приложение» кабинета (F-14-116…129) — этап 21, лейн client+online, попытка 2 ───────────────────────────

/** EmployeeAppAccess фронта (client.ts) — все поля частичные (PATCH сверху текущего/дефолта) */
const staffPushType = z.enum(['bookings', 'calls', 'reviews', 'payroll', 'news']);
export const employeeAppAccessBody = z.object({
  onlyOwnBookings: z.boolean().optional(),
  hideClientContacts: z.boolean().optional(),
  analyticsAllowed: z.boolean().optional(),
  pushEnabledByOwner: z.boolean().optional(),
  pushTypesAllowed: z.array(staffPushType).optional(),
  pushTypesOn: z.array(staffPushType).optional(),
  hideClientDataInPush: z.boolean().optional(),
  payrollAccess: z.enum(['self', 'all', 'none']).optional(),
  payrollCurrentDayOnly: z.boolean().optional(),
  twoStepLoginEnabled: z.boolean().optional(),
});

export const payoutBody = z.object({ amount: z.number().min(1) });

// ─────────────────────────── автоперевод (F-00-174) — этап 21, лейн client+online, попытка 2 ───────────────────────────

export const translationOwner = z.enum(['staff', 'business', 'service']);
export const translationOverrideBody = z.object({ owner: translationOwner, ownerId: id32, field: z.string().min(1).max(40), text: z.string().max(4000) });
