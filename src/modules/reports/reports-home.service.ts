import { Injectable } from '@nestjs/common';
import type { RequestContext } from '../../common/http/context.js';
import { PrismaService } from '../../common/prisma.service.js';
import { utcToLocalDate } from '../../common/time/time.js';
import { clientBookings, dueAtOf, repeatIntervals } from '../clients/clients.visits.js';
import { ReportsDashboardService } from './reports-dashboard.service.js';
import { ReportsJournalService } from './reports-journal.service.js';
import { inRange, localDateAt, locationsOf, tzMapOf, wideUtcBounds, type ReportRange } from './reports-common.js';
import { receivedMoney, sumMoney } from './reports-money.js';

/** Сколько клиентов отдаём в список главной (HOME_LIST_LIMIT фронта) */
const LIST_LIMIT = 50;
/** «Записался после рассылки» — в течение 7 дней (MAILING_RETURN_WINDOW_DAYS фронта) */
const MAILING_WINDOW_DAYS = 7;

type Localized = { ru: string; hy?: string; en?: string };

export interface HomeClientRow {
  clientId: string;
  name: string;
  phone?: string;
  lastVisit?: string;
  dueAt?: string;
  serviceName?: Localized;
}

/**
 * ⭐ Главная владельца (владелец, 01.10.2026; getOwnerHome фронта, src/api/reports.ts). Пять цифр — ТЕ ЖЕ расчёты,
 * что отчёты, куда ведут кнопки, поэтому цифры совпадают по построению:
 * - выручка к плану — полученные деньги месяца (receivedMoney, как «Итого» overview) и цель из settings/reports.monthlyGoal;
 * - загрузка — итог «Загруженности» (ReportsJournalService.workload);
 * - «записались снова» и «не пришли» — overview за тот же период (extras.rebookingPct, occupancy.noShow);
 * - «пора позвать» — dueAtOf «Клиентов» (подборка «Пора записать»).
 * Плюс отдача от рассылок (записи получателей в течение 7 дней) и «первые шаги» пустого салона.
 */
