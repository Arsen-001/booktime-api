import { Injectable } from '@nestjs/common';
import type { Booking as BookingRow } from '../../generated/prisma/client.js';
import type { MemberInfo } from '../../common/http/context.js';
import { moneyToJson } from '../../common/money/money.js';
import { PrismaService } from '../../common/prisma.service.js';
import { DEFAULT_TZ, localDayRangeUtc, nowLocal, utcToLocal } from '../../common/time/time.js';
import { BookingPaymentsService } from '../finance/booking-payments.service.js';
import { bookingView } from '../journal/journal.views.js';
import { extrasOf } from '../journal/rules.js';
import { dayMoneyOf } from './day-money.js';

/**
 * Рабочий день журнала (⭐ 01.10.2026, пункты 5–7 владельца) — то же, что считает мок фронта
 * (src/api/journal-workday.ts, правила — src/domain/journalWorkday.ts):
 *  · утренняя сводка — записи дня, кто не подтвердил, заявки, новые клиенты, дни рождения, предоплаты без
 *    подтверждения, долги клиентов, незакрытые визиты прошлых дней;
 *  · незакрытые визиты — прошедшие записи без «Пришёл»/«Не пришёл» и визиты «Пришёл» с остатком к оплате;
 *  · итоги дня — записи, «не пришёл», отмены, выручка и деньги кассы по способам (смену и Z-отчёт ведёт finance).
 * Мастер без journal.others видит только свои записи (владелец, 01.10.2026).
 */

/** Статусы «до прихода»: у прошедшей записи в них не отмечено ни «Пришёл», ни «Не пришёл» */
const BEFORE_ARRIVAL = ['awaiting_confirmation', 'awaiting_prepayment', 'scheduled', 'client_confirmed'];
const CANCELLED = ['cancelled_by_client', 'cancelled_by_master'];
/** Окно «незакрытых» — как у «Пришли, но не оплатили» финансов */
export const UNCLOSED_DAYS = 14;
const DEBT_DAYS = 365;
const DAY_MS = 86_400_000;

type ClientName = { id: string; name: string; lastName: string | null };

export interface WorkdayItem {
  bookingId: string;
  start: string;
  durationMin: number;
  staffId: string;
  clientId?: string;
  clientName?: string;
  serviceIds: string[];
  total: number;
  status: string;
  /** Клиент нажал «Я оплатил» (предоплата ждёт подтверждения мастера) */
  reported?: boolean;
}

const fullName = (c: ClientName | undefined) => (c ? [c.name, c.lastName].filter(Boolean).join(' ').trim() : undefined);

/** Только свои записи у мастера без journal.others (индивидуал — один на свой бизнес) */
export function ownStaffOf(m: MemberInfo): string | undefined {
  return !m.permissions.has('journal.others') && m.kind !== 'individual' ? m.staffId : undefined;
}

/** День рождения в этот день; 29 февраля в невисокосный год — 28-го (как isBirthdayOn фронта) */
function isBirthdayOn(birthday: string | null, date: string): boolean {
  if (!birthday || birthday.length < 10) return false;
  const md = birthday.slice(5, 10);
  if (md === date.slice(5, 10)) return true;
  const year = Number(date.slice(0, 4));
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return md === '02-29' && !leap && date.slice(5, 10) === '02-28';
}

function ageOn(birthday: string, date: string): number | undefined {
  const y = Number(birthday.slice(0, 4));
  if (!y || y < 1900) return undefined;
  const age = Number(date.slice(0, 4)) - y - (date.slice(5, 10) < birthday.slice(5, 10) ? 1 : 0);
  return age > 0 && age < 120 ? age : undefined;
}

