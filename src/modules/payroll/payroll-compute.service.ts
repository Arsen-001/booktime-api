import { Injectable } from '@nestjs/common';
import { ApiError } from '../../common/errors/api-error.js';
import { PrismaService } from '../../common/prisma.service.js';
import { DEFAULT_TZ, localDayRangeUtc, utcToLocalDate } from '../../common/time/time.js';
import { ScheduleService } from '../schedule/schedule.service.js';
import { PREPAYMENT_LINE_LABEL } from '../finance/prepayment-ops.js';
import { PayrollCatalogService, versionedSchemeOf } from './payroll-catalog.service.js';
import {
  applyDailyGuaranteedMinimum,
  applyMonthlyGuaranteedMinimum,
  accrualDateOf,
  assistantsLookup,
  computeServicesForDay,
  lineAssistantsOf,
  withAssistedMasters,
  evaluateCriterionForStaff,
  extraRevenueAmount,
  locationServicesTurnover,
  monthlySalaryQualifies,
  onlineWidgetRewardForDay,
  payoutForTarget,
  applyPayout,
  productSaleBase,
  pickRuleForChart,
  qualifyingMonthlySalaryMonths,
  recordsRewardForDay,
  resolveActiveChartAssignment,
  roundMoney,
  ruleAsScheme,
  schemeAtDate,
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
  type VersionedScheme,
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

function monthEndOf(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10);
}

/** Продажа склада филиала (документ «sale», не отменён, не автосписание) — для «% с продаж» и оборота товаров */
interface ProductSaleDoc {
  day: string;
  /** Продавец документа (StockOp.staffId) — если у строки своего продавца нет */
  staffId: string | null;
  /** sellerId — продавец строки (З9, заход 4); cost — себестоимость строки: кол-во × Product.costPrice */
  lines: { goodId: string; qty: number; unitPrice: number; discountPct: number; cost: number; sellerId: string | null }[];
}

function engineBookingOf(b: { id: string; locationId: string; status: string; deletedAt: Date | null; startAt: Date; total: bigint; groupEventId: string | null; services: unknown; extras?: unknown }): EngineBooking {
  const lineAssistants = lineAssistantsOf(b.extras);
  return {
    id: b.id,
    locationId: b.locationId,
    status: b.status,
    deletedAt: b.deletedAt,
    startAt: b.startAt,
    total: Number(b.total),
    groupEventId: b.groupEventId,
    services: (b.services as unknown as EngineBooking['services']) ?? [],
    // F-09-046/047: кто ассистировал в строке (окно записи → extras.serviceLineExtras[i].assistants)
    ...(lineAssistants.some((l) => l.length) ? { lineAssistants } : {}),
  };
}

