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
import { ApiError } from '../../common/errors/api-error.js';
import { PrismaService } from '../../common/prisma.service.js';
import { DEFAULT_TZ, localDayRangeUtc } from '../../common/time/time.js';
import { ScheduleService } from '../schedule/schedule.service.js';
import { PayrollCatalogService } from './payroll-catalog.service.js';
import { applyDailyGuaranteedMinimum, applyMonthlyGuaranteedMinimum, computeServicesForDay, evaluateCriterionForStaff, extraRevenueAmount, locationServicesTurnover, monthlySalaryQualifies, onlineWidgetRewardForDay, pickRuleForChart, qualifyingMonthlySalaryMonths, recordsRewardForDay, resolveActiveChartAssignment, roundMoney, ruleAsScheme, sumDayResult, } from './payroll-engine.js';
/** Диапазон дней между двумя ISODate включительно (< 400 дней, как у ScheduleService.hours) */
function eachDay(from, to) {
    const out = [];
    let d = new Date(`${from}T00:00:00.000Z`);
    const end = new Date(`${to}T00:00:00.000Z`);
    while (d <= end && out.length < 400) {
        out.push(d.toISOString().slice(0, 10));
        d = new Date(d.getTime() + 86_400_000);
    }
    return out;
}
function monthStartOf(date) {
    return `${date.slice(0, 7)}-01`;
}
/**
 * Расчёт зарплаты за день/период/ведомость (F-09-058…070) — движок `payroll-engine.ts`, данные из bookings/
 * group_events/services/loyalty_tx/tech_cards уже построенных разделов. Честные гэпы (ассистенты, комиссия
 * эквайринга, оплата за товар) см. в шапке payroll-engine.ts и docs/PROGRESS.md.
 */
