import { z } from 'zod';
import { ESTIMATE_STATUSES, ORDER_HISTORY_EVENTS, ORDER_STATUSES } from './order-rules.js';

const id32 = z.string().min(1).max(32);
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const amd = z.number().int().min(0).max(1_000_000_000);

export const orderItemSchema = z.object({
  title: z.string().trim().min(1).max(200),
  qty: z.number().int().min(1).max(10_000),
  note: z.string().max(500).optional(),
});

/** Фото — адреса или data URI, как Business.photos / Staff.photos (своей загрузки файлов у кабинета нет) */
const photos = z.array(z.string().min(1).max(4_000_000)).max(10);

export const createOrderBody = z.object({
  clientName: z.string().trim().min(1).max(160),
  clientPhone: z.string().min(1).max(40),
  clientId: id32.optional(),
  items: z.array(orderItemSchema).min(1).max(50),
  photos: photos.optional(),
  staffId: id32.nullable().optional(),
  dueDate: ymd.nullable().optional(),
  price: amd,
  prepaid: amd.optional(),
  comment: z.string().max(2000).nullable().optional(),
  locationId: id32.nullable().optional(),
});
export type CreateOrderBody = z.infer<typeof createOrderBody>;

/** Правка: любые поля создания (статус — только через /status) */
export const patchOrderBody = z.object({
  clientName: z.string().trim().min(1).max(160).optional(),
  clientPhone: z.string().min(1).max(40).optional(),
  clientId: id32.nullable().optional(),
  items: z.array(orderItemSchema).min(1).max(50).optional(),
  photos: photos.optional(),
  staffId: id32.nullable().optional(),
  dueDate: ymd.nullable().optional(),
  price: amd.optional(),
  prepaid: amd.optional(),
  comment: z.string().max(2000).nullable().optional(),
  locationId: id32.nullable().optional(),
});
export type PatchOrderBody = z.infer<typeof patchOrderBody>;

export const orderStatusBody = z.object({ status: z.enum(ORDER_STATUSES) });

// ─────────── ⭐ смета (05.10.2026) ───────────

export const estimateLineSchema = z.object({
  title: z.string().trim().min(1).max(200),
  price: amd,
});

/** Отправить смету клиенту: строки работ/запчастей с ценами или одна сумма (total) + комментарий */
export const sendEstimateBody = z
  .object({
    lines: z.array(estimateLineSchema).max(30).default([]),
    total: amd.optional(),
    comment: z.string().trim().max(1000).nullable().optional(),
  })
  .refine((b) => b.lines.length > 0 || b.total !== undefined, { message: 'lines or total required', path: ['total'] });
export type SendEstimateBody = z.infer<typeof sendEstimateBody>;

/** Сотрудник отмечает ответ клиента, полученный по телефону */
export const staffEstimateDecisionBody = z.object({
  decision: z.enum(['approve', 'decline']),
  comment: z.string().trim().max(500).nullable().optional(),
});

/** Клиент по ссылке /o/<code>: version — смета, которую он видел (устарела — 409 estimate_changed) */
export const publicEstimateDecisionBody = z.object({
  decision: z.enum(['approve', 'decline']),
  version: z.number().int().min(1).max(10_000),
  comment: z.string().trim().max(500).nullable().optional(),
});

export const listOrdersQuery = z.object({
  status: z.enum([...ORDER_STATUSES, 'active', 'all']).default('all'),
  q: z.string().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListOrdersQuery = z.infer<typeof listOrdersQuery>;

// ─────────── ответы (OpenAPI) ───────────

const historyEntryOut = z.object({
  at: z.string(),
  status: z.enum(ORDER_STATUSES),
  by: z.string().nullable(),
  event: z.enum(ORDER_HISTORY_EVENTS).optional(),
  amount: z.number().int().optional(),
  note: z.string().optional(),
});

const estimateOut = z.object({
  status: z.enum(ESTIMATE_STATUSES),
  version: z.number().int(),
  lines: z.array(z.object({ title: z.string(), price: z.number().int() })),
  total: z.number().int(),
  comment: z.string().nullable(),
  sentAt: z.string().nullable(),
  remindedAt: z.string().nullable(),
  decidedAt: z.string().nullable(),
  decidedBy: z.enum(['client', 'staff']).nullable(),
  clientComment: z.string().nullable(),
});

export const orderOut = z.object({
  id: z.string(),
  businessId: z.string(),
  locationId: z.string().nullable(),
  number: z.number().int(),
  code: z.string(),
  clientId: z.string().nullable(),
  clientName: z.string(),
  clientPhone: z.string(),
  items: z.array(orderItemSchema),
  photos: z.array(z.string()),
  staffId: z.string().nullable(),
  status: z.enum(ORDER_STATUSES),
  dueDate: z.string().nullable(),
  price: z.number().int(),
  prepaid: z.number().int(),
  comment: z.string().nullable(),
  history: z.array(historyEntryOut),
  readyNotifiedAt: z.string().nullable(),
  issuedAt: z.string().nullable(),
  /** «Заказ ждёт вас» (04.10.2026): сколько авто-напоминаний ушло за текущий «Готов» и когда последнее */
  pickupReminderCount: z.number().int(),
  pickupRemindedAt: z.string().nullable(),
  /** ⭐ Смета (05.10.2026); null — не отправляли */
  estimate: estimateOut.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const orderListOut = z.object({ items: z.array(orderOut), total: z.number().int() });

export const publicOrderOut = z.object({
  number: z.number().int(),
  status: z.enum(ORDER_STATUSES),
  items: z.array(z.object({ title: z.string(), qty: z.number().int() })),
  dueDate: z.string().nullable(),
  readyAt: z.string().nullable(),
  price: z.number().int(),
  prepaid: z.number().int(),
  estimate: estimateOut.omit({ remindedAt: true, decidedBy: true }).nullable(),
  business: z.object({ name: z.string(), phone: z.string(), address: z.string(), slug: z.string() }),
});
