var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service.js';
import { locationsOf, localDateAt, metricValue, priorRange, tzMapOf, wideUtcBounds } from './reports-common.js';
const ARRIVED = 'arrived';
const CANCELLED = ['cancelled_by_client', 'cancelled_by_master', 'no_show'];
const INCOMPLETE = ['awaiting_confirmation', 'awaiting_prepayment', 'scheduled', 'client_confirmed'];
let ReportsDashboardService = class ReportsDashboardService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async churnDaysOf(businessId) {
        const row = await this.prisma.businessSetting.findUnique({ where: { businessId_area: { businessId, area: 'reports' } } });
        const days = row?.data?.churnDays;
        return typeof days === 'number' && days > 0 ? days : 60;
    }
    async bookingsInRange(businessId, locations, range, staffId, position) {
        const tzMap = tzMapOf(locations);
        const { from, to } = wideUtcBounds(range);
        let staffIds;
        if (position) {
            const staff = await this.prisma.staff.findMany({ where: { businessId, deletedAt: null }, select: { id: true, position: true } });
            staffIds = staff.filter((s) => (s.position?.ru ?? '') === position).map((s) => s.id);
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
            select: { id: true, staffId: true, clientId: true, status: true, total: true, paidAmount: true, startAt: true, locationId: true, durationMin: true },
        });
        return rows.filter((b) => {
            const d = localDateAt(b.startAt, b.locationId, tzMap);
            return d >= range.from && d <= range.to;
        });
    }
    async overview(businessId, locationIds, range, filters) {
        const locations = await locationsOf(this.prisma, businessId, locationIds);
        const tzMap = tzMapOf(locations);
        const dateOf = (b) => localDateAt(b.startAt, b.locationId, tzMap);
        const [current, previous, churnDays] = await Promise.all([
            this.bookingsInRange(businessId, locations, range, filters.staffId, filters.position),
            this.bookingsInRange(businessId, locations, priorRange(range), filters.staffId, filters.position),
            this.churnDaysOf(businessId),
        ]);
        const curArrived = current.filter((b) => b.status === ARRIVED);
        const prevArrived = previous.filter((b) => b.status === ARRIVED);
        // Продажи товаров визита (StockOp type=sale, этап 13) — привязаны к тем же bookingId
        const productsOf = async (rows) => {
            if (!rows.length)
                return { amount: 0, count: 0, byDay: new Map() };
            const ops = await this.prisma.stockOp.findMany({ where: { businessId, type: 'sale', cancelledAt: null, bookingId: { in: rows.map((b) => b.id) } }, select: { id: true, bookingId: true } });
            const lines = ops.length ? await this.prisma.stockOpLine.findMany({ where: { opId: { in: ops.map((o) => o.id) } } }) : [];
            let amount = 0;
            let count = 0;
            const byDay = new Map();
            for (const op of ops) {
                const booking = rows.find((b) => b.id === op.bookingId);
                const day = booking ? dateOf(booking) : undefined;
                for (const line of lines.filter((l) => l.opId === op.id)) {
                    const lineAmount = Number(line.unitPrice) * line.qtySale;
                    amount += lineAmount;
                    count += 1;
                    if (day)
                        byDay.set(day, (byDay.get(day) ?? 0) + lineAmount);
                }
            }
            return { amount, count, byDay };
        };
        const [curProducts, prevProducts] = await Promise.all([productsOf(curArrived), productsOf(prevArrived)]);
        const curServicesAmount = curArrived.reduce((s, b) => s + Number(b.total), 0);
        const prevServicesAmount = prevArrived.reduce((s, b) => s + Number(b.total), 0);
        const curTotal = curServicesAmount + curProducts.amount;
        const prevTotal = prevServicesAmount + prevProducts.amount;
        const byDayMap = new Map();
        for (const b of curArrived) {
            const cell = byDayMap.get(dateOf(b)) ?? { total: 0, services: 0, products: 0 };
            cell.services += Number(b.total);
            cell.total += Number(b.total);
            byDayMap.set(dateOf(b), cell);
        }
        for (const [day, amt] of curProducts.byDay) {
            const cell = byDayMap.get(day) ?? { total: 0, services: 0, products: 0 };
            cell.products += amt;
            cell.total += amt;
            byDayMap.set(day, cell);
        }
        const byDay = [...byDayMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, ...v }));
        const sales = {
            total: { ...metricValue(curTotal, prevTotal), count: curArrived.length },
            services: { ...metricValue(curServicesAmount, prevServicesAmount), count: curArrived.length },
            products: { ...metricValue(curProducts.amount, prevProducts.amount), count: curProducts.count },
            avgVisit: metricValue(curArrived.length ? Math.round(curTotal / curArrived.length) : 0, prevArrived.length ? Math.round(prevTotal / prevArrived.length) : 0),
            avgService: metricValue(curArrived.length ? Math.round(curServicesAmount / curArrived.length) : 0, prevArrived.length ? Math.round(prevServicesAmount / prevArrived.length) : 0),
            avgProduct: metricValue(curProducts.count ? Math.round(curProducts.amount / curProducts.count) : 0, prevProducts.count ? Math.round(prevProducts.amount / prevProducts.count) : 0),
            byDay,
        };
        // Посещаемость: «новый» — эта запись и есть самый ранний визит клиента за всё время (F-00-131)
        const curClients = new Set(curArrived.map((b) => b.clientId).filter((x) => Boolean(x)));
        const prevClients = new Set(prevArrived.map((b) => b.clientId).filter((x) => Boolean(x)));
        const firstVisit = curClients.size
            ? await this.prisma.booking.groupBy({ by: ['clientId'], where: { businessId, clientId: { in: [...curClients] }, status: ARRIVED, deletedAt: null }, _min: { startAt: true } })
            : [];
        const firstVisitMap = new Map(firstVisit.map((r) => [r.clientId, r._min.startAt.getTime()]));
        const newClientsByDayMap = new Map();
        let newClients = 0;
        for (const b of curArrived) {
            if (!b.clientId)
                continue;
            const isFirstEver = firstVisitMap.get(b.clientId) === b.startAt.getTime();
            const cell = newClientsByDayMap.get(dateOf(b)) ?? { newClients: 0, returningClients: 0 };
            if (isFirstEver) {
                cell.newClients += 1;
                newClients += 1;
            }
            else
                cell.returningClients += 1;
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
        const cancelledCount = current.filter((b) => CANCELLED.includes(b.status)).length;
        const totalCount = current.length || 1;
        const pct = (n) => Math.round((n / totalCount) * 1000) / 10;
        const occByDayMap = new Map();
        for (const b of current) {
            const cell = occByDayMap.get(dateOf(b)) ?? { done: 0, total: 0 };
            cell.total += 1;
            if (b.status === ARRIVED)
                cell.done += 1;
            occByDayMap.set(dateOf(b), cell);
        }
        const occupancy = {
            completed: { count: completedCount, sharePct: pct(completedCount) },
            incomplete: { count: incompleteCount, sharePct: pct(incompleteCount) },
            cancelled: { count: cancelledCount, sharePct: pct(cancelledCount) },
            avgOccupancyPct: pct(completedCount),
            byDay: [...occByDayMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, occupancyPct: v.total ? Math.round((v.done / v.total) * 1000) / 10 : 0 })),
        };
        return { sales, attendance, occupancy, isEmpty: current.length === 0 && curProducts.count === 0 };
    }
};
ReportsDashboardService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [PrismaService])
], ReportsDashboardService);
export { ReportsDashboardService };
//# sourceMappingURL=reports-dashboard.service.js.map