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
import { ApiError } from '../../common/errors/api-error.js';
import { newId } from '../../common/ids/ids.js';
import { normalizePhone } from '../../common/phone.js';
import { localDayRangeUtc, localToUtc, nowLocal, utcToLocal } from '../../common/time/time.js';
import { addDays as addDaysLocal, staffDayHours, toMinutes } from '../availability/engine.js';
import { AvailabilityService } from '../availability/availability.service.js';
import { personKeyOf } from '../availability/occupy.js';
import { assertJournal, BookingsService, staffActor } from './bookings.service.js';
import { bookingView, extrasView } from './journal.views.js';
import { extrasOf, linesDuration, occupiesTime } from './rules.js';
const arr = (v) => (Array.isArray(v) ? v : []);
const addMin = (d, m) => new Date(d.getTime() + m * 60_000);
/**
 * Журнал вокруг записей (02 §4, §9): настройки раздела, история, проверки занятости, склейка визитов, пакеты,
 * лист ожидания, медкарта, импорт/выгрузка, «Закрыть окно» (F-00-107). Жизнь самой записи — BookingsService.
 */
let JournalService = class JournalService {
    constructor(bookings, availability) {
        this.bookings = bookings;
        this.availability = availability;
    }
    get prisma() {
        return this.bookings.prisma;
    }
    // ─────────── настройки журнала (F-01-155, F-01-165…180) ───────────
    config(businessId) {
        return this.bookings.settings.get(businessId);
    }
    async patchConfig(ctx, businessId, patch) {
        const personal = Object.keys(patch).every((k) => k === 'staffMarkupMin');
        if (!personal && !ctx.member.permissions.has('settings.manage') && ctx.member.role !== 'owner')
            throw new ApiError('forbidden', 'settings.manage required');
        return this.bookings.settings.update(businessId, (a) => {
            for (const [k, v] of Object.entries(patch)) {
                if (v === undefined)
                    continue;
                if (k === 'settings')
                    a.settings = { ...a.settings, ...v };
                else if (k === 'staffMarkupMin' || k === 'staffJournalRights' || k === 'staffWindowRights' || k === 'hotDiscountPct') {
                    a[k] = { ...a[k], ...v };
                }
                else
                    a[k] = v;
            }
        }, ctx.member.staffId);
    }
    async addCategory(ctx, businessId, input) {
        const def = { id: newId('bookingCategory'), name: input.name.trim(), colorIndex: input.colorIndex, system: false };
        if (!def.name)
            throw new ApiError('name_required', 'Name required');
        await this.bookings.settings.update(businessId, (a) => void a.bookingCategories.push(def), ctx.member.staffId);
        return def;
    }
    async addRecurrenceTemplate(ctx, businessId, input) {
        const tpl = { id: newId('recurrenceTemplate'), name: input.name.trim(), rule: input.rule };
        await this.bookings.settings.update(businessId, (a) => void a.recurrenceTemplates.push(tpl), ctx.member.staffId);
        return tpl;
    }
    // ─────────── история записи (F-01-096) ───────────
    async history(businessIds, bookingId) {
        const b = await this.bookings.find(this.prisma, businessIds, bookingId);
        const tz = await this.bookings.tzOfLocation(this.prisma, b.locationId);
        const rows = await this.prisma.bookingHistory.findMany({ where: { bookingId }, orderBy: { at: 'desc' } });
        return rows.map((r) => ({ id: r.id, bookingId: r.bookingId, authorName: r.authorName, action: r.action, summary: r.summary, at: utcToLocal(r.at, tz) }));
    }
    async logHistory(businessIds, bookingId, input) {
        const b = await this.bookings.find(this.prisma, businessIds, bookingId);
        const tz = await this.bookings.tzOfLocation(this.prisma, b.locationId);
        const r = await this.prisma.bookingHistory.create({
            data: { id: newId('bookingHistory'), bookingId, businessId: b.businessId, authorName: input.authorName.slice(0, 160), action: input.action, summary: input.summary.slice(0, 1000) },
        });
        return { id: r.id, bookingId, authorName: r.authorName, action: r.action, summary: r.summary, at: utcToLocal(r.at, tz) };
    }
    // ─────────── проверки занятости (F-01-034, F-01-114, F-01-215, K4) ───────────
    /**
     * Занято ли время человека (во ВСЕХ его бизнесах, F-00-045) и экземпляров ресурсов; внутри ли рабочих часов.
     * Та же таблица busy_blocks, что проверяет «замок на мастера» при записи, — экран и запись не разойдутся.
     */
    async check(businessId, input) {
        const tz = await this.bookings.tzOfBusiness(this.prisma, businessId);
        const startAt = localToUtc(input.start, tz);
        const endAt = addMin(startAt, input.durationMin);
        const now = new Date();
        const journal = await this.bookings.settings.get(businessId);
        const ignoreNoShow = journal.settings.allowOverlapOverNoShow;
        let overlap = false;
        let withinHours = true;
        if (input.staffId) {
            const staff = await this.prisma.staff.findUnique({ where: { id: input.staffId }, select: { id: true, userId: true } });
            if (staff) {
                overlap =
                    (await this.prisma.busyBlock.count({
                        where: {
                            personKey: personKeyOf(staff),
                            active: true,
                            source: { not: 'mark_busy' },
                            startAt: { lt: endAt },
                            endAt: { gt: startAt },
                            OR: [{ holdUntil: null }, { holdUntil: { gt: now } }],
                            ...(ignoreNoShow ? { noShow: false } : {}),
                            ...(input.excludeBookingId ? { NOT: { source: 'booking', sourceId: input.excludeBookingId } } : {}),
                        },
                    })) > 0;
                const schedules = await this.availability.schedules(this.prisma, [staff.id], input.start.slice(0, 10), input.start.slice(0, 10));
                const hours = staffDayHours(schedules, staff.id, input.start.slice(0, 10));
                const from = toMinutes(input.start.slice(11, 16));
                withinHours = hours.some((h) => toMinutes(h.from) <= from && from + input.durationMin <= toMinutes(h.to));
            }
        }
        let resourceFree = true;
        if (input.resourceId && input.instanceId) {
            resourceFree =
                (await this.prisma.resourceBusy.count({
                    where: {
                        resourceId: input.resourceId,
                        instanceId: input.instanceId,
                        active: true,
                        startAt: { lt: endAt },
                        endAt: { gt: startAt },
                        OR: [{ holdUntil: null }, { holdUntil: { gt: now } }],
                        ...(ignoreNoShow ? { noShow: false } : {}),
                        ...(input.excludeBookingId ? { NOT: { sourceId: input.excludeBookingId } } : {}),
                    },
                })) === 0;
        }
        let occupiedInstanceIds = [];
        if (input.locationId) {
            const resources = await this.prisma.resource.findMany({ where: { businessId, locationId: input.locationId }, select: { id: true } });
            const rows = await this.prisma.resourceBusy.findMany({
                where: {
                    resourceId: { in: resources.map((r) => r.id) },
                    active: true,
                    startAt: { lt: endAt },
                    endAt: { gt: startAt },
                    OR: [{ holdUntil: null }, { holdUntil: { gt: now } }],
                    ...(ignoreNoShow ? { noShow: false } : {}),
                    ...(input.excludeBookingId ? { NOT: { sourceId: input.excludeBookingId } } : {}),
                },
                select: { instanceId: true, resourceId: true },
            });
            occupiedInstanceIds = [...new Set(rows.map((r) => r.instanceId ?? r.resourceId))];
        }
        return { overlap, withinHours, resourceFree, occupiedInstanceIds };
    }
    // ─────────── визит (F-01-041) ───────────
    async visitId(businessId, input) {
        const tz = await this.bookings.tzOfBusiness(this.prisma, businessId);
        const visitId = await this.bookings.resolveVisit(this.prisma, {
            businessId,
            clientId: input.clientId,
            startAt: localToUtc(input.start, tz),
            durationMin: input.durationMin,
            excludeId: input.excludeBookingId,
            tz,
        });
        return { visitId: visitId ?? null };
    }
    /** Статус ставится сразу на весь визит (F-01-041) */
    async syncVisitStatus(actor, businessIds, visitId, status, excludeId) {
        const siblings = await this.prisma.booking.findMany({ where: { businessId: { in: businessIds }, visitId, deletedAt: null, id: { not: excludeId } }, select: { id: true, status: true } });
        for (const s of siblings)
            if (s.status !== status)
                await this.bookings.update(actor, businessIds, s.id, { status });
        return { updated: siblings.length };
    }
    // ─────────── дублирование, запись от бота (F-01-192, F-01-036) ───────────
    async duplicate(ctx, businessIds, id) {
        const src = await this.bookings.find(this.prisma, businessIds, id);
        const tz = await this.bookings.tzOfLocation(this.prisma, src.locationId);
        const e = extrasOf(src.extras);
        // Копия в то же время у того же мастера — двойная запись (F-00-045 важнее): копия встаёт на ближайшее свободное
        // время этого мастера в его рабочие часы после исходной (тот же день, дальше — до 14 дней вперёд)
        const origin = utcToLocal(src.startAt, tz);
        let start = null;
        for (let day = 0; day <= 14 && !start; day++) {
            const date = addDaysLocal(origin.slice(0, 10), day);
            const fromMin = day === 0 ? toMinutes(origin.slice(11, 16)) + src.durationMin : 0;
            for (let m = Math.ceil(fromMin / 15) * 15; m + src.durationMin <= 24 * 60; m += 15) {
                const candidate = `${date}T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
                const c = await this.check(src.businessId, { staffId: src.staffId, start: candidate, durationMin: src.durationMin });
                if (!c.overlap && c.withinHours) {
                    start = candidate;
                    break;
                }
            }
        }
        if (!start)
            throw new ApiError('slot_taken', 'No free time for the copy');
        const copy = await this.bookings.createRaw(staffActor(ctx), {
            businessId: src.businessId,
            locationId: src.locationId,
            staffId: src.staffId,
            clientId: src.clientId ?? undefined,
            appUserId: src.appUserId ?? undefined,
            start,
            durationMin: src.durationMin,
            status: 'scheduled',
            services: arr(src.services),
            resourceIds: [],
            workplace: src.workplace,
            source: 'journal',
            createdBy: src.createdByRef,
            forWhom: src.forWhom,
            visitorName: src.visitorName ?? undefined,
            comment: src.comment ?? undefined,
        });
        await this.bookings.patchExtras(staffActor(ctx), businessIds, copy.id, (x) => {
            x.categoryIds = e.categoryIds;
            x.colorIndex = e.colorIndex;
            x.customFieldValues = e.customFieldValues;
        });
        return copy;
    }
    async external(actor, businessId, input) {
        if (!input.phone.trim())
            throw new ApiError('phone_required', 'Phone required');
        if (!input.name.trim())
            throw new ApiError('name_required', 'Name required');
        const svc = await this.prisma.service.findFirst({ where: { id: input.serviceId, businessId } });
        if (!svc)
            throw new ApiError('not_found', 'Service not found');
        let staffId = input.staffId;
        if (!staffId) {
            const duration = svc.durationMax ?? svc.durationMin;
            for (const id of arr(svc.staffIds)) {
                const c = await this.check(businessId, { staffId: id, start: input.start, durationMin: duration });
                if (!c.overlap) {
                    staffId = id;
                    break;
                }
            }
            if (!staffId)
                throw new ApiError('no_free_staff', 'No free staff');
        }
        const res = await this.bookings.place(actor, {
            source: 'external',
            businessId,
            locationId: input.locationId,
            staffId,
            start: input.start,
            services: [{ serviceId: input.serviceId }],
            client: { phone: input.phone, name: input.name },
            createdBy: 'client',
        });
        return res.booking;
    }
    // ─────────── пакеты (F-01-113, F-01-134…136, F-16-125…130) ───────────
    packageView(g) {
        return { id: g.id, businessId: g.businessId, order: g.orderMode, bookingIds: arr(g.bookingIds), createdAt: utcToLocal(g.createdAt) };
    }
    async createPackage(ctx, businessId, input) {
        const actor = staffActor(ctx);
        const created = [];
        let cursor = input.start;
        try {
            for (const step of input.steps) {
                const start = input.order === 'parallel' ? input.start : cursor;
                const b = await this.bookings.createRaw(actor, {
                    businessId,
                    locationId: input.locationId,
                    staffId: step.staffId,
                    clientId: input.clientId,
                    start,
                    durationMin: step.durationMin,
                    status: 'scheduled',
                    services: [{ serviceId: step.serviceId, staffId: step.staffId, price: step.price, durationMin: step.durationMin, qty: 1 }],
                    resourceIds: [],
                    workplace: 'salon',
                    source: 'journal',
                    createdBy: input.createdBy,
                    forWhom: 'self',
                    comment: input.comment,
                });
                created.push(b);
                if (input.order === 'sequential_one') {
                    const next = toMinutes(cursor.slice(11, 16)) + step.durationMin + (step.bufferAfterMin ?? 0);
                    cursor = `${cursor.slice(0, 10)}T${String(Math.floor(next / 60)).padStart(2, '0')}:${String(next % 60).padStart(2, '0')}`;
                }
            }
        }
        catch (e) {
            // Пакет — всё или ничего: уже созданные записи пакета снимаются
            for (const b of created)
                await this.bookings.remove(actor, [businessId], b.id).catch(() => undefined);
            throw e;
        }
        const groupId = newId('packageGroup');
        await this.prisma.packageGroup.create({ data: { id: groupId, businessId, orderMode: input.order, bookingIds: created.map((b) => b.id) } });
        for (const b of created)
            await this.bookings.patchExtras(actor, [businessId], b.id, (e) => void (e.packageGroupId = groupId));
        return { groupId, bookings: created };
    }
    async getPackage(businessIds, groupId) {
        const g = await this.prisma.packageGroup.findFirst({ where: { id: groupId, businessId: { in: businessIds } } });
        return g ? this.packageView(g) : null;
    }
    async packageSiblings(businessIds, bookingId) {
        const b = await this.bookings.find(this.prisma, businessIds, bookingId);
        const groupId = extrasOf(b.extras).packageGroupId;
        if (!groupId)
            return [];
        const g = await this.prisma.packageGroup.findUnique({ where: { id: groupId } });
        if (!g)
            return [];
        const rows = await this.prisma.booking.findMany({ where: { id: { in: arr(g.bookingIds).filter((id) => id !== bookingId) }, deletedAt: null } });
        const staff = await this.prisma.staff.findMany({ where: { id: { in: rows.map((r) => r.staffId) } }, select: { id: true, name: true } });
        const out = [];
        for (const r of rows)
            out.push({ booking: await this.bookings.view(this.prisma, r), staffName: staff.find((s) => s.id === r.staffId)?.name ?? '' });
        return out;
    }
    async transferPackage(ctx, businessIds, bookingId, deltaMin, authorName) {
        const siblings = await this.packageSiblings(businessIds, bookingId);
        for (const { booking } of siblings) {
            const startMin = (((toMinutes(booking.start.slice(11, 16)) + deltaMin) % 1440) + 1440) % 1440;
            const start = `${booking.start.slice(0, 10)}T${String(Math.floor(startMin / 60)).padStart(2, '0')}:${String(startMin % 60).padStart(2, '0')}`;
            await this.bookings.update(staffActor(ctx), businessIds, booking.id, { start });
            await this.logHistory(businessIds, booking.id, { authorName, action: 'updated', summary: 'Перенесено вместе с пакетом' });
        }
        return { moved: siblings.length };
    }
    async deletePackage(ctx, businessIds, bookingId, authorName) {
        const b = await this.bookings.find(this.prisma, businessIds, bookingId);
        const groupId = extrasOf(b.extras).packageGroupId;
        const g = groupId ? await this.prisma.packageGroup.findUnique({ where: { id: groupId } }) : null;
        const ids = g ? arr(g.bookingIds) : [bookingId];
        for (const id of ids)
            await this.bookings.remove(staffActor(ctx), businessIds, id, { byName: authorName }).catch(() => undefined);
        return ids;
    }
    async checkLinked(businessId, plans) {
        const problems = [];
        for (const p of plans) {
            const duration = p.lines.reduce((n, l) => n + l.durationMin, 0);
            const c = await this.check(businessId, { staffId: p.staffId, start: p.start, durationMin: duration });
            if (c.overlap)
                problems.push({ staffId: p.staffId, reason: 'busy' });
            else if (!c.withinHours)
                problems.push({ staffId: p.staffId, reason: 'offHours' });
        }
        return problems;
    }
    async attachLinked(ctx, businessId, input) {
        const actor = staffActor(ctx);
        const newIds = [];
        try {
            for (const plan of input.plans) {
                const b = await this.bookings.createRaw(actor, {
                    businessId,
                    locationId: input.locationId,
                    staffId: plan.staffId,
                    clientId: input.clientId,
                    start: plan.start,
                    durationMin: plan.lines.reduce((n, l) => n + l.durationMin, 0),
                    status: 'scheduled',
                    services: plan.lines.map((l) => ({ serviceId: l.serviceId, staffId: plan.staffId, price: l.price, durationMin: l.durationMin, qty: 1 })),
                    resourceIds: [],
                    workplace: 'salon',
                    source: 'journal',
                    createdBy: input.createdBy,
                    forWhom: 'self',
                });
                newIds.push(b.id);
            }
        }
        catch (e) {
            for (const id of newIds)
                await this.bookings.remove(actor, [businessId], id).catch(() => undefined);
            throw e;
        }
        const main = await this.bookings.find(this.prisma, [businessId], input.mainBookingId);
        const existingId = extrasOf(main.extras).packageGroupId;
        const existing = existingId ? await this.prisma.packageGroup.findUnique({ where: { id: existingId } }) : null;
        const groupId = existing?.id ?? newId('packageGroup');
        if (existing) {
            await this.prisma.packageGroup.update({
                where: { id: groupId },
                data: { orderMode: input.order === 'parallel' ? 'parallel' : existing.orderMode, bookingIds: [...arr(existing.bookingIds), ...newIds] },
            });
        }
        else {
            await this.prisma.packageGroup.create({ data: { id: groupId, businessId, orderMode: input.order, bookingIds: [input.mainBookingId, ...newIds] } });
        }
        for (const id of [input.mainBookingId, ...newIds])
            await this.bookings.patchExtras(actor, [businessId], id, (e) => void (e.packageGroupId = groupId));
        return newIds;
    }
    // ─────────── серия повторов из окна записи (F-01-100…107) ───────────
    /**
     * Копии — самостоятельные записи с общим seriesId (F-01-107), без предоплаты исходной (360426); занятое время
     * мастера пропускается, а не создаёт двойную запись (F-00-045). Даты считает окно (generateOccurrenceDates).
     */
    async createRecurrence(ctx, businessIds, sourceId, input) {
        const src = await this.bookings.find(this.prisma, businessIds, sourceId);
        assertJournal(ctx, 'journal.create', src.staffId);
        const seriesId = newId('recurrenceSeries');
        await this.prisma.bookingSeries.create({
            data: {
                id: seriesId,
                businessId: src.businessId,
                locationId: src.locationId,
                staffId: src.staffId,
                kind: 'recurrence',
                rule: { rule: input.rule, sourceBookingId: sourceId, dates: input.dates },
                active: false,
                createdUntil: input.dates.at(-1) ?? null,
                createdByName: ctx.member.name,
                createdBy: ctx.member.staffId,
            },
        });
        const created = [];
        let skipped = 0;
        for (const date of input.dates.slice(0, 366)) {
            try {
                created.push(await this.bookings.createRaw(staffActor(ctx), {
                    businessId: src.businessId,
                    locationId: src.locationId,
                    staffId: src.staffId,
                    clientId: input.rule.withClient ? (src.clientId ?? undefined) : undefined,
                    start: `${date}T${input.rule.time}`,
                    durationMin: src.durationMin,
                    status: 'scheduled',
                    services: arr(src.services),
                    resourceIds: arr(src.resourceIds),
                    workplace: src.workplace,
                    source: src.source,
                    createdBy: src.createdByRef,
                    forWhom: src.forWhom,
                    comment: src.comment ?? undefined,
                    seriesId,
                }));
            }
            catch (e) {
                if (e instanceof ApiError && (e.code === 'slot_taken' || e.code === 'resource_unavailable'))
                    skipped++;
                else
                    throw e;
            }
        }
        return { created, skipped, seriesId };
    }
    async seriesBookings(businessIds, seriesId) {
        const rows = await this.prisma.booking.findMany({ where: { businessId: { in: businessIds }, seriesId, deletedAt: null }, orderBy: { startAt: 'asc' } });
        return this.bookings.views(this.prisma, rows);
    }
    async deleteSeries(ctx, businessIds, seriesId, byName) {
        const rows = await this.prisma.booking.findMany({ where: { businessId: { in: businessIds }, seriesId, deletedAt: null }, select: { id: true } });
        for (const r of rows)
            await this.bookings.remove(staffActor(ctx), businessIds, r.id, { byName });
        await this.prisma.bookingSeries.updateMany({ where: { id: seriesId }, data: { active: false } });
        return { deleted: rows.length };
    }
    // ─────────── лист ожидания (F-01-156…162; одна таблица с приложением, 01 §7.1) ───────────
    waitlistView(e) {
        return {
            id: e.id,
            businessId: e.businessId,
            locationId: e.locationId ?? '',
            clientName: e.clientName,
            clientPhone: e.clientPhone,
            serviceIds: arr(e.serviceIds),
            staffIds: arr(e.staffIds),
            slots: arr(e.slots),
            comment: e.comment,
            ...(e.bookingId ? { bookingId: e.bookingId } : {}),
            ...(e.notifiedAt ? { notifiedAt: utcToLocal(e.notifiedAt) } : {}),
            createdAt: utcToLocal(e.createdAt),
        };
    }
    async listWaitlist(businessId, f) {
        const today = nowLocal().slice(0, 10);
        let rows = (await this.prisma.waitlistEntry.findMany({ where: { businessId }, orderBy: { createdAt: 'desc' } })).map((e) => {
            const v = this.waitlistView(e);
            const status = v.bookingId ? 'closed' : v.slots.some((s) => !s.date || s.date >= today) ? 'active' : 'expired';
            return { ...v, status };
        });
        const status = f.status ?? 'active';
        if (status !== 'all')
            rows = rows.filter((r) => r.status === status);
        const dateMode = f.dateMode ?? 'selected';
        if (dateMode !== 'all') {
            const target = dateMode === 'today' ? today : f.selectedDate;
            if (target)
                rows = rows.filter((r) => r.slots.some((s) => !s.date || s.date === target));
        }
        const q = (f.query ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
        if (q.length >= 2) {
            const digits = q.replace(/\D/g, '');
            rows = rows.filter((r) => r.clientName.toLowerCase().includes(q) || (digits && r.clientPhone.replace(/\D/g, '').includes(digits)));
        }
        const earliest = (r) => r.slots.map((s) => s.date).filter((d) => Boolean(d)).sort()[0];
        const sort = f.sort ?? 'soonest';
        rows.sort((a, b) => {
            if (sort === 'newest')
                return b.createdAt.localeCompare(a.createdAt);
            if (sort === 'oldest')
                return a.createdAt.localeCompare(b.createdAt);
            const da = earliest(a);
            const db = earliest(b);
            if (da && db)
                return da.localeCompare(db);
            if (da)
                return -1;
            if (db)
                return 1;
            return b.createdAt.localeCompare(a.createdAt);
        });
        return rows;
    }
    async createWaitlist(ctx, businessId, input) {
        const phone = normalizePhone(input.clientPhone) ?? input.clientPhone;
        const client = await this.prisma.client.findFirst({ where: { businessId, phone, deletedAt: null }, select: { id: true } });
        const e = await this.prisma.waitlistEntry.create({
            data: {
                id: newId('waitlistEntry'),
                businessId,
                locationId: input.locationId ?? null,
                clientName: input.clientName.trim(),
                clientPhone: phone,
                clientId: client?.id ?? null,
                serviceIds: input.serviceIds,
                staffIds: input.staffIds,
                slots: input.slots,
                comment: input.comment ?? '',
                createdBy: ctx.member.staffId,
            },
        });
        return this.waitlistView(e);
    }
    async updateWaitlist(businessId, id, patch) {
        const cur = await this.prisma.waitlistEntry.findFirst({ where: { id, businessId } });
        if (!cur)
            throw new ApiError('not_found', 'Waitlist entry not found');
        const e = await this.prisma.waitlistEntry.update({
            where: { id },
            data: {
                ...(patch.locationId !== undefined ? { locationId: patch.locationId } : {}),
                ...(patch.clientName !== undefined ? { clientName: patch.clientName.trim() } : {}),
                ...(patch.clientPhone !== undefined ? { clientPhone: normalizePhone(patch.clientPhone) ?? patch.clientPhone } : {}),
                ...(patch.serviceIds !== undefined ? { serviceIds: patch.serviceIds } : {}),
                ...(patch.staffIds !== undefined ? { staffIds: patch.staffIds } : {}),
                ...(patch.slots !== undefined ? { slots: patch.slots } : {}),
                ...(patch.comment !== undefined ? { comment: patch.comment } : {}),
                version: { increment: 1 },
            },
        });
        return this.waitlistView(e);
    }
    async closeWaitlist(businessId, id, bookingId) {
        const res = await this.prisma.waitlistEntry.updateMany({ where: { id, businessId }, data: { bookingId } });
        if (!res.count)
            throw new ApiError('not_found', 'Waitlist entry not found');
    }
    async deleteWaitlist(businessId, id) {
        await this.prisma.waitlistEntry.deleteMany({ where: { id, businessId } });
    }
    // ─────────── медицинские сферы (F-01-189…191) ───────────
    async medicalVisit(businessIds, bookingId) {
        const r = await this.prisma.medicalVisitNote.findFirst({ where: { bookingId, businessId: { in: businessIds } } });
        return r ? { bookingId, ...r.data, authorName: r.authorName, updatedAt: utcToLocal(r.updatedAt) } : null;
    }
    async setMedicalVisit(businessIds, bookingId, patch, authorName) {
        const b = await this.bookings.find(this.prisma, businessIds, bookingId);
        const cur = await this.prisma.medicalVisitNote.findUnique({ where: { bookingId } });
        const data = { ...(cur?.data ?? {}), ...patch };
        const r = await this.prisma.medicalVisitNote.upsert({
            where: { bookingId },
            create: { bookingId, businessId: b.businessId, data, authorName },
            update: { data, authorName },
        });
        return { bookingId, ...r.data, authorName: r.authorName, updatedAt: utcToLocal(r.updatedAt) };
    }
    async medicalCard(businessId, clientId) {
        const r = await this.prisma.medicalCard.findFirst({ where: { clientId, businessId } });
        return r ? { clientId, ...r.data, updatedAt: utcToLocal(r.updatedAt) } : null;
    }
    async setMedicalCard(businessId, clientId, patch) {
        const client = await this.prisma.client.findFirst({ where: { id: clientId, businessId }, select: { id: true } });
        if (!client)
            throw new ApiError('not_found', 'Client not found');
        const cur = await this.prisma.medicalCard.findUnique({ where: { clientId } });
        const data = { filledAt: nowLocal().slice(0, 10), ...(cur?.data ?? {}), ...patch };
        const r = await this.prisma.medicalCard.upsert({ where: { clientId }, create: { clientId, businessId, data }, update: { data } });
        return { clientId, ...r.data, updatedAt: utcToLocal(r.updatedAt) };
    }
    planView(p) {
        return { id: p.id, clientId: p.clientId, title: p.title, items: arr(p.items), createdAt: utcToLocal(p.createdAt), updatedAt: utcToLocal(p.updatedAt) };
    }
    async listPlans(businessId, clientId) {
        const rows = await this.prisma.treatmentPlan.findMany({ where: { businessId, clientId }, orderBy: { createdAt: 'desc' } });
        return rows.map((p) => this.planView(p));
    }
    /** F-01-191: цена в плане — текущая минимальная у услуги */
    async refreshPlanPrices(businessId, clientId) {
        const rows = await this.prisma.treatmentPlan.findMany({ where: { businessId, clientId } });
        const ids = [...new Set(rows.flatMap((p) => arr(p.items).map((i) => i.serviceId)))];
        const prices = new Map((await this.prisma.service.findMany({ where: { id: { in: ids } }, select: { id: true, priceMin: true } })).map((s) => [s.id, Number(s.priceMin)]));
        for (const p of rows) {
            const items = arr(p.items).map((i) => ({ ...i, priceMin: prices.get(i.serviceId) ?? i.priceMin }));
            await this.prisma.treatmentPlan.update({ where: { id: p.id }, data: { items } });
        }
    }
    async addPlan(businessId, clientId, input) {
        const prices = new Map((await this.prisma.service.findMany({ where: { id: { in: input.serviceIds }, businessId }, select: { id: true, priceMin: true } })).map((s) => [s.id, Number(s.priceMin)]));
        const p = await this.prisma.treatmentPlan.create({
            data: {
                id: newId('treatmentPlan'),
                businessId,
                clientId,
                title: input.title,
                items: input.serviceIds.map((serviceId) => ({ id: newId('treatmentPlanItem'), serviceId, priceMin: prices.get(serviceId) ?? 0 })),
            },
        });
        return this.planView(p);
    }
    async duplicatePlan(businessId, clientId, planId) {
        const src = await this.prisma.treatmentPlan.findFirst({ where: { id: planId, businessId, clientId } });
        if (!src)
            return null;
        const p = await this.prisma.treatmentPlan.create({
            data: {
                id: newId('treatmentPlan'),
                businessId,
                clientId,
                title: `${src.title} · copy`,
                items: arr(src.items).map((i) => ({ ...i, id: newId('treatmentPlanItem') })),
            },
        });
        return this.planView(p);
    }
    async deletePlan(businessId, clientId, planId) {
        await this.prisma.treatmentPlan.deleteMany({ where: { id: planId, businessId, clientId } });
    }
    // ─────────── метки клиента из окна записи (F-01-070) ───────────
    async setClientTags(ctx, businessId, clientId, tags) {
        await this.prisma.$transaction(async (tx) => {
            const c = await tx.client.findFirst({ where: { id: clientId, businessId, deletedAt: null }, select: { tags: true } });
            if (!c)
                throw new ApiError('not_found', 'Client not found');
            await tx.client.update({ where: { id: clientId }, data: { tags, updatedBy: ctx.member.staffId, version: { increment: 1 } } });
            const { AuditService } = await import('../../common/audit/audit.service.js');
            await new AuditService().record(tx, ctx, { action: 'updated', entityType: 'client', entityId: clientId, businessId, before: { tags: c.tags }, after: { tags } });
        });
    }
    // ─────────── импорт и выгрузка «Записей» (F-01-182, F-01-183) ───────────
    async importRows(ctx, businessId, locationId, createdBy, rows) {
        const STATUS = { '-1': 'no_show', '0': 'scheduled', '1': 'arrived', '2': 'client_confirmed', 'не пришел': 'no_show', ожидание: 'scheduled', пришел: 'arrived', подтвердил: 'client_confirmed' };
        const actor = staffActor(ctx);
        const errors = [];
        let createdCount = 0;
        for (const [index, row] of rows.slice(0, 5000).entries()) {
            try {
                const phone = normalizePhone(row.clientPhone);
                if (!phone)
                    throw new Error('phone');
                let client = await this.prisma.client.findFirst({ where: { businessId, phone, deletedAt: null }, select: { id: true } });
                if (!client)
                    client = await this.prisma.client.create({ data: { id: newId('client'), businessId, phone, name: row.clientName || phone, gender: 'unknown', tags: [], source: 'import' }, select: { id: true } });
                const m = /^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})$/.exec(row.dateTime.trim());
                if (!m)
                    throw new Error('bad_date');
                const start = `${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}`;
                const status = STATUS[row.statusRaw.trim().toLowerCase()] ?? 'scheduled';
                const durationMin = Math.max(15, Math.round((row.durationMin ?? 15) / 15) * 15);
                const price = Math.round(row.price * (1 - (row.discountPct ?? 0) / 100));
                const b = await this.bookings.createRaw(actor, {
                    businessId,
                    locationId,
                    staffId: row.staffId,
                    clientId: client.id,
                    start,
                    durationMin,
                    status,
                    services: [{ serviceId: 'imported', staffId: row.staffId, price, durationMin, qty: 1 }],
                    resourceIds: [],
                    workplace: 'salon',
                    source: 'import',
                    createdBy,
                    forWhom: 'self',
                    comment: row.comment,
                });
                if (status === 'arrived' && row.paidAmount)
                    await this.bookings.patchExtras(actor, [businessId], b.id, (e) => void (e.paidAmount = row.paidAmount));
                createdCount++;
            }
            catch {
                errors.push(`#${index + 2}: ${row.clientName || row.clientPhone}`);
            }
        }
        await this.logDataOp(ctx, businessId, 'import', createdCount);
        return { createdCount, errorCount: errors.length, errors };
    }
    async logDataOp(ctx, businessId, kind, count) {
        const r = await this.prisma.dataExport.create({
            data: { id: newId('dataExport'), businessId, area: kind === 'import' ? 'bookings-import' : 'bookings', authorId: ctx.member.staffId, authorName: ctx.member.name, count },
        });
        return { id: r.id, kind, count, authorStaffId: r.authorId ?? '', at: utcToLocal(r.at) };
    }
    async dataOps(businessId, authorStaffId) {
        const rows = await this.prisma.dataExport.findMany({ where: { businessId, area: { in: ['bookings', 'bookings-import'] }, authorId: authorStaffId }, orderBy: { at: 'desc' }, take: 100 });
        return rows.map((r) => ({ id: r.id, kind: r.area === 'bookings-import' ? 'import' : 'export', count: r.count, authorStaffId: r.authorId ?? '', at: utcToLocal(r.at) }));
    }
    // ─────────── зеркало для экранов, ещё считающих у себя (PLAN §7, до этапа 21) ───────────
    /** Записи бизнеса за период + их доп. данные + групповые события + пакеты — одним ответом */
    async mirror(businessIds, from, to) {
        const tz = await this.bookings.tzOfBusiness(this.prisma, businessIds[0] ?? '');
        const range = { gte: localDayRangeUtc(from, tz).from, lt: localDayRangeUtc(to, tz).to };
        const rows = await this.prisma.booking.findMany({ where: { businessId: { in: businessIds }, startAt: range }, orderBy: { startAt: 'asc' } });
        const events = await this.prisma.groupEvent.findMany({ where: { businessId: { in: businessIds }, startAt: range }, orderBy: { startAt: 'asc' } });
        const groups = await this.prisma.packageGroup.findMany({ where: { businessId: { in: businessIds } } });
        const bookings = [];
        const extras = {};
        for (const r of rows) {
            const ltz = await this.bookings.tzOfLocation(this.prisma, r.locationId);
            bookings.push(bookingView(r, ltz));
            if (hasExtras(r))
                extras[r.id] = extrasView(r, ltz);
        }
        const { groupEventView } = await import('./journal.views.js');
        // Карточки клиентов этих записей — в форме ядра (не вся CRM: зеркало клиентов ограничено тем, что открыто, K8)
        const clientIds = [...new Set(rows.map((r) => r.clientId).filter((x) => Boolean(x)))];
        const clients = clientIds.length ? await this.prisma.client.findMany({ where: { id: { in: clientIds } } }) : [];
        const { coreClient } = await import('./bookings.service.js');
        return {
            businessIds,
            from,
            to,
            bookings,
            extras,
            groupEvents: events.map((e) => groupEventView(e, tz)),
            packageGroups: groups.map((g) => this.packageView(g)),
            clients: clients.map((c) => ({ ...coreClient(c), ...(c.email ? { email: c.email } : {}), ...(c.note ? { note: c.note } : {}), ...(c.blocked !== null ? { blocked: c.blocked } : {}), ...(c.deletedAt ? { deletedAt: utcToLocal(c.deletedAt) } : {}) })),
        };
    }
    // ─────────── «Закрыть окно» ссылкой из переписки (F-00-107) ───────────
    /** Выдать (или найти живую) ссылку на ближайшее окно мастера — зовёт карточка мастера клиента (этап 9) */
    async mintClaim(input) {
        const tz = await this.bookings.tzOfBusiness(this.prisma, input.businessId);
        const startAt = localToUtc(input.start, tz);
        const existing = await this.prisma.slotClaim.findFirst({
            where: { businessId: input.businessId, staffId: input.staffId, serviceId: input.serviceId ?? null, startLocal: input.start, status: 'pending', clientPhone: input.clientPhone ?? null, createdAt: { gt: new Date(Date.now() - 7 * 86_400_000) } },
        });
        if (existing)
            return existing.token;
        const token = newId('slotClaim');
        await this.prisma.slotClaim.create({
            data: { token, businessId: input.businessId, staffId: input.staffId, serviceId: input.serviceId ?? null, startLocal: input.start, startAt, clientName: input.clientName ?? null, clientPhone: input.clientPhone ?? null },
        });
        return token;
    }
};
JournalService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [BookingsService,
        AvailabilityService])
], JournalService);
export { JournalService };
function hasExtras(r) {
    const e = r.extras;
    return Boolean(r.deletedAt || Number(r.paidAmount) > 0 || (e && Object.keys(e).length > 0));
}
export { linesDuration, occupiesTime };
//# sourceMappingURL=journal.service.js.map