@Injectable()
export class WorkdayService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: BookingPaymentsService,
  ) {}

  private async tzOf(businessId: string): Promise<string> {
    const loc = await this.prisma.location.findFirst({ where: { businessId, deletedAt: null }, orderBy: { sortOrder: 'asc' }, select: { tz: true } });
    return loc?.tz ?? DEFAULT_TZ;
  }

  private async clientNames(ids: (string | null)[]): Promise<Map<string, ClientName>> {
    const list = [...new Set(ids.filter((x): x is string => Boolean(x)))];
    if (!list.length) return new Map();
    const rows = await this.prisma.client.findMany({ where: { id: { in: list } }, select: { id: true, name: true, lastName: true } });
    return new Map(rows.map((r) => [r.id, r]));
  }

  /** Сумма визита к оплате (услуги + товары) — товары считает finance, как в окне оплаты; без товаров — booking.total */
  private async payable(b: BookingRow): Promise<bigint> {
    const goods = extrasOf(b.extras).goodsLines ?? [];
    return goods.length ? (await this.payments.payableOf(b)).payable : b.total;
  }

  private item(b: BookingRow, tz: string, names: Map<string, ClientName>): WorkdayItem {
    const services = Array.isArray(b.services) ? (b.services as { serviceId: string }[]) : [];
    const prepayment = b.prepayment as { paid?: boolean; clientMarkedPaidAt?: string } | null;
    return {
      bookingId: b.id,
      start: utcToLocal(b.startAt, tz),
      durationMin: b.durationMin,
      staffId: b.staffId,
      ...(b.clientId ? { clientId: b.clientId } : {}),
      clientName: fullName(names.get(b.clientId ?? '')) || b.visitorName || undefined,
      serviceIds: services.map((s) => s.serviceId),
      total: moneyToJson(b.total),
      status: b.status,
      ...(prepayment?.clientMarkedPaidAt && !prepayment.paid ? { reported: true } : {}),
    };
  }

  // ─────────── Незакрытые визиты ───────────

  /** Прошедшие записи без отметки прихода и визиты «Пришёл» с остатком, новые сверху */
  async unclosed(businessId: string, staffId: string | undefined, days = UNCLOSED_DAYS, onDate?: string) {
    const tz = await this.tzOf(businessId);
    const now = new Date();
    const range = onDate ? localDayRangeUtc(onDate, tz) : { from: new Date(now.getTime() - Math.max(1, Math.min(days, 60)) * DAY_MS), to: now };
    const rows = await this.prisma.booking.findMany({
      where: {
        businessId,
        deletedAt: null,
        groupEventId: null,
        ...(staffId ? { staffId } : {}),
        startAt: { gte: range.from, lt: range.to < now ? range.to : now },
        status: { in: [...BEFORE_ARRIVAL, 'arrived'] },
      },
      orderBy: { startAt: 'desc' },
      take: 500,
    });
    const names = await this.clientNames(rows.map((b) => b.clientId));
    const out = [];
    for (const b of rows) {
      const ended = b.endAt.getTime() <= now.getTime();
      if (!b.clientId && !b.visitorName && b.total <= 0n) continue; // запись-блок без клиента и суммы — закрывать нечего
      const total = await this.payable(b);
      const due = total - b.paidAmount > 0n ? total - b.paidAmount : 0n;
      let reason: 'arrival' | 'payment' | undefined;
      if (BEFORE_ARRIVAL.includes(b.status) && ended) reason = 'arrival';
      else if (b.status === 'arrived' && due > 0n) reason = 'payment';
      if (!reason) continue;
      out.push({
        booking: bookingView(b, tz),
        clientName: fullName(names.get(b.clientId ?? '')) || b.visitorName || undefined,
        total: moneyToJson(total),
        paid: moneyToJson(total - due),
        due: moneyToJson(due),
        reason,
      });
    }
    return out;
  }

  // ─────────── Утренняя сводка ───────────

  async morning(businessId: string, staffId: string | undefined, date: string) {
    const tz = await this.tzOf(businessId);
    const day = localDayRangeUtc(date, tz);
    // Участники групповых событий — не отдельные визиты (как мок фронта)
    const own = { groupEventId: null, ...(staffId ? { staffId } : {}) };
    const dayRows = await this.prisma.booking.findMany({
      where: { businessId, deletedAt: null, ...own, startAt: { gte: day.from, lt: day.to } },
      orderBy: { startAt: 'asc' },
    });
    const active = dayRows.filter((b) => !CANCELLED.includes(b.status));
    const today = nowLocal(tz).slice(0, 10);
    // Предоплаты без подтверждения — с этого дня и на 30 дней вперёд
    const prepayRows = await this.prisma.booking.findMany({
      where: { businessId, deletedAt: null, ...own, status: 'awaiting_prepayment', startAt: { gte: day.from, lt: new Date(day.from.getTime() + 30 * DAY_MS) } },
      orderBy: { startAt: 'asc' },
      take: 100,
    });
    // Новые клиенты: у клиента записи дня ещё не было ни одного визита «Пришёл» раньше этого дня
    const dayClientIds = [...new Set(active.map((b) => b.clientId).filter((x): x is string => Boolean(x)))];
    const seen = dayClientIds.length
      ? await this.prisma.booking.findMany({
          where: { businessId, deletedAt: null, clientId: { in: dayClientIds }, status: 'arrived', startAt: { lt: day.from } },
          select: { clientId: true },
          distinct: ['clientId'],
        })
      : [];
    const returning = new Set(seen.map((r) => r.clientId));
    // Дни рождения: все клиенты бизнеса (мастеру — только те, кто у него бывал)
    const md = date.slice(5, 10);
    const bdayWhere = md === '02-28' ? { OR: [{ birthday: { endsWith: '-02-28' } }, { birthday: { endsWith: '-02-29' } }] } : { birthday: { endsWith: `-${md}` } };
    let bdayClients = await this.prisma.client.findMany({
      where: { businessId, deletedAt: null, ...bdayWhere },
      select: { id: true, name: true, lastName: true, birthday: true },
      take: 100,
    });
    bdayClients = bdayClients.filter((c) => isBirthdayOn(c.birthday, date));
    if (staffId && bdayClients.length) {
      const mine = await this.prisma.booking.findMany({ where: { businessId, staffId, clientId: { in: bdayClients.map((c) => c.id) } }, select: { clientId: true }, distinct: ['clientId'] });
      const ids = new Set(mine.map((r) => r.clientId));
      bdayClients = bdayClients.filter((c) => ids.has(c.id));
    }
    // Долги: визиты «Пришёл» за год, по которым получено меньше суммы визита
    const debtRows = await this.prisma.booking.findMany({
      where: { businessId, deletedAt: null, ...own, status: 'arrived', clientId: { not: null }, startAt: { gte: new Date(day.to.getTime() - DEBT_DAYS * DAY_MS), lt: day.to } },
    });
    const debtBy = new Map<string, { amount: bigint; visits: number; last: Date }>();
    for (const b of debtRows) {
      const total = await this.payable(b);
      const due = total - b.paidAmount;
      if (due <= 0n || !b.clientId) continue;
      const d = debtBy.get(b.clientId) ?? { amount: 0n, visits: 0, last: b.startAt };
      d.amount += due;
      d.visits += 1;
      if (b.startAt > d.last) d.last = b.startAt;
      debtBy.set(b.clientId, d);
    }
    const names = await this.clientNames([...dayRows, ...prepayRows].map((b) => b.clientId).concat([...debtBy.keys()]));
    const item = (b: BookingRow) => this.item(b, tz, names);
    // Незакрытые прошлых дней (до начала этого дня) — одна цифра со ссылкой на список
    const unclosedBefore = (await this.unclosed(businessId, staffId)).filter((r) => r.booking.start.slice(0, 10) < (date <= today ? date : today)).length;
    const bookingOf = new Map(active.filter((b) => b.clientId).map((b) => [b.clientId!, b]));
    return {
      date,
      bookings: active.map(item),
      notConfirmed: active.filter((b) => b.status === 'scheduled' && b.clientId).map(item),
      requests: active.filter((b) => b.status === 'awaiting_confirmation').map(item),
      newClients: active.filter((b) => b.clientId && !returning.has(b.clientId)).map(item),
      birthdays: bdayClients.map((c) => {
        const b = bookingOf.get(c.id);
        return {
          clientId: c.id,
          name: fullName(c) ?? c.name,
          birthday: c.birthday!,
          ...(ageOn(c.birthday!, date) ? { age: ageOn(c.birthday!, date) } : {}),
          ...(b ? { bookingId: b.id, start: utcToLocal(b.startAt, tz) } : {}),
        };
      }),
      prepayments: prepayRows.map(item),
      debts: [...debtBy.entries()]
        .map(([clientId, d]) => ({ clientId, name: fullName(names.get(clientId)) ?? '', amount: moneyToJson(d.amount), visits: d.visits, lastVisit: utcToLocal(d.last, tz).slice(0, 10) }))
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 50),
      debtTotal: { clients: debtBy.size, amount: moneyToJson([...debtBy.values()].reduce((sum, d) => sum + d.amount, 0n)) },
      unclosedCount: unclosedBefore,
    };
  }

  // ─────────── Итоги дня ───────────

  async dayClose(businessId: string, staffId: string | undefined, date: string) {
    const tz = await this.tzOf(businessId);
    const day = localDayRangeUtc(date, tz);
    const rows = await this.prisma.booking.findMany({
      where: { businessId, deletedAt: null, groupEventId: null, ...(staffId ? { staffId } : {}), startAt: { gte: day.from, lt: day.to } },
      orderBy: { startAt: 'asc' },
    });
    const names = await this.clientNames(rows.map((b) => b.clientId));
    const item = (b: BookingRow) => this.item(b, tz, names);
    const active = rows.filter((b) => !CANCELLED.includes(b.status));
    const arrived = rows.filter((b) => b.status === 'arrived');
    const noShows = rows.filter((b) => b.status === 'no_show');
    const cancelled = rows.filter((b) => CANCELLED.includes(b.status));
    const unclosed = await this.unclosed(businessId, staffId, UNCLOSED_DAYS, date);
    // Деньги кассы за день — операции всех касс бизнеса, датой этого дня (как «Касса за день» finance); мастеру — нет
    const money = staffId ? { cash: 0n, card: 0n, transfer: 0n, other: 0n, refunds: 0n, expense: 0n } : await dayMoneyOf(this.prisma, businessId, day);
    const sum = (xs: BookingRow[]) => moneyToJson(xs.reduce((s, b) => s + b.total, 0n));
    const totalIn = money.cash + money.card + money.transfer + money.other;
    return {
      date,
      counts: { bookings: active.length, arrived: arrived.length, noShow: noShows.length, cancelled: cancelled.length, unclosed: unclosed.length },
      revenue: { booked: sum(active), done: sum(arrived) },
      money: {
        cash: moneyToJson(money.cash),
        card: moneyToJson(money.card),
        transfer: moneyToJson(money.transfer),
        other: moneyToJson(money.other),
        totalIn: moneyToJson(totalIn),
        refunds: moneyToJson(money.refunds),
        expense: moneyToJson(money.expense),
      },
      noShows: noShows.map(item),
      cancellations: cancelled.map(item),
    };
  }
}
