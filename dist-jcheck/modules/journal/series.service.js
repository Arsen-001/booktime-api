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
import { ApiError } from '../../common/errors/api-error.js';
import { newId } from '../../common/ids/ids.js';
import { nowLocal, utcToLocal } from '../../common/time/time.js';
import { AvailabilityService } from '../availability/availability.service.js';
import { addDays, eachDay, staffDayHours, toMinutes, weekdayIndex } from '../availability/engine.js';
import { assertJournal, BookingsService, SYSTEM_ACTOR, staffActor } from './bookings.service.js';
/** F-00-064 / A11 (PLAN §6 №6): создаются на 8 недель вперёд, продлеваются ночью, когда до конца осталось < 2 недель */
export const SERIES_HORIZON_WEEKS = 8;
export const SERIES_REFILL_WEEKS = 2;
/** Дата попала на выходной/занято — ищем следующий свободный день не дальше этого */
export const SERIES_MAX_SHIFT_DAYS = 14;
function occurrenceDates(rule, from, to) {
    const dates = [];
    if (rule.kind === 'weekly') {
        for (const d of eachDay(from < rule.startDate ? rule.startDate : from, to))
            if (weekdayIndex(d) === rule.weekday)
                dates.push(d);
        return dates;
    }
    const interval = Math.max(1, rule.intervalDays ?? 7);
    let d = rule.startDate;
    while (d < from)
        d = addDays(d, interval);
    while (d <= to) {
        dates.push(d);
        d = addDays(d, interval);
    }
    return dates;
}
export function seriesFirstDate(kind, startDate, weekday) {
    if (kind !== 'weekly' || weekday === undefined)
        return startDate;
    let d = startDate;
    for (let i = 0; i < 7 && weekdayIndex(d) !== weekday; i++)
        d = addDays(d, 1);
    return d;
}
const plusWeeks = (date, w) => dayjs(date).add(w, 'week').format('YYYY-MM-DD');
/**
 * Повторяющиеся записи по правилу (F-00-064, K5): правило в booking_series (kind=rule), записи — обычные записи с
 * seriesId через единый поток (замок на мастера). Выходной или занято — запись переезжает на ближайший свободный день;
 * отмена одной не трогает серию. Ночью воркер продлевает активные серии (extendDue).
 */
