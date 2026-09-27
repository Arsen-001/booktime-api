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
import { ApiError } from '../../common/errors/api-error.js';
import { newId } from '../../common/ids/ids.js';
import { PrismaService } from '../../common/prisma.service.js';
import { DEFAULT_TZ, localDayRangeUtc, nowLocal, utcToLocal } from '../../common/time/time.js';
import { staffViewWithLogin } from '../businesses/views.js';
import { AvailabilityService, DEFAULT_SCHEDULE_SETTINGS } from '../availability/availability.service.js';
import { addDays, eachDay, hoursText, intervalsToRanges, mergeIntervals, minutesOf, rangesToIntervals, scheduleHours, staffDayHours, stripBreaks, toMinutes, weekStart, weekdayIndex, } from '../availability/engine.js';
export const DEFAULT_DAY_RANGE = { from: '10:00', to: '19:00' };
const EMPTY_WEEK = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
const WORKING_TYPES = new Set(['work']);
const isWorkingType = (typeId) => WORKING_TYPES.has(typeId);
const STAFF_INCLUDE = {
    locations: { select: { locationId: true } },
    logins: { select: { login: true, disabledAt: true } },
};
export function actorOf(ctx) {
    const m = ctx.member;
    return { name: m.name, staffId: m.staffId, role: m.role === 'admin' ? 'admin' : m.role === 'master' ? 'master' : 'owner' };
}
/**
 * График (docs/backend/02 §5, F-02-001…106, F-00-051…060): таблица «сотрудники × дни», ячейки, типы дня, шаблоны,
 * копирование, история, быстрые инструменты мастера. Правила — как в моке фронта (src/api/schedule/*), только
 * в базе. Правка графика поверх записей (A7, F-02-106) — разрешена с предупреждением: без force ответ перечисляет
 * задетые записи и ничего не пишет.
 */