let PayrollComputeService = class PayrollComputeService {
    constructor(prisma, catalog, schedule) {
        this.prisma = prisma;
        this.catalog = catalog;
        this.schedule = schedule;
    }
    async requireLocation(businessId, locationId) {
        const location = await this.prisma.location.findFirst({ where: { id: locationId, businessId } });
        if (!location)
            throw new ApiError('not_found', 'Location not found');
        return location;
    }
    async staffAtLocation(businessId, locationId) {
        const rows = await this.prisma.staffLocation.findMany({ where: { locationId }, select: { staffId: true } });
        const ids = rows.map((r) => r.staffId);
        if (!ids.length)
            return [];
        return this.prisma.staff.findMany({ where: { id: { in: ids }, businessId, status: { notIn: ['fired', 'disabled'] } }, orderBy: { createdAt: 'asc' } });
    }
    async loadBookings(businessId, locationId, from, to) {
        const { from: gte } = localDayRangeUtc(from, DEFAULT_TZ);
        const { to: lt } = localDayRangeUtc(to, DEFAULT_TZ);
        const rows = await this.prisma.booking.findMany({ where: { businessId, locationId, startAt: { gte, lt } } });
        return rows.map((b) => ({
            id: b.id,
            locationId: b.locationId,
            status: b.status,
            deletedAt: b.deletedAt,
            startAt: b.startAt,
            total: Number(b.total),
            groupEventId: b.groupEventId,
            services: b.services ?? [],
        }));
    }
    async loadGroupEvents(businessId, locationId, from, to) {
        const { from: gte } = localDayRangeUtc(from, DEFAULT_TZ);
        const { to: lt } = localDayRangeUtc(to, DEFAULT_TZ);
        const rows = await this.prisma.groupEvent.findMany({ where: { businessId, locationId, startAt: { gte, lt } } });
        return rows.map((e) => ({ id: e.id, locationId: e.locationId, staffId: e.staffId, serviceId: e.serviceId, status: e.status, startAt: e.startAt }));
    }
    async loadServices(businessId) {
        const rows = await this.prisma.service.findMany({ where: { businessId } });
        return rows.map((s) => ({ id: s.id, categoryId: s.categoryId, name: s.name?.ru || s.name?.en || s.id, priceMin: Number(s.priceMin) }));
    }
    /** F-09-019: доля визита, закрытая каждым видом лояльности (LoyaltyTx.kind='charge', источник → блок) */
    async loyaltyPaidLookup(businessId, bookingIds) {
        if (!bookingIds.length)
            return () => undefined;
        const rows = await this.prisma.loyaltyTx.findMany({ where: { businessId, kind: 'charge', bookingId: { in: bookingIds } } });
        const map = new Map();
        for (const r of rows) {
            if (!r.bookingId)
                continue;
            const amount = Math.abs(Number(r.amount));
            if (amount <= 0)
                continue;
            const entry = map.get(r.bookingId) ?? { bonus: 0, membership: 0, clientAccount: 0, certificate: 0, promotion: 0 };
            if (r.source === 'card')
                entry.bonus += amount;
            else if (r.source === 'membership')
                entry.membership += amount;
            else if (r.source === 'account')
                entry.clientAccount += amount;
            else if (r.source === 'certificate')
                entry.certificate += amount;
            map.set(r.bookingId, entry);
        }
        return (bookingId) => map.get(bookingId);
    }
    /**
     * F-09-110: себестоимость техкарты «услуга × мастер» — сумма (qtyWriteoff × Product.costPrice ТЕКУЩИЙ).
     * 🔒 Честная простота: point-in-time себестоимость (costPriceAt) не построена нигде на сервере — этап 13
     * сам оставил её как есть (docs/PROGRESS.md «Этап 13», «не строил»), поэтому здесь берём цену на СЕЙЧАС,
     * не на дату визита.
     */
    async techCardCostLookup(businessId, locationId) {
        const cards = await this.prisma.techCard.findMany({ where: { businessId, locationId } });
        if (!cards.length)
            return () => undefined;
        const goodIds = new Set();
        for (const c of cards)
            for (const line of c.lines)
                goodIds.add(line.goodId);
        const products = await this.prisma.product.findMany({ where: { id: { in: Array.from(goodIds) } }, select: { id: true, costPrice: true } });
        const costOf = new Map(products.map((p) => [p.id, Number(p.costPrice)]));
        const byKey = new Map(cards.map((c) => [`${c.serviceId}:${c.staffId}`, c]));
        return (serviceId, staffId) => {
            const card = byKey.get(`${serviceId}:${staffId}`);
            if (!card)
                return undefined;
            const lines = card.lines;
            if (!lines.length)
                return undefined;
            return roundMoney(lines.reduce((sum, l) => sum + l.qtyWriteoff * (costOf.get(l.goodId) ?? 0), 0));
        };
    }
    unpaidForBookingLookup(bookings, paidAmounts) {
        const byId = new Map(bookings.map((b) => [b.id, b]));
        return (bookingId) => {
            const b = byId.get(bookingId);
            if (!b)
                return 0;
            return Math.max(0, roundMoney(b.total - (paidAmounts.get(bookingId) ?? 0)));
        };
    }
    /**
     * F-09-002/099: назначение схемы действующее НА `referenceDate` (для периода — конец периода, «смена
     * ставки с 01.10 не меняет сентябрь») — вызывается ОДИН раз, не по дням.
     */
    async resolveEffectiveSchemes(businessId, locationId, staffIds, referenceDate, criteriaBookings) {
        const settings = await this.catalog.ensureSettings(locationId, businessId);
        const map = new Map();
        const simplifiedRows = await this.prisma.payrollScheme.findMany({ where: { businessId, staffId: { in: staffIds } } });
        const simplifiedByStaff = new Map(simplifiedRows.map((r) => [r.staffId, { staffId: r.staffId, ...r.data, createdAt: r.createdAt.toISOString() }]));
        if (settings.payrollModel !== 'classic') {
            for (const staffId of staffIds) {
                const s = simplifiedByStaff.get(staffId);
                if (s)
                    map.set(staffId, s);
            }
            return map;
        }
        const [chartRows, ruleRows, criterionRows, assignmentRows] = await Promise.all([
            this.prisma.payrollChart.findMany({ where: { businessId } }),
            this.prisma.payrollRule.findMany({ where: { businessId } }),
            this.prisma.payrollCriterion.findMany({ where: { businessId } }),
            this.prisma.payrollChartAssignment.findMany({ where: { businessId, staffId: { in: staffIds } } }),
        ]);
        const chartsById = new Map(chartRows.map((c) => [c.id, c]));
        const rulesById = new Map(ruleRows.map((r) => [r.id, { ...r.data, createdAt: r.createdAt.toISOString() }]));
        const criteriaById = new Map(criterionRows.map((c) => [c.id, { id: c.id, metric: c.metric, scope: c.scope, byServices: c.byServices, byProducts: c.byProducts, threshold: Number(c.threshold) }]));
        const criterionPeriod = new Map(criterionRows.map((c) => [c.id, c.period]));
        const assignments = assignmentRows.map((a) => ({ chartId: a.chartId, staffId: a.staffId, startDate: a.startDate.toISOString().slice(0, 10) }));
        const monthStart = monthStartOf(referenceDate);
        for (const staffId of staffIds) {
            const assignment = resolveActiveChartAssignment(assignments, staffId, referenceDate);
            const chart = assignment ? chartsById.get(assignment.chartId) : undefined;
            let resolved = false;
            if (chart) {
                const ruleId = pickRuleForChart({ type: chart.type, standardRuleId: chart.standardRuleId, planRows: chart.planRows }, (criterionId) => {
                    const criterion = criteriaById.get(criterionId);
                    if (!criterion)
                        return false;
                    const periodFrom = criterionPeriod.get(criterionId) === 'day' ? referenceDate : monthStart;
                    return evaluateCriterionForStaff(criterion, criteriaBookings, staffId, locationId, periodFrom, referenceDate);
                });
                const rule = ruleId ? rulesById.get(ruleId) : undefined;
                if (rule) {
                    map.set(staffId, ruleAsScheme(rule, staffId));
                    resolved = true;
                }
            }
            if (!resolved) {
                const s = simplifiedByStaff.get(staffId);
                if (s)
                    map.set(staffId, s);
            }
        }
        return map;
    }
    /** Мастер без payroll.manage видит только себя (В-10 «мастер видит свою выручку»); staffFilter=undefined — всех */
    filterOwn(staffIds, ownOnlyStaffId) {
        return ownOnlyStaffId ? staffIds.filter((id) => id === ownOnlyStaffId) : staffIds;
    }
    async computeDay(businessId, locationId, date, ownOnlyStaffId) {
        await this.requireLocation(businessId, locationId);
        const staffRows = await this.staffAtLocation(businessId, locationId);
        const staffIds = this.filterOwn(staffRows.map((s) => s.id), ownOnlyStaffId);
        const monthStart = monthStartOf(date);
        const [bookings, groupEvents, services] = await Promise.all([this.loadBookings(businessId, locationId, monthStart, date), this.loadGroupEvents(businessId, locationId, date, date), this.loadServices(businessId)]);
        const schemes = await this.resolveEffectiveSchemes(businessId, locationId, staffIds, date, bookings);
        const dayBookings = bookings.filter((b) => b.startAt.toISOString().slice(0, 10) === date);
        const bookingIds = dayBookings.map((b) => b.id);
        const paidAmounts = new Map((await this.prisma.booking.findMany({ where: { id: { in: bookingIds } }, select: { id: true, paidAmount: true } })).map((b) => [b.id, Number(b.paidAmount)]));
        const [loyaltyPaidForBooking, techCardCost] = await Promise.all([this.loyaltyPaidLookup(businessId, bookingIds), this.techCardCostLookup(businessId, locationId)]);
        const unpaidForBooking = this.unpaidForBookingLookup(dayBookings, paidAmounts);
        const opsByStaff = computeServicesForDay({ date, locationId, staffIds, bookings, groupEvents, services, schemes, loyaltyPaidForBooking, techCardCost, unpaidForBooking });
        const turnover = locationServicesTurnover(bookings, locationId, date);
        const events = await this.loadBookingEventsForRewards(businessId, date, date);
        const bookingsWithMeta = await this.loadBookingsWithMeta(businessId, locationId, date, date);
        const staffResults = [];
        for (const staffId of staffIds) {
            const scheme = schemes.get(staffId);
            const operations = opsByStaff.get(staffId) ?? [];
            const servicesAmount = roundMoney(operations.reduce((sum, op) => sum + op.amount, 0));
            const recordsAmount = scheme?.records.enabled
                ? roundMoney(recordsRewardForDay(bookingsWithMeta, staffId, date, scheme.records, services) + onlineWidgetRewardForDay(bookingsWithMeta, events, staffId, date, scheme.records, services))
                : 0;
            const extraAmount = scheme?.extraServiceRevenue.enabled ? extraRevenueAmount(turnover, scheme.extraServiceRevenue) : 0;
            // F-09-036/037: за день считается только hour/day оклад — month доказывает себя только за целый период
            let workdayAmount = 0;
            if (scheme?.workday.enabled && scheme.workday.basePeriod !== 'month') {
                const hoursResult = await this.scheduleHours(businessId, staffId, date, date, locationId);
                workdayAmount = scheme.workday.basePeriod === 'hour' ? roundMoney(scheme.workday.baseAmount * hoursResult.totalHours) : hoursResult.workDays > 0 ? scheme.workday.baseAmount : 0;
            }
            const result = { staffId, configured: Boolean(scheme), operations, servicesAmount, productsAmount: 0, workdayAmount, recordsAmount, extraAmount, total: 0 };
            result.total = scheme?.workday.enabled ? applyDailyGuaranteedMinimum(sumDayResult(result), scheme.workday.guaranteedMinimum) : sumDayResult(result);
            const hasActivity = operations.length > 0 || workdayAmount > 0 || recordsAmount > 0 || extraAmount > 0;
            if (hasActivity)
                staffResults.push(result);
        }
        staffResults.sort((a, b) => b.total - a.total);
        return { date, anyConfigured: schemes.size > 0, staff: staffResults, locationServicesTurnover: turnover };
    }
    async loadBookingsWithMeta(businessId, locationId, from, to) {
        const { from: gte } = localDayRangeUtc(from, DEFAULT_TZ);
        const { to: lt } = localDayRangeUtc(to, DEFAULT_TZ);
        const rows = await this.prisma.booking.findMany({ where: { businessId, locationId, startAt: { gte, lt } } });
        return rows.map((b) => ({
            id: b.id,
            locationId: b.locationId,
            status: b.status,
            deletedAt: b.deletedAt,
            startAt: b.startAt,
            total: Number(b.total),
            groupEventId: b.groupEventId,
            services: b.services ?? [],
            createdByRef: b.createdByRef,
            createdAt: b.createdAt,
            source: b.source,
        }));
    }
    async loadBookingEventsForRewards(businessId, from, to) {
        const { from: gte } = localDayRangeUtc(from, DEFAULT_TZ);
        const { to: lt } = localDayRangeUtc(to, DEFAULT_TZ);
        const rows = await this.prisma.bookingEvent.findMany({ where: { businessId, kind: 'status', toStatus: 'arrived', at: { gte, lt } } });
        return rows.map((e) => ({ bookingId: e.bookingId, kind: e.kind, toStatus: e.toStatus, byRef: e.byRef }));
    }
    async computePeriod(businessId, locationId, from, to, positionKey, ownOnlyStaffId) {
        await this.requireLocation(businessId, locationId);
        let staffRows = await this.staffAtLocation(businessId, locationId);
        if (positionKey)
            staffRows = staffRows.filter((s) => ((s.position?.ru ?? s.position?.en ?? '') === positionKey));
        const staffIds = this.filterOwn(staffRows.map((s) => s.id), ownOnlyStaffId);
        const monthStart = monthStartOf(to);
        const loadFrom = from < monthStart ? from : monthStart;
        const [bookings, groupEvents, services] = await Promise.all([this.loadBookings(businessId, locationId, loadFrom, to), this.loadGroupEvents(businessId, locationId, from, to), this.loadServices(businessId)]);
        const schemes = await this.resolveEffectiveSchemes(businessId, locationId, staffIds, to, bookings);
        const bookingIds = bookings.filter((b) => b.status === 'arrived' && !b.deletedAt).map((b) => b.id);
        const paidRows = await this.prisma.booking.findMany({ where: { id: { in: bookingIds } }, select: { id: true, paidAmount: true } });
        const paidAmounts = new Map(paidRows.map((b) => [b.id, Number(b.paidAmount)]));
        const [loyaltyPaidForBooking, techCardCost] = await Promise.all([this.loyaltyPaidLookup(businessId, bookingIds), this.techCardCostLookup(businessId, locationId)]);
        const unpaidForBooking = this.unpaidForBookingLookup(bookings, paidAmounts);
        const bookingsWithMeta = await this.loadBookingsWithMeta(businessId, locationId, loadFrom, to);
        const events = await this.loadBookingEventsForRewards(businessId, loadFrom, to);
        const qualifyingMonths = qualifyingMonthlySalaryMonths(from, to);
        const dates = eachDay(from, to);
        const rows = [];
        for (const staffId of staffIds) {
            const scheme = schemes.get(staffId);
            const hoursResult = await this.scheduleHours(businessId, staffId, from, to, locationId);
            let servicesCount = 0;
            let servicesRevenue = 0;
            let servicesPayoutAmount = 0;
            let recordsAmount = 0;
            let extraAmount = 0;
            for (const date of dates) {
                const opsByStaff = computeServicesForDay({ date, locationId, staffIds: [staffId], bookings, groupEvents, services, schemes, loyaltyPaidForBooking, techCardCost, unpaidForBooking });
                const ops = opsByStaff.get(staffId) ?? [];
                servicesCount += ops.reduce((n, op) => n + op.lines.length, 0);
                servicesRevenue = roundMoney(servicesRevenue + ops.reduce((sum, op) => sum + op.revenue, 0));
                servicesPayoutAmount = roundMoney(servicesPayoutAmount + ops.reduce((sum, op) => sum + op.amount, 0));
                if (scheme?.records.enabled) {
                    recordsAmount = roundMoney(recordsAmount + recordsRewardForDay(bookingsWithMeta, staffId, date, scheme.records, services) + onlineWidgetRewardForDay(bookingsWithMeta, events, staffId, date, scheme.records, services));
                }
                if (scheme?.extraServiceRevenue.enabled) {
                    const turnover = locationServicesTurnover(bookings, locationId, date);
                    extraAmount = roundMoney(extraAmount + extraRevenueAmount(turnover, scheme.extraServiceRevenue));
                }
            }
            let workdayAmount = 0;
            if (scheme?.workday.enabled) {
                if (scheme.workday.basePeriod === 'hour')
                    workdayAmount = roundMoney(scheme.workday.baseAmount * hoursResult.totalHours);
                else if (scheme.workday.basePeriod === 'day')
                    workdayAmount = roundMoney(scheme.workday.baseAmount * hoursResult.workDays);
                else {
                    for (const month of qualifyingMonths) {
                        if (monthlySalaryQualifies(month, hoursResult.hoursByMonth.get(month) ?? 0, scheme.createdAt))
                            workdayAmount = roundMoney(workdayAmount + scheme.workday.baseAmount);
                    }
                }
            }
            const productsAmount = 0; // F-09-031/032: как в моке — нет данных, какой сотрудник продал товар
            const totalAmount = roundMoney(servicesRevenue + productsAmount);
            let salary = roundMoney(servicesPayoutAmount + productsAmount + workdayAmount + recordsAmount + extraAmount);
            if (scheme?.workday.enabled)
                salary = applyMonthlyGuaranteedMinimum(salary, scheme.workday.guaranteedMinimum, from, to);
            if (hoursResult.workDays === 0 && servicesRevenue === 0 && salary === 0 && !scheme)
                continue;
            rows.push({ staffId, workDays: hoursResult.workDays, workHours: hoursResult.totalHours, servicesCount, servicesAmount: servicesRevenue, productsCount: 0, productsAmount, totalAmount, paidAmount: totalAmount, salary });
        }
        rows.sort((a, b) => b.salary - a.salary);
        return { from, to, anyConfigured: schemes.size > 0, rows };
    }
    /** F-09-036: часы графика в этот день (не часы с клиентами) — тот же источник, что колонка «Рабочее время»
     * журнала/отчётов (`ScheduleService.hours`, этап 6), а не своя копия подсчёта смен. */
    async scheduleHours(businessId, staffId, from, to, locationId) {
        const result = await this.schedule.hours(businessId, staffId, from, to, locationId);
        let workDays = 0;
        let totalHours = 0;
        const hoursByMonth = new Map();
        for (const d of result.days) {
            const minutes = d.hours.reduce((sum, r) => sum + Math.max(0, toMinutes(r.to) - toMinutes(r.from)), 0);
            const hours = roundMoney(minutes / 60);
            if (hours > 0)
                workDays += 1;
            totalHours = roundMoney(totalHours + hours);
            const month = d.date.slice(0, 7);
            hoursByMonth.set(month, roundMoney((hoursByMonth.get(month) ?? 0) + hours));
        }
        return { totalHours, workDays, hoursByMonth };
    }
    async computeStatement(businessId, locationId, staffId, from, to) {
        await this.requireLocation(businessId, locationId);
        const monthStart = monthStartOf(to);
        const loadFrom = from < monthStart ? from : monthStart;
        const [bookings, groupEvents, services] = await Promise.all([this.loadBookings(businessId, locationId, loadFrom, to), this.loadGroupEvents(businessId, locationId, from, to), this.loadServices(businessId)]);
        const schemes = await this.resolveEffectiveSchemes(businessId, locationId, [staffId], to, bookings);
        const bookingIds = bookings.filter((b) => b.status === 'arrived' && !b.deletedAt).map((b) => b.id);
        const paidRows = await this.prisma.booking.findMany({ where: { id: { in: bookingIds } }, select: { id: true, paidAmount: true } });
        const paidAmounts = new Map(paidRows.map((b) => [b.id, Number(b.paidAmount)]));
        const [loyaltyPaidForBooking, techCardCost] = await Promise.all([this.loyaltyPaidLookup(businessId, bookingIds), this.techCardCostLookup(businessId, locationId)]);
        const unpaidForBooking = this.unpaidForBookingLookup(bookings, paidAmounts);
        const operations = [];
        for (const date of eachDay(from, to)) {
            const opsByStaff = computeServicesForDay({ date, locationId, staffIds: [staffId], bookings, groupEvents, services, schemes, loyaltyPaidForBooking, techCardCost, unpaidForBooking });
            for (const op of opsByStaff.get(staffId) ?? [])
                operations.push({ ...op, date });
        }
        const total = roundMoney(operations.reduce((sum, op) => sum + op.amount, 0));
        return { staffId, from, to, operations, total };
    }
};
PayrollComputeService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [PrismaService,
        PayrollCatalogService,
        ScheduleService])
], PayrollComputeService);
export { PayrollComputeService };
function toMinutes(hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
}
//# sourceMappingURL=payroll-compute.service.js.map