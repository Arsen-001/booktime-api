import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service.js';
import dayjs from 'dayjs';
import { inRange, localDateAt, locationsOf, tzMapOf, wideUtcBounds, type ReportRange } from './reports-common.js';
import { receivedMoney, sumMoney } from './reports-money.js';

function eachDay(range: ReportRange): string[] {
  const out: string[] = [];
  for (let d = dayjs(range.from); !d.isAfter(dayjs(range.to)) && out.length < 400; d = d.add(1, 'day')) out.push(d.format('YYYY-MM-DD'));
  return out;
}

type LocalizedText = { ru: string; hy?: string; en?: string };
const ruOf = (v: unknown): string => (v as LocalizedText | null)?.ru ?? '';
type ServiceLine = { serviceId: string; staffId: string; price: number; qty: number; unitPrice?: number; discountPct?: number; upsellOf?: string };

/**
 * «По сотрудникам/услугам/клиентам» (F-12-050…056, docs/backend/02 §16 `by-staff`/`by-service`/`by-client`).
 * Считаем по Booking.services (снимок строк услуги на момент записи, PLAN §4.1) — визит status='arrived'
 * (F-00-131). Себестоимость расходников/ФОТ на услугу (consumablesCost/payrollCost, F-12-054) — кросс-модульный
 * джойн техкарты (этап 13) и зарплаты (этап 14) на строку, отдельный проход; здесь 0, profit = paidMoney.
 */
@Injectable()
export class ReportsSalesService {
  constructor(private readonly prisma: PrismaService) {}

  private async arrivedInRange(businessId: string, locations: { id: string; tz: string }[], range: ReportRange) {
    const tzMap = tzMapOf(locations);
    const { from, to } = wideUtcBounds(range);
    const rows = await this.prisma.booking.findMany({
      where: { businessId, locationId: { in: locations.map((l) => l.id) }, status: 'arrived', deletedAt: null, startAt: { gte: from, lt: to } },
      select: { id: true, clientId: true, services: true, startAt: true, locationId: true, total: true, staffId: true, durationMin: true, visitId: true, deletedAt: true },
    });
    return { rows: rows.filter((b) => inRange(localDateAt(b.startAt, b.locationId, tzMap), range)), tzMap };
  }

  private async loyaltyByStaff(businessId: string, staffIds: string[], range: ReportRange) {
    if (!staffIds.length) return new Map<string, { points: number; memberships: number; certificates: number; clientAccounts: number }>();
    const { from, to } = wideUtcBounds(range);
    const tx = await this.prisma.loyaltyTx.findMany({ where: { businessId, staffId: { in: staffIds }, kind: 'charge', createdAt: { gte: from, lt: to } }, select: { staffId: true, source: true, amount: true } });
    const map = new Map<string, { points: number; memberships: number; certificates: number; clientAccounts: number }>();
    for (const t of tx) {
      if (!t.staffId) continue;
      const cell = map.get(t.staffId) ?? { points: 0, memberships: 0, certificates: 0, clientAccounts: 0 };
      const amt = Math.abs(Number(t.amount));
      if (t.source === 'card') cell.points += amt;
      else if (t.source === 'membership') cell.memberships += amt;
      else if (t.source === 'certificate') cell.certificates += amt;
      else if (t.source === 'account') cell.clientAccounts += amt;
      map.set(t.staffId, cell);
    }
    return map;
  }

  private discountOf(line: ServiceLine): number {
    if (!line.discountPct) return 0;
    const gross = (line.unitPrice ?? line.price) * line.qty;
    return Math.max(0, Math.round((gross * line.discountPct) / 100));
  }

  // ─────────────────────────── F-12-050…052: «По сотрудникам» ───────────────────────────

