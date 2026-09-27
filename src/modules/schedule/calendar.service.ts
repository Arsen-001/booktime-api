import { Injectable } from '@nestjs/common';
import dayjs from 'dayjs';
import type { Prisma } from '../../generated/prisma/client.js';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { newId } from '../../common/ids/ids.js';
import { DEFAULT_TZ, nowLocal } from '../../common/time/time.js';
import { AvailabilityService } from '../availability/availability.service.js';
import { addDays, eachDay, scheduleHours, staffDayHours, stripBreaks, toMinutes, weekStart, weekdayIndex, type DayHours, type MarkLike } from '../availability/engine.js';
import { OccupyService, personKeyOf } from '../availability/occupy.js';
import { DEFAULT_DAY_RANGE, ScheduleService } from './schedule.service.js';

type Tx = Prisma.TransactionClient;

export interface MarkInput {
  date: string;
  from: string;
  to: string;
  kind: 'busy' | 'free';
  workplace?: string | null;
  note?: string | null;
}

/** Местная дата + минуты дня → момент UTC ('24:00' — полночь следующего дня) */
function atMinutes(date: string, minutes: number, tz = DEFAULT_TZ): Date {
  return dayjs.tz(date, 'YYYY-MM-DD', tz).startOf('day').add(minutes, 'minute').toDate();
}

/**
 * «Мой календарь» (F-00-051…060): режим, отметки, быстрые инструменты, отпуск, неделя одним запросом.
 * Отметка «занят» проецируется в busy_blocks (occupy.ts, source mark_busy) — чужой бизнес человека видит «занято»
 * (F-00-046), а окна клиентам в других его местах закрываются (F-00-045).
 */
@Injectable()
export class CalendarService {
  constructor(
    private readonly schedule: ScheduleService,
    private readonly availability: AvailabilityService,
    private readonly occupy: OccupyService,
  ) {}

  private get prisma() {
    return this.schedule.prisma;
  }

  private markView(m: { id: string; staffId: string; date: string; fromTime: string; toTime: string; kind: string; workplace: string | null; note: string | null }) {
    return {
      id: m.id,
      staffId: m.staffId,
      date: m.date,
      from: m.fromTime,
      to: m.toTime,
      kind: m.kind as 'busy' | 'free',
      ...(m.workplace ? { workplace: m.workplace } : {}),
      ...(m.note ? { note: m.note } : {}),
    };
  }

  async marks(businessId: string, staffId: string, from: string, to: string) {
    await this.schedule.staffMap(this.prisma, businessId, [staffId]);
    const rows = await this.prisma.calendarMark.findMany({ where: { staffId, date: { gte: from, lte: to } }, orderBy: [{ date: 'asc' }, { fromTime: 'asc' }] });
    return rows.map((m) => this.markView(m));
  }

  private async txMarks(tx: Tx, staffId: string, from: string, to: string) {
    const rows = await tx.calendarMark.findMany({ where: { staffId, date: { gte: from, lte: to } }, orderBy: [{ date: 'asc' }, { fromTime: 'asc' }] });
    return rows.map((m) => this.markView(m));
  }

