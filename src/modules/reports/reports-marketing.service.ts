import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service.js';
import { localDateAt, locationsOf, tzMapOf, wideUtcBounds, type ReportRange } from './reports-common.js';
import { utcToLocal } from '../../common/time/time.js';

/**
 * «Акции» (F-12-064…067) и «Сообщения» (F-12-068…071), docs/backend/02 §16 `promotions`/`messages`.
 *
 * Честная приближённость «Акций»: схема (этап 11) не хранит, какая именно `Promotion` сработала на конкретном
 * визите (ServiceLine несёт только `discountPct`, без ссылки на акцию) — «клиенты акции» приближены КЛИЕНТАМИ,
 * у которых есть карта одного из `Promotion.cardTypeIds`, применённая к их визитам в диапазоне; точная привязка
 * визит↔акция потребовала бы добавить `promotionId` на строку услуги в этапе 11 (не этот этап меняет прошлый).
 *
 * «Сообщения» сейчас показывают только push (`notify_outbox`, этап 10) — SMS/WhatsApp бизнеса (В-08) остаются
 * адаптером-заглушкой без своего журнала (см. docs/PROGRESS.md этапа 10); появится свой лог — добавится сюда.
 */
const NOTIFY_STATUS_TO_SCREEN: Record<string, string> = { queued: 'sending', sent: 'sent', skipped: 'notDelivered', failed: 'rejected' };

@Injectable()
export class ReportsMarketingService {
  constructor(private readonly prisma: PrismaService) {}

  async promotions(businessId: string, promotionId: string, range: ReportRange) {
    const promo = await this.prisma.promotion.findFirst({ where: { id: promotionId, businessId } });
    const emptyClients = { newCount: 0, returningCount: 0, cameByPromotion: 0, cameAgain: 0, notReturned: 0, byDay: [] };
    if (!promo) return { promotionName: '', clients: emptyClients, revenue: 0, repeatRevenue: 0, staff: [] };
    const promotionName = promo.name;
    const cardTypeIds = promo.cardTypeIds as string[];
    const locations = await locationsOf(this.prisma, businessId);
    const tzMap = tzMapOf(locations);
    const { from, to } = wideUtcBounds(range);

    const cards = cardTypeIds.length ? await this.prisma.loyaltyCard.findMany({ where: { businessId, cardTypeId: { in: cardTypeIds } }, select: { clientId: true, createdAt: true } }) : [];
    const promoClientIds = new Set(cards.map((c) => c.clientId).filter((x): x is string => Boolean(x)));
    if (!promoClientIds.size) return { promotionName, clients: emptyClients, revenue: 0, repeatRevenue: 0, staff: [] };

    const bookings = await this.prisma.booking.findMany({
      where: { businessId, status: 'arrived', clientId: { in: [...promoClientIds] }, startAt: { gte: from, lt: to } },
      select: { clientId: true, staffId: true, startAt: true, locationId: true, total: true },
    });
    const inWindow = bookings.filter((b) => {
      const d = localDateAt(b.startAt, b.locationId, tzMap);
      return d >= range.from && d <= range.to;
    });
    const byDayMap = new Map<string, number>();
    for (const b of inWindow) {
      const d = localDateAt(b.startAt, b.locationId, tzMap);
      byDayMap.set(d, (byDayMap.get(d) ?? 0) + 1);
    }
    const perClientVisits = new Map<string, number>();
    for (const b of inWindow) if (b.clientId) perClientVisits.set(b.clientId, (perClientVisits.get(b.clientId) ?? 0) + 1);
    const cameByPromotion = perClientVisits.size;
    const cameAgain = [...perClientVisits.values()].filter((n) => n > 1).length;
    const cardsIssuedFirst = new Map(cards.map((c) => [c.clientId, c.createdAt] as const));
    let newCount = 0;
    for (const cid of perClientVisits.keys()) {
      const issued = cardsIssuedFirst.get(cid);
      if (issued && issued >= from) newCount += 1;
    }
    const notReturned = [...promoClientIds].filter((cid) => !perClientVisits.has(cid)).length;

    const perStaff = new Map<string, { clients: Set<string>; repeat: Set<string> }>();
    for (const b of inWindow) {
      const cell = perStaff.get(b.staffId) ?? { clients: new Set<string>(), repeat: new Set<string>() };
      if (b.clientId) {
        if (cell.clients.has(b.clientId)) cell.repeat.add(b.clientId);
        cell.clients.add(b.clientId);
      }
      perStaff.set(b.staffId, cell);
    }
    const staffNames = await this.prisma.staff.findMany({ where: { id: { in: [...perStaff.keys()] } }, select: { id: true, name: true } });
    const staffNameMap = new Map(staffNames.map((s) => [s.id, s.name] as const));
    const staff = [...perStaff.entries()].map(([staffId, v]) => ({ staffId, staffName: staffNameMap.get(staffId) ?? '', clientsServed: v.clients.size, clientsReturned: v.repeat.size }));

    const revenue = inWindow.reduce((s, b) => s + Number(b.total), 0);
    const repeatRevenue = inWindow.filter((b) => b.clientId && (perClientVisits.get(b.clientId) ?? 0) > 1).reduce((s, b) => s + Number(b.total), 0);

    return {
      promotionName,
      clients: { newCount, returningCount: cameByPromotion - newCount, cameByPromotion, cameAgain, notReturned, byDay: [...byDayMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, visits]) => ({ date, visits })) },
      revenue,
      repeatRevenue,
      staff,
    };
  }

  async messages(
    businessId: string,
    filters: { range: ReportRange; typeCode?: string; status?: string; phoneSearch?: string; channel?: string; page: number; pageSize: number },
  ) {
    if (filters.channel && filters.channel !== 'push') return { items: [], total: 0 };
    const { from, to } = wideUtcBounds(filters.range);
    const rows = await this.prisma.notifyOutbox.findMany({
      where: { businessId, app: 'client', createdAt: { gte: from, lt: to }, ...(filters.typeCode ? { kind: filters.typeCode } : {}), ...(filters.status ? { status: filters.status } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 5000,
    });
    const inWindow = rows.filter((r) => {
      const d = r.createdAt.toISOString().slice(0, 10);
      return d >= filters.range.from && d <= filters.range.to;
    });
    const userIds = [...new Set(inWindow.map((r) => r.recipientUserId))];
    const users = userIds.length ? await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, phone: true } }) : [];
    const phoneMap = new Map(users.map((u) => [u.id, u.phone] as const));
    let items = inWindow.map((r) => ({
      id: r.id,
      at: utcToLocal(r.createdAt),
      typeLabel: r.kind,
      channel: 'push',
      // notify_outbox — свой словарь статусов (queued|sent|skipped|failed, этап 10), у экрана словарь SMS-
      // провайдера (messages.json: sent/delivered/notDelivered/sending/rejected…) — приводим к ближайшему,
      // а не заводим новые ключи под словарь, рассчитанный на настоящего провайдера (В-08, ещё не подключён)
      status: NOTIFY_STATUS_TO_SCREEN[r.status] ?? r.status,
      contact: phoneMap.get(r.recipientUserId) ?? '',
      text: r.body,
    }));
    if (filters.phoneSearch) items = items.filter((i) => i.contact.includes(filters.phoneSearch!));
    const total = items.length;
    const page = items.slice((filters.page - 1) * filters.pageSize, filters.page * filters.pageSize);
    return { items: page, total };
  }
}
