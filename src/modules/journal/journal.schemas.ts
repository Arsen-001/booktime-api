import { z } from 'zod';
import { BOOKING_SOURCES, BOOKING_STATUSES } from './rules.js';

const id = z.string().min(1).max(40);
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'YYYY-MM-DDTHH:mm');
const hm = z.string().regex(/^\d{2}:\d{2}$/, 'HH:mm');
const status = z.enum(BOOKING_STATUSES as [string, ...string[]]);
const source = z.enum(BOOKING_SOURCES as [string, ...string[]]);
const money = z.number().int().min(0).max(1_000_000_000);

export const serviceLine = z.object({
  serviceId: id,
  staffId: z.string().max(40).default(''),
  price: z.number().int().min(0).max(1_000_000_000),
  durationMin: z.number().int().min(0).max(24 * 60),
  qty: z.number().int().min(1).max(100).default(1),
  unitPrice: z.number().int().min(0).optional(),
  discountPct: z.number().min(0).max(100).optional(),
  resourceId: id.optional(),
  /** ⭐ Допродажа при записи: строка — сопутствующая к этой услуге (счётчик «Допродано») */
  upsellOf: id.optional(),
});

const prepayment = z.object({ amount: money, paid: z.boolean(), holdUntil: localDateTime.optional() });

export const placeBody = z.object({
  source,
  businessId: id.optional(),
  staffId: id,
  start: localDateTime,
  services: z.array(z.object({ serviceId: id, staffId: id.optional(), qty: z.number().int().min(1).max(100).optional(), discountPct: z.number().min(0).max(100).optional(), unitPrice: z.number().int().min(0).optional(), upsellOf: id.optional() })).max(30),
  locationId: id.optional(),
  workplace: z.string().max(8).optional(),
  client: z.object({ clientId: id.optional(), appUserId: id.optional(), phone: z.string().max(30).optional(), name: z.string().max(160).optional() }).optional(),
  forWhom: z.string().max(6).optional(),
  visitorName: z.string().max(160).optional(),
  comment: z.string().max(5000).optional(),
  groupEventId: id.optional(),
  resourceIds: z.array(z.string().max(40)).max(20).optional(),
  staffAssignment: z.enum(['specific', 'any']).optional(),
  createdBy: z.string().max(40).optional(),
  status: status.optional(),
  seriesId: id.optional(),
  visitId: id.optional(),
});

export const rawBody = z.object({
  businessId: id.optional(),
  locationId: id,
  staffId: id,
  clientId: id.optional(),
  appUserId: id.optional(),
  start: localDateTime,
  durationMin: z.number().int().min(0).max(24 * 60).optional(),
  status,
  services: z.array(serviceLine).max(30),
  resourceIds: z.array(z.string().max(40)).max(20).optional(),
  workplace: z.string().max(8).optional(),
  source,
  createdBy: z.string().max(40).optional(),
  forWhom: z.string().max(6).optional(),
  visitorName: z.string().max(160).optional(),
  comment: z.string().max(5000).optional(),
  prepayment: prepayment.optional(),
  groupEventId: id.optional(),
  seriesId: id.optional(),
  visitId: id.optional(),
  staffAssignment: z.enum(['specific', 'any']).optional(),
  /** client-2-fix: номер доп. места участника события (eventExtraSeat фронта) */
  extraSeat: z.number().int().min(1).max(100).optional(),
});

export const patchBody = z.object({
  start: localDateTime.optional(),
  staffId: id.optional(),
  locationId: id.optional(),
  clientId: id.nullable().optional(),
  services: z.array(serviceLine).max(30).optional(),
  durationMin: z.number().int().min(0).max(24 * 60).optional(),
  resourceIds: z.array(z.string().max(40)).max(20).optional(),
  workplace: z.string().max(8).optional(),
  comment: z.string().max(5000).nullable().optional(),
  visitorName: z.string().max(160).nullable().optional(),
  forWhom: z.string().max(6).optional(),
  visitId: id.nullable().optional(),
  seriesId: id.nullable().optional(),
  groupEventId: id.nullable().optional(),
  staffAssignment: z.enum(['specific', 'any']).nullable().optional(),
  status: status.optional(),
  prepayment: prepayment.nullable().optional(),
  /** F-01-033: updatedAt записи, которую загрузило окно */
  expectedUpdatedAt: localDateTime.optional(),
});

export const statusBody = z.object({ status, actor: z.enum(['business', 'client', 'system']).optional() });
export const arrivedBody = z.object({ amount: money.optional() });
export const deleteBody = z.object({ byName: z.string().max(160).optional(), byClient: z.boolean().optional() });
export const delayBody = z.object({ delayMin: z.number().int().min(1).max(600) });
export const finishEarlyBody = z.object({ actualDurationMin: z.number().int().min(1).max(24 * 60).optional() });
export const idsBody = z.object({ ids: z.array(id).max(2000) });

