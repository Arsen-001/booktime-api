import { Injectable } from '@nestjs/common';
import { ApiError } from '../../common/errors/api-error.js';
import { PrismaService } from '../../common/prisma.service.js';
import { DEFAULT_TZ, localDayRangeUtc } from '../../common/time/time.js';
import { ScheduleService } from '../schedule/schedule.service.js';
import { PayrollCatalogService } from './payroll-catalog.service.js';
import {
  applyDailyGuaranteedMinimum,
  applyMonthlyGuaranteedMinimum,
  computeServicesForDay,
  evaluateCriterionForStaff,
  extraRevenueAmount,
  locationServicesTurnover,
  monthlySalaryQualifies,
  onlineWidgetRewardForDay,
  pickRuleForChart,
  qualifyingMonthlySalaryMonths,
  recordsRewardForDay,
  resolveActiveChartAssignment,
  roundMoney,
  ruleAsScheme,
  sumDayResult,
  type EffectiveScheme,
  type EngineBooking,
  type EngineBookingEvent,
  type EngineGroupEvent,
  type EngineService,
  type LoyaltyPaidBreakdown,
  type PayrollChartAssignmentData,
  type PayrollCriterionData,
  type SchemeBlocks,
  type StaffDayResult,
} from './payroll-engine.js';

interface StatementOperationRow {
  date: string;
  time: string;
  bookingId?: string;
  label: string;
  amount: number;
  revenue: number;
  lines: unknown[];
}

/** Диапазон дней между двумя ISODate включительно (< 400 дней, как у ScheduleService.hours) */
function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  let d = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  while (d <= end && out.length < 400) {
    out.push(d.toISOString().slice(0, 10));
    d = new Date(d.getTime() + 86_400_000);
  }
  return out;
}

