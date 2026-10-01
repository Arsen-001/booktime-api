import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service.js';
import { DEFAULT_TZ, localDayRangeUtc, utcToLocal } from '../../common/time/time.js';
import { isCancelled } from './rules.js';

/**
 * «Лента изменений за день» журнала (фронт: src/api/journal-feed.ts, ⭐ рабочий день №12). Своих событий не заводит —
 * читает то, что уже пишут: booking_events (создана / статус / перенос / удалена / задерживается) и booking_payments
 * (оплата и её отмена, один платёж = одна строка по groupId). Имена сотрудников и клиентов подставлены — экрану не нужно
 * ничего догружать. Без journal.others — только строки своих записей (staffId — свой).
 */
export type DayFeedKind = 'created' | 'moved' | 'status' | 'cancelled' | 'deleted' | 'delayed' | 'payment' | 'paymentCancelled';

export interface DayFeedItem {
  id: string;
  kind: DayFeedKind;
  at: string;
  bookingId: string;
  businessId: string;
  staffId: string;
  staffName?: string;
  prevStaffId?: string;
  prevStaffName?: string;
  clientName?: string;
  start?: string;
  prevStart?: string;
  from?: string;
  to?: string;
  late?: boolean;
  amount?: number;
  method?: string;
  delayMin?: number;
  by: string;
  byName?: string;
}

const MAX_ITEMS = 500;

@Injectable()
export class DayFeedService {
  constructor(private readonly prisma: PrismaService) {}

  private async tzOf(businessId: string): Promise<string> {
    const loc = await this.prisma.location.findFirst({ where: { businessId, deletedAt: null }, orderBy: { sortOrder: 'asc' }, select: { tz: true } });
    return loc?.tz ?? DEFAULT_TZ;
  }

