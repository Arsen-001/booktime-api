import { z } from 'zod';
import { localized } from '../businesses/business.schemas.js';

/** Схемы zod раздела «platform» (docs/backend/06 §1, 02 §19) — тела запросов и валидация входа. */

// ─────────────────────────── Модерация (F-00-168…171, F-00-179) ───────────────────────────

export const MODERATION_KINDS = ['staffPhoto', 'salonPhoto', 'servicePhoto', 'service', 'text', 'diploma', 'story', 'complaint', 'review'] as const;
export const MODERATION_SOURCES = ['user', 'visit', 'template', 'reuse'] as const;
export const MODERATION_STATUSES = ['pending', 'approved', 'rejected', 'auto'] as const;

export const moderationSubmitBody = z.object({
  kind: z.enum(MODERATION_KINDS),
  // Ключ вызывающей стороны, НЕ сама картинка (см. комментарий поля в schema.prisma) — колонка VARCHAR(64).
  // Фасад обязан прислать короткий стабильный ключ (id/хеш), не data: URL целиком (этап 21, лейн rest: было
  // найдено, что settings.ts::submitMediaForReview слал сам url — чинили в settings.ts, не здесь).
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

/** Решение по нескольким материалам сразу (выбор галочками в очереди, этап 21 лейн rest — панель раньше звала одиночные параллельно) */
export const moderationBulkIdsBody = z.object({ ids: z.array(z.string().min(1).max(32)).min(1).max(200) });
export const moderationBulkRejectBody = z.object({
  ids: z.array(z.string().min(1).max(32)).min(1).max(200),
  reasonId: z.string().min(1).max(32),
  note: z.string().max(300).optional(),
});

/** Статус/видимость по refId — тот же refId, что и в submit (может быть длинным data: URL), поэтому телом, не путём */
export const moderationRefIdBody = z.object({ refId: z.string().min(1).max(4_000_000) });

export const rejectReasonBody = z.object({
  id: z.string().max(32).optional(),
  label: localized,
  active: z.boolean().optional(),
  order: z.number().int().optional(),
});

// ─────────────────────────── Бизнесы (F-00-183, F-00-164) ───────────────────────────

export const adsOptInBody = z.object({ optIn: z.boolean() });
export const markLeftBody = z.object({ dataHanded: z.boolean() });
export const blockBody = z.object({ blocked: z.boolean() });
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

export const visitListQuery = z.object({ status: z.enum(VISIT_STATUSES).optional(), district: z.string().max(40).optional() });

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
export const completeCallbackBody = z.object({ note: z.string().max(2000).optional() });

// ─────────────────────────── Копии (F-00-183) ───────────────────────────

export const backupCountsShape = z.object({ clients: z.number().int(), bookings: z.number().int(), services: z.number().int(), staff: z.number().int() });

// ─────────────────────────── Спрос и «первый» (F-00-180, F-00-181) ───────────────────────────

export const demandQuery = z.object({ period: z.enum(['week', 'prevWeek', 'month']).default('week') });

export const firstAwardBody = z.object({
  businessId: z.string().min(1).max(32),
  scope: z.enum(['sphere', 'district']),
  sphereId: z.string().min(1).max(20),
  district: z.string().max(20).optional(),
  freeDays: z.number().int().min(0).max(366),
  coins: z.number().int().min(0).max(1_000_000),
});

// ─────────────────────────── Реклама (F-00-163…166) ───────────────────────────

export const AD_KINDS = ['banner', 'supplier'] as const;
export const AD_SIZES = ['any', 'individual', 'salonSmall', 'salonLarge'] as const;

export const adTargetShape = z.object({
  sphereIds: z.array(z.string().max(20)).max(30).default([]),
  districts: z.array(z.string().max(20)).max(30).default([]),
  size: z.enum(AD_SIZES).default('any'),
  minStars: z.number().min(0).max(5).optional(),
});

export const adInputBody = z.object({
  kind: z.enum(AD_KINDS),
  title: z.string().min(1).max(200),
  text: z.string().max(2000).optional(),
  imageUrl: z.string().max(4_000_000).optional(),
  ctaUrl: z.string().max(1000).optional(),
  advertiser: z.object({ name: z.string().min(1).max(160), contact: z.string().min(1).max(160) }),
  placementId: z.string().min(1).max(20),
  target: adTargetShape,
  productKeywords: z.array(z.string().max(60)).max(30).default([]),
  startDate: z.string().length(10),
  endDate: z.string().length(10),
  price: z.number().int().nonnegative(),
  paused: z.boolean().optional(),
  supportTicketId: z.string().max(32).optional(),
});

export const adListQuery = z.object({ kind: z.enum(AD_KINDS).optional() });
export const adPauseBody = z.object({ paused: z.boolean() });

export const adContextQuery = z.object({
  placement: z.string().min(1).max(20),
  date: z.string().length(10).optional(),
  businessId: z.string().max(32).optional(),
  district: z.string().max(20).optional(),
  sphere: z.string().max(20).optional(),
});

export const stockOfferQuery = z.object({ businessId: z.string().min(1).max(32), product: z.string().min(1).max(200) });

// ─────────────────────────── Сторис (F-00-159…162) ───────────────────────────

export const storyConfigBody = z.object({
  places: z.union([z.literal(5), z.literal(6), z.literal(10)]),
  scope: z.enum(['district', 'city']),
  pricePerDay: z.number().int().nonnegative(),
  lastPlacesCount: z.number().int().nonnegative(),
  lastPlacesMarkup: z.number().int().nonnegative(),
  queueMarkup: z.number().int().nonnegative(),
  daysAhead: z.number().int().positive().max(60),
});

export const storyBoardQuery = z.object({ days: z.coerce.number().int().positive().max(60).default(10), district: z.string().max(20).optional() });
export const storyPlacesQuery = z.object({ date: z.string().length(10), district: z.string().max(20).optional() });

// ─────────────────────────── Заметки основателя (01 §8, F-00-203…208) ───────────────────────────

export const waveItemStatus = z.enum(['todo', 'building', 'passed']);
export const waveItemShape = z.object({ id: z.string().min(1).max(32), wave: z.union([z.literal(1), z.literal(2), z.literal(3)]), fids: z.array(z.string().max(20)).max(200), title: localized, status: waveItemStatus, note: z.string().max(2000).optional() });

export const prelaunchStatus = z.enum(['open', 'decided', 'done']);
export const prelaunchItemShape = z.object({
  id: z.string().min(1).max(32),
  order: z.number().int(),
  title: localized,
  hint: localized,
  status: prelaunchStatus,
  decision: z.string().max(2000).default(''),
  note: z.string().max(2000).default(''),
  updatedAt: z.string().max(20).optional(),
});

export const paybackInputsShape = z.object({
  monthlyCosts: z.number().nonnegative(),
  individualPrice: z.number().nonnegative(),
  salonPerMaster: z.number().nonnegative(),
  avgMasters: z.number().nonnegative(),
  discountShare: z.number().min(0).max(100),
  discountPercent: z.number().min(0).max(100),
  targetNet: z.number().nonnegative(),
  usdRate: z.number().nonnegative(),
  eurRate: z.number().nonnegative(),
});

export const nameCandidateShape = z.object({
  id: z.string().min(1).max(32),
  name: z.string().min(1).max(80),
  spelling: z.object({ ru: z.string().max(80), hy: z.string().max(80), en: z.string().max(80) }),
  checks: z.object({ ru: z.enum(['unknown', 'ok', 'bad']), hy: z.enum(['unknown', 'ok', 'bad']), en: z.enum(['unknown', 'ok', 'bad']) }),
  domain: z.string().max(120),
  domainStatus: z.enum(['unknown', 'free', 'taken', 'bought']),
  note: z.string().max(500).default(''),
});

export const brandStateShape = z.object({ chosenId: z.string().max(32).optional(), decidedAt: z.string().max(30).optional() });

export const platformNotesBody = z.object({
  waveItems: z.array(waveItemShape).max(200).optional(),
  prelaunchItems: z.array(prelaunchItemShape).max(200).optional(),
  paybackInputs: paybackInputsShape.optional(),
  nameCandidates: z.array(nameCandidateShape).max(200).optional(),
  brand: brandStateShape.optional(),
});

// ─────────────────────────── Подключение салона за 10 минут (F-00-176, F-00-171, F-00-052) ───────────────────────────

const connectTimeRange = z.object({ from: z.string().regex(/^([01]\d|2[0-4]):[0-5]\d$/), to: z.string().regex(/^([01]\d|2[0-4]):[0-5]\d$/) });
/** WeekTemplate — ключи '0'…'6' (0 = пн); дни вне 0..6 отбрасываются сервисом, не схемой (внутренний инструмент) */
export const connectWeekShape = z.record(z.string(), z.array(connectTimeRange).max(12));

export const connectServiceLineShape = z.object({
  templateId: z.string().min(1).max(60),
  name: localized,
  durationMin: z.number().int().positive().max(1000),
  price: z.number().int().nonnegative(),
  selected: z.boolean(),
});

export const connectStartBody = z.object({ visitId: z.string().max(32).optional() });

export const connectDraftPatchBody = z
  .object({
    step: z.number().int().min(0).max(10),
    kind: z.enum(['individual', 'salon']),
    name: z.string().max(160),
    sphereId: z.string().max(40),
    ownerName: z.string().max(160),
    ownerPhone: z.string().max(20),
    district: z.string().max(40),
    address: z.string().max(300),
    yandexMapsUrl: z.string().max(1000),
    coords: z.object({ lat: z.number(), lng: z.number() }),
    photos: z.array(z.string().max(4_000_000)).max(6),
    services: z.array(connectServiceLineShape).max(60),
    hours: connectWeekShape,
    calendarMode: z.enum(['free', 'busy']),
    promoCodeId: z.string().max(32),
    responsibleId: z.string().max(32),
  })
  .partial();
export type ConnectDraftPatchBody = z.infer<typeof connectDraftPatchBody>;

export const connectInviteInputBody = z.object({ name: z.string().max(160), phone: z.string().min(6).max(20) });

export const connectFinishBody = connectDraftPatchBody;