function monthStartOf(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/**
 * Расчёт зарплаты за день/период/ведомость (F-09-058…070) — движок `payroll-engine.ts`, данные из bookings/
 * group_events/services/loyalty_tx/tech_cards уже построенных разделов. Честные гэпы (ассистенты, комиссия
 * эквайринга, оплата за товар) см. в шапке payroll-engine.ts и docs/PROGRESS.md.
 */
@Injectable()
export class PayrollComputeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: PayrollCatalogService,
    private readonly schedule: ScheduleService,
  ) {}

  private async requireLocation(businessId: string, locationId: string) {
    const location = await this.prisma.location.findFirst({ where: { id: locationId, businessId } });
    if (!location) throw new ApiError('not_found', 'Location not found');
    return location;
  }

  private async staffAtLocation(businessId: string, locationId: string) {
    const rows = await this.prisma.staffLocation.findMany({ where: { locationId }, select: { staffId: true } });
    const ids = rows.map((r) => r.staffId);
    if (!ids.length) return [] as { id: string; name: string; position: unknown; createdAt: Date }[];
    return this.prisma.staff.findMany({ where: { id: { in: ids }, businessId, status: { notIn: ['fired', 'disabled'] } }, orderBy: { createdAt: 'asc' } });
  }

  private async loadBookings(businessId: string, locationId: string, from: string, to: string): Promise<EngineBooking[]> {
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
      services: (b.services as unknown as EngineBooking['services']) ?? [],
    }));
  }

  private async loadGroupEvents(businessId: string, locationId: string, from: string, to: string): Promise<EngineGroupEvent[]> {
    const { from: gte } = localDayRangeUtc(from, DEFAULT_TZ);
    const { to: lt } = localDayRangeUtc(to, DEFAULT_TZ);
    const rows = await this.prisma.groupEvent.findMany({ where: { businessId, locationId, startAt: { gte, lt } } });
    return rows.map((e) => ({ id: e.id, locationId: e.locationId, staffId: e.staffId, serviceId: e.serviceId, status: e.status, startAt: e.startAt }));
  }

  private async loadServices(businessId: string): Promise<EngineService[]> {
    const rows = await this.prisma.service.findMany({ where: { businessId } });
    return rows.map((s) => ({ id: s.id, categoryId: s.categoryId, name: (s.name as { ru?: string; en?: string; hy?: string })?.ru || (s.name as { en?: string })?.en || s.id, priceMin: Number(s.priceMin) }));
  }

  /** F-09-019: доля визита, закрытая каждым видом лояльности (LoyaltyTx.kind='charge', источник → блок) */
  private async loyaltyPaidLookup(businessId: string, bookingIds: string[]): Promise<(bookingId: string) => LoyaltyPaidBreakdown | undefined> {
    if (!bookingIds.length) return () => undefined;
    const rows = await this.prisma.loyaltyTx.findMany({ where: { businessId, kind: 'charge', bookingId: { in: bookingIds } } });
    const map = new Map<string, LoyaltyPaidBreakdown>();
    for (const r of rows) {
      if (!r.bookingId) continue;
      const amount = Math.abs(Number(r.amount));
      if (amount <= 0) continue;
      const entry = map.get(r.bookingId) ?? { bonus: 0, membership: 0, clientAccount: 0, certificate: 0, promotion: 0 };
      if (r.source === 'card') entry.bonus += amount;
      else if (r.source === 'membership') entry.membership += amount;
      else if (r.source === 'account') entry.clientAccount += amount;
      else if (r.source === 'certificate') entry.certificate += amount;
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
  private async techCardCostLookup(businessId: string, locationId: string): Promise<(serviceId: string, staffId: string, atDate: string) => number | undefined> {
    const cards = await this.prisma.techCard.findMany({ where: { businessId, locationId } });
    if (!cards.length) return () => undefined;
    const goodIds = new Set<string>();
    for (const c of cards) for (const line of c.lines as { goodId: string }[]) goodIds.add(line.goodId);
    const products = await this.prisma.product.findMany({ where: { id: { in: Array.from(goodIds) } }, select: { id: true, costPrice: true } });
    const costOf = new Map(products.map((p) => [p.id, Number(p.costPrice)]));
    const byKey = new Map(cards.map((c) => [`${c.serviceId}:${c.staffId}`, c]));
    return (serviceId, staffId) => {
      const card = byKey.get(`${serviceId}:${staffId}`);
      if (!card) return undefined;
      const lines = card.lines as { goodId: string; qtyWriteoff: number }[];
      if (!lines.length) return undefined;
      return roundMoney(lines.reduce((sum, l) => sum + l.qtyWriteoff * (costOf.get(l.goodId) ?? 0), 0));
    };
  }

  private unpaidForBookingLookup(bookings: EngineBooking[], paidAmounts: Map<string, number>): (bookingId: string) => number {
    const byId = new Map(bookings.map((b) => [b.id, b]));
    return (bookingId) => {
      const b = byId.get(bookingId);
      if (!b) return 0;
      return Math.max(0, roundMoney(b.total - (paidAmounts.get(bookingId) ?? 0)));
    };
  }

  /**
   * F-09-002/099: назначение схемы действующее НА `referenceDate` (для периода — конец периода, «смена
   * ставки с 01.10 не меняет сентябрь») — вызывается ОДИН раз, не по дням.
   */
  private async resolveEffectiveSchemes(businessId: string, locationId: string, staffIds: string[], referenceDate: string, criteriaBookings: EngineBooking[]): Promise<Map<string, EffectiveScheme>> {
    const settings = await this.catalog.ensureSettings(locationId, businessId);
    const map = new Map<string, EffectiveScheme>();
    const simplifiedRows = await this.prisma.payrollScheme.findMany({ where: { businessId, staffId: { in: staffIds } } });
    const simplifiedByStaff = new Map(simplifiedRows.map((r) => [r.staffId, { staffId: r.staffId, ...(r.data as unknown as SchemeBlocks), createdAt: r.createdAt.toISOString() } as EffectiveScheme]));

    if (settings.payrollModel !== 'classic') {
      for (const staffId of staffIds) {
        const s = simplifiedByStaff.get(staffId);
        if (s) map.set(staffId, s);
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
    const rulesById = new Map(ruleRows.map((r) => [r.id, { ...(r.data as unknown as SchemeBlocks), createdAt: r.createdAt.toISOString() }]));
    const criteriaById = new Map<string, PayrollCriterionData>(criterionRows.map((c) => [c.id, { id: c.id, metric: c.metric as PayrollCriterionData['metric'], scope: c.scope as PayrollCriterionData['scope'], byServices: c.byServices, byProducts: c.byProducts, threshold: Number(c.threshold) }]));
    const criterionPeriod = new Map(criterionRows.map((c) => [c.id, c.period as 'month' | 'day']));
    const assignments: PayrollChartAssignmentData[] = assignmentRows.map((a) => ({ chartId: a.chartId, staffId: a.staffId, startDate: a.startDate.toISOString().slice(0, 10) }));
    const monthStart = monthStartOf(referenceDate);

    for (const staffId of staffIds) {
      const assignment = resolveActiveChartAssignment(assignments, staffId, referenceDate);
      const chart = assignment ? chartsById.get(assignment.chartId) : undefined;
      let resolved = false;
      if (chart) {
        const ruleId = pickRuleForChart({ type: chart.type as 'standard' | 'planned', standardRuleId: chart.standardRuleId, planRows: chart.planRows as { criterionId: string; ruleId: string }[] }, (criterionId) => {
          const criterion = criteriaById.get(criterionId);
          if (!criterion) return false;
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
        if (s) map.set(staffId, s);
      }
    }
    return map;
  }

  /** Мастер без payroll.manage видит только себя (В-10 «мастер видит свою выручку»); staffFilter=undefined — всех */
  private filterOwn(staffIds: string[], ownOnlyStaffId: string | undefined): string[] {
    return ownOnlyStaffId ? staffIds.filter((id) => id === ownOnlyStaffId) : staffIds;
  }

  async computeDay(businessId: string, locationId: string, date: string, ownOnlyStaffId?: string) {
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

    const staffResults: StaffDayResult[] = [];
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
      const result: StaffDayResult = { staffId, configured: Boolean(scheme), operations, servicesAmount, productsAmount: 0, workdayAmount, recordsAmount, extraAmount, total: 0 };
      result.total = scheme?.workday.enabled ? applyDailyGuaranteedMinimum(sumDayResult(result), scheme.workday.guaranteedMinimum) : sumDayResult(result);
      const hasActivity = operations.length > 0 || workdayAmount > 0 || recordsAmount > 0 || extraAmount > 0;
      if (hasActivity) staffResults.push(result);
    }
    staffResults.sort((a, b) => b.total - a.total);

    return { date, anyConfigured: schemes.size > 0, staff: staffResults, locationServicesTurnover: turnover };
  }

  private async loadBookingsWithMeta(businessId: string, locationId: string, from: string, to: string) {
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
      services: (b.services as unknown as EngineBooking['services']) ?? [],
      createdByRef: b.createdByRef,
      createdAt: b.createdAt,
      source: b.source,
    }));
  }

  private async loadBookingEventsForRewards(businessId: string, from: string, to: string): Promise<EngineBookingEvent[]> {
    const { from: gte } = localDayRangeUtc(from, DEFAULT_TZ);
    const { to: lt } = localDayRangeUtc(to, DEFAULT_TZ);
    const rows = await this.prisma.bookingEvent.findMany({ where: { businessId, kind: 'status', toStatus: 'arrived', at: { gte, lt } } });
    return rows.map((e) => ({ bookingId: e.bookingId, kind: e.kind, toStatus: e.toStatus, byRef: e.byRef }));
  }

  async computePeriod(businessId: string, locationId: string, from: string, to: string, positionKey?: string, ownOnlyStaffId?: string) {
    await this.requireLocation(businessId, locationId);
    let staffRows = await this.staffAtLocation(businessId, locationId);
    if (positionKey) staffRows = staffRows.filter((s) => (((s.position as { ru?: string; en?: string; hy?: string } | null)?.ru ?? (s.position as { en?: string } | null)?.en ?? '') === positionKey));
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

    const rows: { staffId: string; workDays: number; workHours: number; servicesCount: number; servicesAmount: number; productsCount: number; productsAmount: number; totalAmount: number; paidAmount: number; salary: number }[] = [];
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
        if (scheme.workday.basePeriod === 'hour') workdayAmount = roundMoney(scheme.workday.baseAmount * hoursResult.totalHours);
        else if (scheme.workday.basePeriod === 'day') workdayAmount = roundMoney(scheme.workday.baseAmount * hoursResult.workDays);
        else {
          for (const month of qualifyingMonths) {
            if (monthlySalaryQualifies(month, hoursResult.hoursByMonth.get(month) ?? 0, scheme.createdAt)) workdayAmount = roundMoney(workdayAmount + scheme.workday.baseAmount);
          }
        }
      }

      const productsAmount = 0; // F-09-031/032: как в моке — нет данных, какой сотрудник продал товар
      const totalAmount = roundMoney(servicesRevenue + productsAmount);
      let salary = roundMoney(servicesPayoutAmount + productsAmount + workdayAmount + recordsAmount + extraAmount);
      if (scheme?.workday.enabled) salary = applyMonthlyGuaranteedMinimum(salary, scheme.workday.guaranteedMinimum, from, to);
      if (hoursResult.workDays === 0 && servicesRevenue === 0 && salary === 0 && !scheme) continue;
      rows.push({ staffId, workDays: hoursResult.workDays, workHours: hoursResult.totalHours, servicesCount, servicesAmount: servicesRevenue, productsCount: 0, productsAmount, totalAmount, paidAmount: totalAmount, salary });
    }
    rows.sort((a, b) => b.salary - a.salary);
    return { from, to, anyConfigured: schemes.size > 0, rows };
  }

  /** F-09-036: часы графика в этот день (не часы с клиентами) — тот же источник, что колонка «Рабочее время»
   * журнала/отчётов (`ScheduleService.hours`, этап 6), а не своя копия подсчёта смен. */
  private async scheduleHours(businessId: string, staffId: string, from: string, to: string, locationId: string): Promise<{ totalHours: number; workDays: number; hoursByMonth: Map<string, number> }> {
    const result = await this.schedule.hours(businessId, staffId, from, to, locationId);
    let workDays = 0;
    let totalHours = 0;
    const hoursByMonth = new Map<string, number>();
    for (const d of result.days) {
      const minutes = (d.hours as { from: string; to: string }[]).reduce((sum, r) => sum + Math.max(0, toMinutes(r.to) - toMinutes(r.from)), 0);
      const hours = roundMoney(minutes / 60);
      if (hours > 0) workDays += 1;
      totalHours = roundMoney(totalHours + hours);
      const month = d.date.slice(0, 7);
      hoursByMonth.set(month, roundMoney((hoursByMonth.get(month) ?? 0) + hours));
    }
    return { totalHours, workDays, hoursByMonth };
  }

  async computeStatement(businessId: string, locationId: string, staffId: string, from: string, to: string) {
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
    const operations: StatementOperationRow[] = [];
    for (const date of eachDay(from, to)) {
      const opsByStaff = computeServicesForDay({ date, locationId, staffIds: [staffId], bookings, groupEvents, services, schemes, loyaltyPaidForBooking, techCardCost, unpaidForBooking });
      for (const op of opsByStaff.get(staffId) ?? []) operations.push({ ...op, date });
    }
    const total = roundMoney(operations.reduce((sum, op) => sum + op.amount, 0));
    return { staffId, from, to, operations, total };
  }
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}
