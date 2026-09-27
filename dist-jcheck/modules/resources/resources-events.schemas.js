import { z } from 'zod';
/**
 * stage 21 (аудит фасадов, лейн «resources»): участники группового события, детали/присоединение события,
 * расписание серии по дням недели (F-16-067…077, отдельно от BookingSeries — та серия про одну повторяющуюся
 * запись клиента), расписание посещений (F-16-078…080), перенос участника, товар/оплата участника (F-16-059…061).
 * Групповое событие само (GroupEvent), участники (Booking.groupEventId) и лист ожидания уже на сервере
 * (этап 7) — здесь только то, чего там не хватало для src/api/resources.ts.
 */
const id = z.string().min(1).max(40);
const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'YYYY-MM-DDTHH:mm');
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const money = z.number().int().min(0).max(1_000_000_000);
const weekday = z.number().int().min(0).max(6);
// ─────────── участники (F-16-047…049) ───────────
export const addParticipantBody = z.object({
    locationId: id,
    staffId: id,
    start: localDateTime,
    name: z.string().max(160),
    phone: z.string().max(30),
    seats: z.number().int().min(1).max(50),
    visitorName: z.string().max(160).optional(),
    comment: z.string().max(2000).optional(),
});
// ─────────── повтор события по шаблону (F-16-064/065/101) ───────────
export const repeatEndBody = z.union([
    z.object({ kind: z.literal('count'), count: z.number().int().min(1).max(500) }),
    z.object({ kind: z.literal('date'), date: localDate }),
]);
export const repeatEventBody = z.object({
    eventId: id,
    freq: z.enum(['daily', 'weekdays', 'monWedFri', 'tueThu', 'weekly', 'monthly', 'yearly']),
    weekIntervalWeeks: z.number().int().min(1).max(52).optional(),
    startDate: localDate,
    end: repeatEndBody,
    withClients: z.boolean(),
    saveAsTemplateName: z.string().max(120).optional(),
});
export const bulkEventIdsBody = z.object({ eventIds: z.array(id).max(500) });
// ─────────── параметры события (F-16-096) ───────────
export const eventParamsBody = z.object({
    staffId: id,
    start: localDateTime,
    durationMin: z.number().int().min(1).max(1440),
    serviceId: id,
    capacity: z.number().int().min(1).max(500),
});
// ─────────── детали события (F-16-039) и присоединение (F-16-081/082) ───────────
export const eventExtraBody = z.object({
    colorIndex: z.number().int().min(1).max(8).optional(),
    categoryIds: z.array(id).max(20),
    comment: z.string().max(2000).optional(),
});
export const eventJoinBody = z.object({ url: z.string().max(1000), instructions: z.string().max(2000) });
// ─────────── расписание серии по дням недели (F-16-067…077) ───────────
export const seriesDayRuleSchema = z.object({
    weekday,
    startTime: z.string().regex(/^\d{2}:\d{2}$/),
    durationMin: z.number().int().min(1).max(1440),
    resourceIds: z.array(z.string().max(40)).max(20),
});
export const createEventSeriesBody = z.object({
    sourceEventId: id,
    days: z.array(seriesDayRuleSchema).min(1).max(7),
    endDate: localDate,
    addClientsFromSource: z.boolean(),
});
export const extendOrShortenBody = z.object({ newEndDate: localDate });
export const editSeriesDayRuleBody = z.object({
    patch: z.object({ startTime: z.string().regex(/^\d{2}:\d{2}$/).optional(), durationMin: z.number().int().min(1).max(1440).optional(), resourceIds: z.array(z.string().max(40)).max(20).optional() }),
    applyToUnique: z.boolean(),
});
export const seriesIdsBody = z.object({ ids: z.array(id).max(200) });
// ─────────── расписание посещений клиента (F-16-078…080) ───────────
export const createVisitScheduleBody = z.object({
    clientId: id.optional(),
    clientName: z.string().max(160),
    clientPhone: z.string().max(30),
    weekdays: z.array(weekday).max(7),
    seats: z.number().int().min(1).max(50),
});
export const updateVisitScheduleBody = z.object({ weekdays: z.array(weekday).max(7) });
// ─────────── лист ожидания — уведомления ручного пути (F-16-166…168) ───────────
export const notifyWaitlistBody = z.object({ serviceId: id, date: localDate, staffId: id.optional() });
// ─────────── перенос участника (F-16-055) ───────────
export const transferParticipantBody = z.object({ targetEventId: id });
// ─────────── товар/абонемент/сертификат участника (F-16-059) ───────────
export const addParticipantExtraBody = z.object({ kind: z.enum(['product', 'membership', 'certificate']), name: z.string().max(160), price: money });
// ─────────── оплата участника (F-16-060/061) ───────────
export const payParticipantBody = z.object({ method: z.enum(['membership', 'card', 'cash', 'other']) });
// ─────────── ассистенты строки записи (F-16-142/143) ───────────
export const setBookingAssistantsBody = z.object({
    assistants: z.array(z.object({ staffId: id, sharePercent: z.number().min(0).max(100) })).max(10),
    shareRule: z.enum(['full', 'split']),
});
//# sourceMappingURL=resources-events.schemas.js.map