  /**
   * ⭐ Решение владельца 01.10.2026 (getSalesByStaff мока): выручка — полученные деньги (receivedMoney) по мастеру
   * визита / продавцу товара; «услуги» (штуки) — оказанные услуги визитов «пришёл». Фильтр услуги/категории режет
   * деньги по визитам, где есть эта услуга. Деньги без сотрудника (приход без визита) — в «Итого»
   * (unassignedRevenue), чтобы итог совпадал с дашбордом и кассой. «Записано на сумму» — bookedAmount/grandBooked.
   */
  async byStaff(businessId: string, locationIds: string[] | undefined, range: ReportRange, filters: { serviceId?: string; serviceCategoryId?: string; position?: string }) {
    const locations = await locationsOf(this.prisma, businessId, locationIds);
    const { rows: arrived } = await this.arrivedInRange(businessId, locations, range);

    let allowedServiceIds: Set<string> | undefined;
    if (filters.serviceId) allowedServiceIds = new Set([filters.serviceId]);
    else if (filters.serviceCategoryId) {
      const svc = await this.prisma.service.findMany({ where: { businessId, categoryId: filters.serviceCategoryId }, select: { id: true } });
      allowedServiceIds = new Set(svc.map((s) => s.id));
    }
    const scoped = allowedServiceIds ? arrived.filter((b) => (b.services as ServiceLine[]).some((l) => allowedServiceIds!.has(l.serviceId))) : arrived;
    const scopedIds = new Set(scoped.map((b) => b.id));
    const money = (await receivedMoney(this.prisma, businessId, locations, range)).filter((m) => !allowedServiceIds || m.kind === 'products' || (!!m.bookingId && scopedIds.has(m.bookingId)));

    const links = await this.prisma.staffLocation.findMany({ where: { locationId: { in: locations.map((l) => l.id) } }, select: { staffId: true } });
    const staffRows = await this.prisma.staff.findMany({ where: { businessId, id: { in: [...new Set(links.map((l) => l.staffId))] }, deletedAt: null }, select: { id: true, name: true, position: true }, orderBy: { sortOrder: 'asc' } });
    const staffList = filters.position ? staffRows.filter((s) => ruOf(s.position) === filters.position) : staffRows;
    const staffIds = staffList.map((s) => s.id);
    const loyalty = await this.loyaltyByStaff(businessId, staffIds, range);
    const { to } = wideUtcBounds(range);
    const futureRows = staffIds.length ? await this.prisma.booking.findMany({ where: { businessId, staffId: { in: staffIds }, locationId: { in: locations.map((l) => l.id) }, deletedAt: null, status: { notIn: ['cancelled_by_client', 'cancelled_by_master', 'no_show'] }, startAt: { gt: to } }, select: { staffId: true, total: true } }) : [];
    const futureByStaff = new Map<string, number>();
    for (const b of futureRows) futureByStaff.set(b.staffId, (futureByStaff.get(b.staffId) ?? 0) + Number(b.total));
    const days = eachDay(range);

    const out = staffList.map((st) => {
      const own = scoped.filter((b) => b.staffId === st.id);
      const ownMoney = money.filter((m) => m.staffId === st.id);
      const servicesAmount = sumMoney(ownMoney.filter((m) => m.kind === 'services'));
      const servicesCount = own.reduce((n, b) => n + (b.services as ServiceLine[]).length, 0);
      const products = ownMoney.filter((m) => m.kind === 'products');
      const productsAmount = sumMoney(products);
      const productsCount = products.reduce((n, m) => n + m.qty, 0);
      const discount = own.reduce((n, b) => n + (b.services as ServiceLine[]).reduce((k, l) => k + this.discountOf(l), 0), 0);
      const l = loyalty.get(st.id) ?? { points: 0, memberships: 0, certificates: 0, clientAccounts: 0 };
      const revenue = servicesAmount + productsAmount;
      const workedHours = Math.round((own.reduce((n, b) => n + b.durationMin, 0) / 60) * 10) / 10;
      const byDayMap = new Map<string, number>();
      for (const m of ownMoney) byDayMap.set(m.date, (byDayMap.get(m.date) ?? 0) + m.amount);
      return {
        staffId: st.id,
        staffName: st.name,
        revenue,
        servicesAmount,
        servicesCount,
        productsAmount,
        productsCount,
        discount,
        points: l.points,
        memberships: l.memberships,
        certificates: l.certificates,
        clientAccounts: l.clientAccounts,
        futureBookingsAmount: futureByStaff.get(st.id) ?? 0,
        workedHours,
        hourCost: workedHours > 0 ? Math.round(revenue / workedHours) : null,
        revenueSharePct: 0,
        bookedAmount: own.reduce((n, b) => n + Number(b.total), 0) + productsAmount,
        byDay: days.map((date) => ({ date, revenue: byDayMap.get(date) ?? 0 })),
      };
    });
    const grand = out.reduce((sum, r) => sum + r.revenue, 0);
    for (const r of out) r.revenueSharePct = grand ? Math.round((r.revenue / grand) * 1000) / 10 : 0;
    const known = new Set(staffIds);
    const unassignedRevenue = filters.position ? 0 : sumMoney(money.filter((m) => !m.staffId || !known.has(m.staffId)));
    return { rows: out, grandRevenue: grand + unassignedRevenue, unassignedRevenue, grandBooked: out.reduce((sum, r) => sum + r.bookedAmount, 0) };
  }

  // ─────────────────────────── F-12-053…054: «По услугам» ───────────────────────────

