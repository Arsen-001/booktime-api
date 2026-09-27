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