  async dayFeed(q: { businessIds: string[]; date: string; onlyStaffId?: string }): Promise<DayFeedItem[]> {
    const tz = await this.tzOf(q.businessIds[0] ?? '');
    const { from, to } = localDayRangeUtc(q.date, tz);
    const staffFilter = q.onlyStaffId ? { OR: [{ staffId: q.onlyStaffId }, { prevStaffId: q.onlyStaffId }] } : {};
    const [events, payments] = await Promise.all([
      this.prisma.bookingEvent.findMany({
        where: { businessId: { in: q.businessIds }, at: { gte: from, lt: to }, ...staffFilter },
        orderBy: { at: 'desc' },
        take: MAX_ITEMS,
      }),
      this.prisma.bookingPayment.findMany({
        where: {
          businessId: { in: q.businessIds },
          kind: { not: 'discount' },
          OR: [{ createdAt: { gte: from, lt: to } }, { cancelledAt: { gte: from, lt: to } }],
        },
        select: { id: true, bookingId: true, businessId: true, amount: true, methodLabel: true, groupId: true, finOpId: true, createdAt: true, createdBy: true, cancelled: true, cancelledAt: true },
        take: MAX_ITEMS * 4,
      }),
    ]);

    // Записи оплат и событий: мастер, клиент, время визита — одним запросом
    const bookingIds = [...new Set([...events.map((e) => e.bookingId), ...payments.map((p) => p.bookingId)])];
    const bookings = bookingIds.length
      ? await this.prisma.booking.findMany({
          where: { id: { in: bookingIds } },
          select: { id: true, staffId: true, clientId: true, visitorName: true, startAt: true },
        })
      : [];
    const bookingById = new Map(bookings.map((b) => [b.id, b]));
    const visible = (staffId: string | undefined, prevStaffId?: string | null) =>
      !q.onlyStaffId || staffId === q.onlyStaffId || prevStaffId === q.onlyStaffId;

    const staffIds = new Set<string>();
    const clientIds = new Set<string>();
    for (const e of events) {
      staffIds.add(e.staffId);
      if (e.prevStaffId) staffIds.add(e.prevStaffId);
      if (e.byRef !== 'client' && e.byRef !== 'system') staffIds.add(e.byRef);
      if (e.clientId) clientIds.add(e.clientId);
    }
    for (const p of payments) {
      if (p.createdBy) staffIds.add(p.createdBy);
      const b = bookingById.get(p.bookingId);
      if (b) {
        staffIds.add(b.staffId);
        if (b.clientId) clientIds.add(b.clientId);
      }
    }
    for (const b of bookings) if (b.clientId) clientIds.add(b.clientId);
    const [staff, clients] = await Promise.all([
      staffIds.size ? this.prisma.staff.findMany({ where: { id: { in: [...staffIds] } }, select: { id: true, name: true } }) : [],
      clientIds.size ? this.prisma.client.findMany({ where: { id: { in: [...clientIds] } }, select: { id: true, name: true } }) : [],
    ]);
    const staffName = new Map(staff.map((s) => [s.id, s.name]));
    const clientName = new Map(clients.map((c) => [c.id, c.name]));
    const nameOfBy = (by: string | null | undefined) => (!by || by === 'client' || by === 'system' ? undefined : staffName.get(by));
    const clientOf = (clientId: string | null | undefined, bookingId: string) =>
      (clientId ? clientName.get(clientId) : undefined) ?? bookingById.get(bookingId)?.visitorName ?? undefined;

    const out: DayFeedItem[] = [];
    for (const e of events) {
      const kind: DayFeedKind = e.kind === 'status' && e.toStatus && isCancelled(e.toStatus) ? 'cancelled' : (e.kind as DayFeedKind);
      const movedStaff = e.prevStaffId && e.prevStaffId !== e.staffId;
      out.push({
        id: e.id,
        kind,
        at: utcToLocal(e.at, tz),
        bookingId: e.bookingId,
        businessId: e.businessId,
        staffId: e.staffId,
        ...(staffName.get(e.staffId) ? { staffName: staffName.get(e.staffId) } : {}),
        ...(movedStaff ? { prevStaffId: e.prevStaffId!, prevStaffName: staffName.get(e.prevStaffId!) } : {}),
        ...(clientOf(e.clientId, e.bookingId) ? { clientName: clientOf(e.clientId, e.bookingId) } : {}),
        start: e.startLocal,
        ...(e.kind === 'moved' && e.prevStart ? { prevStart: e.prevStart } : {}),
        ...(e.fromStatus ? { from: e.fromStatus } : {}),
        ...(e.toStatus ? { to: e.toStatus } : {}),
        ...(e.late ? { late: true } : {}),
        ...(e.delayMin ? { delayMin: e.delayMin } : {}),
        by: e.byRef,
        ...(nameOfBy(e.byRef) ? { byName: nameOfBy(e.byRef) } : {}),
      });
    }

    // Оплаты: строки одного нажатия «Оплатить» (groupId, у старых — операция) — одна строка ленты
    const grouped = new Map<string, DayFeedItem>();
    for (const p of payments) {
      const b = bookingById.get(p.bookingId);
      if (!b || !visible(b.staffId)) continue;
      const key = p.groupId ?? p.finOpId ?? p.id;
      const add = (kind: 'payment' | 'paymentCancelled', at: Date) => {
        const id = `${kind}:${key}`;
        const prev = grouped.get(id);
        if (prev) {
          prev.amount = (prev.amount ?? 0) + Number(p.amount);
          return;
        }
        const by = p.createdBy ?? 'system';
        grouped.set(id, {
          id,
          kind,
          at: utcToLocal(at, tz),
          bookingId: b.id,
          businessId: p.businessId,
          staffId: b.staffId,
          ...(staffName.get(b.staffId) ? { staffName: staffName.get(b.staffId) } : {}),
          ...(clientOf(b.clientId, b.id) ? { clientName: clientOf(b.clientId, b.id) } : {}),
          start: utcToLocal(b.startAt, tz),
          amount: Number(p.amount),
          method: p.methodLabel,
          by,
          ...(nameOfBy(by) ? { byName: nameOfBy(by) } : {}),
        });
      };
      if (p.createdAt >= from && p.createdAt < to) add('payment', p.createdAt);
      if (p.cancelled && p.cancelledAt && p.cancelledAt >= from && p.cancelledAt < to) add('paymentCancelled', p.cancelledAt);
    }
    out.push(...grouped.values());
    return out.sort((a, b) => (a.at === b.at ? b.id.localeCompare(a.id) : b.at.localeCompare(a.at))).slice(0, MAX_ITEMS);
  }
}
