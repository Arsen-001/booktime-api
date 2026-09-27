var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { Injectable } from '@nestjs/common';
import dayjs from 'dayjs';
import { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { ApiError } from '../../common/errors/api-error.js';
import { newId } from '../../common/ids/ids.js';
import { PrismaService } from '../../common/prisma.service.js';
import { localToUtc, utcToLocal, utcToLocalDate } from '../../common/time/time.js';
import { addDays, eachDay, weekdayIndex } from '../availability/engine.js';
import { clientRowView } from '../clients/clients.views.js';
import { BookingsService, staffActor } from '../journal/bookings.service.js';
import { GroupEventsService } from '../journal/group-events.service.js';
import { bookingView, groupEventView } from '../journal/journal.views.js';
import { ResourcesService } from './resources.service.js';
const arr = (v) => (Array.isArray(v) ? v : []);
const addMin = (d, m) => new Date(d.getTime() + m * 60_000);
const ACTIVE_STATUSES = new Set(['awaiting_confirmation', 'awaiting_prepayment', 'scheduled', 'client_confirmed', 'arrived']);
const isActiveBooking = (status) => ACTIVE_STATUSES.has(status);
const extrasOf = (v) => (v && typeof v === 'object' ? v : {});
const bookingExtrasOf = (v) => (v && typeof v === 'object' ? v : {});
// weekdayIndex (availability/engine.js) — 0 = понедельник … 6 = воскресенье (ISO), как SeriesDayRule.weekday
// и WeekdayPicker фронта. dayjs().day() (0=воскресенье) сюда НЕ подходит — используется только для месяцев/лет.
const WEEKDAY_SETS = {
    weekdays: [0, 1, 2, 3, 4],
    monWedFri: [0, 2, 4],
    tueThu: [1, 3],
};
const REPEAT_SAFETY_LIMIT = 500;
/** Копия repeatDates фронта (src/domain/resources.ts) — та же семантика дат повтора (F-16-064/067) */
function repeatDates(freq, startDate, weekIntervalWeeks, end) {
    const maxCount = end.kind === 'count' ? Math.max(1, end.count) : REPEAT_SAFETY_LIMIT;
    const endDate = end.kind === 'date' ? end.date : undefined;
    const dates = [];
    if (freq === 'monthly' || freq === 'yearly') {
        let d = dayjs(startDate, 'YYYY-MM-DD');
        for (let i = 0; i < maxCount && dates.length < REPEAT_SAFETY_LIMIT; i++) {
            const iso = d.format('YYYY-MM-DD');
            if (endDate && iso > endDate)
                break;
            dates.push(iso);
            d = d.add(1, freq === 'monthly' ? 'month' : 'year');
        }
        return dates;
    }
    const weekdaySet = WEEKDAY_SETS[freq];
    const stepDays = freq === 'weekly' ? 7 * Math.max(1, weekIntervalWeeks ?? 1) : 1;
    let cursor = startDate;
    for (let i = 0; i < REPEAT_SAFETY_LIMIT && dates.length < maxCount; i++) {
        if (endDate && cursor > endDate)
            break;
        if (!weekdaySet || weekdaySet.includes(weekdayIndex(cursor)))
            dates.push(cursor);
        cursor = addDays(cursor, stepDays);
    }
    return dates;
}
function seriesOccurrences(days, from, to) {
    if (to < from)
        return [];
    const out = [];
    for (const date of eachDay(from, to)) {
        const wd = weekdayIndex(date);
        for (const rule of days)
            if (rule.weekday === wd)
                out.push({ date, rule });
    }
    return out;
}
/**
 * stage 21 (аудит фасадов, лейн «resources»): участники группового события, повтор/серия по дням недели,
 * расписание посещений, детали/присоединение события, перенос участника, товар/оплата участника — всё, чего
 * не хватало src/api/resources.ts на сервере (GroupEvent/Booking/лист ожидания уже были, этап 7).
 * Использует GroupEventsService/BookingsService журнала как есть (create/update/place уже несут «замок на
 * мастера», аудит, инвалидацию окон) — не заводит вторую копию этой логики.
 */
let ResourcesEventsService = class ResourcesEventsService {
    constructor(prisma, bookings, groupEvents, resources, audit) {
        this.prisma = prisma;
        this.bookings = bookings;
        this.groupEvents = groupEvents;
        this.resources = resources;
        this.audit = audit;
    }
    actor(ctx) {
        return staffActor(ctx);
    }
    // ─────────── участники (F-16-047…049) ───────────
    async listParticipants(businessId, eventId) {
        const tz = await this.resources.tzOfBusiness(businessId);
        const rows = await this.prisma.booking.findMany({ where: { groupEventId: eventId, businessId, deletedAt: null }, orderBy: { createdAt: 'asc' } });
        const clientIds = [...new Set(rows.map((r) => r.clientId).filter((id) => Boolean(id)))];
        const clients = clientIds.length ? await this.prisma.client.findMany({ where: { id: { in: clientIds } } }) : [];
        const byId = new Map(clients.map((c) => [c.id, clientRowView(c)]));
        return rows.map((b) => ({ booking: bookingView(b, tz), client: b.clientId ? byId.get(b.clientId) : undefined }));
    }
    async addParticipant(ctx, businessId, eventId, input) {
        const event = await this.prisma.groupEvent.findFirst({ where: { id: eventId, businessId } });
        if (!event)
            throw new ApiError('not_found', 'Event not found');
        const res = await this.bookings.place(this.actor(ctx), {
            source: 'journal',
            businessId,
            locationId: input.locationId,
            staffId: input.staffId,
            start: input.start,
            services: [{ serviceId: event.serviceId, qty: Math.max(1, input.seats) }],
            groupEventId: eventId,
            client: { phone: input.phone, name: input.name },
            visitorName: input.visitorName,
            comment: input.comment,
            createdBy: ctx.member.staffId,
        });
        return res.booking;
    }
    async removeParticipant(ctx, businessId, bookingId) {
        await this.bookings.remove(this.actor(ctx), [businessId], bookingId, { byName: ctx.member?.name });
    }
    /** F-16-170: сколько будущих событий этой групповой услуги — предупреждение перед удалением услуги */
    async countFutureForService(businessId, serviceId) {
        return this.prisma.groupEvent.count({ where: { businessId, serviceId, status: 'scheduled', startAt: { gte: new Date() } } });
    }
    // ─────────── повтор события по шаблону (F-16-064/065/101) ───────────
    async repeatEvent(ctx, businessId, input) {
        const source = await this.prisma.groupEvent.findFirst({ where: { id: input.eventId, businessId } });
        if (!source)
            throw new ApiError('not_found', 'Event not found');
        const tz = await this.resources.tzOfBusiness(businessId);
        const time = utcToLocal(source.startAt, tz).slice(11);
        const dates = repeatDates(input.freq, input.startDate, input.weekIntervalWeeks, input.end);
        const sourceResourceIds = arr(source.resourceIds);
        for (const date of dates) {
            const start = `${date}T${time}`;
            let resourceIds = [];
            if (sourceResourceIds.length) {
                resourceIds = (await this.resources.pickFreeInstances(businessId, [source.serviceId], localToUtc(start, tz), source.durationMin)) ?? [];
            }
            const created = await this.groupEvents.create(ctx, businessId, {
                locationId: source.locationId,
                serviceId: source.serviceId,
                staffId: source.staffId,
                start,
                durationMin: source.durationMin,
                capacity: source.capacity,
                resourceIds,
                onlineUrl: source.onlineUrl ?? undefined,
                status: 'scheduled',
            });
            if (input.withClients) {
                const participants = await this.listParticipants(businessId, source.id);
                for (const p of participants) {
                    if (!isActiveBooking(p.booking.status))
                        continue;
                    try {
                        await this.addParticipant(ctx, businessId, created.id, {
                            locationId: source.locationId,
                            staffId: source.staffId,
                            start,
                            name: p.client?.name ?? p.booking.visitorName ?? '',
                            phone: p.client?.phone ?? '',
                            seats: Math.max(1, p.booking.services[0]?.qty ?? 1),
                            visitorName: p.booking.visitorName,
                            comment: p.booking.comment,
                        });
                    }
                    catch (e) {
                        if (!(e instanceof ApiError) || e.code !== 'group_full')
                            throw e;
                    }
                }
            }
        }
        if (input.saveAsTemplateName?.trim()) {
            await this.resources.saveEventTemplate(businessId, { name: input.saveAsTemplateName.trim(), freq: input.freq, weekIntervalWeeks: input.weekIntervalWeeks });
        }
        return { createdCount: dates.length };
    }
    /** F-16-066: массовая отмена (через GroupEventsService.update — освобождает занятость правильно, не «в обход») */
    async bulkDelete(ctx, businessId, eventIds) {
        const now = new Date();
        const toCancel = await this.prisma.groupEvent.findMany({ where: { id: { in: eventIds }, businessId, status: 'scheduled', startAt: { gte: now } }, select: { id: true } });
        for (const e of toCancel)
            await this.groupEvents.update(ctx, [businessId], e.id, { status: 'cancelled' });
        return { cancelledCount: toCancel.length };
    }
    /** Отмена «Массового удаления» (F-16-066) */
    async bulkRestore(ctx, businessId, eventIds) {
        const toRestore = await this.prisma.groupEvent.findMany({ where: { id: { in: eventIds }, businessId, status: 'cancelled' }, select: { id: true } });
        for (const e of toRestore)
            await this.groupEvents.update(ctx, [businessId], e.id, { status: 'scheduled' });
        return { restoredCount: toRestore.length };
    }
    /**
     * F-16-096: переносит параметры события и АКТИВНЫХ участников на новое время/сотрудника той же операцией
     * (участники не держат свою занятость — F-16-036…, время держит само событие, см. group-events.service.ts —
     * поэтому перенос строк участников ниже это просто данные записи, без освобождения/занятия чего-либо).
     */
    async saveEventParams(ctx, businessId, eventId, patch) {
        const before = await this.prisma.groupEvent.findFirst({ where: { id: eventId, businessId } });
        if (!before)
            throw new ApiError('not_found', 'Event not found');
        const tz = await this.resources.tzOfBusiness(businessId);
        const beforeStart = utcToLocal(before.startAt, tz);
        const timeChanged = patch.start !== beforeStart || patch.staffId !== before.staffId || patch.durationMin !== before.durationMin;
        const updated = await this.groupEvents.update(ctx, [businessId], eventId, patch);
        if (timeChanged) {
            const startAt = localToUtc(patch.start, tz);
            const participants = await this.prisma.booking.findMany({ where: { groupEventId: eventId, businessId, deletedAt: null } });
            for (const p of participants) {
                if (!isActiveBooking(p.status))
                    continue;
                await this.prisma.booking.update({
                    where: { id: p.id },
                    data: { startAt, endAt: addMin(startAt, patch.durationMin), staffId: patch.staffId, durationMin: patch.durationMin, version: { increment: 1 } },
                });
            }
        }
        if (before.seriesId)
            await this.markSeriesEventUnique(before.seriesId, eventId);
        return updated;
    }
    /** Пояс бизнеса + сегодняшняя местная дата + её полночь в UTC (граница «будущих» событий серии) */
    async localToday(businessId) {
        const tz = await this.resources.tzOfBusiness(businessId);
        const today = utcToLocalDate(new Date(), tz);
        return { tz, today, startOfToday: localToUtc(`${today}T00:00`, tz) };
    }
    async markSeriesEventUnique(seriesId, eventId) {
        const def = await this.prisma.eventSeriesDef.findUnique({ where: { id: seriesId } });
        if (!def)
            return;
        const ids = arr(def.uniqueEventIds);
        if (ids.includes(eventId))
            return;
        await this.prisma.eventSeriesDef.update({ where: { id: seriesId }, data: { uniqueEventIds: [...ids, eventId] } });
    }
    // ─────────── детали события (F-16-039) ───────────
    async getEventExtra(businessId, eventId) {
        const e = await this.prisma.groupEvent.findFirst({ where: { id: eventId, businessId }, select: { extras: true } });
        const x = extrasOf(e?.extras);
        return { eventId, colorIndex: x.colorIndex, categoryIds: x.categoryIds ?? [], comment: x.comment };
    }
    async saveEventExtra(ctx, businessId, eventId, patch) {
        const event = await this.prisma.groupEvent.findFirst({ where: { id: eventId, businessId } });
        if (!event)
            throw new ApiError('not_found', 'Event not found');
        const current = extrasOf(event.extras);
        const next = { ...current, colorIndex: patch.colorIndex, categoryIds: patch.categoryIds, comment: patch.comment?.trim() || undefined };
        await this.prisma.$transaction(async (tx) => {
            await tx.groupEvent.update({ where: { id: eventId }, data: { extras: next } });
            await this.audit.record(tx, ctx, { action: 'update', entityType: 'event', entityId: eventId, businessId, before: { extra: current }, after: { extra: next } });
        });
        return { eventId, colorIndex: next.colorIndex, categoryIds: next.categoryIds ?? [], comment: next.comment };
    }
    // ─────────── онлайн-занятия: присоединиться и уведомить (F-16-081…083) ───────────
    async getEventJoin(businessId, eventId) {
        const e = await this.prisma.groupEvent.findFirst({ where: { id: eventId, businessId } });
        if (!e)
            return undefined;
        const x = extrasOf(e.extras);
        if (!e.onlineUrl && !x.joinInstructions)
            return undefined;
        return { url: e.onlineUrl ?? '', instructions: x.joinInstructions ?? '', sentAt: x.joinSentAt ?? [] };
    }
    async saveEventJoin(businessId, eventId, input) {
        const event = await this.prisma.groupEvent.findFirst({ where: { id: eventId, businessId } });
        if (!event)
            throw new ApiError('not_found', 'Event not found');
        const current = extrasOf(event.extras);
        const next = { ...current, joinInstructions: input.instructions.trim() };
        await this.prisma.groupEvent.update({ where: { id: eventId }, data: { onlineUrl: input.url.trim() || null, extras: next } });
        return { url: input.url.trim(), instructions: next.joinInstructions ?? '', sentAt: next.joinSentAt ?? [] };
    }
    async sendEventJoinNotifications(businessId, eventId) {
        const event = await this.prisma.groupEvent.findFirst({ where: { id: eventId, businessId } });
        if (!event)
            throw new ApiError('not_found', 'Event not found');
        const current = extrasOf(event.extras);
        if (!event.onlineUrl)
            throw new ApiError('no_join_link', 'No join link');
        const participants = await this.prisma.booking.findMany({ where: { groupEventId: eventId, businessId, deletedAt: null }, select: { status: true } });
        const notifiedCount = participants.filter((p) => isActiveBooking(p.status)).length;
        const next = { ...current, joinSentAt: [...(current.joinSentAt ?? []), new Date().toISOString()] };
        await this.prisma.groupEvent.update({ where: { id: eventId }, data: { extras: next } });
        return { notifiedCount };
    }
    // ─────────── расписание (серия) группового события по дням недели (F-16-067…077) ───────────
    async getSeriesDef(businessId, seriesId) {
        if (!seriesId)
            return undefined;
        const def = await this.prisma.eventSeriesDef.findFirst({ where: { id: seriesId, businessId } });
        return def ? this.seriesDefView(def) : undefined;
    }
    async listSeriesDefsByIds(businessId, ids) {
        if (!ids.length)
            return {};
        const rows = await this.prisma.eventSeriesDef.findMany({ where: { id: { in: ids }, businessId } });
        const out = {};
        for (const r of rows)
            out[r.id] = this.seriesDefView(r);
        return out;
    }
    seriesDefView(def) {
        return {
            id: def.id,
            businessId: def.businessId,
            locationId: def.locationId,
            staffId: def.staffId,
            serviceId: def.serviceId,
            capacity: def.capacity,
            days: arr(def.days),
            endDate: def.endDate,
            sourceEventId: def.sourceEventId,
            uniqueEventIds: arr(def.uniqueEventIds),
            createdAt: def.createdAt.toISOString(),
        };
    }
    async listSeriesEvents(businessId, seriesId) {
        const tz = await this.resources.tzOfBusiness(businessId);
        const rows = await this.prisma.groupEvent.findMany({ where: { businessId, seriesId }, orderBy: { startAt: 'asc' } });
        return rows.map((e) => groupEventView(e, tz));
    }
    /** F-16-067: создаёт серию из уже существующего события; исходное получает seriesId, остальные даты — новые события */
    async createEventSeries(ctx, businessId, input) {
        const source = await this.prisma.groupEvent.findFirst({ where: { id: input.sourceEventId, businessId } });
        if (!source)
            throw new ApiError('not_found', 'Event not found');
        if (source.seriesId)
            throw new ApiError('already_series', 'Already a series');
        const tz = await this.resources.tzOfBusiness(businessId);
        const sourceDate = utcToLocalDate(source.startAt, tz);
        const seriesId = newId('eventSeriesDef');
        const occurrences = seriesOccurrences(input.days, sourceDate, input.endDate).filter((o) => !(o.date === sourceDate && o.rule.weekday === dayjs(sourceDate).day()));
        const created = [];
        for (const { date, rule } of occurrences) {
            const ev = await this.groupEvents.create(ctx, businessId, {
                locationId: source.locationId,
                serviceId: source.serviceId,
                staffId: source.staffId,
                start: `${date}T${rule.startTime}`,
                durationMin: rule.durationMin,
                capacity: source.capacity,
                resourceIds: rule.resourceIds,
                seriesId,
                status: 'scheduled',
            });
            created.push(ev);
        }
        await this.prisma.$transaction([
            this.prisma.groupEvent.update({ where: { id: source.id }, data: { seriesId } }),
            this.prisma.eventSeriesDef.create({
                data: {
                    id: seriesId,
                    businessId,
                    locationId: source.locationId,
                    staffId: source.staffId,
                    serviceId: source.serviceId,
                    capacity: source.capacity,
                    days: input.days,
                    endDate: input.endDate,
                    sourceEventId: source.id,
                    uniqueEventIds: [],
                    createdBy: ctx.member.staffId,
                },
            }),
        ]);
        if (input.addClientsFromSource) {
            const participants = await this.listParticipants(businessId, source.id);
            const active = participants.filter((p) => isActiveBooking(p.booking.status));
            for (const event of created) {
                for (const p of active) {
                    try {
                        await this.addParticipant(ctx, businessId, event.id, {
                            locationId: source.locationId,
                            staffId: source.staffId,
                            start: event.start,
                            name: p.client?.name ?? p.booking.visitorName ?? '',
                            phone: p.client?.phone ?? '',
                            seats: Math.max(1, p.booking.services[0]?.qty ?? 1),
                            visitorName: p.booking.visitorName,
                            comment: p.booking.comment,
                        });
                    }
                    catch (e) {
                        if (!(e instanceof ApiError) || e.code !== 'group_full')
                            throw e;
                    }
                }
            }
            const weekdays = [...new Set(input.days.map((d) => d.weekday))];
            if (weekdays.length) {
                await this.prisma.visitScheduleEntry.createMany({
                    data: active
                        .filter((p) => Math.max(1, p.booking.services[0]?.qty ?? 1) === 1)
                        .map((p) => ({
                        id: newId('visitScheduleEntry'),
                        seriesId,
                        businessId,
                        clientId: p.client?.id ?? null,
                        clientName: p.client?.name ?? p.booking.visitorName ?? '',
                        clientPhone: p.client?.phone ?? '',
                        weekdays,
                    })),
                });
            }
        }
        return { seriesId, createdCount: created.length };
    }
    /** F-16-071: продлить (создаёт недостающие) или сократить (отменяет будущие сверх новой даты) серию */
    async extendOrShortenSeries(ctx, businessId, seriesId, newEndDate) {
        const def = await this.prisma.eventSeriesDef.findFirst({ where: { id: seriesId, businessId } });
        if (!def)
            throw new ApiError('not_found', 'Series not found');
        const today = dayjs().format('YYYY-MM-DD');
        if (newEndDate < today)
            throw new ApiError('invalid_end_date', 'End date in the past');
        let createdCount = 0;
        let cancelledCount = 0;
        if (newEndDate > def.endDate) {
            const source = await this.prisma.groupEvent.findFirst({ where: { id: def.sourceEventId } });
            if (!source)
                throw new ApiError('not_found', 'Source event not found');
            const occurrences = seriesOccurrences(arr(def.days), dayjs(def.endDate).add(1, 'day').format('YYYY-MM-DD'), newEndDate);
            for (const { date, rule } of occurrences) {
                await this.groupEvents.create(ctx, businessId, {
                    locationId: source.locationId,
                    serviceId: source.serviceId,
                    staffId: source.staffId,
                    start: `${date}T${rule.startTime}`,
                    durationMin: rule.durationMin,
                    capacity: source.capacity,
                    resourceIds: rule.resourceIds,
                    seriesId,
                    status: 'scheduled',
                });
                createdCount += 1;
            }
        }
        else if (newEndDate < def.endDate) {
            const toCancel = await this.prisma.groupEvent.findMany({ where: { businessId, seriesId, status: 'scheduled', startAt: { gt: localToUtc(`${newEndDate}T23:59`, await this.resources.tzOfBusiness(businessId)) } } });
            for (const e of toCancel)
                await this.groupEvents.update(ctx, [businessId], e.id, { status: 'cancelled' });
            cancelledCount = toCancel.length;
        }
        await this.prisma.eventSeriesDef.update({ where: { id: seriesId }, data: { endDate: newEndDate } });
        return { createdCount, cancelledCount };
    }
    /** F-16-072 (удалить день): убирает ВСЕ будущие события серии этого дня недели (прошедшие остаются) */
    async removeSeriesWeekday(ctx, businessId, seriesId, weekday) {
        const def = await this.prisma.eventSeriesDef.findFirst({ where: { id: seriesId, businessId } });
        if (!def)
            throw new ApiError('not_found', 'Series not found');
        const rows = await this.prisma.groupEvent.findMany({ where: { businessId, seriesId, status: 'scheduled', startAt: { gte: new Date(new Date().toDateString()) } } });
        const toCancel = rows.filter((e) => dayjs(e.startAt).day() === weekday);
        for (const e of toCancel)
            await this.groupEvents.update(ctx, [businessId], e.id, { status: 'cancelled' });
        await this.prisma.eventSeriesDef.update({ where: { id: seriesId }, data: { days: arr(def.days).filter((d) => d.weekday !== weekday) } });
        return { cancelledCount: toCancel.length };
    }
    /** F-16-072 (добавить день): создаёт будущие события этого дня недели до конца серии */
    async addSeriesWeekday(ctx, businessId, seriesId, rule) {
        const def = await this.prisma.eventSeriesDef.findFirst({ where: { id: seriesId, businessId } });
        if (!def)
            throw new ApiError('not_found', 'Series not found');
        const source = await this.prisma.groupEvent.findFirst({ where: { id: def.sourceEventId } });
        if (!source)
            throw new ApiError('not_found', 'Source event not found');
        const today = dayjs().format('YYYY-MM-DD');
        const occurrences = seriesOccurrences([rule], today, def.endDate);
        for (const { date } of occurrences) {
            await this.groupEvents.create(ctx, businessId, {
                locationId: source.locationId,
                serviceId: source.serviceId,
                staffId: source.staffId,
                start: `${date}T${rule.startTime}`,
                durationMin: rule.durationMin,
                capacity: source.capacity,
                resourceIds: rule.resourceIds,
                seriesId,
                status: 'scheduled',
            });
        }
        const days = [...arr(def.days).filter((d) => d.weekday !== rule.weekday), rule];
        await this.prisma.eventSeriesDef.update({ where: { id: seriesId }, data: { days: days } });
        return { createdCount: occurrences.length };
    }
    /** F-16-071/074: правит будущие события дня недели; изменённые отдельно (unique) пропускаются, если !applyToUnique */
    async editSeriesDayRule(ctx, businessId, seriesId, weekday, patch, applyToUnique) {
        const def = await this.prisma.eventSeriesDef.findFirst({ where: { id: seriesId, businessId } });
        if (!def)
            throw new ApiError('not_found', 'Series not found');
        const days = arr(def.days);
        const rule = days.find((d) => d.weekday === weekday);
        if (!rule)
            throw new ApiError('not_found', 'Weekday rule not found');
        const nextRule = { ...rule, ...patch };
        const uniqueIds = new Set(arr(def.uniqueEventIds));
        const rows = await this.prisma.groupEvent.findMany({ where: { businessId, seriesId, status: 'scheduled', startAt: { gte: new Date(new Date().toDateString()) } } });
        const dayEvents = rows.filter((e) => dayjs(e.startAt).day() === weekday);
        let updatedCount = 0;
        let skippedUniqueCount = 0;
        const tz = await this.resources.tzOfBusiness(businessId);
        for (const e of dayEvents) {
            if (uniqueIds.has(e.id) && !applyToUnique) {
                skippedUniqueCount += 1;
                continue;
            }
            await this.groupEvents.update(ctx, [businessId], e.id, {
                start: `${utcToLocalDate(e.startAt, tz)}T${nextRule.startTime}`,
                durationMin: nextRule.durationMin,
                resourceIds: nextRule.resourceIds,
            });
            updatedCount += 1;
        }
        await this.prisma.eventSeriesDef.update({ where: { id: seriesId }, data: { days: days.map((d) => (d.weekday === weekday ? nextRule : d)) } });
        return { updatedCount, skippedUniqueCount };
    }
    /** F-16-076: отменяет все будущие события серии, прошедшие остаются в отчётах */
    async deleteSeries(ctx, businessId, seriesId) {
        const def = await this.prisma.eventSeriesDef.findFirst({ where: { id: seriesId, businessId } });
        if (!def)
            throw new ApiError('not_found', 'Series not found');
        const toCancel = await this.prisma.groupEvent.findMany({ where: { businessId, seriesId, status: 'scheduled', startAt: { gte: new Date(new Date().toDateString()) } } });
        for (const e of toCancel)
            await this.groupEvents.update(ctx, [businessId], e.id, { status: 'cancelled' });
        await this.prisma.eventSeriesDef.delete({ where: { id: seriesId } });
        return { cancelledCount: toCancel.length };
    }
    // ─────────── расписание посещений клиента (F-16-078…080) ───────────
    async listVisitSchedules(businessId, seriesId) {
        const rows = await this.prisma.visitScheduleEntry.findMany({ where: { seriesId, businessId } });
        return rows.map((v) => this.visitScheduleView(v));
    }
    visitScheduleView(v) {
        return { id: v.id, seriesId: v.seriesId, clientId: v.clientId ?? undefined, clientName: v.clientName, clientPhone: v.clientPhone, weekdays: arr(v.weekdays), createdAt: v.createdAt.toISOString() };
    }
    async futureSeriesEventsOnWeekdays(businessId, seriesId, weekdays) {
        const rows = await this.prisma.groupEvent.findMany({ where: { businessId, seriesId, status: 'scheduled', startAt: { gte: new Date(new Date().toDateString()) } } });
        return rows.filter((e) => weekdays.includes(dayjs(e.startAt).day()));
    }
    async createVisitSchedule(ctx, businessId, input) {
        if (input.seats > 1)
            throw new ApiError('multi_seat_no_schedule', 'Multi-seat client cannot use visit schedule');
        if (!input.weekdays.length)
            throw new ApiError('weekday_required', 'At least one weekday required');
        const def = await this.prisma.eventSeriesDef.findFirst({ where: { id: input.seriesId, businessId } });
        if (!def)
            throw new ApiError('not_found', 'Series not found');
        const tz = await this.resources.tzOfBusiness(businessId);
        const events = await this.futureSeriesEventsOnWeekdays(businessId, input.seriesId, input.weekdays);
        let createdCount = 0;
        for (const event of events) {
            try {
                await this.addParticipant(ctx, businessId, event.id, {
                    locationId: def.locationId,
                    staffId: event.staffId,
                    start: utcToLocal(event.startAt, tz),
                    name: input.clientName,
                    phone: input.clientPhone,
                    seats: 1,
                });
                createdCount += 1;
            }
            catch (e) {
                if (!(e instanceof ApiError) || e.code !== 'group_full')
                    throw e;
            }
        }
        const row = await this.prisma.visitScheduleEntry.create({
            data: { id: newId('visitScheduleEntry'), seriesId: input.seriesId, businessId, clientId: input.clientId ?? null, clientName: input.clientName, clientPhone: input.clientPhone, weekdays: input.weekdays },
        });
        return { entry: this.visitScheduleView(row), createdCount };
    }
    async findParticipantBooking(businessId, eventId, phone) {
        const rows = await this.prisma.booking.findMany({ where: { groupEventId: eventId, businessId, deletedAt: null } });
        for (const b of rows) {
            if (!b.clientId)
                continue;
            const c = await this.prisma.client.findUnique({ where: { id: b.clientId }, select: { phone: true } });
            if (c?.phone === phone)
                return b;
        }
        return undefined;
    }
    /** F-16-079: снятие дня недели убирает клиента только из будущих событий этого дня */
    async updateVisitSchedule(ctx, businessId, id, weekdays) {
        const entry = await this.prisma.visitScheduleEntry.findFirst({ where: { id, businessId } });
        if (!entry)
            throw new ApiError('not_found', 'Visit schedule not found');
        const currentWeekdays = arr(entry.weekdays);
        const removed = currentWeekdays.filter((d) => !weekdays.includes(d));
        const added = weekdays.filter((d) => !currentWeekdays.includes(d));
        if (removed.length) {
            for (const event of await this.futureSeriesEventsOnWeekdays(businessId, entry.seriesId, removed)) {
                const booking = await this.findParticipantBooking(businessId, event.id, entry.clientPhone);
                if (booking)
                    await this.removeParticipant(ctx, businessId, booking.id);
            }
        }
        if (added.length) {
            const def = await this.prisma.eventSeriesDef.findFirst({ where: { id: entry.seriesId, businessId } });
            if (!def)
                throw new ApiError('not_found', 'Series not found');
            const tz = await this.resources.tzOfBusiness(businessId);
            for (const event of await this.futureSeriesEventsOnWeekdays(businessId, entry.seriesId, added)) {
                try {
                    await this.addParticipant(ctx, businessId, event.id, { locationId: def.locationId, staffId: event.staffId, start: utcToLocal(event.startAt, tz), name: entry.clientName, phone: entry.clientPhone, seats: 1 });
                }
                catch (e) {
                    if (!(e instanceof ApiError) || e.code !== 'group_full')
                        throw e;
                }
            }
        }
        const row = await this.prisma.visitScheduleEntry.update({ where: { id }, data: { weekdays } });
        return this.visitScheduleView(row);
    }
    /** F-16-079 «Удалить»: снимает клиента со всего будущего расписания */
    async deleteVisitSchedule(ctx, businessId, id) {
        const entry = await this.prisma.visitScheduleEntry.findFirst({ where: { id, businessId } });
        if (!entry)
            return;
        for (const event of await this.futureSeriesEventsOnWeekdays(businessId, entry.seriesId, arr(entry.weekdays))) {
            const booking = await this.findParticipantBooking(businessId, event.id, entry.clientPhone);
            if (booking)
                await this.removeParticipant(ctx, businessId, booking.id);
        }
        await this.prisma.visitScheduleEntry.delete({ where: { id } });
    }
    // ─────────── лист ожидания СВОЕГО экрана (F-16-149…168, отдельная таблица — см. schema.prisma) ───────────
    waitlistView(e) {
        return {
            id: e.id,
            businessId: e.businessId,
            locationId: e.locationId,
            clientName: e.clientName,
            clientPhone: e.clientPhone,
            serviceIds: arr(e.serviceIds),
            staffIds: arr(e.staffIds),
            wishes: arr(e.wishes),
            comment: e.comment || undefined,
            tags: arr(e.tags),
            createdAt: e.createdAt.toISOString(),
            ...(e.closedBookingId ? { closedBookingId: e.closedBookingId } : {}),
        };
    }
    async listWaitlist(businessId) {
        const rows = await this.prisma.resourcesWaitlistEntry.findMany({ where: { businessId }, orderBy: { createdAt: 'desc' } });
        return rows.map((e) => this.waitlistView(e));
    }
    async updateWaitlistEntry(ctx, businessId, id, patch) {
        const existing = await this.prisma.resourcesWaitlistEntry.findFirst({ where: { id, businessId } });
        if (!existing)
            throw new ApiError('not_found', 'Waitlist entry not found');
        if (existing.closedBookingId)
            throw new ApiError('waitlist_entry_closed', 'Entry already closed');
        if (patch.clientName !== undefined && !patch.clientName.trim())
            throw new ApiError('name_required', 'Name required');
        if (patch.serviceIds !== undefined && patch.serviceIds.length === 0)
            throw new ApiError('service_required', 'Service required');
        const row = await this.prisma.$transaction(async (tx) => {
            const updated = await tx.resourcesWaitlistEntry.update({
                where: { id },
                data: {
                    ...(patch.clientName !== undefined ? { clientName: patch.clientName.trim() } : {}),
                    ...(patch.clientPhone !== undefined ? { clientPhone: patch.clientPhone } : {}),
                    ...(patch.serviceIds !== undefined ? { serviceIds: patch.serviceIds } : {}),
                    ...(patch.staffIds !== undefined ? { staffIds: patch.staffIds } : {}),
                    ...(patch.wishes !== undefined ? { wishes: patch.wishes } : {}),
                    ...(patch.comment !== undefined ? { comment: patch.comment.trim() } : {}),
                },
            });
            await this.audit.record(tx, ctx, { action: 'update', entityType: 'waitlist', entityId: id, businessId, before: { clientName: existing.clientName }, after: { clientName: updated.clientName } });
            return updated;
        });
        return this.waitlistView(row);
    }
    /** F-16-166…168: отмечает активные заявки на услугу как «предложено» (свой ручной путь, отдельный от В-18) */
    async notifyWaitlistForFreedSlot(businessId, serviceId, date, staffId) {
        const today = dayjs().format('YYYY-MM-DD');
        const rows = await this.prisma.resourcesWaitlistEntry.findMany({ where: { businessId, closedBookingId: null } });
        const matching = rows.filter((e) => {
            const serviceIds = arr(e.serviceIds);
            const staffIds = arr(e.staffIds);
            if (!serviceIds.includes(serviceId))
                return false;
            if (staffIds.length && staffId && !staffIds.includes(staffId))
                return false;
            const wishes = arr(e.wishes);
            return wishes.length === 0 || wishes.some((w) => !w.date || w.date === date || w.date >= today);
        });
        const now = new Date().toISOString();
        for (const e of matching) {
            await this.prisma.resourcesWaitlistEntry.update({ where: { id: e.id }, data: { notifiedTimes: [...arr(e.notifiedTimes), now] } });
        }
        return { notifiedIds: matching.map((e) => e.id) };
    }
    async getWaitlistNotifications(businessId, entryId) {
        const e = await this.prisma.resourcesWaitlistEntry.findFirst({ where: { id: entryId, businessId }, select: { notifiedTimes: true } });
        return arr(e?.notifiedTimes);
    }
    // ─────────── перенос брони в другое событие (F-16-055) ───────────
    async listTransferTargets(businessId, serviceId, excludeEventId) {
        const tz = await this.resources.tzOfBusiness(businessId);
        const rows = await this.prisma.groupEvent.findMany({ where: { businessId, serviceId, id: { not: excludeEventId }, status: 'scheduled', startAt: { gte: new Date() } }, orderBy: { startAt: 'asc' } });
        return rows.map((e) => groupEventView(e, tz));
    }
    /** F-16-055/048: перенос запрещён в заполненное событие */
    async transferParticipant(businessId, bookingId, targetEventId) {
        const tz = await this.resources.tzOfBusiness(businessId);
        const [booking, target] = await Promise.all([
            this.prisma.booking.findFirst({ where: { id: bookingId, businessId } }),
            this.prisma.groupEvent.findFirst({ where: { id: targetEventId, businessId } }),
        ]);
        if (!booking || !target)
            throw new ApiError('not_found', 'Booking or event not found');
        const participants = await this.prisma.booking.findMany({ where: { groupEventId: targetEventId, businessId, deletedAt: null }, select: { status: true, services: true } });
        const taken = participants.reduce((n, p) => (isActiveBooking(p.status) ? n + Math.max(1, arr(p.services)[0]?.qty ?? 1) : n), 0);
        const seats = Math.max(1, arr(booking.services)[0]?.qty ?? 1);
        if (taken + seats > target.capacity)
            throw new ApiError('group_full', 'Event is full');
        const updated = await this.prisma.booking.update({
            where: { id: bookingId },
            data: { groupEventId: targetEventId, staffId: target.staffId, startAt: target.startAt, endAt: addMin(target.startAt, target.durationMin), durationMin: target.durationMin, version: { increment: 1 } },
        });
        return bookingView(updated, tz);
    }
    // ─────────── ассистенты строки записи (F-16-142/143) ───────────
    async getBookingAssistants(businessId, bookingId, serviceIndex) {
        const b = await this.prisma.booking.findFirst({ where: { id: bookingId, businessId }, select: { extras: true } });
        return bookingExtrasOf(b?.extras).serviceLineExtras?.[serviceIndex]?.assistants ?? [];
    }
    async setBookingAssistants(businessId, bookingId, serviceIndex, assistants, shareRule) {
        const b = await this.prisma.booking.findFirst({ where: { id: bookingId, businessId } });
        if (!b)
            throw new ApiError('not_found', 'Booking not found');
        const normalized = shareRule === 'split'
            ? assistants.map((a, i, arr) => ({ staffId: a.staffId, sharePercent: Math.floor(100 / arr.length) + (i < 100 % Math.max(1, arr.length) ? 1 : 0) }))
            : assistants;
        const extras = bookingExtrasOf(b.extras);
        const lines = [...(extras.serviceLineExtras ?? [])];
        while (lines.length <= serviceIndex)
            lines.push({ discountPct: 0 });
        lines[serviceIndex] = { ...lines[serviceIndex], assistants: normalized.map((a) => ({ staffId: a.staffId, sharePct: a.sharePercent })) };
        await this.prisma.booking.update({ where: { id: bookingId }, data: { extras: { ...extras, serviceLineExtras: lines }, version: { increment: 1 } } });
        return normalized;
    }
    // ─────────── продажа товара/абонемента/сертификата участнику (F-16-059) ───────────
    async listParticipantExtras(businessId, bookingId) {
        const b = await this.prisma.booking.findFirst({ where: { id: bookingId, businessId }, select: { extras: true } });
        return bookingExtrasOf(b?.extras).participantExtras ?? [];
    }
    async addParticipantExtra(businessId, bookingId, kind, name, price) {
        const b = await this.prisma.booking.findFirst({ where: { id: bookingId, businessId } });
        if (!b)
            throw new ApiError('not_found', 'Booking not found');
        const extras = bookingExtrasOf(b.extras);
        const item = { id: newId('goodsLine'), bookingId, kind, name: name.trim(), price };
        const next = [...(extras.participantExtras ?? []), item];
        await this.prisma.booking.update({ where: { id: bookingId }, data: { extras: { ...extras, participantExtras: next }, version: { increment: 1 } } });
        return item;
    }
    async removeParticipantExtra(businessId, bookingId, itemId) {
        const b = await this.prisma.booking.findFirst({ where: { id: bookingId, businessId } });
        if (!b)
            return;
        const extras = bookingExtrasOf(b.extras);
        const next = (extras.participantExtras ?? []).filter((i) => i.id !== itemId);
        await this.prisma.booking.update({ where: { id: bookingId }, data: { extras: { ...extras, participantExtras: next }, version: { increment: 1 } } });
    }
    // ─────────── оплата участника (F-16-060/061) — только фиксируем способ, деньги не принимаем ───────────
    async getParticipantPayment(businessId, bookingId) {
        const b = await this.prisma.booking.findFirst({ where: { id: bookingId, businessId }, select: { extras: true } });
        return bookingExtrasOf(b?.extras).participantPayment;
    }
    async payParticipant(businessId, bookingId, method) {
        const tz = await this.resources.tzOfBusiness(businessId);
        const b = await this.prisma.booking.findFirst({ where: { id: bookingId, businessId } });
        if (!b)
            throw new ApiError('not_found', 'Booking not found');
        if (method === 'membership' && !b.clientId)
            throw new ApiError('no_membership', 'No membership available');
        const extras = bookingExtrasOf(b.extras);
        const extrasTotal = (extras.participantExtras ?? []).reduce((n, i) => n + i.price, 0);
        const next = { ...extras, participantPayment: { method, at: new Date().toISOString() } };
        const updated = await this.prisma.booking.update({
            where: { id: bookingId },
            data: { extras: next, prepayment: { amount: Number(b.total) + extrasTotal, paid: true }, version: { increment: 1 } },
        });
        return bookingView(updated, tz);
    }
    async cancelParticipantPayment(businessId, bookingId) {
        const tz = await this.resources.tzOfBusiness(businessId);
        const b = await this.prisma.booking.findFirst({ where: { id: bookingId, businessId } });
        if (!b)
            throw new ApiError('not_found', 'Booking not found');
        const extras = bookingExtrasOf(b.extras);
        const { participantPayment: _drop, ...rest } = extras;
        const updated = await this.prisma.booking.update({ where: { id: bookingId }, data: { extras: rest, prepayment: Prisma.DbNull, version: { increment: 1 } } });
        return bookingView(updated, tz);
    }
};
ResourcesEventsService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [PrismaService,
        BookingsService,
        GroupEventsService,
        ResourcesService,
        AuditService])
], ResourcesEventsService);
export { ResourcesEventsService };
//# sourceMappingURL=resources-events.service.js.map