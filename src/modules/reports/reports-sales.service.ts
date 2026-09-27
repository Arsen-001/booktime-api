import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service.js';
import { inRange, localDateAt, locationsOf, tzMapOf, wideUtcBounds, type ReportRange } from './reports-common.js';

type LocalizedText = { ru: string; hy?: string; en?: string };
const ruOf = (v: unknown): string => (v as LocalizedText | null)?.ru ?? '';
type ServiceLine = { serviceId: string; staffId: string; price: number; qty: number; unitPrice?: number; discountPct?: number };

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
      where: { businessId, locationId: { in: locations.map((l) => l.id) }, status: 'arrived', startAt: { gte: from, lt: to } },
      select: { id: true, clientId: true, services: true, startAt: true, locationId: true, total: true, staffId: true, durationMin: true },
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

  async byStaff(businessId: string, locationIds: string[] | undefined, range: ReportRange, filters: { serviceId?: string; serviceCategoryId?: string; position?: string }) {
    const locations = await locationsOf(this.prisma, businessId, locationIds);
    const { rows, tzMap } = await this.arrivedInRange(businessId, locations, range);

    let allowedServiceIds: Set<string> | undefined;
    if (filters.serviceId) allowedServiceIds = new Set([filters.serviceId]);
    else if (filters.serviceCategoryId) {
      const svc = await this.prisma.service.findMany({ where: { businessId, categoryId: filters.serviceCategoryId }, select: { id: true } });
      allowedServiceIds = new Set(svc.map((s) => s.id));
    }

    const staffTotals = new Map<string, { servicesAmount: number; servicesCount: number; discount: number; byDay: Map<string, number> }>();
    for (const b of rows) {
      const day = localDateAt(b.startAt, b.locationId, tzMap);
      for (const line of b.services as ServiceLine[]) {
        if (allowedServiceIds && !allowedServiceIds.has(line.serviceId)) continue;
        const cell = staffTotals.get(line.staffId) ?? { servicesAmount: 0, servicesCount: 0, discount: 0, byDay: new Map<string, number>() };
        cell.servicesAmount += line.price;
        cell.servicesCount += 1;
        cell.discount += this.discountOf(line);
        cell.byDay.set(day, (cell.byDay.get(day) ?? 0) + line.price);
        staffTotals.set(line.staffId, cell);
      }
    }
    // F-12-051: часы отработаны считаем по ГЛАВНОМУ мастеру записи (booking.staffId), не по строке услуги —
    // строка может быть выполнена ассистентом, а слот в календаре занимает основной мастер (01 §4)
    const workedMinutes = new Map<string, number>();
    for (const b of rows) workedMinutes.set(b.staffId, (workedMinutes.get(b.staffId) ?? 0) + b.durationMin);

    let staffIds = [...staffTotals.keys()];
    if (filters.position) {
      const staffRows = await this.prisma.staff.findMany({ where: { id: { in: staffIds } }, select: { id: true, position: true } });
      const allowed = new Set(staffRows.filter((s) => ruOf(s.position) === filters.position).map((s) => s.id));
      staffIds = staffIds.filter((id) => allowed.has(id));
    }
    if (!staffIds.length) return { rows: [], grandRevenue: 0 };

    const staffNames = await this.prisma.staff.findMany({ where: { id: { in: staffIds } }, select: { id: true, name: true } });
    const nameMap = new Map(staffNames.map((s) => [s.id, s.name] as const));
    const { from, to } = wideUtcBounds(range);
    const productOps = await this.prisma.stockOp.findMany({ where: { businessId, type: 'sale', cancelledAt: null, staffId: { in: staffIds }, date: { gte: from, lt: to } }, select: { id: true, staffId: true } });
    const productLines = productOps.length ? await this.prisma.stockOpLine.findMany({ where: { opId: { in: productOps.map((o) => o.id) } } }) : [];
    const productsByStaff = new Map<string, { amount: number; count: number }>();
    for (const op of productOps) {
      if (!op.staffId) continue;
      const cell = productsByStaff.get(op.staffId) ?? { amount: 0, count: 0 };
      for (const line of productLines.filter((l) => l.opId === op.id)) {
        cell.amount += Number(line.unitPrice) * line.qtySale;
        cell.count += 1;
      }
      productsByStaff.set(op.staffId, cell);
    }
    const loyalty = await this.loyaltyByStaff(businessId, staffIds, range);
    // F-12-051: сумма БУДУЩИХ записей (деньги, не число — в отличие от F-12-042 «Загруженности»)
    const futureRows = await this.prisma.booking.findMany({ where: { businessId, staffId: { in: staffIds }, deletedAt: null, status: { notIn: ['cancelled_by_client', 'cancelled_by_master'] }, startAt: { gt: to } }, select: { staffId: true, total: true } });
    const futureByStaff = new Map<string, number>();
    for (const b of futureRows) futureByStaff.set(b.staffId, (futureByStaff.get(b.staffId) ?? 0) + Number(b.total));

    const out = staffIds.map((id) => {
      const s = staffTotals.get(id)!;
      const products = productsByStaff.get(id) ?? { amount: 0, count: 0 };
      const l = loyalty.get(id) ?? { points: 0, memberships: 0, certificates: 0, clientAccounts: 0 };
      const revenue = s.servicesAmount + products.amount;
      const workedHours = Math.round(((workedMinutes.get(id) ?? 0) / 60) * 10) / 10;
      return {
        staffId: id,
        staffName: nameMap.get(id) ?? '',
        revenue,
        servicesAmount: s.servicesAmount,
        servicesCount: s.servicesCount,
        productsAmount: products.amount,
        productsCount: products.count,
        discount: s.discount,
        points: l.points,
        memberships: l.memberships,
        certificates: l.certificates,
        clientAccounts: l.clientAccounts,
        futureBookingsAmount: futureByStaff.get(id) ?? 0,
        workedHours,
        // Стоимость часа работы (F-12-051) — начисление ФОТ на час нужно из зарплаты (этап 14, схемы разные
        // по сотруднику); кросс-модульный расчёт на строку отчёта отдельным проходом, здесь честно null.
        hourCost: null as number | null,
        revenueSharePct: 0,
        byDay: [...s.byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, rev]) => ({ date, revenue: rev })),
      };
    });
    const grandRevenue = out.reduce((sum, r) => sum + r.revenue, 0);
    for (const r of out) r.revenueSharePct = grandRevenue ? Math.round((r.revenue / grandRevenue) * 1000) / 10 : 0;
    return { rows: out, grandRevenue };
  }

  // ─────────────────────────── F-12-053…054: «По услугам» ───────────────────────────

  async byService(businessId: string, locationIds: string[] | undefined, range: ReportRange, filters: { staffId?: string; categoryId?: string }) {
    const locations = await locationsOf(this.prisma, businessId, locationIds);
    const { rows, tzMap } = await this.arrivedInRange(businessId, locations, range);

    const perService = new Map<string, { amount: number; count: number; discount: number; byDay: Map<string, number> }>();
    for (const b of rows) {
      const day = localDateAt(b.startAt, b.locationId, tzMap);
      for (const line of b.services as ServiceLine[]) {
        if (filters.staffId && line.staffId !== filters.staffId) continue;
        const cell = perService.get(line.serviceId) ?? { amount: 0, count: 0, discount: 0, byDay: new Map<string, number>() };
        cell.amount += line.price;
        cell.count += 1;
        cell.discount += this.discountOf(line);
        cell.byDay.set(day, (cell.byDay.get(day) ?? 0) + line.price);
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
        byDay: [...cell.byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, paidMoney]) => ({ date, paidMoney })),
      };
    });
    return { rows: rowsOut, grandPaidMoney };
  }

  // ─────────────────────────── F-12-055…056: «По клиентам» ───────────────────────────

  async byClient(businessId: string, locationIds: string[] | undefined, range: ReportRange) {
    const locations = await locationsOf(this.prisma, businessId, locationIds);
    const { rows } = await this.arrivedInRange(businessId, locations, range);

    const perClient = new Map<string, { revenue: number; visits: number }>();
    for (const b of rows) {
      if (!b.clientId) continue;
      const cell = perClient.get(b.clientId) ?? { revenue: 0, visits: 0 };
      cell.revenue += Number(b.total);
      cell.visits += 1;
      perClient.set(b.clientId, cell);
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
        clientName: c?.name ?? '',
        clientPhone: c?.phone,
        clientEmail: c?.email ?? undefined,
        revenue: cell.revenue,
        revenueSharePct: grandRevenue ? Math.round((cell.revenue / grandRevenue) * 1000) / 10 : 0,
        avgReceipt: cell.visits ? Math.round(cell.revenue / cell.visits) : 0,
        visits: cell.visits,
        clientDeleted: Boolean(c?.deletedAt) || undefined,
      };
    });
    return { rows: rowsOut, grandRevenue };
  }
}