const goodsLine = z.object({ itemId: id, qty: z.number().int().min(1).max(1000), price: money, discountPct: z.number().min(0).max(100), sellerId: z.string().max(40), code: z.string().max(80).optional(), upsellOf: id.optional() });

export const extrasPatchBody = z.object({
  categoryIds: z.array(z.string().max(40)).max(30).optional(),
  colorIndex: z.number().int().min(0).max(40).nullable().optional(),
  customFieldValues: z.record(z.string(), z.union([z.string().max(2000), z.number(), z.null()])).optional(),
  goodsLines: z.array(goodsLine.extend({ id })).max(100).optional(),
  serviceLineExtras: z.array(z.object({ discountPct: z.number().min(0).max(100), assistants: z.array(z.object({ staffId: id, sharePct: z.number().min(0).max(100) })).optional() })).max(30).optional(),
  paidAmount: money.optional(),
  autoWriteoff: z.object({ status: z.enum(['written_off', 'not_written_off']), amountDue: money, subscriptionId: id.optional() }).nullable().optional(),
  consumablesDeducted: z.boolean().optional(),
  techCardOverrides: z.record(z.string(), id).optional(),
  packageGroupId: id.nullable().optional(),
  payments: z.array(z.object({ id, method: z.string().max(20), amount: money, label: z.string().max(200), cashRegister: z.string().max(80).optional(), refId: z.string().max(40).optional(), at: localDateTime })).max(50).optional(),
  prepaymentDecision: z.object({ kept: z.boolean(), reason: z.enum(['late_reschedule', 'no_show']), decidedBy: z.string().max(160), decidedAt: localDateTime, auto: z.boolean().optional() }).nullable().optional(),
  /** F-01-032: технический перерыв под записью, мин (0 — без перерыва) */
  breakOverrideMin: z.number().int().min(0).max(600).nullable().optional(),
});

export const paymentLinesBody = z.object({
  lines: z.array(z.object({ method: z.string().max(20), amount: money, label: z.string().max(200), cashRegister: z.string().max(80).optional(), refId: z.string().max(40).optional() })).min(1).max(20),
});
export const refundBody = z.object({ amount: money });
export const instantPayBody = z.object({ total: money });
export const goodsLineBody = goodsLine;
export const goodsLinePatchBody = goodsLine.partial();
export const decisionBody = z.object({ kept: z.boolean(), reason: z.enum(['late_reschedule', 'no_show']), decidedBy: z.string().max(160), auto: z.boolean().optional() });

export const historyBody = z.object({ authorName: z.string().max(160), action: z.enum(['created', 'updated', 'statusChanged', 'deleted', 'restored']), summary: z.string().max(1000) });

export const checkBody = z.object({
  staffId: id.optional(),
  start: localDateTime,
  durationMin: z.number().int().min(0).max(24 * 60),
  excludeBookingId: id.optional(),
  resourceId: id.optional(),
  instanceId: z.string().max(40).optional(),
  locationId: id.optional(),
  /** Есть ли у этого клиента другая запись в это время (у любого мастера бизнеса) — журнал предупреждает */
  clientId: id.optional(),
  /** F-00-047: место записи — «дома» / «выезд» на смене в салоне с галочкой владельца журнал показывает до сохранения */
  workplace: z.string().max(16).optional(),
});

export const visitIdBody = z.object({ clientId: id.optional(), start: localDateTime, durationMin: z.number().int().min(0), excludeBookingId: id.optional() });
export const visitStatusBody = z.object({ status, excludeId: id });

export const configPatchBody = z
  .object({
    settings: z.record(z.string(), z.unknown()),
    visitIntervalMin: z.number().int().min(0).max(1440),
    bookingCategories: z.array(z.object({ id, name: z.string().max(80).optional(), labelKey: z.string().max(60).optional(), colorIndex: z.number().int(), system: z.boolean() })),
    customFieldDefs: z.array(z.record(z.string(), z.unknown())).max(100),
    recurrenceTemplates: z.array(z.object({ id, name: z.string().max(120), rule: z.unknown() })).max(100),
    staffJournalRights: z.record(z.string(), z.unknown()),
    staffWindowRights: z.record(z.string(), z.unknown()),
    staffMarkupMin: z.record(z.string(), z.number().int().min(0).max(240)),
    breakCombineMode: z.enum(['longest', 'sum']),
    splitByResourceEnabled: z.boolean(),
    autoWriteoffServiceIds: z.array(id).max(1000),
    hotDiscountPct: z.record(z.string(), z.number().int().min(0).max(100)),
    // === stage 21 (lane rest) ===
    zoomMin: z.union([z.literal(5), z.literal(10), z.literal(15)]),
    hiddenStatuses: z.array(z.string().max(30)).max(20),
    // === /stage 21 ===
  })
  .partial();

