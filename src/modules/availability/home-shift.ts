import type { Prisma } from '../../generated/prisma/client.js';
import { DEFAULT_TZ, utcToLocal } from '../../common/time/time.js';
import { scheduleHours, toMinutes, type DayHours, type WeekTemplate } from './engine.js';

type Tx = Prisma.TransactionClient;

/**
 * F-00-047 «Запретить мастерам домашние записи в часы смены» (галочка владельца салона, Business.forbidHomeBookingsDuringShift).
 *
 * Домашняя запись — запись с местом «дома» или «выезд к клиенту» (не в салоне). Смена — часы графиков мастера в бизнесе
 * с галочкой, кроме домашних, выездных и онлайн-графиков (те и есть «не в салоне»). Мастер — тот же человек во всех своих
 * карточках (F-00-045: user_id карточки), поэтому домашняя запись в его собственном бизнесе тоже проверяется по смене
 * в салоне. Галочки нет — можно (предупреждение мастеру и администратору — отдельная задача).
 *
 * Проверка — при постановке и переносе записи (BookingsService.occupyBooking, в той же транзакции).
 */
export const HOME_WORKPLACES: ReadonlySet<string> = new Set(['home', 'visit']);
const NOT_SHIFT_WORKPLACES: ReadonlySet<string> = new Set(['home', 'visit', 'online']);

export function isHomeWorkplace(workplace: string | null | undefined): boolean {
  return Boolean(workplace && HOME_WORKPLACES.has(workplace));
}

export interface ShiftSchedule {
  workplace: string;
  week: WeekTemplate;
  overrides: Record<string, DayHours>;
  openUntil: string | null;
}

/**
 * Часы смены (минуты от полуночи), пересекающиеся с [fromMin, toMin) в дату date; нет пересечения — null.
 * Касание концами — не пересечение (смена до 14:00, домашняя запись с 14:00 — можно).
 */
export function shiftOverlap(schedules: readonly ShiftSchedule[], date: string, fromMin: number, toMin: number): { from: number; to: number } | null {
  for (const s of schedules) {
    if (NOT_SHIFT_WORKPLACES.has(s.workplace)) continue;
    if (s.openUntil && date > s.openUntil) continue;
    for (const r of scheduleHours(s, date)) {
      const a = toMinutes(r.from);
      const b = toMinutes(r.to);
      if (b > a && a < toMin && fromMin < b) return { from: a, to: b };
    }
  }
  return null;
}

export interface HomeShiftConflict {
  /** Салон, в чьей смене стоит домашняя запись */
  businessId: string;
  staffId: string;
  date: string;
  /** Часы смены 'HH:mm' */
  from: string;
  to: string;
}

const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/**
 * Найти смену салона с галочкой F-00-047, на которую попадает домашняя запись людей staffIds в [startAt, endAt).
 * Запись не домашняя — null без запросов к базе.
 */
export async function findHomeShiftConflict(
  tx: Tx,
  input: { staffIds: readonly string[]; workplace: string | null | undefined; startAt: Date; endAt: Date },
): Promise<HomeShiftConflict | null> {
  if (!isHomeWorkplace(input.workplace) || !input.staffIds.length || input.endAt <= input.startAt) return null;
  const own = await tx.staff.findMany({ where: { id: { in: [...input.staffIds] } }, select: { id: true, userId: true } });
  const userIds = [...new Set(own.map((s) => s.userId).filter((u): u is string => Boolean(u)))];
  // Все карточки тех же людей (у мастера может быть салон и свой бизнес), только действующие
  const cards = await tx.staff.findMany({
    where: { OR: [{ id: { in: own.map((s) => s.id) } }, ...(userIds.length ? [{ userId: { in: userIds } }] : [])], deletedAt: null, status: 'active' },
    select: { id: true, businessId: true },
  });
  if (!cards.length) return null;
  const strict = await tx.business.findMany({
    where: { id: { in: [...new Set(cards.map((c) => c.businessId))] }, forbidHomeBookingsDuringShift: true },
    select: { id: true },
  });
  if (!strict.length) return null;
  const strictIds = new Set(strict.map((b) => b.id));
  const shiftCards = cards.filter((c) => strictIds.has(c.businessId));
  const rows = await tx.workSchedule.findMany({
    where: { staffId: { in: shiftCards.map((c) => c.id) }, workplace: { notIn: [...NOT_SHIFT_WORKPLACES] } },
    include: { days: true },
  });
  if (!rows.length) return null;
  const locations = await tx.location.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.locationId))] } }, select: { id: true, tz: true } });
  const tzOf = new Map(locations.map((l) => [l.id, l.tz || DEFAULT_TZ]));
  for (const r of rows) {
    const tz = tzOf.get(r.locationId) ?? DEFAULT_TZ;
    const start = utcToLocal(input.startAt, tz);
    const end = utcToLocal(input.endAt, tz);
    const date = start.slice(0, 10);
    const fromMin = toMinutes(start.slice(11, 16));
    // Запись через полночь — до конца дня начала (часы смены — в пределах одного дня)
    const toMin = end.slice(0, 10) === date ? toMinutes(end.slice(11, 16)) : 24 * 60;
    const schedule: ShiftSchedule = {
      workplace: r.workplace,
      week: r.week as unknown as WeekTemplate,
      openUntil: r.openUntil,
      overrides: Object.fromEntries(r.days.map((d) => [d.date, d.hours as unknown as DayHours])),
    };
    const hit = shiftOverlap([schedule], date, fromMin, toMin);
    if (hit) {
      const card = shiftCards.find((c) => c.id === r.staffId)!;
      return { businessId: card.businessId, staffId: card.id, date, from: hm(hit.from), to: hm(hit.to) };
    }
  }
  return null;
}