  async byService(businessId: string, locationIds: string[] | undefined, range: ReportRange, filters: { staffId?: string; categoryId?: string }) {
    const locations = await locationsOf(this.prisma, businessId, locationIds);
    const { rows, tzMap } = await this.arrivedInRange(businessId, locations, range);

    // Строка услуги = price (за единицу после скидки) × qty — как в моке (getSalesByServices) и linesTotal журнала.
    // ⭐ «Допродано» (решение владельца 01.10.2026): строки с upsellOf — услуга добавлена к визиту как сопутствующая;
    // те же визиты/период/мастер, что у остальных колонок, и уже входят в count/paidMoney.
    const perService = new Map<string, { amount: number; count: number; discount: number; upsoldCount: number; upsoldMoney: number; byDay: Map<string, number> }>();
    for (const b of rows) {
      const day = localDateAt(b.startAt, b.locationId, tzMap);
      for (const line of b.services as ServiceLine[]) {
        if (filters.staffId && line.staffId !== filters.staffId) continue;
        const qty = Math.max(1, line.qty || 1);
        const lineTotal = line.price * qty;
        const cell = perService.get(line.serviceId) ?? { amount: 0, count: 0, discount: 0, upsoldCount: 0, upsoldMoney: 0, byDay: new Map<string, number>() };
        cell.amount += lineTotal;
        cell.count += qty;
        cell.discount += this.discountOf(line);
        if (line.upsellOf) {
          cell.upsoldCount += qty;
          cell.upsoldMoney += lineTotal;
        }
        cell.byDay.set(day, (cell.byDay.get(day) ?? 0) + lineTotal);
        perService.set(line.serviceId, cell);
      }
    }
    let serviceIds = [...perService.keys()];
    const services = serviceIds.length ? await this.prisma.service.findMany({ where: { id: { in: serviceIds } }, include: { category: { select: { name: true } } } }) : [];
    if (filters.categoryId) {
      const allowed = new Set(services.filter((s) => s.categoryId === filters.categoryId).map((s) => s.id));
      serviceIds = serviceIds.filter((id) => allowed.has(id));
    }
    const serviceMap = new Map(services.map((s) => [s.id, s] as const));
    const grandPaidMoney = serviceIds.reduce((sum, id) => sum + (perService.get(id)?.amount ?? 0), 0);

    const rowsOut = serviceIds.map((id) => {
      const cell = perService.get(id)!;
      const svc = serviceMap.get(id);
      return {
        serviceId: id,
        serviceName: svc ? ruOf(svc.name) : '',
        categoryName: svc?.category ? ruOf(svc.category.name) : '',
        count: cell.count,
        discount: cell.discount,
        points: 0,
        memberships: 0,
        certificates: 0,
        clientAccounts: 0,
        paidMoney: cell.amount,
        consumablesCost: 0,
        payrollCost: 0,
        profit: cell.amount,
        revenueSharePct: grandPaidMoney ? Math.round((cell.amount / grandPaidMoney) * 1000) / 10 : 0,
        upsoldCount: cell.upsoldCount,
        upsoldMoney: cell.upsoldMoney,
        byDay: [...cell.byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, paidMoney]) => ({ date, paidMoney })),
      };
    });
    return { rows: rowsOut, grandPaidMoney };
  }

  // ─────────────────────────── F-12-055…056: «По клиентам» ───────────────────────────

  /** ⭐ Решение владельца 01.10.2026 (getSalesByClients мока): выручка клиента — полученные от него деньги; визиты — «пришёл» */
  async byClient(businessId: string, locationIds: string[] | undefined, range: ReportRange) {
    const locations = await locationsOf(this.prisma, businessId, locationIds);
    const { rows } = await this.arrivedInRange(businessId, locations, range);
    const money = await receivedMoney(this.prisma, businessId, locations, range);

    const perClient = new Map<string, { revenue: number; visits: Set<string> }>();
    for (const b of rows) {
      if (!b.clientId) continue;
      const cell = perClient.get(b.clientId) ?? { revenue: 0, visits: new Set<string>() };
      cell.visits.add(b.visitId ?? b.id);
      perClient.set(b.clientId, cell);
    }
    for (const m of money) {
      if (!m.clientId) continue;
      const cell = perClient.get(m.clientId) ?? { revenue: 0, visits: new Set<string>() };
      cell.revenue += m.amount;
      perClient.set(m.clientId, cell);
    }
    const clientIds = [...perClient.keys()];
    const clients = clientIds.length ? await this.prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, name: true, phone: true, email: true, deletedAt: true } }) : [];
    const clientMap = new Map(clients.map((c) => [c.id, c] as const));
    const grandRevenue = [...perClient.values()].reduce((sum, c) => sum + c.revenue, 0);

    const rowsOut = clientIds.map((id) => {
      const cell = perClient.get(id)!;
      const c = clientMap.get(id);
      return {
        clientId: id,
        clientName: c?.name ?? '—',
        clientPhone: c?.phone,
        clientEmail: c?.email ?? undefined,
        revenue: cell.revenue,
        revenueSharePct: grandRevenue ? Math.round((cell.revenue / grandRevenue) * 1000) / 10 : 0,
        avgReceipt: cell.visits.size ? Math.round(cell.revenue / cell.visits.size) : 0,
        visits: cell.visits.size,
        clientDeleted: Boolean(c?.deletedAt) || undefined,
      };
    });
    rowsOut.sort((a, b) => b.revenue - a.revenue);
    return { rows: rowsOut, grandRevenue };
  }
}