let SeriesService = class SeriesService {
    constructor(bookings, availability) {
        this.bookings = bookings;
        this.availability = availability;
    }
    get prisma() {
        return this.bookings.prisma;
    }
    ruleOf(row) {
        return { ...row.rule, id: row.id, active: row.active };
    }
    async list(businessId, staffId) {
        const rows = await this.prisma.bookingSeries.findMany({ where: { businessId, kind: 'rule', ...(staffId ? { staffId } : {}) }, orderBy: { createdAt: 'asc' } });
        return rows.map((r) => this.ruleOf(r));
    }
    async hoursFits(staffId, locationId, date, time, durationMin, cache) {
        let schedules = cache.get(staffId);
        if (!schedules) {
            schedules = (await this.availability.schedules(this.prisma, [staffId]));
            cache.set(staffId, schedules);
        }
        const startMin = toMinutes(time);
        return staffDayHours(schedules, staffId, date, locationId).some((h) => toMinutes(h.from) <= startMin && toMinutes(h.to) - startMin >= durationMin);
    }
    async preview(input) {
        const start = seriesFirstDate(input.kind, input.startDate, input.weekday);
        const dates = occurrenceDates({ ...input, startDate: start }, start, plusWeeks(start, SERIES_HORIZON_WEEKS));
        const cache = new Map();
        let offDays = 0;
        for (const d of dates)
            if (!(await this.hoursFits(input.staffId, input.locationId, d, input.time, input.durationMin, cache)))
                offDays++;
        return { firstDate: dates[0] ?? input.startDate, count: dates.length, offDays };
    }
    async generate(actor, rule, from, to, createdBy) {
        const occurrences = [];
        let movedCount = 0;
        let skipped = 0;
        const cache = new Map();
        for (const original of occurrenceDates(rule, from, to)) {
            let created = null;
            for (let i = 0; i <= SERIES_MAX_SHIFT_DAYS && !created; i++) {
                const d = addDays(original, i);
                if (!(await this.hoursFits(rule.staffId, rule.locationId, d, rule.time, rule.durationMin, cache)))
                    continue;
                try {
                    const res = await this.bookings.place(actor, {
                        source: 'journal',
                        businessId: rule.businessId,
                        locationId: rule.locationId,
                        staffId: rule.staffId,
                        start: `${d}T${rule.time}`,
                        services: [{ serviceId: rule.serviceId }],
                        client: rule.clientId ? { clientId: rule.clientId } : rule.clientPhone ? { phone: rule.clientPhone, name: rule.clientName } : undefined,
                        createdBy,
                        seriesId: rule.id,
                    });
                    created = { bookingId: res.booking.id, date: d, time: rule.time, moved: d !== original };
                }
                catch (e) {
                    if (!(e instanceof ApiError))
                        throw e;
                    if (e.code !== 'slot_taken' && e.code !== 'resource_unavailable' && e.code !== 'outside_hours')
                        throw e;
                }
            }
            if (!created)
                skipped++;
            else {
                if (created.moved)
                    movedCount++;
                occurrences.push(created);
            }
        }
        if (occurrences.length) {
            const last = occurrences.map((o) => o.date).sort().at(-1);
            await this.prisma.bookingSeries.update({ where: { id: rule.id }, data: { createdUntil: last } });
        }
        return { occurrences, movedCount, skipped };
    }
    async create(ctx, businessId, input) {
        assertJournal(ctx, 'journal.create', input.staffId);
        const startDate = seriesFirstDate(input.kind, input.startDate, input.weekday);
        const id = newId('seriesRule');
        const rule = {
            id,
            businessId,
            locationId: input.locationId,
            staffId: input.staffId,
            serviceId: input.serviceId,
            durationMin: input.durationMin,
            ...(input.clientId ? { clientId: input.clientId } : {}),
            ...(input.clientName ? { clientName: input.clientName } : {}),
            ...(input.clientPhone ? { clientPhone: input.clientPhone } : {}),
            kind: input.kind,
            ...(input.intervalDays ? { intervalDays: input.intervalDays } : {}),
            ...(input.weekday !== undefined ? { weekday: input.weekday } : {}),
            time: input.time,
            startDate,
            active: true,
            createdAt: nowLocal(),
            createdByName: input.createdByName ?? ctx.member.name,
        };
        await this.prisma.bookingSeries.create({
            data: { id, businessId, locationId: rule.locationId, staffId: rule.staffId, kind: 'rule', rule: rule, createdByName: rule.createdByName, createdBy: ctx.member.staffId },
        });
        const result = await this.generate(staffActor(ctx), rule, startDate, plusWeeks(startDate, SERIES_HORIZON_WEEKS), input.createdBy ?? ctx.member.staffId);
        return { rule, ...result };
    }
    async occurrences(businessIds, seriesId) {
        const rows = await this.prisma.booking.findMany({ where: { businessId: { in: businessIds }, seriesId, deletedAt: null }, orderBy: { startAt: 'asc' } });
        return this.bookings.views(this.prisma, rows);
    }
    /** Продлить серию: onlyIfNeeded — только если до конца созданного осталось меньше SERIES_REFILL_WEEKS */
    async extend(actor, businessId, seriesId, onlyIfNeeded, createdBy) {
        const row = await this.prisma.bookingSeries.findFirst({ where: { id: seriesId, businessId, kind: 'rule' } });
        if (!row)
            throw new ApiError('not_found', 'Series not found');
        const rule = this.ruleOf(row);
        if (onlyIfNeeded && !rule.active)
            return null;
        const last = await this.prisma.booking.findFirst({ where: { seriesId, deletedAt: null }, orderBy: { startAt: 'desc' }, select: { startAt: true, locationId: true } });
        const lastDate = last ? utcToLocal(last.startAt).slice(0, 10) : null;
        const today = nowLocal().slice(0, 10);
        if (onlyIfNeeded && lastDate && lastDate >= plusWeeks(today, SERIES_REFILL_WEEKS))
            return null;
        const from = lastDate ? addDays(lastDate, 1) : rule.startDate < today ? today : rule.startDate;
        const to = plusWeeks(from, SERIES_HORIZON_WEEKS);
        const result = await this.generate(actor, rule, from, to, createdBy ?? (actor.kind === 'staff' ? actor.ref : 'client'));
        if (onlyIfNeeded && !result.occurrences.length)
            return null;
        return { rule, ...result };
    }
    async setActive(businessId, seriesId, active) {
        const row = await this.prisma.bookingSeries.findFirst({ where: { id: seriesId, businessId } });
        if (!row)
            throw new ApiError('not_found', 'Series not found');
        await this.prisma.bookingSeries.update({ where: { id: seriesId }, data: { active, rule: { ...row.rule, active } } });
    }
    async extendDue(actor, businessId) {
        const rows = await this.prisma.bookingSeries.findMany({ where: { kind: 'rule', active: true, ...(businessId ? { businessId } : {}) }, select: { id: true, businessId: true } });
        let added = 0;
        for (const r of rows) {
            try {
                added += (await this.extend(actor, r.businessId, r.id, true))?.occurrences.length ?? 0;
            }
            catch {
                /* одна сломанная серия не останавливает остальные */
            }
        }
        return added;
    }
};
SeriesService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [BookingsService,
        AvailabilityService])
], SeriesService);
export { SeriesService };
export { SYSTEM_ACTOR };
//# sourceMappingURL=series.service.js.map