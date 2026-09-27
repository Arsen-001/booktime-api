import type { Prisma } from '../../generated/prisma/client.js';
import type { PrismaService } from '../../common/prisma.service.js';
import { utcToLocal } from '../../common/time/time.js';
import type { BookingIndexEntry } from './clients.filters.js';
import type { ClientRowView } from './clients.views.js';

type Db = PrismaService | Prisma.TransactionClient;

interface BookingLite {
  id: string;
  clientId: string | null;
  visitId: string | null;
  staffId: string;
  status: string;
  startAt: Date;
  total: bigint;
  paidAmount: bigint;
  extras: unknown;
  services: unknown;
}

/**
 * Записи клиентов бизнеса (этап 7) → поля строки CRM, которые этап 5 честно держал нулями: визиты, первый/последний
 * визит, отмены, «Продано / Оплачено / Баланс» — то же правило денег, что clientMoney фронта (src/domain/clients/money.ts):
 * визит = группа записей одного прихода (visitId); «Пришёл» без отдельной оплаты считается оплаченным (В-39); явная
 * оплата визита — сумма строк оплаты записи. И индекс записей для конструктора фильтров (FilterContext.bookings).
 */
export async function clientBookings(db: Db, businessIds: string[], clientIds?: string[]): Promise<BookingLite[]> {
  return db.booking.findMany({
    where: { businessId: { in: businessIds }, deletedAt: null, clientId: clientIds ? { in: clientIds } : { not: null } },
    select: { id: true, clientId: true, visitId: true, staffId: true, status: true, startAt: true, total: true, paidAmount: true, extras: true, services: true },
    orderBy: { startAt: 'asc' },
  });
}

export function withVisits(rows: ClientRowView[], bookings: BookingLite[], clientPaid: Map<string, number>): ClientRowView[] {
  const byClient = new Map<string, BookingLite[]>();
  for (const b of bookings) if (b.clientId) byClient.set(b.clientId, [...(byClient.get(b.clientId) ?? []), b]);
  return rows.map((row) => {
    const own = byClient.get(row.id) ?? [];
    if (!own.length) return row;
    const arrived = own.filter((b) => b.status === 'arrived');
    const dates = arrived.map((b) => utcToLocal(b.startAt).slice(0, 10)).sort();
    const groups = new Map<string, { total: number; paid: number; explicit: boolean }>();
    for (const b of arrived) {
      const key = b.visitId ?? b.id;
      const g = groups.get(key) ?? { total: 0, paid: 0, explicit: false };
      g.total += Number(b.total);
      const payments = ((b.extras as { payments?: unknown[] } | null)?.payments ?? []) as unknown[];
      if (payments.length || Number(b.paidAmount) > 0) {
        g.explicit = true;
        g.paid += Number(b.paidAmount);
      }
      groups.set(key, g);
    }
    let soldVisits = 0;
    let visitsPaid = 0;
    for (const g of groups.values()) {
      soldVisits += g.total;
      visitsPaid += g.explicit ? g.paid : g.total;
    }
    const sold = soldVisits + row.sold;
    const paid = visitsPaid + (clientPaid.get(row.id) ?? row.paid);
    return {
      ...row,
      visits: groups.size,
      firstVisit: dates[0],
      lastVisit: dates[dates.length - 1],
      cancelCount: own.filter((b) => b.status === 'cancelled_by_client' || b.status === 'cancelled_by_master').length,
      sold,
      paid,
      balance: paid - sold,
    };
  });
}

export function bookingIndex(bookings: BookingLite[]): BookingIndexEntry[] {
  return bookings
    .filter((b) => b.clientId)
    .map((b) => ({
      clientId: b.clientId!,
      status: b.status,
      start: utcToLocal(b.startAt),
      total: Number(b.total),
      staffId: b.staffId,
      serviceIds: ((b.services ?? []) as { serviceId: string }[]).map((l) => l.serviceId),
    }));
}

/** В-38: постоянный клиент — 3+ состоявшихся визита за последние 12 месяцев */
export function isRegular(bookings: BookingLite[], clientId: string, now = new Date()): boolean {
  const since = now.getTime() - 365 * 86_400_000;
  const visits = new Set(bookings.filter((b) => b.clientId === clientId && b.status === 'arrived' && b.startAt.getTime() >= since && b.startAt.getTime() <= now.getTime()).map((b) => b.visitId ?? b.id));
  return visits.size >= 3;
}