  private async txAddMark(tx: Tx, businessId: string, staff: { id: string; userId: string | null }, input: MarkInput, actorId: string | null) {
    if (toMinutes(input.to) <= toMinutes(input.from)) throw new ApiError('invalid_range', 'Mark end before start');
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

  private async txRemoveMark(tx: Tx, id: string) {
    await this.occupy.release(tx, 'mark_busy', id);
    await tx.calendarMark.deleteMany({ where: { id } });
  }

  private async txReplaceMarks(tx: Tx, businessId: string, staff: { id: string; userId: string | null }, from: string, to: string, marks: MarkInput[], actorId: string | null) {
    for (const m of await this.txMarks(tx, staff.id, from, to)) await this.txRemoveMark(tx, m.id);
    for (const m of marks) await this.txAddMark(tx, businessId, staff, m, actorId);
  }

  private async staffOf(tx: Tx | typeof this.prisma, businessId: string, staffId: string) {
    const staff = (await this.schedule.staffMap(tx, businessId, [staffId])).get(staffId)!;
    return staff;
  }

  private async done(businessId: string, staffId: string, dates: string[]) {
    await this.availability.invalidate({ businessIds: [businessId], staffIds: [staffId], dates });
    const staff = await this.prisma.staff.findUnique({ where: { id: staffId }, select: { userId: true } });
    if (staff?.userId) await this.availability.invalidate({ personKeys: [staff.userId], dates });
  }

  // ─────────── режим (F-00-051) — меняет только сам мастер ───────────

  async mode(businessId: string, staffId: string) {
    return (await this.staffOf(this.prisma, businessId, staffId)).calendarMode as 'free' | 'busy';
  }

  async setMode(ctx: RequestContext, businessId: string, staffId: string, mode: 'free' | 'busy') {
    if (ctx.member!.staffId !== staffId) throw new ApiError('forbidden', 'Calendar mode is changed by the master only');
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

  async addMark(ctx: RequestContext, businessId: string, staffId: string, input: MarkInput) {
    this.schedule.assertCanEdit(ctx, [staffId]);
    const mark = await this.prisma.$transaction(async (tx) => this.txAddMark(tx, businessId, await this.staffOf(tx, businessId, staffId), input, ctx.member!.staffId));
    await this.done(businessId, staffId, [input.date]);
    return mark;
  }

  async removeMark(ctx: RequestContext, businessId: string, staffId: string, id: string, withUndo: boolean) {
    this.schedule.assertCanEdit(ctx, [staffId]);
    const res = await this.prisma.$transaction(async (tx) => {
      const mark = await tx.calendarMark.findFirst({ where: { id, staffId, businessId } });
      if (!mark) throw new ApiError('not_found', 'Mark not found');
      const before = await this.txMarks(tx, staffId, mark.date, mark.date);
      await this.txRemoveMark(tx, id);
      return { before, from: mark.date, to: mark.date, changed: 1 };
    });
    await this.done(businessId, staffId, [res.from]);
    return withUndo ? res : undefined;
  }

  async restoreMarks(ctx: RequestContext, businessId: string, staffId: string, from: string, to: string, marks: MarkInput[]) {
    this.schedule.assertCanEdit(ctx, [staffId]);
    await this.prisma.$transaction(async (tx) => {
      const staff = await this.staffOf(tx, businessId, staffId);
      await this.txReplaceMarks(tx, businessId, staff, from, to, marks, ctx.member!.staffId);
    });
    await this.done(businessId, staffId, eachDay(from, to).slice(0, 31));
  }

  /** Часы дня «с–до» без перерывов, если есть график */
  private async wholeDayRange(tx: Tx, staffId: string, date: string) {
    const schedules = await this.availability.schedules(tx, [staffId], date, date);
    const hours = staffDayHours(schedules, staffId, date);
    return hours.length ? stripBreaks(hours)[0]! : null;
  }

  private async txOpenDay(tx: Tx, businessId: string, staff: { id: string; userId: string | null; calendarMode: string }, date: string, actorId: string | null): Promise<boolean> {
    const marks = await this.txMarks(tx, staff.id, date, date);
    if (staff.calendarMode === 'busy') {
      const range = (await this.wholeDayRange(tx, staff.id, date)) ?? DEFAULT_DAY_RANGE;
      if (marks.some((m) => m.kind === 'free' && m.from <= range.from && m.to >= range.to)) return false;
      for (const m of marks.filter((x) => x.kind === 'free')) await this.txRemoveMark(tx, m.id);
      await this.txAddMark(tx, businessId, staff, { date, from: range.from, to: range.to, kind: 'free' }, actorId);
      return true;
    }
    const busy = marks.filter((x) => x.kind === 'busy');
    for (const m of busy) await this.txRemoveMark(tx, m.id);
    return busy.length > 0;
  }

  /** «Открыть весь день» (F-00-054) */
  async openWholeDay(ctx: RequestContext, businessId: string, staffId: string, date: string) {
    this.schedule.assertCanEdit(ctx, [staffId]);
    const res = await this.prisma.$transaction(async (tx) => {
      const staff = await this.staffOf(tx, businessId, staffId);
      const before = await this.txMarks(tx, staffId, date, date);
      const changed = (await this.txOpenDay(tx, businessId, staff, date, ctx.member!.staffId)) ? 1 : 0;
      return { before, from: date, to: date, changed };
    });
    await this.done(businessId, staffId, [date]);
    return res;
  }

  /** «Открыть по рабочим часам» — неделя разом, прошедшие дни не трогаем */
  async openWeek(ctx: RequestContext, businessId: string, staffId: string, from: string, to: string) {
    this.schedule.assertCanEdit(ctx, [staffId]);
    const today = nowLocal().slice(0, 10);
    const start = from < today ? today : from;
    const res = await this.prisma.$transaction(async (tx) => {
      const staff = await this.staffOf(tx, businessId, staffId);
      const before = await this.txMarks(tx, staffId, start, to);
      let changed = 0;
      for (const date of start <= to ? eachDay(start, to).slice(0, 31) : []) {
        if (!(await this.wholeDayRange(tx, staffId, date))) continue;
        if (await this.txOpenDay(tx, businessId, staff, date, ctx.member!.staffId)) changed += 1;
      }
      return { before, from: start, to, changed };
    });
    await this.done(businessId, staffId, start <= to ? eachDay(start, to).slice(0, 31) : []);
    return res;
  }

  /** «Провести пальцем» (F-00-054): отрезок занятым/открытым по режиму; тот же отрезок повторно — снимает */
  async markRange(ctx: RequestContext, businessId: string, staffId: string, date: string, from: string, to: string) {
    this.schedule.assertCanEdit(ctx, [staffId]);
    if (toMinutes(to) <= toMinutes(from)) throw new ApiError('invalid_range', 'Range end before start');
    const res = await this.prisma.$transaction(async (tx) => {
      const staff = await this.staffOf(tx, businessId, staffId);
      const kind = staff.calendarMode === 'busy' ? 'free' : 'busy';
      const before = await this.txMarks(tx, staffId, date, date);
      const same = before.find((m) => m.kind === kind && m.from === from && m.to === to);
      if (same) {
        await this.txRemoveMark(tx, same.id);
        return { before, from: date, to: date, changed: 1, removed: true };
      }
      await this.txAddMark(tx, businessId, staff, { date, from, to, kind }, ctx.member!.staffId);
      return { before, from: date, to: date, changed: 1, removed: false };
    });
    await this.done(businessId, staffId, [date]);
    return res;
  }

  /** «Как на прошлой неделе» для отметок: сначала очищает текущую неделю */
  async copyMarksFromLastWeek(ctx: RequestContext, businessId: string, staffId: string, weekAnchor: string) {
    this.schedule.assertCanEdit(ctx, [staffId]);
    const thisWeek = weekStart(weekAnchor);
    const thisEnd = addDays(thisWeek, 6);
    const res = await this.prisma.$transaction(async (tx) => {
      const staff = await this.staffOf(tx, businessId, staffId);
      const last = await this.txMarks(tx, staffId, addDays(thisWeek, -7), addDays(thisWeek, -1));
      const before = await this.txMarks(tx, staffId, thisWeek, thisEnd);
      if (last.length === 0) return { before, from: thisWeek, to: thisEnd, changed: 0 };
      await this.txReplaceMarks(tx, businessId, staff, thisWeek, thisEnd, last.map((m) => ({ ...m, date: addDays(m.date, 7) })), ctx.member!.staffId);
      return { before, from: thisWeek, to: thisEnd, changed: last.length };
    });
    await this.done(businessId, staffId, eachDay(thisWeek, thisEnd));
    return res;
  }

  /** «В отпуске до…» (F-00-054, F-02-010): закрывает дни от завтра до даты включительно */
  async setVacation(ctx: RequestContext, businessId: string, staffId: string, until: string) {
    const tomorrow = addDays(nowLocal().slice(0, 10), 1);
    if (until < tomorrow) throw new ApiError('invalid_range', 'Vacation must end after today');
    const dates = eachDay(tomorrow, until).slice(0, 800);
    const res = await this.prisma.$transaction(
      async (tx) => {
        const before = await this.schedule.txSnapshotCells(tx, businessId, [staffId], dates);
        const r = await this.schedule.txSetCells(tx, ctx, businessId, { staffIds: [staffId], dates, typeId: 'vacation', hours: [], vacationUntil: until });
        return { ...r, before };
      },
      { timeout: 60_000 },
    );
    await this.done(businessId, staffId, dates.slice(0, 31));
    return res;
  }

  /** Неделя «Моего календаря» одним запросом */
  async week(businessId: string, staffId: string, from: string, to: string) {
    const staff = await this.staffOf(this.prisma, businessId, staffId);
    const dates = eachDay(from, to).slice(0, 42);
    const [schedules, marks, types, bookings] = await Promise.all([
      this.availability.schedules(this.prisma, [staffId], from, to),
      this.txMarks(this.prisma as unknown as Tx, staffId, from, to),
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
  async saveDay(ctx: RequestContext, businessId: string, staffId: string, input: { date: string; typeId: string; hours: DayHours; force?: boolean }) {
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
  async hasEmptyNextWeek(businessId: string, staffId: string, from: string): Promise<boolean> {
    if (weekdayIndex(from) !== 6) return false;
    const staff = await this.staffOf(this.prisma, businessId, staffId);
    if (staff.calendarMode !== 'busy') return false;
    const count = await this.prisma.calendarMark.count({ where: { staffId, kind: 'free', date: { gte: from, lte: addDays(from, 6) } } });
    return count === 0;
  }

  /** Для зеркала: отметки в окне */
  async marksOfBusiness(businessId: string, from: string, to: string): Promise<MarkLike[]> {
    const rows = await this.prisma.calendarMark.findMany({ where: { businessId, date: { gte: from, lte: to } }, orderBy: [{ date: 'asc' }, { fromTime: 'asc' }] });
    return rows.map((m) => this.markView(m));
  }
}
