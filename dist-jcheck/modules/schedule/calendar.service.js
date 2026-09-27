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
import { DEFAULT_TZ, nowLocal } from '../../common/time/time.js';
import { AvailabilityService } from '../availability/availability.service.js';
import { addDays, eachDay, scheduleHours, staffDayHours, stripBreaks, toMinutes, weekStart, weekdayIndex } from '../availability/engine.js';
import { OccupyService, personKeyOf } from '../availability/occupy.js';
import { DEFAULT_DAY_RANGE, ScheduleService } from './schedule.service.js';
/** Местная дата + минуты дня → момент UTC ('24:00' — полночь следующего дня) */
function atMinutes(date, minutes, tz = DEFAULT_TZ) {
    return dayjs.tz(date, 'YYYY-MM-DD', tz).startOf('day').add(minutes, 'minute').toDate();
}
/**
 * «Мой календарь» (F-00-051…060): режим, отметки, быстрые инструменты, отпуск, неделя одним запросом.
 * Отметка «занят» проецируется в busy_blocks (occupy.ts, source mark_busy) — чужой бизнес человека видит «занято»
 * (F-00-046), а окна клиентам в других его местах закрываются (F-00-045).
 */
let CalendarService = class CalendarService {
    constructor(schedule, availability, occupy) {
        this.schedule = schedule;
        this.availability = availability;
        this.occupy = occupy;
    }
    get prisma() {
        return this.schedule.prisma;
    }
    markView(m) {
        return {
            id: m.id,
            staffId: m.staffId,
            date: m.date,
            from: m.fromTime,
            to: m.toTime,
            kind: m.kind,
            ...(m.workplace ? { workplace: m.workplace } : {}),
            ...(m.note ? { note: m.note } : {}),
        };
    }
    async marks(businessId, staffId, from, to) {
        await this.schedule.staffMap(this.prisma, businessId, [staffId]);
        const rows = await this.prisma.calendarMark.findMany({ where: { staffId, date: { gte: from, lte: to } }, orderBy: [{ date: 'asc' }, { fromTime: 'asc' }] });
        return rows.map((m) => this.markView(m));
    }
    async txMarks(tx, staffId, from, to) {
        const rows = await tx.calendarMark.findMany({ where: { staffId, date: { gte: from, lte: to } }, orderBy: [{ date: 'asc' }, { fromTime: 'asc' }] });
        return rows.map((m) => this.markView(m));
    }
    async txAddMark(tx, businessId, staff, input, actorId) {
        if (toMinutes(input.to) <= toMinutes(input.from))
            throw new ApiError('invalid_range', 'Mark end before start');
        const id = newId('calendarMark');
        const row = await tx.calendarMark.create({
            data: {
                id,
                businessId,
                staffId: staff.id,
                date: input.date,
                fromTime: input.from,
                toTime: input.to,
                kind: input.kind,
                workplace: input.workplace ?? null,
                note: input.note ?? null,
                createdBy: actorId,
            },
        });
        if (input.kind === 'busy') {
            await this.occupy.occupy(tx, {
                allowOverlap: true,
                blocks: [
                    {
                        personKey: personKeyOf(staff),
                        staffId: staff.id,
                        businessId,
                        workplace: input.workplace ?? null,
                        startAt: atMinutes(input.date, toMinutes(input.from)),
                        endAt: atMinutes(input.date, toMinutes(input.to)),
                        source: 'mark_busy',
                        sourceId: id,
                        visibilityLabel: 'busy',
                    },
                ],
            });
        }
        return this.markView(row);
    }
    async txRemoveMark(tx, id) {
        await this.occupy.release(tx, 'mark_busy', id);
        await tx.calendarMark.deleteMany({ where: { id } });
    }
    async txReplaceMarks(tx, businessId, staff, from, to, marks, actorId) {
        for (const m of await this.txMarks(tx, staff.id, from, to))
            await this.txRemoveMark(tx, m.id);
        for (const m of marks)
            await this.txAddMark(tx, businessId, staff, m, actorId);
    }
    async staffOf(tx, businessId, staffId) {
        const staff = (await this.schedule.staffMap(tx, businessId, [staffId])).get(staffId);
        return staff;
    }
    async done(businessId, staffId, dates) {
        await this.availability.invalidate({ businessIds: [businessId], staffIds: [staffId], dates });
        const staff = await this.prisma.staff.findUnique({ where: { id: staffId }, select: { userId: true } });
        if (staff?.userId)
            await this.availability.invalidate({ personKeys: [staff.userId], dates });
    }
    // ─────────── режим (F-00-051) — меняет только сам мастер ───────────
    async mode(businessId, staffId) {
        return (await this.staffOf(this.prisma, businessId, staffId)).calendarMode;
    }
    async setMode(ctx, businessId, staffId, mode) {
        if (ctx.member.staffId !== staffId)
            throw new ApiError('forbidden', 'Calendar mode is changed by the master only');
        await this.prisma.$transaction(async (tx) => {
            const staff = await this.staffOf(tx, businessId, staffId);
            await tx.staff.update({ where: { id: staffId }, data: { calendarMode: mode, version: { increment: 1 } } });
            await this.schedule.pushHistory(tx, businessId, {
                action: 'set_mode',
                targetStaffIds: [staffId],
                dates: [],
                details: { mode },
                actorName: staff.name,
                actorStaffId: staffId,
            });
        });
        await this.done(businessId, staffId, []);
    }
    // ─────────── отметки ───────────
    async addMark(ctx, businessId, staffId, input) {
        this.schedule.assertCanEdit(ctx, [staffId]);
        const mark = await this.prisma.$transaction(async (tx) => this.txAddMark(tx, businessId, await this.staffOf(tx, businessId, staffId), input, ctx.member.staffId));
        await this.done(businessId, staffId, [input.date]);
        return mark;
    }
    async removeMark(ctx, businessId, staffId, id, withUndo) {
        this.schedule.assertCanEdit(ctx, [staffId]);
        const res = await this.prisma.$transaction(async (tx) => {
            const mark = await tx.calendarMark.findFirst({ where: { id, staffId, businessId } });
            if (!mark)
                throw new ApiError('not_found', 'Mark not found');
            const before = await this.txMarks(tx, staffId, mark.date, mark.date);
            await this.txRemoveMark(tx, id);
            return { before, from: mark.date, to: mark.date, changed: 1 };
        });
        await this.done(businessId, staffId, [res.from]);
        return withUndo ? res : undefined;
    }
    async restoreMarks(ctx, businessId, staffId, from, to, marks) {
        this.schedule.assertCanEdit(ctx, [staffId]);
        await this.prisma.$transaction(async (tx) => {
            const staff = await this.staffOf(tx, businessId, staffId);
            await this.txReplaceMarks(tx, businessId, staff, from, to, marks, ctx.member.staffId);
        });
        await this.done(businessId, staffId, eachDay(from, to).slice(0, 31));
    }
    /** Часы дня «с–до» без перерывов, если есть график */
    async wholeDayRange(tx, staffId, date) {
        const schedules = await this.availability.schedules(tx, [staffId], date, date);
        const hours = staffDayHours(schedules, staffId, date);
        return hours.length ? stripBreaks(hours)[0] : null;
    }
    async txOpenDay(tx, businessId, staff, date, actorId) {
        const marks = await this.txMarks(tx, staff.id, date, date);
        if (staff.calendarMode === 'busy') {
            const range = (await this.wholeDayRange(tx, staff.id, date)) ?? DEFAULT_DAY_RANGE;
            if (marks.some((m) => m.kind === 'free' && m.from <= range.from && m.to >= range.to))
                return false;
            for (const m of marks.filter((x) => x.kind === 'free'))
                await this.txRemoveMark(tx, m.id);
            await this.txAddMark(tx, businessId, staff, { date, from: range.from, to: range.to, kind: 'free' }, actorId);
            return true;
        }
        const busy = marks.filter((x) => x.kind === 'busy');
        for (const m of busy)
            await this.txRemoveMark(tx, m.id);
        return busy.length > 0;
    }
    /** «Открыть весь день» (F-00-054) */
    async openWholeDay(ctx, businessId, staffId, date) {
        this.schedule.assertCanEdit(ctx, [staffId]);
        const res = await this.prisma.$transaction(async (tx) => {
            const staff = await this.staffOf(tx, businessId, staffId);
            const before = await this.txMarks(tx, staffId, date, date);
            const changed = (await this.txOpenDay(tx, businessId, staff, date, ctx.member.staffId)) ? 1 : 0;
            return { before, from: date, to: date, changed };
        });
        await this.done(businessId, staffId, [date]);
        return res;
    }
    /** «Открыть по рабочим часам» — неделя разом, прошедшие дни не трогаем */
    async openWeek(ctx, businessId, staffId, from, to) {
        this.schedule.assertCanEdit(ctx, [staffId]);
        const today = nowLocal().slice(0, 10);
        const start = from < today ? today : from;
        const res = await this.prisma.$transaction(async (tx) => {
            const staff = await this.staffOf(tx, businessId, staffId);
            const before = await this.txMarks(tx, staffId, start, to);
            let changed = 0;
            for (const date of start <= to ? eachDay(start, to).slice(0, 31) : []) {
                if (!(await this.wholeDayRange(tx, staffId, date)))
                    continue;
                if (await this.txOpenDay(tx, businessId, staff, date, ctx.member.staffId))
                    changed += 1;
            }
            return { before, from: start, to, changed };
        });
        await this.done(businessId, staffId, start <= to ? eachDay(start, to).slice(0, 31) : []);
        return res;
    }
    /** «Провести пальцем» (F-00-054): отрезок занятым/открытым по режиму; тот же отрезок повторно — снимает */
    async markRange(ctx, businessId, staffId, date, from, to) {
        this.schedule.assertCanEdit(ctx, [staffId]);
        if (toMinutes(to) <= toMinutes(from))
            throw new ApiError('invalid_range', 'Range end before start');
        const res = await this.prisma.$transaction(async (tx) => {
            const staff = await this.staffOf(tx, businessId, staffId);
            const kind = staff.calendarMode === 'busy' ? 'free' : 'busy';
            const before = await this.txMarks(tx, staffId, date, date);
            const same = before.find((m) => m.kind === kind && m.from === from && m.to === to);
            if (same) {
                await this.txRemoveMark(tx, same.id);
                return { before, from: date, to: date, changed: 1, removed: true };
            }
            await this.txAddMark(tx, businessId, staff, { date, from, to, kind }, ctx.member.staffId);
            return { before, from: date, to: date, changed: 1, removed: false };
        });
        await this.done(businessId, staffId, [date]);
        return res;
    }
    /** «Как на прошлой неделе» для отметок: сначала очищает текущую неделю */
    async copyMarksFromLastWeek(ctx, businessId, staffId, weekAnchor) {
        this.schedule.assertCanEdit(ctx, [staffId]);
        const thisWeek = weekStart(weekAnchor);
        const thisEnd = addDays(thisWeek, 6);
        const res = await this.prisma.$transaction(async (tx) => {
            const staff = await this.staffOf(tx, businessId, staffId);
            const last = await this.txMarks(tx, staffId, addDays(thisWeek, -7), addDays(thisWeek, -1));
            const before = await this.txMarks(tx, staffId, thisWeek, thisEnd);
            if (last.length === 0)
                return { before, from: thisWeek, to: thisEnd, changed: 0 };
            await this.txReplaceMarks(tx, businessId, staff, thisWeek, thisEnd, last.map((m) => ({ ...m, date: addDays(m.date, 7) })), ctx.member.staffId);
            return { before, from: thisWeek, to: thisEnd, changed: last.length };
        });
        await this.done(businessId, staffId, eachDay(thisWeek, thisEnd));
        return res;
    }
    /** «В отпуске до…» (F-00-054, F-02-010): закрывает дни от завтра до даты включительно */
    async setVacation(ctx, businessId, staffId, until) {
        const tomorrow = addDays(nowLocal().slice(0, 10), 1);
        if (until < tomorrow)
            throw new ApiError('invalid_range', 'Vacation must end after today');
        const dates = eachDay(tomorrow, until).slice(0, 800);
        const res = await this.prisma.$transaction(async (tx) => {
            const before = await this.schedule.txSnapshotCells(tx, businessId, [staffId], dates);
            const r = await this.schedule.txSetCells(tx, ctx, businessId, { staffIds: [staffId], dates, typeId: 'vacation', hours: [], vacationUntil: until });
            return { ...r, before };
        }, { timeout: 60_000 });
        await this.done(businessId, staffId, dates.slice(0, 31));
        return res;
    }
    /** Неделя «Моего календаря» одним запросом */
    async week(businessId, staffId, from, to) {
        const staff = await this.staffOf(this.prisma, businessId, staffId);
        const dates = eachDay(from, to).slice(0, 42);
        const [schedules, marks, types, bookings] = await Promise.all([
            this.availability.schedules(this.prisma, [staffId], from, to),
            this.txMarks(this.prisma, staffId, from, to),
            this.schedule.dayTypes(this.prisma, [staffId], from, to),
            this.schedule.bookingDays(this.prisma, businessId, [staffId], from, to),
        ]);
        const own = schedules;
        const main = own.find((s) => s.workplace === 'salon') ?? own[0];
        const others = own.filter((s) => s !== main);
        const days = dates.map((date) => {
            const hours = main ? scheduleHours(main, date) : [];
            const elsewhere = others.map((s) => ({ workplace: s.workplace, hours: scheduleHours(s, date) })).filter((x) => x.hours.length > 0);
            return {
                date,
                hours,
                typeId: this.schedule.effectiveTypeId(types, staffId, date, hours),
                ...(elsewhere.length ? { elsewhere } : {}),
                marks: marks.filter((m) => m.date === date),
                bookings: bookings.get(`${staffId}|${date}`) ?? 0,
            };
        });
        const now = nowLocal().slice(0, 10);
        const upcoming = days.filter((d) => d.date >= now && (d.hours.length > 0 || (d.elsewhere?.length ?? 0) > 0));
        const nothingOpen = staff.calendarMode === 'busy' && upcoming.length > 0 && upcoming.every((d) => !d.marks.some((m) => m.kind === 'free'));
        return { mode: staff.calendarMode, days, nothingOpen };
    }
    /** Правка одного дня из календаря: нерабочий тип при записях — ok:false без force */
    async saveDay(ctx, businessId, staffId, input) {
        const working = input.typeId === 'work';
        return this.schedule.applyCells(ctx, businessId, {
            staffIds: [staffId],
            dates: [input.date],
            typeId: working && input.hours.length === 0 ? 'not_working' : input.typeId,
            hours: working ? input.hours : [],
            force: input.force,
        });
    }
    /** Мастер «всё занято» без единого открытого часа на 7 дней (F-00-055) — только для воскресенья */
    async hasEmptyNextWeek(businessId, staffId, from) {
        if (weekdayIndex(from) !== 6)
            return false;
        const staff = await this.staffOf(this.prisma, businessId, staffId);
        if (staff.calendarMode !== 'busy')
            return false;
        const count = await this.prisma.calendarMark.count({ where: { staffId, kind: 'free', date: { gte: from, lte: addDays(from, 6) } } });
        return count === 0;
    }
    /** Для зеркала: отметки в окне */
    async marksOfBusiness(businessId, from, to) {
        const rows = await this.prisma.calendarMark.findMany({ where: { businessId, date: { gte: from, lte: to } }, orderBy: [{ date: 'asc' }, { fromTime: 'asc' }] });
        return rows.map((m) => this.markView(m));
    }
};
CalendarService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [ScheduleService,
        AvailabilityService,
        OccupyService])
], CalendarService);
export { CalendarService };
//# sourceMappingURL=calendar.service.js.map