@Injectable()
export class ReportsHomeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dashboard: ReportsDashboardService,
    private readonly journal: ReportsJournalService,
  ) {}

  async home(ctx: RequestContext, businessId: string, locationIds: string[] | undefined, range: ReportRange, month: string, monthRange: ReportRange) {
    const locations = await locationsOf(this.prisma, businessId, locationIds);
    const canPhones = ctx.member?.permissions.has('clients.phones') ?? false;

    const [settings, monthMoney, overview, load, setup] = await Promise.all([
      this.prisma.businessSetting.findUnique({ where: { businessId_area: { businessId, area: 'reports' } } }),
      receivedMoney(this.prisma, businessId, locations, monthRange),
      this.dashboard.overview(businessId, locationIds, range, {}),
      this.journal.workload(businessId, locationIds, range),
      this.setup(businessId),
    ]);

    const goalRaw = (settings?.data as { monthlyGoal?: Record<string, number> } | undefined)?.monthlyGoal?.[month];
    const goal = typeof goalRaw === 'number' && goalRaw > 0 ? goalRaw : null;
    const revenue = sumMoney(monthMoney);

    const services = await this.prisma.service.findMany({ where: { businessId }, select: { id: true, name: true, repeatIntervalDays: true } });
    const serviceById = new Map(services.map((s) => [s.id, s] as const));
    const lastService = (lines: unknown): Localized | undefined => {
      const list = (lines ?? []) as { serviceId: string }[];
      const line = list.find((l) => serviceById.get(l.serviceId)?.repeatIntervalDays) ?? list[0];
      return line ? (serviceById.get(line.serviceId)?.name as Localized | undefined) : undefined;
    };

    const [due, notRebooked, mailings] = await Promise.all([
      this.due(businessId, canPhones, lastService),
      this.notRebooked(businessId, locations, range, canPhones, lastService),
      this.mailings(businessId, range),
    ]);

    return {
      range,
      month,
      plan: { goal, revenue, percent: goal ? Math.round((revenue / goal) * 100) : null },
      load: {
        pct: load.totalScheduledHours > 0 ? Math.round((load.totalWorkedHours / load.totalScheduledHours) * 100) : null,
        workedHours: load.totalWorkedHours,
        scheduledHours: load.totalScheduledHours,
      },
      rebooking: {
        pct: overview.extras.rebookingPct,
        rebooked: overview.extras.rebookedClients,
        visited: overview.extras.visitedClients,
        notRebooked,
      },
      noShow: { count: overview.occupancy.noShow.count, pct: overview.extras.noShowPct },
      due,
      mailings,
      setup,
      isEmpty: setup.bookings === 0,
    };
  }

  /** «Пора позвать» — та же подборка, что «Пора записать» в «Клиентах» (dueAtOf): срок наступил, будущей записи нет */
  private async due(businessId: string, canPhones: boolean, lastService: (lines: unknown) => Localized | undefined) {
    const [bookings, intervals] = await Promise.all([clientBookings(this.prisma, [businessId]), repeatIntervals(this.prisma, [businessId])]);
    if (!intervals.size) return { count: 0, clients: [] as HomeClientRow[] };
    const now = new Date();
    const today = utcToLocalDate(now);
    const byClient = new Map<string, typeof bookings>();
    for (const b of bookings) if (b.clientId) byClient.set(b.clientId, [...(byClient.get(b.clientId) ?? []), b]);
    const dueIds = new Map<string, string>();
    for (const [clientId, own] of byClient) {
      const dueAt = dueAtOf(own, intervals, now);
      if (dueAt && dueAt <= today) dueIds.set(clientId, dueAt);
    }
    if (!dueIds.size) return { count: 0, clients: [] as HomeClientRow[] };
    const clients = await this.prisma.client.findMany({ where: { id: { in: [...dueIds.keys()] }, businessId, deletedAt: null }, select: { id: true, name: true, phone: true } });
    const rows = clients
      .map((c): HomeClientRow => {
        const own = byClient.get(c.id) ?? [];
        let last: (typeof own)[number] | undefined;
        for (const b of own) if (b.status === 'arrived' && (!last || b.startAt > last.startAt)) last = b;
        return {
          clientId: c.id,
          name: c.name,
          ...(canPhones ? { phone: c.phone } : {}),
          lastVisit: last ? utcToLocalDate(last.startAt) : undefined,
          dueAt: dueIds.get(c.id),
          serviceName: last ? lastService(last.services) : undefined,
        };
      })
      .sort((a, b) => (a.dueAt! < b.dueAt! ? -1 : a.dueAt! > b.dueAt! ? 1 : a.name.localeCompare(b.name)));
    return { count: rows.length, clients: rows.slice(0, LIST_LIMIT) };
  }

  /** «Не записались снова» — то же правило, что «Доля перезаписи» overview (ReportsDashboardService.rebookingOf) */
  private async notRebooked(businessId: string, locations: { id: string; tz: string }[], range: ReportRange, canPhones: boolean, lastService: (lines: unknown) => Localized | undefined) {
    const tzMap = tzMapOf(locations);
    const { from, to } = wideUtcBounds(range);
    const arrived = (
      await this.prisma.booking.findMany({
        where: { businessId, locationId: { in: locations.map((l) => l.id) }, status: 'arrived', deletedAt: null, startAt: { gte: from, lt: to }, clientId: { not: null } },
        select: { clientId: true, startAt: true, locationId: true, services: true },
      })
    ).filter((b) => inRange(localDateAt(b.startAt, b.locationId, tzMap), range));
    const { lastVisit, rebooked } = await this.dashboard.rebookingOf(businessId, locations, arrived);
    const ids = [...lastVisit.entries()].filter(([id]) => !rebooked.has(id)).sort((a, b) => (a[1] < b[1] ? -1 : 1));
    if (!ids.length) return [] as HomeClientRow[];
    const clients = await this.prisma.client.findMany({ where: { id: { in: ids.map(([id]) => id) }, businessId, deletedAt: null }, select: { id: true, name: true, phone: true } });
    const byId = new Map(clients.map((c) => [c.id, c] as const));
    const lastLines = new Map<string, { at: Date; services: unknown }>();
    for (const b of arrived) {
      const prev = lastLines.get(b.clientId!);
      if (!prev || b.startAt > prev.at) lastLines.set(b.clientId!, { at: b.startAt, services: b.services });
    }
    return ids
      .filter(([id]) => byId.has(id))
      .slice(0, LIST_LIMIT)
      .map(([id, date]): HomeClientRow => {
        const c = byId.get(id)!;
        return { clientId: id, name: c.name, ...(canPhones ? { phone: c.phone } : {}), lastVisit: date, serviceName: lastService(lastLines.get(id)?.services) };
      });
  }

  /** Отдача от рассылок периода: получатели, записавшиеся в течение 7 дней после отправки; рассылок нет — null */
  private async mailings(businessId: string, range: ReportRange) {
    const { from, to } = wideUtcBounds(range);
    const sent = (
      await this.prisma.notifyMailing.findMany({
        where: { businessId, status: 'sent', OR: [{ sentAt: { gte: from, lt: to } }, { sentAt: null, createdAt: { gte: from, lt: to } }] },
        select: { id: true, sentAt: true, createdAt: true },
      })
    ).filter((m) => inRange(utcToLocalDate(m.sentAt ?? m.createdAt), range));
    if (!sent.length) return null;
    const recipients = await this.prisma.notifyMailingRecipient.findMany({ where: { mailingId: { in: sent.map((m) => m.id) } }, select: { mailingId: true, clientId: true } });
    const byMailing = new Map<string, Set<string>>();
    for (const r of recipients) byMailing.set(r.mailingId, (byMailing.get(r.mailingId) ?? new Set()).add(r.clientId));
    const allRecipients = new Set(recipients.map((r) => r.clientId));
    const earliest = new Date(Math.min(...sent.map((m) => (m.sentAt ?? m.createdAt).getTime())));
    const bookings = allRecipients.size
      ? await this.prisma.booking.findMany({
          where: { businessId, clientId: { in: [...allRecipients] }, deletedAt: null, status: { not: 'cancelled_by_master' }, createdAt: { gt: earliest } },
          select: { id: true, clientId: true, createdAt: true, total: true },
        })
      : [];
    const booked = new Map<string, (typeof bookings)[number]>();
    for (const m of sent) {
      const at = (m.sentAt ?? m.createdAt).getTime();
      const until = at + MAILING_WINDOW_DAYS * 86_400_000;
      const ids = byMailing.get(m.id) ?? new Set<string>();
      for (const b of bookings) {
        const created = b.createdAt.getTime();
        if (b.clientId && ids.has(b.clientId) && created > at && created <= until) booked.set(b.id, b);
      }
    }
    const list = [...booked.values()];
    return {
      mailings: sent.length,
      recipients: allRecipients.size,
      bookedClients: new Set(list.map((b) => b.clientId)).size,
      bookings: list.length,
      bookedAmount: list.reduce((sum, b) => sum + Number(b.total), 0),
      windowDays: MAILING_WINDOW_DAYS,
    };
  }

  /** «Первые шаги» пустого салона: услуги, мастера (у индивидуала — он сам), записи */
  private async setup(businessId: string) {
    const business = await this.prisma.business.findUnique({ where: { id: businessId }, select: { kind: true } });
    const [services, masters, bookings] = await Promise.all([
      this.prisma.service.count({ where: { businessId, active: true } }),
      this.prisma.staff.count({ where: { businessId, deletedAt: null, status: 'active', ...(business?.kind === 'individual' ? {} : { role: 'master' }) } }),
      this.prisma.booking.count({ where: { businessId, deletedAt: null } }),
    ]);
    return { services, masters, bookings };
  }
}
