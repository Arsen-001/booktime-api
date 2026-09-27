import { z } from 'zod';
import { localized } from '../businesses/business.schemas.js';

/** Схемы zod раздела «platform» (docs/backend/06 §1, 02 §19) — тела запросов и валидация входа. */

// ─────────────────────────── Модерация (F-00-168…171, F-00-179) ───────────────────────────

export const MODERATION_KINDS = ['staffPhoto', 'salonPhoto', 'servicePhoto', 'service', 'text', 'diploma', 'story', 'complaint', 'review'] as const;
export const MODERATION_SOURCES = ['user', 'visit', 'template', 'reuse'] as const;
export const MODERATION_STATUSES = ['pending', 'approved', 'rejected', 'auto'] as const;

export const moderationSubmitBody = z.object({
  kind: z.enum(MODERATION_KINDS),
  refId: z.string().min(1).max(64),
  staffId: z.string().max(32).optional(),
  serviceId: z.string().max(32).optional(),
  label: z.string().max(200).optional(),
  text: z.string().max(4000).optional(),
  imageUrl: z.string().max(4_000_000).optional(),
  paidCoins: z.number().int().positive().optional(),
  source: z.enum(MODERATION_SOURCES).optional(),
  targetItemId: z.string().max(32).optional(),
});

export const moderationListQuery = z.object({
  status: z.enum(MODERATION_STATUSES).optional(),
  kind: z.enum(MODERATION_KINDS).optional(),
});

export const rejectBody = z.object({ reasonId: z.string().min(1).max(32), note: z.string().max(300).optional() });

export const rejectReasonBody = z.object({
  id: z.string().max(32).optional(),
  label: localized,
  active: z.boolean().optional(),
  order: z.number().int().optional(),
});

// ─────────────────────────── Бизнесы (F-00-183, F-00-164) ───────────────────────────

export const adsOptInBody = z.object({ optIn: z.boolean() });
export const markLeftBody = z.object({ dataHanded: z.boolean() });
export const exportQuery = z.object({ what: z.enum(['clients', 'bookings']) });
/** Заголовки CSV — экран уже перевёл их (Р12: сервер UI-текст не переводит) */
export const exportBody = z.object({ headers: z.array(z.string().max(80)).min(1).max(20) });

// ─────────────────────────── Поддержка (F-00-182) ───────────────────────────

export const SUPPORT_CHANNELS = ['app', 'cabinet', 'phone', 'whatsapp', 'telegram', 'email'] as const;
export const SUPPORT_TOPICS = ['help', 'newSphere', 'banner', 'ads', 'billing', 'bug', 'other'] as const;
export const SUPPORT_SECTIONS = ['journal', 'schedule', 'clients', 'online', 'services', 'staff', 'stock', 'finance', 'billing', 'coins', 'settings', 'clientApp'] as const;

export const supportListQuery = z.object({ status: z.enum(['open', 'waiting', 'closed', 'active']).optional(), channel: z.enum(SUPPORT_CHANNELS).optional() });
export const supportReplyBody = z.object({ text: z.string().min(1).max(4000) });

// ─────────────────────────── Идеи (F-00-009) ───────────────────────────

export const ideaCreateBody = z.object({ text: z.string().min(1).max(2000) });
export const ideaStatusBody = z.object({ status: z.enum(['considering', 'inProgress', 'done']) });

// ─────────────────────────── Заявки на сферы (F-00-151/152) ───────────────────────────

export const sphereCreateBody = z.object({
  kind: z.enum(['noSphere', 'newSphere']).default('newSphere'),
  businessId: z.string().max(32).optional(),
  masterName: z.string().min(1).max(160),
  phone: z.string().min(6).max(20),
  sphereName: z.string().min(1).max(160),
  needs: z.array(z.string().max(200)).max(50).optional(),
  note: z.string().max(500).optional(),
});

export const sphereListQuery = z.object({ kind: z.enum(['noSphere', 'newSphere']).optional() });

export const sphereSaveBody = z.object({
  status: z.enum(['open', 'agreed', 'inProgress', 'done']).optional(),
  needs: z.array(z.string().max(200)).max(50).optional(),
  readyAt: z.string().max(10).optional(),
  note: z.string().max(500).optional(),
});

// ─────────────────────────── Визиты (F-00-177) ───────────────────────────

export const VISIT_STATUSES = ['connected', 'thinking', 'refused'] as const;
export const VISIT_TOOLS = ['dikidi', 'altegio', 'whatsapp', 'notebook', 'other', 'nothing'] as const;

export const visitInputBody = z.object({
  placeName: z.string().min(1).max(160),
  contactName: z.string().max(160).optional(),
  phone: z.string().max(20).optional(),
  district: z.string().max(40).optional(),
  address: z.string().max(300).optional(),
  sphereId: z.string().max(40).optional(),
  status: z.enum(VISIT_STATUSES),
  visitedAt: z.string().length(10),
  callbackDate: z.string().length(10).optional(),
  refusalReason: z.string().max(300).optional(),
  note: z.string().max(2000).optional(),
  currentTool: z.enum(VISIT_TOOLS).optional(),
  willingToPay: z.number().int().nonnegative().optional(),
  responsibleId: z.string().min(1).max(32),
});

export const visitPatchBody = visitInputBody.partial();
export const callbackDateBody = z.object({ callbackDate: z.string().length(10) });
export const visitConnectBody = z.object({ businessId: z.string().min(1).max(32) });

// ─────────────────────────── Копии (F-00-183) ───────────────────────────

export const backupCountsShape = z.object({ clients: z.number().int(), bookings: z.number().int(), services: z.number().int(), staff: z.number().int() });