/** Кэш «доп. от прибыли»: по месяцу филиала — оборот услуг и расходы; null — расходов в финансах нет вовсе */
type ExpenseCache = Map<string, { turnover: number; expenses: number } | null>;

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

  private async staffAtLocation(businessId: string, locationId: string, anyStatus = false) {
    const rows = await this.prisma.staffLocation.findMany({ where: { locationId }, select: { staffId: true } });
    const ids = rows.map((r) => r.staffId);
    if (!ids.length) return [] as { id: string; name: string; position: unknown; createdAt: Date }[];
    return this.prisma.staff.findMany({ where: { id: { in: ids }, businessId, ...(anyStatus ? {} : { status: { notIn: ['fired', 'disabled'] } }) }, orderBy: { createdAt: 'asc' } });
  }

  private async loadBookings(businessId: string, locationId: string, from: string, to: string): Promise<EngineBooking[]> {
    const { from: gte } = localDayRangeUtc(from, DEFAULT_TZ);
    const { to: lt } = localDayRangeUtc(to, DEFAULT_TZ);
    const rows = await this.prisma.booking.findMany({ where: { businessId, locationId, startAt: { gte, lt } } });
    return rows.map(engineBookingOf);
  }

  /**
   * F-09-005 (QA 01.10, accrualDateLookup мока): «Дата поступления средств на счёт» — визит попадает в зарплату днём
   * последней оплаты (строки оплаты визита BookingPayment и полученная предоплата «Деньги пришли»). Без этой настройки
   * — undefined (день визита). `extra` — визиты филиала вне загруженного диапазона дат, деньги за которые пришли в
   * [from, to]: они начисляются в этом периоде. 🔒 Срок зачисления карты (settlementDays мока) на сервере не хранится —
   * 0 дней, как по умолчанию в моке.
   */
  private async accrualLookup(businessId: string, locationId: string, from: string, to: string, loaded: readonly EngineBooking[]): Promise<{ lookup?: (bookingId: string) => string | undefined; extra: EngineBooking[] }> {
    const settings = await this.catalog.ensureSettings(locationId, businessId);
    if (settings.accrualDateBasis !== 'received') return { extra: [] };
    const { from: gte } = localDayRangeUtc(from, DEFAULT_TZ);
    const { to: lt } = localDayRangeUtc(to, DEFAULT_TZ);
    const prepaymentWhere = { businessId, kind: 'income', cancelled: false, lineLabel: PREPAYMENT_LINE_LABEL };
    const [paidInRange, prepaidInRange] = await Promise.all([
      this.prisma.bookingPayment.findMany({ where: { businessId, cancelled: false, createdAt: { gte, lt } }, select: { bookingId: true } }),
      this.prisma.finOp.findMany({ where: { ...prepaymentWhere, refId: { not: null }, date: { gte, lt } }, select: { refId: true } }),
    ]);
    const loadedIds = new Set(loaded.map((b) => b.id));
    const otherIds = [...new Set([...paidInRange.map((p) => p.bookingId), ...prepaidInRange.map((o) => o.refId as string)])].filter((id) => !loadedIds.has(id));
    const extra = otherIds.length ? (await this.prisma.booking.findMany({ where: { id: { in: otherIds }, businessId, locationId } })).map(engineBookingOf) : [];
    const ids = [...loadedIds, ...extra.map((b) => b.id)];
    const latest = new Map<string, string>();
    const bump = (bookingId: string, day: string) => {
      const cur = latest.get(bookingId);
      if (!cur || day > cur) latest.set(bookingId, day);
    };
    if (ids.length) {
      const [payments, prepaid] = await Promise.all([
        this.prisma.bookingPayment.findMany({ where: { businessId, cancelled: false, bookingId: { in: ids } }, select: { bookingId: true, createdAt: true } }),
        this.prisma.finOp.findMany({ where: { ...prepaymentWhere, refId: { in: ids } }, select: { refId: true, date: true } }),
      ]);
      for (const p of payments) bump(p.bookingId, utcToLocalDate(p.createdAt));
      for (const o of prepaid) if (o.refId) bump(o.refId, utcToLocalDate(o.date));
    }
    return { lookup: (bookingId) => latest.get(bookingId), extra };
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

  /** Продажи склада филиала за период с их строками и категории товаров (F-09-031/032/043, порт мока) */
  private async loadProductSales(businessId: string, locationId: string, from: string, to: string): Promise<{ docs: ProductSaleDoc[]; categoryOf: Map<string, string> }> {
    const { from: gte } = localDayRangeUtc(from, DEFAULT_TZ);
    const { to: lt } = localDayRangeUtc(to, DEFAULT_TZ);
    const ops = await this.prisma.stockOp.findMany({ where: { businessId, locationId, type: 'sale', cancelledAt: null, autoWriteoff: false, date: { gte, lt } }, select: { id: true, date: true, staffId: true } });
    if (!ops.length) return { docs: [], categoryOf: new Map() };
    const lines = await this.prisma.stockOpLine.findMany({ where: { opId: { in: ops.map((o) => o.id) } } });
    // costTotal строки продажи — её цена, не себестоимость; себестоимость — Product.costPrice (как techCardCostLookup:
    // point-in-time себестоимости на сервере нет, берём текущую)
    const goods = await this.prisma.product.findMany({ where: { id: { in: [...new Set(lines.map((l) => l.goodId))] } }, select: { id: true, categoryId: true, costPrice: true } });
    const costOf = new Map(goods.map((g) => [g.id, Number(g.costPrice)] as const));
    const docs = ops.map((o) => ({
      day: utcToLocalDate(o.date),
      staffId: o.staffId,
      lines: lines
        .filter((l) => l.opId === o.id)
        .map((l) => ({ goodId: l.goodId, qty: Math.abs(l.qtySale), unitPrice: Number(l.unitPrice), discountPct: l.discountPct ?? 0, cost: roundMoney(Math.abs(l.qtySale) * (costOf.get(l.goodId) ?? 0)), sellerId: l.sellerId })),
    }));
    return { docs, categoryOf: new Map(goods.map((g) => [g.id, g.categoryId])) };
  }

  /** F-09-043: оборот товаров филиала за день — цена × кол-во за вычетом скидки строки (locationProductsTurnover мока) */
  private productsTurnover(docs: ProductSaleDoc[], day: string): number {
    let total = 0;
    for (const d of docs) if (d.day === day) for (const l of d.lines) total = roundMoney(total + roundMoney(l.unitPrice * l.qty) * (1 - l.discountPct / 100));
    return total;
  }

  /** Себестоимость проданных за день товаров — «расходы» для «доп. от прибыли по товарам» (locationProductsCost мока) */
  private productsCost(docs: ProductSaleDoc[], day: string): number {
    let total = 0;
    for (const d of docs) if (d.day === day) for (const l of d.lines) total = roundMoney(total + l.cost);
    return total;
  }

  /**
   * З9, F-09-031/032: выручка, штуки и выплата «% с продаж» сотрудника за период (productSalesPay мока); ставка — по
   * версии схемы на день продажи (З6)
   */
  private productSalesPay(docs: ProductSaleDoc[], categoryOf: Map<string, string>, staffId: string, schemeOn: (day: string) => EffectiveScheme | undefined, from: string, to: string) {
    let revenue = 0;
    let count = 0;
    let payout = 0;
    for (const d of docs) {
      if (d.day < from || d.day > to) continue;
      const block = schemeOn(d.day)?.productSales;
      for (const l of d.lines) {
        // З9 (как мок): продавец строки, нет — продавец документа
        if ((l.sellerId ?? d.staffId) !== staffId) continue;
        const price = roundMoney(l.unitPrice * l.qty);
        revenue = roundMoney(revenue + price * (1 - l.discountPct / 100));
        count += l.qty;
        if (!block?.enabled) continue;
        const unitCost = l.qty > 0 ? l.cost / l.qty : 0;
        const costPercent = unitCost > 0 && l.unitPrice > 0 ? (unitCost / l.unitPrice) * 100 : (block.demoCostPercent ?? 0);
        const base = productSaleBase(price, l.discountPct, costPercent, block.costBasis);
        payout = roundMoney(payout + applyPayout(base, payoutForTarget(block, l.goodId, categoryOf.get(l.goodId))));
      }
    }
    return { revenue, count, payout };
  }

  /**
   * Решение владельца 01.10.2026 (как мок locationExpensesForDay): «доп. от прибыли» — оборот периода минус расходы
   * периода. Прибыль считается за календарный месяц дня — оборот услуг «Пришёл» месяца минус операции «расход»
   * филиала за месяц — и делится по дням пропорционально обороту дня; так день, сумма дней и период дают одно число.
   * Возвращает расходы, приходящиеся на день; undefined — в финансах филиала расходов нет вовсе (тогда условные 70 %).
   */
  private async expensesForDay(businessId: string, locationId: string, day: string, dayTurnover: number, cache: ExpenseCache): Promise<number | undefined> {
    const month = day.slice(0, 7);
    let entry = cache.get(month);
    if (entry === undefined) {
      const any = await this.prisma.finOp.count({ where: { businessId, locationId, kind: 'expense', cancelled: false } });
      if (any === 0) entry = null;
      else {
        const { from: gte } = localDayRangeUtc(`${month}-01`, DEFAULT_TZ);
        const { to: lt } = localDayRangeUtc(monthEndOf(month), DEFAULT_TZ);
        const [exp, turn] = await Promise.all([
          this.prisma.finOp.aggregate({ where: { businessId, locationId, kind: 'expense', cancelled: false, date: { gte, lt } }, _sum: { amount: true } }),
          this.prisma.booking.aggregate({ where: { businessId, locationId, status: 'arrived', deletedAt: null, startAt: { gte, lt } }, _sum: { total: true } }),
        ]);
        entry = { expenses: Number(exp._sum.amount ?? 0n), turnover: Number(turn._sum.total ?? 0n) };
      }
      cache.set(month, entry);
    }
    if (entry === null) return undefined;
    if (entry.turnover <= 0 || dayTurnover <= 0) return 0;
    const monthProfit = Math.max(0, entry.turnover - entry.expenses);
    return roundMoney(dayTurnover - (monthProfit * dayTurnover) / entry.turnover);
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
   * Схемы сотрудников на каждый день — как resolveEffectiveSchemes мока, который зовут на дату каждого дня (З6,
   * F-09-002/054/099): упрощённая схема — версия, действующая в этот день («Действует с», schemeAtDate); классическая
   * модель — назначение схемы на этот день и правило по её критериям за день или месяц по этот день, без назначения —
   * упрощённая схема. Данные читаются один раз, ответ на дату запоминается. Было (до 17.11): одна схема на конец
   * периода, и смена ставки с 15.11 пересчитывала по новой ставке и 01–14.11.
   */
  private async schemeResolver(businessId: string, locationId: string, staffIds: string[], criteriaBookings: EngineBooking[]): Promise<(date: string) => Map<string, EffectiveScheme>> {
    const settings = await this.catalog.ensureSettings(locationId, businessId);
    const simplifiedRows = await this.prisma.payrollScheme.findMany({ where: { businessId, staffId: { in: staffIds } } });
    const simplifiedByStaff = new Map<string, { scheme: VersionedScheme; createdAt: string }>(simplifiedRows.map((r) => [r.staffId, { scheme: versionedSchemeOf(r), createdAt: r.createdAt.toISOString() }]));
    const simplifiedOn = (staffId: string, date: string): EffectiveScheme | undefined => {
      const s = simplifiedByStaff.get(staffId);
      return s ? { staffId, ...schemeAtDate(s.scheme, date), createdAt: s.createdAt } : undefined;
    };
    const cache = new Map<string, Map<string, EffectiveScheme>>();
    const memo = (resolve: (date: string) => Map<string, EffectiveScheme>) => (date: string) => {
      let map = cache.get(date);
      if (!map) cache.set(date, (map = resolve(date)));
      return map;
    };

    if (settings.payrollModel !== 'classic') {
      return memo((date) => {
        const map = new Map<string, EffectiveScheme>();
        for (const staffId of staffIds) {
          const s = simplifiedOn(staffId, date);
          if (s) map.set(staffId, s);
        }
        return map;
      });
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

    return memo((date) => {
      const map = new Map<string, EffectiveScheme>();
      const monthStart = monthStartOf(date);
      for (const staffId of staffIds) {
        const assignment = resolveActiveChartAssignment(assignments, staffId, date);
        const chart = assignment ? chartsById.get(assignment.chartId) : undefined;
        let resolved = false;
        if (chart) {
          const ruleId = pickRuleForChart({ type: chart.type as 'standard' | 'planned', standardRuleId: chart.standardRuleId, planRows: chart.planRows as { criterionId: string; ruleId: string }[] }, (criterionId) => {
            const criterion = criteriaById.get(criterionId);
            if (!criterion) return false;
            const periodFrom = criterionPeriod.get(criterionId) === 'day' ? date : monthStart;
            return evaluateCriterionForStaff(criterion, criteriaBookings, staffId, locationId, periodFrom, date);
          });
          const rule = ruleId ? rulesById.get(ruleId) : undefined;
          if (rule) {
            map.set(staffId, ruleAsScheme(rule, staffId));
            resolved = true;
          }
        }
        if (!resolved) {
          const s = simplifiedOn(staffId, date);
          if (s) map.set(staffId, s);
        }
      }
      return map;
    });
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
    // Доля ассистента — по схеме мастера строки (F-09-047): в набор схем — и мастера, кому эти сотрудники ассистировали
    const schemes = (await this.schemeResolver(businessId, locationId, withAssistedMasters(staffIds, bookings), bookings))(date);
    const accrual = await this.accrualLookup(businessId, locationId, date, date, bookings);
    bookings.push(...accrual.extra);
    const assistantsForLine = assistantsLookup(bookings);
    const dayBookings = bookings.filter((b) => accrualDateOf(b, accrual.lookup) === date);
    const bookingIds = dayBookings.map((b) => b.id);
    const paidAmounts = new Map((await this.prisma.booking.findMany({ where: { id: { in: bookingIds } }, select: { id: true, paidAmount: true } })).map((b) => [b.id, Number(b.paidAmount)]));
    const [loyaltyPaidForBooking, techCardCost] = await Promise.all([this.loyaltyPaidLookup(businessId, bookingIds), this.techCardCostLookup(businessId, locationId)]);
    const unpaidForBooking = this.unpaidForBookingLookup(dayBookings, paidAmounts);

    const opsByStaff = computeServicesForDay({ date, locationId, staffIds, bookings, groupEvents, services, schemes, loyaltyPaidForBooking, techCardCost, unpaidForBooking, accrualDateForBooking: accrual.lookup, assistantsForLine });
    const turnover = locationServicesTurnover(bookings, locationId, date);

    const events = await this.loadBookingEventsForRewards(businessId, date, date);
    const bookingsWithMeta = await this.loadBookingsWithMeta(businessId, locationId, date, date);
    // F-09-031/111 (как мок): % с продаж товаров и доп. от оборота товаров — тем же расчётом, что период
    const sales = await this.loadProductSales(businessId, locationId, date, date);
    const expenseCache: ExpenseCache = new Map();

    const staffResults: StaffDayResult[] = [];
    for (const staffId of staffIds) {
      const scheme = schemes.get(staffId);
      const operations = opsByStaff.get(staffId) ?? [];
      const servicesAmount = roundMoney(operations.reduce((sum, op) => sum + op.amount, 0));
      const recordsAmount = scheme?.records.enabled
        ? roundMoney(recordsRewardForDay(bookingsWithMeta, staffId, date, scheme.records, services, locationId) + onlineWidgetRewardForDay(bookingsWithMeta, events, staffId, date, scheme.records, services, locationId))
        : 0;
      const extraAmount = roundMoney(
        (scheme?.extraServiceRevenue.enabled ? extraRevenueAmount(turnover, scheme.extraServiceRevenue, await this.expensesForDay(businessId, locationId, date, turnover, expenseCache)) : 0) +
          (scheme?.extraProductRevenue.enabled ? extraRevenueAmount(this.productsTurnover(sales.docs, date), scheme.extraProductRevenue, this.productsCost(sales.docs, date)) : 0),
      );
      const productsAmount = this.productSalesPay(sales.docs, sales.categoryOf, staffId, () => scheme, date, date).payout;
      // F-09-036/037: за день считается только hour/day оклад — month доказывает себя только за целый период
      let workdayAmount = 0;
      if (scheme?.workday.enabled && scheme.workday.basePeriod !== 'month') {
        const hoursResult = await this.scheduleHours(businessId, staffId, date, date, locationId);
        workdayAmount = scheme.workday.basePeriod === 'hour' ? roundMoney(scheme.workday.baseAmount * hoursResult.totalHours) : hoursResult.workDays > 0 ? scheme.workday.baseAmount : 0;
      }
      const result: StaffDayResult = { staffId, configured: Boolean(scheme), operations, servicesAmount, productsAmount, workdayAmount, recordsAmount, extraAmount, total: 0 };
      result.total = scheme?.workday.enabled ? applyDailyGuaranteedMinimum(sumDayResult(result), scheme.workday.guaranteedMinimum) : sumDayResult(result);
      const hasActivity = operations.length > 0 || productsAmount > 0 || workdayAmount > 0 || recordsAmount > 0 || extraAmount > 0;
      if (hasActivity) staffResults.push(result);
    }
    staffResults.sort((a, b) => b.total - a.total);

    return { date, anyConfigured: staffIds.some((id) => schemes.has(id)), staff: staffResults, locationServicesTurnover: turnover };
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

  /**
   * `anyStatus` — расчёт одного сотрудника (`ownOnlyStaffId`) и уволенного/отключённого: ведомость и выписка
   * сотрудника считают его всегда (как computeStatement/staffSalaryForSheetSync мока), список «Расчёта» — только
   * работающих (F-09-064).
   */
  async computePeriod(businessId: string, locationId: string, from: string, to: string, positionKey?: string, ownOnlyStaffId?: string, anyStatus = false) {
    await this.requireLocation(businessId, locationId);
    let staffRows = await this.staffAtLocation(businessId, locationId, anyStatus && Boolean(ownOnlyStaffId));
    if (positionKey) staffRows = staffRows.filter((s) => (((s.position as { ru?: string; en?: string; hy?: string } | null)?.ru ?? (s.position as { en?: string } | null)?.en ?? '') === positionKey));
    const staffIds = this.filterOwn(staffRows.map((s) => s.id), ownOnlyStaffId);
    // С начала месяца первого дня: критерии классической модели считаются за месяц по каждый день периода (З6)
    const loadFrom = monthStartOf(from);
    const [bookings, groupEvents, services] = await Promise.all([this.loadBookings(businessId, locationId, loadFrom, to), this.loadGroupEvents(businessId, locationId, from, to), this.loadServices(businessId)]);
    // Доля ассистента — по схеме мастера строки (F-09-047): в набор схем — и мастера, кому эти сотрудники ассистировали.
    // З6: схема — на каждый день (версия «Действует с»), минимум месяца и «нет графика» — по схеме на конец периода
    const schemesOn = await this.schemeResolver(businessId, locationId, withAssistedMasters(staffIds, bookings), bookings);
    const schemesAtEnd = schemesOn(to);
    const accrual = await this.accrualLookup(businessId, locationId, from, to, bookings);
    bookings.push(...accrual.extra);
    const assistantsForLine = assistantsLookup(bookings);
    const bookingIds = bookings.filter((b) => b.status === 'arrived' && !b.deletedAt).map((b) => b.id);
    const paidRows = await this.prisma.booking.findMany({ where: { id: { in: bookingIds } }, select: { id: true, paidAmount: true } });
    const paidAmounts = new Map(paidRows.map((b) => [b.id, Number(b.paidAmount)]));
    const [loyaltyPaidForBooking, techCardCost] = await Promise.all([this.loyaltyPaidLookup(businessId, bookingIds), this.techCardCostLookup(businessId, locationId)]);
    const unpaidForBooking = this.unpaidForBookingLookup(bookings, paidAmounts);
    const bookingsWithMeta = await this.loadBookingsWithMeta(businessId, locationId, loadFrom, to);
    const events = await this.loadBookingEventsForRewards(businessId, loadFrom, to);
    const sales = await this.loadProductSales(businessId, locationId, from, to);
    const expenseCache: ExpenseCache = new Map();
    const bookingById = new Map(bookings.map((b) => [b.id, b]));
    const qualifyingMonths = qualifyingMonthlySalaryMonths(from, to);
    const dates = eachDay(from, to);
    // Премии/штрафы за период — строки взаиморасчётов, как их показывает ведомость (PayBreakdown мока)
    const { from: fromUtc } = localDayRangeUtc(from, DEFAULT_TZ);
    const { to: toUtc } = localDayRangeUtc(to, DEFAULT_TZ);
    const settlementRows = staffIds.length
      ? await this.prisma.payrollSettlementEntry.findMany({ where: { businessId, staffId: { in: staffIds }, kind: { in: ['bonus', 'adjustment', 'penalty'] }, createdAt: { gte: fromUtc, lt: toUtc } }, select: { staffId: true, kind: true, amount: true } })
      : [];
    const wholeMonth = from.slice(0, 7) === to.slice(0, 7) && from.endsWith('-01') && to === monthEndOf(to.slice(0, 7));

    const rows = [];
    for (const staffId of staffIds) {
      const schemeAtEnd = schemesAtEnd.get(staffId);
      let configured = false;
      const hoursResult = await this.scheduleHours(businessId, staffId, from, to, locationId);
      let servicesCount = 0;
      let servicesRevenue = 0;
      let servicesPayoutAmount = 0;
      let recordsAmount = 0;
      let extraAmount = 0;
      let workdayAmount = 0;
      let dailyMinTopUp = 0;
      let extraProfitAssumed = false;
      let unpaidVisits = 0;
      let unpaidAmount = 0;
      const unpaidSeen = new Set<string>();
      // День за днём — как computeStaffPay мока: услуги, «за запись», доп. от оборота, оплата за час/день и минимум
      // за день (F-09-038) по каждому рабочему дню; оклад и минимум месяца — после, за целый месяц
      for (const date of dates) {
        const schemes = schemesOn(date);
        const scheme = schemes.get(staffId);
        if (scheme) configured = true;
        const opsByStaff = computeServicesForDay({ date, locationId, staffIds: [staffId], bookings, groupEvents, services, schemes, loyaltyPaidForBooking, techCardCost, unpaidForBooking, accrualDateForBooking: accrual.lookup, assistantsForLine });
        const ops = opsByStaff.get(staffId) ?? [];
        const hours = hoursResult.hoursByDate.get(date) ?? 0;
        let dayServices = 0;
        servicesCount += ops.reduce((n, op) => n + op.lines.length, 0);
        for (const op of ops) {
          servicesRevenue = roundMoney(servicesRevenue + op.revenue);
          dayServices = roundMoney(dayServices + op.amount);
          // З3: визит «Пришёл», за который в кассу пришло не всё — факт и доля этого мастера (как мок)
          const booking = op.bookingId ? bookingById.get(op.bookingId) : undefined;
          if (!booking || unpaidSeen.has(booking.id)) continue;
          const unpaid = unpaidForBooking(booking.id);
          if (unpaid <= 0) continue;
          unpaidSeen.add(booking.id);
          const bookingTotal = booking.services.reduce((sum, l) => sum + l.price * l.qty, 0) || 1;
          unpaidVisits += 1;
          unpaidAmount = roundMoney(unpaidAmount + (unpaid * op.revenue) / bookingTotal);
        }
        servicesPayoutAmount = roundMoney(servicesPayoutAmount + dayServices);
        let dayRecords = 0;
        let dayExtra = 0;
        let dayWorkday = 0;
        if (scheme?.records.enabled) {
          dayRecords = roundMoney(recordsRewardForDay(bookingsWithMeta, staffId, date, scheme.records, services, locationId) + onlineWidgetRewardForDay(bookingsWithMeta, events, staffId, date, scheme.records, services, locationId));
        }
        if (scheme?.extraServiceRevenue.enabled) {
          const turnover = locationServicesTurnover(bookings, locationId, date);
          const expenses = await this.expensesForDay(businessId, locationId, date, turnover, expenseCache);
          if (scheme.extraServiceRevenue.base === 'profit' && expenses === undefined) extraProfitAssumed = true;
          dayExtra = extraRevenueAmount(turnover, scheme.extraServiceRevenue, expenses);
        }
        if (scheme?.extraProductRevenue.enabled) {
          dayExtra = roundMoney(dayExtra + extraRevenueAmount(this.productsTurnover(sales.docs, date), scheme.extraProductRevenue, this.productsCost(sales.docs, date)));
        }
        if (scheme?.workday.enabled) {
          if (scheme.workday.basePeriod === 'hour') dayWorkday = roundMoney(scheme.workday.baseAmount * hours);
          else if (scheme.workday.basePeriod === 'day') dayWorkday = hours > 0 ? scheme.workday.baseAmount : 0;
        }
        recordsAmount = roundMoney(recordsAmount + dayRecords);
        extraAmount = roundMoney(extraAmount + dayExtra);
        workdayAmount = roundMoney(workdayAmount + dayWorkday);
        // F-09-038: минимум за день — по каждому рабочему дню (как «Расчёт за день» и мок)
        if (scheme?.workday.enabled && (hours > 0 || ops.length > 0)) {
          const dayTotal = roundMoney(dayServices + dayRecords + dayExtra + dayWorkday);
          dailyMinTopUp = roundMoney(dailyMinTopUp + (applyDailyGuaranteedMinimum(dayTotal, scheme.workday.guaranteedMinimum) - dayTotal));
        }
      }

      // F-09-037 (как мок): месячный оклад — по версии схемы на последний день месяца (в пределах периода)
      for (const month of qualifyingMonths) {
        const monthEnd = `${month}-31` > to ? to : `${month}-31`;
        const scheme = schemesOn(monthEnd < from ? from : monthEnd).get(staffId);
        if (!scheme?.workday.enabled || scheme.workday.basePeriod !== 'month') continue;
        if (!monthlySalaryQualifies(month, hoursResult.hoursByMonth.get(month) ?? 0, scheme.createdAt)) continue;
        // Решение 01.10.2026 (как мок): оклад × часы графика месяца по сегодня / часы графика за весь месяц
        const mh = await this.monthHours(businessId, staffId, month, locationId);
        workdayAmount = roundMoney(workdayAmount + Math.round(scheme.workday.baseAmount * monthWorkShare(mh.worked, mh.scheduled)));
      }

      // F-09-031/032, З9 (как мок): % с продаж — по продажам склада филиала за период, продавец документа — сотрудник
      const products = this.productSalesPay(sales.docs, sales.categoryOf, staffId, (day) => schemesOn(day).get(staffId), from, to);
      const productsAmount = products.payout;
      const totalAmount = roundMoney(servicesRevenue + products.revenue);
      const beforeMin = roundMoney(servicesPayoutAmount + productsAmount + workdayAmount + recordsAmount + extraAmount + dailyMinTopUp);
      let salary = beforeMin;
      const min = schemeAtEnd?.workday.enabled ? schemeAtEnd.workday.guaranteedMinimum : undefined;
      // Минимум месяца — тоже пропорционально отработанному по графику (решение 01.10.2026, как мок)
      const minMonth = min && min.enabled && min.period === 'month' && wholeMonth ? await this.monthHours(businessId, staffId, from.slice(0, 7), locationId) : undefined;
      const minProrated = min && minMonth ? Math.round(min.amount * monthWorkShare(minMonth.worked, minMonth.scheduled)) : undefined;
      if (min && min.period === 'month') salary = applyMonthlyGuaranteedMinimum(salary, minProrated !== undefined ? { ...min, amount: minProrated } : min, from, to);
      if (hoursResult.workDays === 0 && servicesRevenue === 0 && products.revenue === 0 && salary === 0 && !configured) continue;
      let bonuses = 0;
      let penalties = 0;
      for (const e of settlementRows) {
        if (e.staffId !== staffId) continue;
        if (e.kind === 'penalty') penalties = roundMoney(penalties + Number(e.amount));
        else bonuses = roundMoney(bonuses + Number(e.amount));
      }
      // З2/З7/З10: из чего сложилась зарплата — PayBreakdown фронта (раньше у ответа сервера не было)
      const breakdown = {
        services: servicesPayoutAmount,
        products: productsAmount,
        workday: workdayAmount,
        records: recordsAmount,
        extra: extraAmount,
        minimumTopUp: roundMoney(salary - beforeMin + dailyMinTopUp),
        salary,
        bonuses,
        penalties,
        toPay: roundMoney(salary + bonuses - penalties),
        unpaidVisits,
        unpaidAmount,
        workdayNoSchedule: Boolean(schemeAtEnd?.workday.enabled) && hoursResult.totalHours === 0,
        minimum:
          min?.enabled && min.amount > 0
            ? {
                amount: min.amount,
                period: min.period,
                applied: min.period === 'day' ? dailyMinTopUp > 0 : wholeMonth && salary > beforeMin,
                wholeMonth,
                ...(minMonth && minProrated !== undefined && minProrated < min.amount ? { proratedAmount: minProrated, workedHours: minMonth.worked, monthHours: minMonth.scheduled } : {}),
              }
            : undefined,
        productsNotLinked: false,
        extraProfitAssumed: extraProfitAssumed && extraAmount > 0,
      };
      rows.push({ staffId, workDays: hoursResult.workDays, workHours: hoursResult.totalHours, scheduledAheadDays: hoursResult.aheadDays, scheduledAheadHours: hoursResult.aheadHours, servicesCount, servicesAmount: servicesRevenue, productsCount: products.count, productsAmount: products.revenue, totalAmount, paidAmount: roundMoney(Math.max(0, totalAmount - unpaidAmount)), salary, breakdown });
    }
    rows.sort((a, b) => b.salary - a.salary);
    return { from, to, anyConfigured: staffIds.some((id) => schemesAtEnd.has(id)), rows };
  }

  /** F-09-036: часы графика в этот день (не часы с клиентами) — тот же источник, что колонка «Рабочее время»
   * журнала/отчётов (`ScheduleService.hours`, этап 6), а не своя копия подсчёта смен.
   * Решение владельца 01.10.2026: «отработано» (и оплата «за рабочий день», оклад месяца) — только по сегодняшний
   * день включительно; дни графика после сегодня — отдельно (`aheadDays/aheadHours`), только для подписи. */
  private async scheduleHours(businessId: string, staffId: string, from: string, to: string, locationId: string): Promise<{ totalHours: number; workDays: number; hoursByMonth: Map<string, number>; hoursByDate: Map<string, number>; aheadDays: number; aheadHours: number }> {
    const result = await this.schedule.hours(businessId, staffId, from, to, locationId);
    const today = utcToLocalDate(new Date());
    let workDays = 0;
    let totalHours = 0;
    let aheadDays = 0;
    let aheadHours = 0;
    const hoursByMonth = new Map<string, number>();
    const hoursByDate = new Map<string, number>();
    for (const d of result.days) {
      const minutes = (d.hours as { from: string; to: string }[]).reduce((sum, r) => sum + Math.max(0, toMinutes(r.to) - toMinutes(r.from)), 0);
      const scheduled = roundMoney(minutes / 60);
      if (d.date > today) {
        if (scheduled > 0) aheadDays += 1;
        aheadHours = roundMoney(aheadHours + scheduled);
        continue;
      }
      if (scheduled > 0) workDays += 1;
      totalHours = roundMoney(totalHours + scheduled);
      hoursByDate.set(d.date, roundMoney((hoursByDate.get(d.date) ?? 0) + scheduled));
      const month = d.date.slice(0, 7);
      hoursByMonth.set(month, roundMoney((hoursByMonth.get(month) ?? 0) + scheduled));
    }
    return { totalHours, workDays, hoursByMonth, hoursByDate, aheadDays, aheadHours };
  }

  /** Часы графика месяца: по сегодня включительно и за весь календарный месяц (доля для оклада и минимума месяца) */
  private async monthHours(businessId: string, staffId: string, month: string, locationId: string): Promise<{ worked: number; scheduled: number }> {
    const r = await this.scheduleHours(businessId, staffId, `${month}-01`, monthEndOf(month), locationId);
    return { worked: r.totalHours, scheduled: roundMoney(r.totalHours + r.aheadHours) };
  }

  async computeStatement(businessId: string, locationId: string, staffId: string, from: string, to: string) {
    await this.requireLocation(businessId, locationId);
    const loadFrom = monthStartOf(from);
    const [bookings, groupEvents, services] = await Promise.all([this.loadBookings(businessId, locationId, loadFrom, to), this.loadGroupEvents(businessId, locationId, from, to), this.loadServices(businessId)]);
    // Доля ассистента — по схеме мастера строки (F-09-047): ведомость Ани-ассистента читает и схему Мариам.
    // З6: схема — на день каждой операции (версия «Действует с»), как «Расчёт за период»
    const schemesOn = await this.schemeResolver(businessId, locationId, withAssistedMasters([staffId], bookings), bookings);
    const accrual = await this.accrualLookup(businessId, locationId, from, to, bookings);
    bookings.push(...accrual.extra);
    const assistantsForLine = assistantsLookup(bookings);
    const bookingIds = bookings.filter((b) => b.status === 'arrived' && !b.deletedAt).map((b) => b.id);
    const paidRows = await this.prisma.booking.findMany({ where: { id: { in: bookingIds } }, select: { id: true, paidAmount: true } });
    const paidAmounts = new Map(paidRows.map((b) => [b.id, Number(b.paidAmount)]));
    const [loyaltyPaidForBooking, techCardCost] = await Promise.all([this.loyaltyPaidLookup(businessId, bookingIds), this.techCardCostLookup(businessId, locationId)]);
    const unpaidForBooking = this.unpaidForBookingLookup(bookings, paidAmounts);
    const operations: StatementOperationRow[] = [];
    for (const date of eachDay(from, to)) {
      const opsByStaff = computeServicesForDay({ date, locationId, staffIds: [staffId], bookings, groupEvents, services, schemes: schemesOn(date), loyaltyPaidForBooking, techCardCost, unpaidForBooking, accrualDateForBooking: accrual.lookup, assistantsForLine });
      for (const op of opsByStaff.get(staffId) ?? []) operations.push({ ...op, date });
    }
    const total = roundMoney(operations.reduce((sum, op) => sum + op.amount, 0));
    // «Рабочее время» «Моей зарплаты» — то же правило, что колонка «Расчёта»: дни и часы графика за период (final-fix 01.10)
    const hoursResult = await this.scheduleHours(businessId, staffId, from, to, locationId);
    // «Зарплата за период» «Моей зарплаты» и «К выплате» ведомости — та же строка «Расчёта» (рабочий день, оклад,
    // минимум) с раскладкой «из чего сложилась» (З2/З7/З10), а не только сумма услуг (final-fix 01.10, проход 17.11)
    const period = await this.computePeriod(businessId, locationId, from, to, undefined, staffId, true);
    const row = period.rows.find((r) => r.staffId === staffId);
    const sheetAmount = await this.staffSalaryForSheet(businessId, staffId, from, to, { locationId, salary: row?.salary ?? 0 });
    return { staffId, from, to, operations, total, salary: row?.salary ?? total, breakdown: row?.breakdown, sheetAmount, workDays: hoursResult.workDays, workHours: hoursResult.totalHours, scheduledAheadDays: hoursResult.aheadDays, scheduledAheadHours: hoursResult.aheadHours };
  }

  /**
   * З1: сколько начислит ведомость сотрудника за период — зарплата по схеме (строка «Расчёта за период»: услуги,
   * товары, рабочий день, оклад, «за запись», доп. от оборота, минимум) по всем его филиалам этого бизнеса, в целых
   * драмах. Одна формула для «Начислить» (createSheet) и жёлтой полосы ведомости — как staffSalaryForSheetSync мока.
   * `known` — уже посчитанная строка одного филиала (выписка ведомости), чтобы не считать её второй раз.
   */
  async staffSalaryForSheet(businessId: string, staffId: string, from: string, to: string, known?: { locationId: string; salary: number }): Promise<number> {
    const links = await this.prisma.staffLocation.findMany({ where: { staffId, location: { businessId } }, select: { locationId: true }, orderBy: { locationId: 'asc' } });
    let total = 0;
    for (const { locationId } of links) {
      const salary =
        known && known.locationId === locationId ? known.salary : ((await this.computePeriod(businessId, locationId, from, to, undefined, staffId, true)).rows.find((r) => r.staffId === staffId)?.salary ?? 0);
      total = roundMoney(total + salary);
    }
    return sheetAmountOf(total);
  }
}

/**
 * Сумма ведомости в целых драмах из зарплаты по схеме (staffSalaryForSheet) — одна формула для начисления и для жёлтой
 * полосы «Ставку в схеме поменяли после начисления»: полоса видна, только если эта сумма отличается от начисленной.
 */
export function sheetAmountOf(total: number): number {
  return Math.round(total);
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Доля месяца, отработанная по графику (по сегодня / весь месяц) — monthWorkShare фронта (domain/payroll.ts) */
function monthWorkShare(workedHours: number, monthHours: number): number {
  if (monthHours <= 0) return workedHours > 0 ? 1 : 0;
  return Math.min(1, Math.max(0, workedHours / monthHours));
}