let ScheduleService = class ScheduleService {
    constructor(prisma, availability) {
        this.prisma = prisma;
        this.availability = availability;
    }
    // ─────────── права и загрузка ───────────
    /** Правка графика: schedule.edit; чужой график — ещё journal.others (мастер правит только себя) */
    assertCanEdit(ctx, staffIds) {
        const m = ctx.member;
        if (!m.permissions.has('schedule.edit'))
            throw new ApiError('forbidden', 'Missing permission: schedule.edit');
        if (staffIds.some((id) => id !== m.staffId) && !m.permissions.has('journal.others')) {
            throw new ApiError('forbidden', 'Foreign schedule is edited by an administrator');
        }
    }
    async staffMap(db, businessId, staffIds) {
        const rows = await db.staff.findMany({
            where: { businessId, id: { in: [...new Set(staffIds)] } },
            select: { id: true, name: true, userId: true, calendarMode: true, status: true, locations: { select: { locationId: true } } },
        });
        if (rows.length !== new Set(staffIds).size)
            throw new ApiError('not_found', 'Staff not found');
        return new Map(rows.map((r) => [r.id, { ...r, locationIds: r.locations.map((l) => l.locationId) }]));
    }
    async dayTypes(db, staffIds, from, to) {
        if (!staffIds.length)
            return new Map();
        const rows = await db.staffDayType.findMany({ where: { staffId: { in: [...staffIds] }, date: { gte: from, lte: to } } });
        return new Map(rows.map((r) => [`${r.staffId}|${r.date}`, { typeId: r.typeId, vacationUntil: r.vacationUntil }]));
    }
    effectiveTypeId(types, staffId, date, hours) {
        const explicit = types.get(`${staffId}|${date}`);
        if (explicit)
            return explicit.typeId;
        return hours.length > 0 ? 'work' : null;
    }
    /** График для чтения одного места: в филиале — его (салон первым), без филиала — салонный */
    findSchedule(schedules, staffId, locationId) {
        const own = schedules.filter((s) => s.staffId === staffId);
        if (locationId) {
            const here = own.filter((s) => s.locationId === locationId);
            return here.find((s) => s.workplace === 'salon') ?? here[0] ?? own[0];
        }
        return own.find((s) => s.workplace === 'salon') ?? own[0];
    }
    /** График, который правит таблица: салонный в филиале, иначе любой в филиале */
    editableSchedule(schedules, staffId, locationId) {
        const here = schedules.filter((s) => s.staffId === staffId && s.locationId === locationId);
        return here.find((s) => s.workplace === 'salon') ?? here[0];
    }
    // ─────────── запись часов и типов дня ───────────
    /** Часы на даты в правимый график сотрудника; графика нет — создаётся салонный с пустой неделей */
    async writeOverrides(tx, businessId, staffId, locationId, patch, actorId) {
        const dates = Object.keys(patch);
        if (!dates.length)
            return;
        const here = await tx.workSchedule.findMany({ where: { staffId, locationId }, orderBy: { createdAt: 'asc' } });
        let schedule = here.find((s) => s.workplace === 'salon') ?? here[0];
        if (!schedule) {
            schedule = await tx.workSchedule.create({
                data: { id: newId('schedule'), businessId, staffId, locationId, workplace: 'salon', week: EMPTY_WEEK, createdBy: actorId, updatedBy: actorId },
            });
        }
        else {
            await tx.workSchedule.update({ where: { id: schedule.id }, data: { version: { increment: 1 }, updatedBy: actorId } });
        }
        for (let i = 0; i < dates.length; i += 500) {
            const part = dates.slice(i, i + 500);
            await tx.scheduleDay.deleteMany({ where: { scheduleId: schedule.id, date: { in: part } } });
            await tx.scheduleDay.createMany({
                data: part.map((date) => ({ scheduleId: schedule.id, date, businessId, staffId, hours: patch[date] })),
            });
        }
    }
    async writeDayTypes(tx, businessId, records) {
        const byStaff = new Map();
        for (const r of records)
            byStaff.set(r.staffId, [...(byStaff.get(r.staffId) ?? []), r]);
        for (const [staffId, list] of byStaff) {
            for (let i = 0; i < list.length; i += 500) {
                const part = list.slice(i, i + 500);
                await tx.staffDayType.deleteMany({ where: { staffId, date: { in: part.map((r) => r.date) } } });
                await tx.staffDayType.createMany({
                    data: part.map((r) => ({ staffId, date: r.date, businessId, typeId: r.typeId, vacationUntil: r.vacationUntil ?? null })),
                });
            }
        }
    }
    async pushHistory(tx, businessId, entry) {
        await tx.scheduleHistory.create({
            data: {
                id: newId('scheduleHistory'),
                businessId,
                action: entry.action,
                targetStaffIds: entry.targetStaffIds,
                dates: entry.dates.length > 400 ? [entry.dates[0], entry.dates[entry.dates.length - 1]] : entry.dates,
                details: (entry.details ?? Prisma.DbNull),
                actorName: entry.actorName,
                actorStaffId: entry.actorStaffId,
            },
        });
    }
    /** Ячейки (staff × date) → тип + часы (txSetCells фронта). Внутри транзакции. */
    async txSetCells(tx, ctx, businessId, input) {
        this.assertCanEdit(ctx, input.staffIds);
        const actor = actorOf(ctx);
        const staff = await this.staffMap(tx, businessId, input.staffIds);
        const hours = isWorkingType(input.typeId) ? input.hours : [];
        const dates = [...new Set(input.dates)].sort();
        const schedules = await this.availability.schedules(tx, input.staffIds, dates[0], dates[dates.length - 1]);
        let addedDays = 0;
        let changedDays = 0;
        let before;
        for (const staffId of input.staffIds) {
            const locationId = input.locationId ?? staff.get(staffId).locationIds[0];
            if (!locationId)
                continue;
            const existing = this.editableSchedule(schedules, staffId, locationId);
            const patch = {};
            for (const date of dates) {
                const was = existing ? scheduleHours(existing, date) : [];
                if (before === undefined)
                    before = hoursText(was);
                if (was.length === 0 && hours.length > 0)
                    addedDays += 1;
                else if (was.length > 0)
                    changedDays += 1;
                patch[date] = hours;
            }
            await this.writeOverrides(tx, businessId, staffId, locationId, patch, actor.staffId);
        }
        await this.writeDayTypes(tx, businessId, input.staffIds.flatMap((staffId) => dates.map((date) => ({ staffId, date, typeId: input.typeId, vacationUntil: input.vacationUntil ?? null }))));
        await this.pushHistory(tx, businessId, {
            action: input.historyAction ?? (input.typeId === 'not_working' ? 'delete_days' : 'set_hours'),
            targetStaffIds: input.staffIds,
            dates,
            details: {
                typeId: input.typeId,
                days: dates.length,
                staff: input.staffIds.length,
                ...(dates.length === 1 && input.staffIds.length === 1 ? { before, after: hoursText(hours) } : {}),
            },
            actorName: actor.name,
            actorStaffId: actor.staffId,
        });
        return { addedDays, changedDays };
    }
    async txSnapshotCells(tx, businessId, staffIds, datesIn) {
        const staff = await this.staffMap(tx, businessId, staffIds);
        const dates = [...datesIn].sort();
        const schedules = await this.availability.schedules(tx, staffIds, dates[0], dates[dates.length - 1]);
        const types = await this.dayTypes(tx, staffIds, dates[0], dates[dates.length - 1]);
        const out = [];
        for (const staffId of staffIds) {
            const loc = staff.get(staffId).locationIds[0];
            const schedule = loc ? this.editableSchedule(schedules, staffId, loc) : undefined;
            for (const date of datesIn) {
                const hours = schedule ? scheduleHours(schedule, date) : [];
                out.push({ staffId, date, hours, typeId: this.effectiveTypeId(types, staffId, date, hours) ?? 'not_working' });
            }
        }
        return out;
    }
    async txRestoreCells(tx, ctx, businessId, snapshot) {
        const staffIds = [...new Set(snapshot.map((c) => c.staffId))];
        this.assertCanEdit(ctx, staffIds);
        const staff = await this.staffMap(tx, businessId, staffIds);
        for (const staffId of staffIds) {
            const loc = staff.get(staffId).locationIds[0];
            if (!loc)
                continue;
            const patch = {};
            for (const c of snapshot.filter((x) => x.staffId === staffId))
                patch[c.date] = c.hours;
            await this.writeOverrides(tx, businessId, staffId, loc, patch, ctx.member.staffId);
        }
        await this.writeDayTypes(tx, businessId, snapshot.map((c) => ({ staffId: c.staffId, date: c.date, typeId: c.typeId })));
    }
    // ─────────── записи, задетые правкой (F-02-106) ───────────
    /** Записи на даты у сотрудников. newHours — только те, что в новые часы не помещаются; без newHours — все. */
    async findAffected(db, businessId, staffIds, datesIn, newHours) {
        if (!staffIds.length || !datesIn.length)
            return [];
        const dates = [...datesIn].sort();
        const from = localDayRangeUtc(dates[0], DEFAULT_TZ).from;
        const to = localDayRangeUtc(dates[dates.length - 1], DEFAULT_TZ).to;
        const dateSet = new Set(dates);
        const blocks = await db.busyBlock.findMany({
            where: { businessId, staffId: { in: [...staffIds] }, source: 'booking', active: true, startAt: { gte: from, lt: to } },
            orderBy: { startAt: 'asc' },
        });
        if (!blocks.length)
            return [];
        const names = new Map((await db.staff.findMany({ where: { id: { in: [...staffIds] } }, select: { id: true, name: true } })).map((s) => [s.id, s.name]));
        const out = [];
        for (const b of blocks) {
            const start = utcToLocal(b.startAt, DEFAULT_TZ);
            if (!dateSet.has(start.slice(0, 10)))
                continue;
            const durationMin = Math.round((b.serviceEndAt.getTime() - b.startAt.getTime()) / 60000);
            if (newHours && newHours.length > 0) {
                const fromMin = toMinutes(start.slice(11, 16));
                if (newHours.some((h) => toMinutes(h.from) <= fromMin && fromMin + durationMin <= toMinutes(h.to)))
                    continue;
            }
            out.push({ bookingId: b.sourceId, staffId: b.staffId, staffName: names.get(b.staffId) ?? '', businessId: b.businessId, start, durationMin });
        }
        return out;
    }
    // ─────────── операции с ячейками ───────────
    async afterWrite(businessId, staffIds, dates) {
        await this.availability.invalidate({ businessIds: [businessId], staffIds: [...staffIds], dates: [...dates] });
    }
    async setCells(ctx, businessId, input) {
        const res = await this.prisma.$transaction((tx) => this.txSetCells(tx, ctx, businessId, input), { timeout: 30_000 });
        await this.afterWrite(businessId, input.staffIds, input.dates);
        return res;
    }
    /** «Настройка графика» одним запросом: проверка записей, слепок «до», запись (F-02-005, F-02-106) */
    async applyCells(ctx, businessId, input) {
        this.assertCanEdit(ctx, input.staffIds);
        if (!input.force) {
            const affected = await this.findAffected(this.prisma, businessId, input.staffIds, input.dates, isWorkingType(input.typeId) ? input.hours : []);
            if (affected.length > 0)
                return { ok: false, affected };
        }
        const result = await this.prisma.$transaction(async (tx) => {
            const before = await this.txSnapshotCells(tx, businessId, input.staffIds, input.dates);
            const r = await this.txSetCells(tx, ctx, businessId, input);
            return { ok: true, ...r, before };
        }, { timeout: 30_000 });
        await this.afterWrite(businessId, input.staffIds, input.dates);
        return result;
    }
    async deleteCells(ctx, businessId, input) {
        this.assertCanEdit(ctx, input.staffIds);
        if (!input.force) {
            const affected = await this.findAffected(this.prisma, businessId, input.staffIds, input.dates);
            if (affected.length > 0)
                throw new ApiError('schedule_has_bookings', String(affected.length));
        }
        return this.setCells(ctx, businessId, { staffIds: input.staffIds, dates: input.dates, typeId: 'not_working', hours: [] });
    }
    async snapshotCells(businessId, staffIds, dates) {
        return this.txSnapshotCells(this.prisma, businessId, staffIds, dates);
    }
    async restoreCells(ctx, businessId, snapshot) {
        await this.prisma.$transaction((tx) => this.txRestoreCells(tx, ctx, businessId, snapshot), { timeout: 30_000 });
        await this.afterWrite(businessId, [...new Set(snapshot.map((c) => c.staffId))], [...new Set(snapshot.map((c) => c.date))]);
    }
    async hasSavedSchedule(businessId, staffIds) {
        if (!staffIds.length)
            return false;
        const schedules = await this.prisma.workSchedule.findMany({ where: { businessId, staffId: { in: staffIds } }, select: { id: true, week: true } });
        if (schedules.some((s) => Object.values(s.week).some((h) => h.length > 0)))
            return true;
        const days = await this.prisma.scheduleDay.findMany({ where: { scheduleId: { in: schedules.map((s) => s.id) } }, select: { hours: true }, take: 2000 });
        return days.some((d) => d.hours.length > 0);
    }
    // ─────────── таблица «Сотрудники × дни» (F-02-002/003) ───────────
    async table(businessId, input) {
        const dates = eachDay(input.from, input.to).slice(0, 62);
        const f = { staffIds: [], positions: [], specializations: [], hasSchedule: 'all', deleted: 'active', fired: 'active', ...input.filters };
        let staffList = await this.prisma.staff.findMany({
            where: { businessId, deletedAt: null },
            include: STAFF_INCLUDE,
            orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        });
        staffList = staffList.filter((s) => s.locations.some((l) => input.locationIds.includes(l.locationId)));
        staffList = staffList.filter((s) => (f.fired === 'only' ? s.status === 'fired' : s.status !== 'fired'));
        staffList = staffList.filter((s) => (f.deleted === 'only' ? s.status === 'disabled' : s.status !== 'disabled'));
        if (f.staffIds.length)
            staffList = staffList.filter((s) => f.staffIds.includes(s.id));
        if (f.positions.length)
            staffList = staffList.filter((s) => f.positions.includes(s.position?.ru ?? ''));
        if (f.specializations.length) {
            const services = await this.prisma.service.findMany({ where: { businessId }, select: { id: true, categoryId: true } });
            const categoryOf = new Map(services.map((sv) => [sv.id, sv.categoryId ?? '']));
            staffList = staffList.filter((s) => (s.serviceIds ?? []).some((id) => f.specializations.includes(categoryOf.get(id) ?? '')));
        }
        const ids = staffList.map((s) => s.id);
        const [schedulesAll, types, bookingDays] = await Promise.all([
            this.availability.schedules(this.prisma, ids, dates[0], dates[dates.length - 1]),
            this.dayTypes(this.prisma, ids, dates[0], dates[dates.length - 1]),
            this.bookingDays(this.prisma, businessId, ids, dates[0], dates[dates.length - 1]),
        ]);
        const singleLocation = input.locationIds.length === 1 ? input.locationIds[0] : undefined;
        const rows = staffList.map((staff) => {
            const own = schedulesAll.filter((s) => s.staffId === staff.id && (!singleLocation || s.locationId === singleLocation));
            const main = own.find((s) => s.workplace === 'salon') ?? own[0];
            const others = own.filter((s) => s !== main);
            let totalDays = 0;
            let totalMinutes = 0;
            const cells = dates.map((date) => {
                const hours = main ? scheduleHours(main, date) : [];
                const typeId = this.effectiveTypeId(types, staff.id, date, hours);
                const elsewhere = others.map((s) => ({ workplace: s.workplace, hours: scheduleHours(s, date) })).filter((x) => x.hours.length > 0);
                const union = staffDayHours(own, staff.id, date);
                const mainWorks = hours.length > 0 && typeId !== 'not_working';
                if (mainWorks || elsewhere.length > 0) {
                    totalDays += 1;
                    totalMinutes += minutesOf(mainWorks ? union : elsewhere.flatMap((x) => x.hours));
                }
                return { date, hours, typeId, hasBookings: bookingDays.has(`${staff.id}|${date}`), ...(elsewhere.length ? { elsewhere } : {}) };
            });
            return { staff: staffViewWithLogin(staff), cells, totalDays, totalMinutes };
        });
        const filtered = f.hasSchedule === 'with' ? rows.filter((r) => r.totalDays > 0) : f.hasSchedule === 'without' ? rows.filter((r) => r.totalDays === 0) : rows;
        return filtered.sort((a, b) => (a.totalDays > 0 ? 0 : 1) - (b.totalDays > 0 ? 0 : 1) || a.staff.name.localeCompare(b.staff.name));
    }
    /** Множество «staffId|date», где у сотрудника есть записи (занятость source=booking) */
    async bookingDays(db, businessId, staffIds, from, to) {
        if (!staffIds.length)
            return new Map();
        const blocks = await db.busyBlock.findMany({
            where: {
                businessId,
                staffId: { in: [...staffIds] },
                source: 'booking',
                active: true,
                startAt: { gte: localDayRangeUtc(from).from, lt: localDayRangeUtc(to).to },
            },
            select: { staffId: true, startAt: true },
        });
        const out = new Map();
        for (const b of blocks) {
            const key = `${b.staffId}|${utcToLocal(b.startAt).slice(0, 10)}`;
            out.set(key, (out.get(key) ?? 0) + 1);
        }
        return out;
    }
    // ─────────── копирование (F-02-015, F-00-054) ───────────
    async copySchedule(ctx, businessId, input) {
        this.assertCanEdit(ctx, input.toStaffIds);
        const cap = dayjs(input.from).add(1, 'month').endOf('month').format('YYYY-MM-DD');
        const to = input.to > cap ? cap : input.to;
        const dates = eachDay(input.from, to);
        if (!dates.length)
            return;
        const actor = actorOf(ctx);
        await this.prisma.$transaction(async (tx) => {
            const staff = await this.staffMap(tx, businessId, [input.fromStaffId, ...input.toStaffIds]);
            const schedules = await this.availability.schedules(tx, [input.fromStaffId], dates[0], dates[dates.length - 1]);
            const types = await this.dayTypes(tx, [input.fromStaffId], dates[0], dates[dates.length - 1]);
            const source = this.findSchedule(schedules, input.fromStaffId);
            const perDate = dates.map((date) => {
                const hours = source ? scheduleHours(source, date) : [];
                return {
                    date,
                    hours: input.includeBreaks ? hours : stripBreaks(hours),
                    typeId: this.effectiveTypeId(types, input.fromStaffId, date, hours) ?? 'not_working',
                };
            });
            for (const staffId of input.toStaffIds) {
                const loc = staff.get(staffId).locationIds[0];
                if (!loc)
                    continue;
                await this.writeOverrides(tx, businessId, staffId, loc, Object.fromEntries(perDate.map((d) => [d.date, d.hours])), actor.staffId);
            }
            await this.writeDayTypes(tx, businessId, input.toStaffIds.flatMap((staffId) => perDate.map((d) => ({ staffId, date: d.date, typeId: d.typeId }))));
            await this.pushHistory(tx, businessId, {
                action: 'copy_schedule',
                targetStaffIds: [input.fromStaffId, ...input.toStaffIds],
                dates,
                details: { days: dates.length, staff: input.toStaffIds.length },
                actorName: actor.name,
                actorStaffId: actor.staffId,
            });
        }, { timeout: 30_000 });
        await this.afterWrite(businessId, input.toStaffIds, dates);
    }
    /** «Как на прошлой неделе»: у того же сотрудника прошлая неделя → текущая */
    async copyFromLastWeek(ctx, businessId, staffId, weekAnchor) {
        this.assertCanEdit(ctx, [staffId]);
        const thisWeek = weekStart(weekAnchor);
        const dates = eachDay(thisWeek, addDays(thisWeek, 6));
        const actor = actorOf(ctx);
        await this.prisma.$transaction(async (tx) => {
            const staff = await this.staffMap(tx, businessId, [staffId]);
            const loc = staff.get(staffId).locationIds[0];
            if (!loc)
                return;
            const schedules = await this.availability.schedules(tx, [staffId], addDays(thisWeek, -7), addDays(thisWeek, 6));
            const schedule = this.editableSchedule(schedules, staffId, loc);
            if (!schedule)
                return;
            const patch = {};
            for (const [i, date] of dates.entries())
                patch[date] = scheduleHours(schedule, addDays(thisWeek, i - 7));
            await this.writeOverrides(tx, businessId, staffId, loc, patch, actor.staffId);
            await this.writeDayTypes(tx, businessId, dates.map((date) => ({ staffId, date, typeId: patch[date].length > 0 ? 'work' : 'not_working' })));
            await this.pushHistory(tx, businessId, {
                action: 'copy_schedule',
                targetStaffIds: [staffId],
                dates,
                details: { days: 7, staff: 1 },
                actorName: actor.name,
                actorStaffId: actor.staffId,
            });
        });
        await this.afterWrite(businessId, [staffId], dates);
    }
    // ─────────── быстрые правки дня (журнал, меню строки) ───────────
    async addWorkDayWithUndo(ctx, businessId, staffId, date) {
        const result = await this.prisma.$transaction(async (tx) => {
            const staff = await this.staffMap(tx, businessId, [staffId]);
            const loc = staff.get(staffId).locationIds[0];
            const schedules = await this.availability.schedules(tx, [staffId], date, date);
            const schedule = loc ? this.editableSchedule(schedules, staffId, loc) : undefined;
            const fromWeek = schedule?.week[String(weekdayIndex(date))] ?? [];
            const hours = fromWeek.length > 0 ? fromWeek : [DEFAULT_DAY_RANGE];
            const before = await this.txSnapshotCells(tx, businessId, [staffId], [date]);
            const r = await this.txSetCells(tx, ctx, businessId, { staffIds: [staffId], dates: [date], typeId: 'work', hours });
            return { ...r, before, hours };
        });
        await this.afterWrite(businessId, [staffId], [date]);
        return result;
    }
    async addWorkDays(ctx, businessId, staffId, input) {
        const result = await this.prisma.$transaction(async (tx) => {
            const schedules = await this.availability.schedules(tx, [staffId]);
            const schedule = this.findSchedule(schedules, staffId, input.locationId);
            let total = { addedDays: 0, changedDays: 0 };
            for (const date of input.dates) {
                const fallback = schedule?.week[String(weekdayIndex(date))];
                const hours = input.hours && input.hours.length > 0 ? input.hours : fallback && fallback.length > 0 ? fallback : [DEFAULT_DAY_RANGE];
                const r = await this.txSetCells(tx, ctx, businessId, { staffIds: [staffId], dates: [date], typeId: 'work', hours, locationId: input.locationId });
                total = { addedDays: total.addedDays + r.addedDays, changedDays: total.changedDays + r.changedDays };
            }
            return total;
        }, { timeout: 30_000 });
        await this.afterWrite(businessId, [staffId], input.dates);
        return result;
    }
    // ─────────── «Убрать из графика» (F-02-020) ───────────
    async removeRange(db, staffId) {
        const end = await this.scheduleEnd(db, staffId);
        const today = nowLocal().slice(0, 10);
        const to = end && end > today ? end : dayjs(today).add(2, 'year').format('YYYY-MM-DD');
        return eachDay(today, to);
    }
    async scheduleEnd(db, staffId) {
        const ends = (await db.workSchedule.findMany({ where: { staffId, openUntil: { not: null } }, select: { openUntil: true } }))
            .map((s) => s.openUntil)
            .sort();
        return ends.at(-1);
    }
    async previewRemove(businessId, staffId) {
        await this.staffMap(this.prisma, businessId, [staffId]);
        return (await this.findAffected(this.prisma, businessId, [staffId], await this.removeRange(this.prisma, staffId))).length;
    }
    async removeFromSchedule(ctx, businessId, staffId, force) {
        this.assertCanEdit(ctx, [staffId]);
        await this.staffMap(this.prisma, businessId, [staffId]);
        const dates = await this.removeRange(this.prisma, staffId);
        if (!force) {
            const affected = (await this.findAffected(this.prisma, businessId, [staffId], dates)).length;
            if (affected > 0)
                return { ok: false, affected };
        }
        const snapshot = await this.prisma.$transaction(async (tx) => {
            const snap = { cells: await this.txSnapshotCells(tx, businessId, [staffId], dates), openUntil: (await this.scheduleEnd(tx, staffId)) ?? null };
            await this.txSetCells(tx, ctx, businessId, { staffIds: [staffId], dates, typeId: 'not_working', hours: [] });
            await tx.workSchedule.updateMany({ where: { staffId }, data: { openUntil: null } });
            return snap;
        }, { timeout: 60_000 });
        await this.afterWrite(businessId, [staffId], dates.slice(0, 31));
        return { ok: true, snapshot };
    }
    async restoreAfterRemove(ctx, businessId, staffId, snapshot) {
        await this.prisma.$transaction(async (tx) => {
            await this.txRestoreCells(tx, ctx, businessId, snapshot.cells);
            await tx.workSchedule.updateMany({ where: { staffId, businessId }, data: { openUntil: snapshot.openUntil ?? null } });
        }, { timeout: 60_000 });
        await this.afterWrite(businessId, [staffId], snapshot.cells.slice(0, 31).map((c) => c.date));
    }
    // ─────────── часы (журнал, зарплата, отчёты) ───────────
    async hours(businessId, staffId, from, to, locationId) {
        await this.staffMap(this.prisma, businessId, [staffId]);
        const dates = eachDay(from, to).slice(0, 400);
        const schedules = await this.availability.schedules(this.prisma, [staffId], dates[0], dates[dates.length - 1]);
        const days = dates.map((date) => ({ date, hours: staffDayHours(schedules, staffId, date, locationId) }));
        return {
            days,
            scheduledMinutes: days.reduce((sum, d) => sum + minutesOf(d.hours), 0),
            scheduleEnd: (await this.scheduleEnd(this.prisma, staffId)) ?? null,
        };
    }
    /** Рабочие часы филиала (или сотрудника) — самое раннее начало и самый поздний конец (ux-r5 L-1) */
    async workRange(businessId, kind, id) {
        const list = await this.prisma.workSchedule.findMany({
            where: { businessId, ...(kind === 'staff' ? { staffId: id } : { locationId: id }) },
            include: { days: { take: 400, orderBy: { date: 'desc' } } },
        });
        const all = [];
        for (const s of list) {
            for (const day of Object.values(s.week))
                all.push(...day);
            for (const d of s.days)
                all.push(...d.hours);
        }
        const merged = mergeIntervals(rangesToIntervals(all));
        if (!merged.length)
            return null;
        const [range] = intervalsToRanges([[merged[0][0], Math.max(...merged.map((m) => m[1]))]]);
        return range;
    }
    // ─────────── шаблоны (F-02-006…009) ───────────
    templateView(t) {
        return {
            id: t.id,
            businessId: t.businessId,
            name: t.name,
            kind: t.kind,
            ...(t.weekdays ? { weekdays: t.weekdays } : {}),
            ...(t.shiftWork !== null ? { shiftWork: t.shiftWork } : {}),
            ...(t.shiftOff !== null ? { shiftOff: t.shiftOff } : {}),
            hours: t.hours,
            createdAt: utcToLocal(t.createdAt),
        };
    }
    async templates(businessId) {
        const rows = await this.prisma.scheduleTemplate.findMany({ where: { businessId }, orderBy: { createdAt: 'asc' } });
        return rows.map((t) => this.templateView(t));
    }
    async createTemplate(ctx, businessId, input) {
        const id = input.id && input.id.startsWith('sctpl_') && !(await this.prisma.scheduleTemplate.findUnique({ where: { id: input.id } })) ? input.id : newId('scheduleTemplate');
        const t = await this.prisma.scheduleTemplate.create({
            data: {
                id,
                businessId,
                name: input.name,
                kind: input.kind,
                weekdays: input.weekdays ?? Prisma.DbNull,
                shiftWork: input.shiftWork ?? null,
                shiftOff: input.shiftOff ?? null,
                hours: input.hours,
                createdBy: ctx.member.staffId,
            },
        });
        return this.templateView(t);
    }
    async updateTemplate(businessId, id, patch) {
        const found = await this.prisma.scheduleTemplate.findFirst({ where: { id, businessId } });
        if (!found)
            throw new ApiError('not_found', 'Template not found');
        await this.prisma.scheduleTemplate.update({
            where: { id },
            data: {
                ...(patch.name !== undefined ? { name: patch.name } : {}),
                ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
                ...(patch.weekdays !== undefined ? { weekdays: patch.weekdays } : {}),
                ...(patch.shiftWork !== undefined ? { shiftWork: patch.shiftWork } : {}),
                ...(patch.shiftOff !== undefined ? { shiftOff: patch.shiftOff } : {}),
                ...(patch.hours !== undefined ? { hours: patch.hours } : {}),
                version: { increment: 1 },
            },
        });
    }
    async deleteTemplate(businessId, id) {
        await this.prisma.scheduleTemplate.deleteMany({ where: { id, businessId } });
    }
    // ─────────── история (F-02-102) ───────────
    async history(businessId, staffIds) {
        const rows = await this.prisma.scheduleHistory.findMany({ where: { businessId }, orderBy: { at: 'desc' }, take: staffIds?.length ? 2000 : 200 });
        const list = rows.map((h) => ({
            id: h.id,
            at: utcToLocal(h.at),
            actorStaffId: h.actorStaffId,
            actorName: h.actorName,
            action: h.action,
            targetStaffIds: h.targetStaffIds,
            dates: h.dates,
            summary: h.summary,
            ...(h.details ? { details: h.details } : {}),
        }));
        if (!staffIds?.length)
            return list;
        return list.filter((h) => h.targetStaffIds.some((id) => staffIds.includes(id))).slice(0, 200);
    }
    // ─────────── настройки раздела ───────────
    async settings(businessId) {
        return this.availability.settings(this.prisma, businessId);
    }
    async patchSettings(businessId, patch) {
        const next = await this.prisma.$transaction(async (tx) => {
            await tx.$queryRaw `SELECT business_id FROM business_settings WHERE business_id = ${businessId} AND area = 'schedule' FOR UPDATE`;
            const cur = await this.availability.settings(tx, businessId);
            const mergeMap = (base, p) => {
                if (!p)
                    return base;
                const out = { ...base };
                for (const [k, v] of Object.entries(p)) {
                    if (v === null)
                        delete out[k];
                    else
                        out[k] = v;
                }
                return out;
            };
            const value = {
                ...DEFAULT_SCHEDULE_SETTINGS,
                ...cur,
                ...(patch.anySpecialistAllowed !== undefined ? { anySpecialistAllowed: patch.anySpecialistAllowed } : {}),
                ...(patch.allowOnlineOverNoShow !== undefined ? { allowOnlineOverNoShow: patch.allowOnlineOverNoShow } : {}),
                ...(patch.planningPeriodYears !== undefined ? { planningPeriodYears: patch.planningPeriodYears } : {}),
                ...(patch.notifyMasterOnScheduleChange !== undefined ? { notifyMasterOnScheduleChange: patch.notifyMasterOnScheduleChange } : {}),
                skipStaffSelection: mergeMap(cur.skipStaffSelection, patch.skipStaffSelection),
                historyLimitDays: mergeMap(cur.historyLimitDays, patch.historyLimitDays),
                includeInFillRate: mergeMap(cur.includeInFillRate, patch.includeInFillRate),
                googleCalendar: mergeMap(cur.googleCalendar, patch.googleCalendar),
            };
            await tx.businessSetting.upsert({
                where: { businessId_area: { businessId, area: 'schedule' } },
                create: { businessId, area: 'schedule', data: value },
                update: { data: value, version: { increment: 1 } },
            });
            return value;
        });
        if (patch.anySpecialistAllowed !== undefined || patch.allowOnlineOverNoShow !== undefined || patch.skipStaffSelection) {
            await this.availability.invalidate({ businessIds: [businessId] });
        }
        return next;
    }
    async setJournalView(businessId, staffId, input) {
        await this.staffMap(this.prisma, businessId, [staffId]);
        await this.prisma.staff.update({
            where: { id: staffId },
            data: {
                ...(input.hiddenInJournal !== undefined ? { hiddenInJournal: input.hiddenInJournal } : {}),
                ...(input.journalMarkupMin !== undefined ? { journalMarkupMin: input.journalMarkupMin } : {}),
                version: { increment: 1 },
            },
        });
    }
};
ScheduleService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [PrismaService,
        AvailabilityService])
], ScheduleService);
export { ScheduleService };
//# sourceMappingURL=schedule.service.js.map