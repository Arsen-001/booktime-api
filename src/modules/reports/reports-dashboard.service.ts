import { Inject, Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service.js';
import { ScheduleService } from '../schedule/schedule.service.js';
import type { ScheduleHoursSource } from './reports-journal.service.js';
import type { z } from 'zod';
import { locationsOf, localDateAt, metricValue, priorRange, tzMapOf, wideUtcBounds, type ReportRange } from './reports-common.js';
import { receivedMoney, sumMoney, type ReceivedMoney } from './reports-money.js';
import type { dashboardQuery } from './reports.schemas.js';

/**
 * «Основные показатели» (F-12-009…018, docs/backend/02 §16 `overview`). Считаем по Booking (F-00-131: «пришёл ·
 * сумма» = status='arrived') + продажи товаров из StockOp (этап 13). Упрощения, записанные честно (PROGRESS.md):
 * - avgOccupancyPct = доля завершённых записей (completed.sharePct) — полный расчёт «занято/доступно по графику»
 *   уже есть в отчёте «Загруженность» (getWorkloadReport); дублировать тяжёлый проход графика здесь не стали.
 * - newClients — booking IS клиента-самой-ранней visit ever (без доп. запроса на локацию первого визита);
 *   lostClients — снимок «на конец периода»: последний визит клиента СТАРШЕ churnDays дней до `to`.
 */
type Query = z.infer<typeof dashboardQuery>;
type BookingRow = { id: string; staffId: string; clientId: string | null; status: string; total: bigint; paidAmount: bigint; startAt: Date; locationId: string; durationMin: number; visitId: string | null; services: unknown; source: string };

const ARRIVED = 'arrived';
const CANCELLED = ['cancelled_by_client', 'cancelled_by_master', 'no_show'];
const INCOMPLETE = ['awaiting_confirmation', 'awaiting_prepayment', 'scheduled', 'client_confirmed'];

@Injectable()
export class ReportsDashboardService {
  /** График мастеров (ScheduleService.hours) — для «Средней заполненности» и «Выручки на час по графику», как мок.
   *  Воркер выгрузки создаёт сервис без графика — тогда заполненность = доля завершённых записей (прежнее упрощение). */
  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(ScheduleService) private readonly schedule?: ScheduleHoursSource,
  ) {}

  /**
   * Отч13 «Доля перезаписи» (rebookingOf мока): из клиентов, пришедших в периоде, у кого уже есть следующая запись —
   * не отменённая, в тех же филиалах (и у тех же сотрудников при фильтре), день позже последнего визита периода.
   * Одно правило для «Основных показателей» и главной владельца.
   */
  async rebookingOf(
    businessId: string,
    locations: { id: string; tz: string }[],
    arrived: Pick<BookingRow, 'clientId' | 'startAt' | 'locationId'>[],
    staffOk: (id: string) => boolean = () => true,
  ): Promise<{ lastVisit: Map<string, string>; rebooked: Set<string> }> {
    const tzMap = tzMapOf(locations);
    const lastVisit = new Map<string, string>();
    let earliest: Date | undefined;
    for (const b of arrived) {
      if (!b.clientId) continue;
      const d = localDateAt(b.startAt, b.locationId, tzMap);
      const prev = lastVisit.get(b.clientId);
      if (!prev || d > prev) lastVisit.set(b.clientId, d);
      if (!earliest || b.startAt < earliest) earliest = b.startAt;
    }
    const rebooked = new Set<string>();
    if (!lastVisit.size || !earliest) return { lastVisit, rebooked };
    const next = await this.prisma.booking.findMany({
      where: {
        businessId,
        clientId: { in: [...lastVisit.keys()] },
        locationId: { in: locations.map((l) => l.id) },
        deletedAt: null,
        status: { notIn: ['cancelled_by_client', 'cancelled_by_master'] },
        startAt: { gt: earliest },
      },
      select: { clientId: true, staffId: true, startAt: true, locationId: true },
    });
    for (const b of next) {
      if (!b.clientId || !staffOk(b.staffId)) continue;
      const last = lastVisit.get(b.clientId);
      if (last && localDateAt(b.startAt, b.locationId, tzMap) > last) rebooked.add(b.clientId);
    }
    return { lastVisit, rebooked };
  }

  /** Минуты смен мастеров по графику за период (как знаменатель «Загруженности»: мастера бизнеса, кроме снятых
   *  галочкой F-12-008). null — графика нет (воркер выгрузки). */
  private async scheduledMinutes(businessId: string, range: ReportRange, staffOk: (id: string) => boolean): Promise<number | null> {
    if (!this.schedule) return null;
    const kind = (await this.prisma.business.findUnique({ where: { id: businessId }, select: { kind: true } }))?.kind;
    const masters = (await this.prisma.staff.findMany({ where: { businessId, deletedAt: null, ...(kind === 'individual' ? {} : { role: 'master' }) }, select: { id: true } })).filter((s) => staffOk(s.id));
    if (!masters.length) return 0;
    const perms = await this.prisma.staffReportsPermission.findMany({ where: { staffId: { in: masters.map((m) => m.id) } }, select: { staffId: true, data: true } });
    const excluded = new Set(perms.filter((p) => (p.data as { workloadIncluded?: boolean } | null)?.workloadIncluded === false).map((p) => p.staffId));
    let total = 0;
    for (const m of masters) {
      if (excluded.has(m.id)) continue;
      try {
        total += (await this.schedule.hours(businessId, m.id, range.from, range.to)).scheduledMinutes;
      } catch {
        /* у мастера нет графика — его часы не входят */
      }
    }
    return total;
  }

  private async churnDaysOf(businessId: string): Promise<number> {
    const row = await this.prisma.businessSetting.findUnique({ where: { businessId_area: { businessId, area: 'reports' } } });
    const days = (row?.data as { churnDays?: number } | undefined)?.churnDays;
    return typeof days === 'number' && days > 0 ? days : 60;
  }

  private async bookingsInRange(businessId: string, locations: { id: string; tz: string }[], range: ReportRange, staffId?: string, position?: string): Promise<BookingRow[]> {
    const tzMap = tzMapOf(locations);
    const { from, to } = wideUtcBounds(range);
    let staffIds: string[] | undefined;
    if (position) {
      const staff = await this.prisma.staff.findMany({ where: { businessId, deletedAt: null }, select: { id: true, position: true } });
      staffIds = staff.filter((s) => ((s.position as { ru?: string } | null)?.ru ?? '') === position).map((s) => s.id);
    }
    const rows = await this.prisma.booking.findMany({
      where: {
        businessId,
        locationId: { in: locations.map((l) => l.id) },
        startAt: { gte: from, lt: to },
        deletedAt: null,
        ...(staffId ? { staffId } : {}),
        ...(staffIds ? { staffId: { in: staffIds } } : {}),
      },
      select: { id: true, staffId: true, clientId: true, status: true, total: true, paidAmount: true, startAt: true, locationId: true, durationMin: true, visitId: true, services: true, source: true },
    });
    return rows.filter((b) => {
      const d = localDateAt(b.startAt, b.locationId, tzMap);
      return d >= range.from && d <= range.to;
    });
  }

  async overview(businessId: string, locationIds: string[] | undefined, range: ReportRange, filters: Pick<Query, 'staffId' | 'position'>) {
    const locations = await locationsOf(this.prisma, businessId, locationIds);
    const tzMap = tzMapOf(locations);
    const dateOf = (b: BookingRow) => localDateAt(b.startAt, b.locationId, tzMap);

    const [current, previous, churnDays] = await Promise.all([
      this.bookingsInRange(businessId, locations, range, filters.staffId, filters.position),
      this.bookingsInRange(businessId, locations, priorRange(range), filters.staffId, filters.position),
      this.churnDaysOf(businessId),
    ]);
    const curArrived = current.filter((b) => b.status === ARRIVED);
    const prevArrived = previous.filter((b) => b.status === ARRIVED);

    // ⭐ Решение владельца 01.10.2026: выручка — полученные деньги (receivedMoney, как «Касса за день»), а не сумма
    // визитов «пришёл». Фильтры «Сотрудник»/«Должность» режут деньги по мастеру визита или продавцу товара; деньги без
    // сотрудника (приход без визита) остаются только в «все сотрудники».
    let positionStaff: Set<string> | undefined;
    if (filters.position) {
      const staff = await this.prisma.staff.findMany({ where: { businessId, deletedAt: null }, select: { id: true, position: true } });
      positionStaff = new Set(staff.filter((s) => ((s.position as { ru?: string } | null)?.ru ?? '') === filters.position).map((s) => s.id));
    }
    const staffOk = (id: string | undefined) => (!filters.staffId && !positionStaff) || (!!id && (!filters.staffId || id === filters.staffId) && (!positionStaff || positionStaff.has(id)));
    const [curMoney, prevMoney] = await Promise.all([
      receivedMoney(this.prisma, businessId, locations, range).then((m) => m.filter((x) => staffOk(x.staffId))),
      receivedMoney(this.prisma, businessId, locations, priorRange(range)).then((m) => m.filter((x) => staffOk(x.staffId))),
    ]);
    // Отч5 (как мок): визит — записи «пришёл», склеенные в визит; средний чек делится на визиты и отдельные продажи
    const computeSales = (arrived: BookingRow[], money: ReceivedMoney[]) => {
      const services = money.filter((m) => m.kind === 'services');
      const products = money.filter((m) => m.kind === 'products');
      const servicesRevenue = sumMoney(services);
      const servicesCount = arrived.reduce((n, b) => n + (Array.isArray(b.services) ? b.services.length : 0), 0);
      const productsRevenue = sumMoney(products);
      const productsCount = products.reduce((n, m) => n + m.qty, 0);
      const saleIds = new Set(products.map((m) => m.saleId));
      const standalone = new Set(products.filter((m) => !m.bookingId).map((m) => m.saleId)).size;
      const visits = new Set(arrived.map((b) => b.visitId ?? b.id)).size;
      const bookedServices = arrived.reduce((n, b) => n + Number(b.total), 0);
      return {
        servicesRevenue,
        servicesCount,
        productsRevenue,
        productsCount,
        receipts: visits + standalone,
        totalRevenue: servicesRevenue + productsRevenue,
        // Решение владельца 01.10.2026 (F-12-010): «операции» = оказанные услуги + проданные штуки товара
        totalCount: servicesCount + productsCount,
        avgVisit: Math.round((servicesRevenue + productsRevenue) / Math.max(1, visits + standalone)),
        avgService: Math.round(servicesRevenue / Math.max(1, servicesCount)),
        avgProduct: Math.round(productsRevenue / Math.max(1, saleIds.size)),
        bookedServices,
        bookedTotal: bookedServices + productsRevenue,
      };
    };
    const cur = computeSales(curArrived, curMoney);
    const prev = computeSales(prevArrived, prevMoney);

    const byDayMap = new Map<string, { total: number; services: number; products: number }>();
    for (const m of curMoney) {
      const cell = byDayMap.get(m.date) ?? { total: 0, services: 0, products: 0 };
      if (m.kind === 'services') cell.services += m.amount;
      else cell.products += m.amount;
      cell.total += m.amount;
      byDayMap.set(m.date, cell);
    }
    const byDay = [...byDayMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, ...v }));

    const sales = {
      total: { ...metricValue(cur.totalRevenue, prev.totalRevenue), count: cur.totalCount },
      services: { ...metricValue(cur.servicesRevenue, prev.servicesRevenue), count: cur.servicesCount },
      products: { ...metricValue(cur.productsRevenue, prev.productsRevenue), count: cur.productsCount },
      avgVisit: { ...metricValue(cur.avgVisit, prev.avgVisit), count: cur.receipts },
      avgService: metricValue(cur.avgService, prev.avgService),
      avgProduct: metricValue(cur.avgProduct, prev.avgProduct),
      // «Записано на сумму» — по цене записи (визиты «пришёл» + товары), отдельно от полученных денег
      booked: { total: cur.bookedTotal, services: cur.bookedServices },
      byDay,
    };

    // Посещаемость: «новый» — эта запись и есть самый ранний визит клиента за всё время (F-00-131)
    const curClients = new Set(curArrived.map((b) => b.clientId).filter((x): x is string => Boolean(x)));
    const prevClients = new Set(prevArrived.map((b) => b.clientId).filter((x): x is string => Boolean(x)));
    const firstVisit = curClients.size
      ? await this.prisma.booking.groupBy({ by: ['clientId'], where: { businessId, clientId: { in: [...curClients] }, status: ARRIVED, deletedAt: null }, _min: { startAt: true } })
      : [];
    const firstVisitMap = new Map(firstVisit.map((r) => [r.clientId as string, r._min.startAt!.getTime()] as const));

    const newClientsByDayMap = new Map<string, { newClients: number; returningClients: number }>();
    const sourceCounts = new Map<string, number>();
    let newClients = 0;
    for (const b of curArrived) {
      if (!b.clientId) continue;
      const isFirstEver = firstVisitMap.get(b.clientId) === b.startAt.getTime();
      const cell = newClientsByDayMap.get(dateOf(b)) ?? { newClients: 0, returningClients: 0 };
      if (isFirstEver) {
        cell.newClients += 1;
        newClients += 1;
        sourceCounts.set(b.source, (sourceCounts.get(b.source) ?? 0) + 1);
      } else cell.returningClients += 1;
      newClientsByDayMap.set(dateOf(b), cell);
    }
    const returningClients = curClients.size - newClients;

    const lastVisitCutoff = new Date(Date.parse(`${range.to}T00:00:00.000Z`) - churnDays * 86_400_000);
    const lastVisitByAll = await this.prisma.booking.groupBy({ by: ['clientId'], where: { businessId, status: ARRIVED, deletedAt: null, clientId: { not: null } }, _max: { startAt: true } });
    const lostClients = lastVisitByAll.filter((r) => r._max.startAt && r._max.startAt < lastVisitCutoff).length;

    const attendance = {
      clients: metricValue(curClients.size, prevClients.size),
      visits: metricValue(curArrived.length, prevArrived.length),
      appointments: metricValue(current.length, previous.length),
      newClients: metricValue(newClients, 0),
      returningClients: metricValue(returningClients, 0),
      lostClients: metricValue(lostClients, 0),
      byDay: [...newClientsByDayMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, ...v })),
    };

    // Заполненность
    const completedCount = curArrived.length;
    const incompleteCount = current.filter((b) => INCOMPLETE.includes(b.status)).length;
    // Отч9 (как мок): «Не пришёл» — своя плитка, в «Отменённых» только отмены
    const noShowCount = current.filter((b) => b.status === 'no_show').length;
    const cancelledCount = current.filter((b) => CANCELLED.includes(b.status) && b.status !== 'no_show').length;
    const totalCount = current.length || 1;
    const pct = (n: number) => Math.round((n / totalCount) * 1000) / 10;
    const occByDayMap = new Map<string, { done: number; total: number }>();
    for (const b of current) {
      const cell = occByDayMap.get(dateOf(b)) ?? { done: 0, total: 0 };
      cell.total += 1;
      if (b.status === ARRIVED) cell.done += 1;
      occByDayMap.set(dateOf(b), cell);
    }
    // Как мок: средняя заполненность — минуты визитов «пришёл» ÷ минуты смен мастеров по графику (без графика —
    // прежнее упрощение «доля завершённых»); те же часы — знаменатель «Выручки на час по графику»
    const staffFilterOk = (id: string) => (!filters.staffId || id === filters.staffId) && (!positionStaff || positionStaff.has(id));
    const scheduled = await this.scheduledMinutes(businessId, range, staffFilterOk);
    const bookedMinutes = curArrived.reduce((n, b) => n + b.durationMin, 0);
    const occupancy = {
      completed: { count: completedCount, sharePct: pct(completedCount) },
      incomplete: { count: incompleteCount, sharePct: pct(incompleteCount) },
      noShow: { count: noShowCount, sharePct: pct(noShowCount) },
      cancelled: { count: cancelledCount, sharePct: pct(cancelledCount) },
      avgOccupancyPct: scheduled === null ? pct(completedCount) : scheduled > 0 ? Math.round((bookedMinutes / scheduled) * 1000) / 10 : 0,
      byDay: [...occByDayMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, occupancyPct: v.total ? Math.round((v.done / v.total) * 1000) / 10 : 0 })),
    };

    // Отч13 (как мок getMainDashboard): перезапись, доля «не пришёл», выручка на час графика, источники новых клиентов
    const { lastVisit, rebooked } = await this.rebookingOf(businessId, locations, curArrived, staffFilterOk);
    const extras = {
      rebookingPct: lastVisit.size > 0 ? Math.round((rebooked.size / lastVisit.size) * 100) : null,
      rebookedClients: rebooked.size,
      visitedClients: lastVisit.size,
      noShowPct: completedCount + noShowCount > 0 ? Math.round((noShowCount / (completedCount + noShowCount)) * 100) : null,
      revenuePerScheduledHour: scheduled ? Math.round(cur.totalRevenue / (scheduled / 60)) : null,
      scheduledHours: Math.round((scheduled ?? 0) / 60),
      newClientSources: [...sourceCounts.entries()].map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count),
    };

    return { sales, attendance, occupancy, extras, isEmpty: current.length === 0 && curMoney.length === 0 };
  }
}