export const categoryBody = z.object({ name: z.string().min(1).max(80), colorIndex: z.number().int().min(0).max(40) });
export const templateBody = z.object({ name: z.string().min(1).max(120), rule: z.record(z.string(), z.unknown()) });

export const externalBody = z.object({ locationId: id.optional(), name: z.string().max(160), phone: z.string().max(30), serviceId: id, staffId: id.optional(), start: localDateTime });

const step = z.object({ serviceId: id, staffId: id, durationMin: z.number().int().min(1).max(24 * 60), bufferAfterMin: z.number().int().min(0).max(600).optional(), name: z.string().max(200).optional(), price: money });
export const packageBody = z.object({ locationId: id, clientId: id.optional(), start: localDateTime, order: z.enum(['parallel', 'sequential_one']), steps: z.array(step).min(1).max(10), createdBy: z.string().max(40), comment: z.string().max(5000).optional() });
export const packageTransferBody = z.object({ deltaMin: z.number().int().min(-1440).max(1440), authorName: z.string().max(160) });
export const authorBody = z.object({ authorName: z.string().max(160) });
const plan = z.object({ staffId: id, start: localDateTime, lines: z.array(z.object({ serviceId: id, price: money, durationMin: z.number().int().min(0).max(1440) })).max(20) });
export const checkLinkedBody = z.object({ plans: z.array(plan).max(10) });
export const attachLinkedBody = z.object({ mainBookingId: id, locationId: id, clientId: id.optional(), createdBy: z.string().max(40), order: z.enum(['parallel', 'sequential_one']), plans: z.array(plan).min(1).max(10) });

export const recurrenceBody = z.object({ rule: z.object({ time: hm, withClient: z.boolean() }).passthrough(), dates: z.array(localDate).max(366) });


export const medicalVisitBody = z.object({ patch: z.record(z.string(), z.string().max(10000)), authorName: z.string().max(160) });
/// F-04-100 (этап 21, лейн rest): своё напоминание клиенту и срок приглашения на повторный визит для ОДНОЙ записи
export const bookingReminderBody = z.object({ remindAt: localDateTime.optional(), revisitInviteDays: z.number().int().min(0).max(365).optional() });
export const medicalCardBody = z.record(z.string(), z.string().max(2000));
export const planBody = z.object({ title: z.string().min(1).max(300), serviceIds: z.array(id).max(100) });

const importRow = z.object({
  dateTime: z.string().max(20),
  staffId: id,
  clientPhone: z.string().max(30),
  clientName: z.string().max(160).optional(),
  durationMin: z.number().int().min(0).max(1440).optional(),
  serviceName: z.string().max(200),
  price: z.number().min(0),
  discountPct: z.number().min(0).max(100).optional(),
  comment: z.string().max(2000).optional(),
  statusRaw: z.string().max(40),
  paidAmount: z.number().min(0).optional(),
});
export const importBody = z.object({ locationId: id, createdBy: z.string().max(40), rows: z.array(importRow).max(5000) });
export const dataOpBody = z.object({ kind: z.enum(['import', 'export']), count: z.number().int().min(0) });

export const groupEventBody = z.object({
  locationId: id,
  serviceId: id,
  staffId: id,
  start: localDateTime,
  durationMin: z.number().int().min(1).max(24 * 60),
  capacity: z.number().int().min(1).max(10_000),
  resourceIds: z.array(z.string().max(40)).max(20).optional(),
  onlineUrl: z.string().max(1000).optional(),
  seriesId: id.optional(),
  status: z.enum(['scheduled', 'cancelled']).optional(),
});
export const groupEventPatchBody = groupEventBody.partial();

export const seriesBody = z.object({
  locationId: id,
  staffId: id,
  serviceId: id,
  durationMin: z.number().int().min(1).max(24 * 60),
  clientId: id.optional(),
  clientName: z.string().max(160).optional(),
  clientPhone: z.string().max(30).optional(),
  kind: z.enum(['weekly', 'every_n_days']),
  intervalDays: z.number().int().min(1).max(60).optional(),
  weekday: z.number().int().min(0).max(6).optional(),
  time: hm,
  startDate: localDate,
  createdByName: z.string().max(160).optional(),
  createdBy: z.string().max(40).optional(),
});
export const seriesPreviewBody = seriesBody.pick({ staffId: true, locationId: true, kind: true, intervalDays: true, weekday: true, time: true, startDate: true, durationMin: true });

export const clientRescheduleBody = z.object({ start: localDateTime });
export const claimMintBody = z.object({ staffId: id, serviceId: id.optional(), start: localDateTime, clientName: z.string().max(160).optional(), clientPhone: z.string().max(30).optional() });

export const windowTagsBody = z.object({ tags: z.array(z.string().max(80)).max(50) });
