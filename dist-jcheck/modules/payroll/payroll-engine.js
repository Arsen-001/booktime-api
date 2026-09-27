/**
 * Движок расчёта зарплаты — портирован из booking-platform/src/domain/payroll.ts (F-09-*), чистые функции без
 * Prisma/Nest. Формулы, округление и порядок операций совпадают с мок-движком буквально (числа не должны
 * разойтись между демо и живым сервером), адаптирован только источник входных данных (Prisma-строки вместо
 * `readCore()`/`readArea()`).
 *
 * Честно НЕ портировано (см. docs/PROGRESS.md «Этап 14», раздел «Не строил»):
 * — ассистенты услуги (F-09-046/047): нет таблицы «кто ассистировал» ни в одном из построенных разделов
 *   (bookingAssistants мока живёт только в браузере, resources.ts backend его не пишет);
 * — деление комиссии эквайринга (F-09-007/107): по умолчанию `businessOnly` = 0 влияния на сотрудника, всегда;
 * — оплата за продажу товара (F-09-031…034): у Booking/StockOp нет данных «какой сотрудник продал», как и в
 *   моке (`productsAmount` там тоже всегда 0, см. api/payroll.ts computePeriod).
 */
export const DEFAULT_PAYOUT = { unit: 'percent', value: 0 };
export function roundMoney(n) {
    return Math.round((n + Number.EPSILON) * 100) / 100;
}
/** Ставка → сумма от базы; выплата по одной позиции не уходит в минус — обрезаем до 0 (F-09-026) */
export function applyPayout(base, payout) {
    const raw = payout.unit === 'percent' ? (base * payout.value) / 100 : payout.value;
    return roundMoney(Math.max(0, raw));
}
export function defaultConsumablesSettings() {
    return { mode: 'off', applyClientDiscount: false };
}
export function defaultLoyaltyAdjustment() {
    return {
        enabled: false,
        includeDiscount: false,
        includeBonus: false,
        includeMembership: false,
        includeClientAccount: false,
        includeCertificate: false,
        includePromotion: false,
        promoPayout: { ...DEFAULT_PAYOUT },
        promoOverrides: [],
    };
}
export function defaultGroupEvents() {
    return {
        enabled: false,
        minPayoutOn: false,
        minPayout: { ...DEFAULT_PAYOUT },
        atLeastOneOn: false,
        atLeastOnePayout: { ...DEFAULT_PAYOUT },
        perAttendeeMode: 'none',
        threshold: 0,
    };
}
export function defaultGuaranteedMinimum() {
    return { enabled: false, amount: 0, period: 'month' };
}
export function emptySchemeBlocks() {
    return {
        personalServices: {
            enabled: false,
            defaultPayout: { ...DEFAULT_PAYOUT },
            overrides: [],
            demoConsumablesPercent: 0,
            consumables: defaultConsumablesSettings(),
            loyaltyAdjustment: defaultLoyaltyAdjustment(),
            groupEvents: defaultGroupEvents(),
        },
        productSales: {
            enabled: false,
            defaultPayout: { ...DEFAULT_PAYOUT },
            overrides: [],
            demoCostPercent: 0,
            costBasis: { enabled: false, order: 'discountFirst' },
            loyaltyAdjustment: defaultLoyaltyAdjustment(),
        },
        workday: { enabled: false, baseAmount: 0, basePeriod: 'day', guaranteedMinimum: defaultGuaranteedMinimum() },
        records: {
            enabled: false,
            perServicePayout: { ...DEFAULT_PAYOUT },
            perServiceOverrides: [],
            onlineWidgetEnabled: false,
            onlineWidgetPayout: { ...DEFAULT_PAYOUT },
        },
        extraServiceRevenue: { enabled: false, percent: 0, base: 'turnover' },
        extraProductRevenue: { enabled: false, percent: 0, base: 'turnover' },
    };
}
export function isSchemeBlank(scheme) {
    return (!scheme.personalServices.enabled &&
        !scheme.productSales.enabled &&
        !scheme.workday.enabled &&
        !scheme.records.enabled &&
        !scheme.extraServiceRevenue.enabled &&
        !scheme.extraProductRevenue.enabled);
}
export function payoutForTarget(block, itemId, categoryId) {
    const itemOverride = block.overrides.find((o) => o.targetType === 'item' && o.targetId === itemId);
    if (itemOverride)
        return itemOverride.payout;
    if (categoryId) {
        const catOverride = block.overrides.find((o) => o.targetType === 'category' && o.targetId === categoryId);
        if (catOverride)
            return catOverride.payout;
    }
    return block.defaultPayout;
}
export function personalServiceBase(line, adjustment, loyaltyPaid) {
    const afterDiscount = roundMoney(line.price * line.qty);
    if (!adjustment.enabled)
        return afterDiscount;
    let base = adjustment.includeDiscount ? roundMoney((line.unitPrice ?? line.price) * line.qty) : afterDiscount;
    if (loyaltyPaid) {
        if (!adjustment.includeBonus)
            base = roundMoney(base - loyaltyPaid.bonus);
        if (!adjustment.includeMembership)
            base = roundMoney(base - loyaltyPaid.membership);
        if (!adjustment.includeClientAccount)
            base = roundMoney(base - loyaltyPaid.clientAccount);
        if (!adjustment.includeCertificate)
            base = roundMoney(base - loyaltyPaid.certificate);
        if (!adjustment.includePromotion)
            base = roundMoney(base - loyaltyPaid.promotion);
    }
    return Math.max(0, base);
}
export function consumablesDeduction(fullLineTotal, discountPct, block, rate, realCost) {
    if (block.consumables.mode === 'off')
        return 0;
    let cost;
    if (realCost !== undefined) {
        cost = roundMoney(realCost);
    }
    else {
        const pct = block.demoConsumablesPercent ?? 0;
        if (pct <= 0)
            return 0;
        cost = roundMoney((fullLineTotal * pct) / 100);
    }
    if (cost <= 0)
        return 0;
    if (block.consumables.applyClientDiscount && discountPct > 0)
        cost = roundMoney(cost * (1 - discountPct / 100));
    if (block.consumables.mode === 'full')
        return cost;
    const sharePct = rate.unit === 'percent' ? rate.value : 100;
    return roundMoney((cost * sharePct) / 100);
}
export function computeGroupEventPayout(attendeesCount, settingsPrice, block, perAttendeeRate, visitPrice = settingsPrice) {
    if (!block.enabled)
        return 0;
    let total = 0;
    if (block.minPayoutOn)
        total = roundMoney(total + applyPayout(settingsPrice, block.minPayout));
    if (attendeesCount > 0 && block.atLeastOneOn)
        total = roundMoney(total + applyPayout(settingsPrice, block.atLeastOnePayout));
    if (block.perAttendeeMode === 'each') {
        total = roundMoney(total + applyPayout(visitPrice, perAttendeeRate) * attendeesCount);
    }
    else if (block.perAttendeeMode === 'aboveThreshold') {
        const extra = Math.max(0, attendeesCount - block.threshold);
        total = roundMoney(total + applyPayout(visitPrice, perAttendeeRate) * extra);
    }
    return total;
}
function lineLabel(service, line) {
    return service ? service.name : line.serviceId;
}
function localDate(d) {
    return d.toISOString().slice(0, 10);
}
function localTime(d) {
    return d.toISOString().slice(11, 16);
}
/**
 * F-09-058/059/017/026/112. Порт computeServicesForDay мока — БЕЗ ассистентов (F-09-046/047, нет данных) и без
 * комиссии эквайринга (F-09-007/107, businessOnly = 0 влияния по умолчанию, честный гэп при других вариантах).
 */
export function computeServicesForDay(input) {
    const byService = new Map(input.services.map((s) => [s.id, s]));
    const result = new Map();
    for (const staffId of input.staffIds)
        result.set(staffId, []);
    const dayBookings = input.bookings.filter((b) => b.locationId === input.locationId && b.status === 'arrived' && !b.deletedAt && localDate(b.startAt) === input.date);
    const individualBookings = dayBookings.filter((b) => !b.groupEventId);
    for (const booking of individualBookings) {
        const byStaff = new Map();
        const loyaltyPaid = input.loyaltyPaidForBooking?.(booking.id);
        const bookingLineTotal = roundMoney(booking.services.reduce((s, l) => s + l.price * l.qty, 0)) || 1;
        for (const line of booking.services) {
            const scheme = input.schemes.get(line.staffId);
            const service = byService.get(line.serviceId);
            const lineTotal = roundMoney(line.price * line.qty);
            let amount = 0;
            let clippedByConsumables = false;
            if (scheme?.personalServices.enabled) {
                const payout = payoutForTarget(scheme.personalServices, line.serviceId, service?.categoryId);
                const lineShare = lineTotal / bookingLineTotal;
                const lineLoyaltyPaid = loyaltyPaid
                    ? {
                        bonus: roundMoney(loyaltyPaid.bonus * lineShare),
                        membership: roundMoney(loyaltyPaid.membership * lineShare),
                        clientAccount: roundMoney(loyaltyPaid.clientAccount * lineShare),
                        certificate: roundMoney(loyaltyPaid.certificate * lineShare),
                        promotion: roundMoney(loyaltyPaid.promotion * lineShare),
                    }
                    : undefined;
                const baseBeforeUnpaid = personalServiceBase(line, scheme.personalServices.loyaltyAdjustment, lineLoyaltyPaid);
                const unpaidForBooking = input.unpaidForBooking?.(booking.id) ?? 0;
                const unpaidLineShare = unpaidForBooking > 0 ? roundMoney(unpaidForBooking * lineShare) : 0;
                const base = unpaidLineShare > 0 ? Math.max(0, roundMoney(baseBeforeUnpaid - unpaidLineShare)) : baseBeforeUnpaid;
                const fullLineTotal = roundMoney((line.unitPrice ?? line.price) * line.qty);
                const techCost = input.techCardCost?.(line.serviceId, line.staffId, input.date);
                const realCost = techCost !== undefined ? roundMoney(techCost * line.qty) : undefined;
                const consumables = consumablesDeduction(fullLineTotal, line.discountPct ?? 0, scheme.personalServices, payout, realCost);
                if (scheme.personalServices.consumables.mode === 'full') {
                    const adjustedBase = Math.max(0, roundMoney(base - consumables));
                    amount = roundMoney(applyPayout(adjustedBase, payout));
                    if (adjustedBase <= 0 && consumables > 0)
                        clippedByConsumables = true;
                }
                else {
                    const raw = applyPayout(base, payout);
                    amount = roundMoney(raw - consumables);
                    if (amount < 0) {
                        amount = 0;
                        clippedByConsumables = true;
                    }
                }
            }
            const bucket = byStaff.get(line.staffId) ?? { lines: [], sum: 0, revenueSum: 0 };
            bucket.lines.push({ kind: 'service', refId: line.serviceId, label: lineLabel(service, line), amount, clippedByConsumables, revenue: lineTotal });
            bucket.sum = roundMoney(bucket.sum + amount);
            bucket.revenueSum = roundMoney(bucket.revenueSum + lineTotal);
            byStaff.set(line.staffId, bucket);
        }
        for (const [staffId, bucket] of byStaff) {
            if (!result.has(staffId))
                result.set(staffId, []);
            result.get(staffId).push({ time: localTime(booking.startAt), bookingId: booking.id, label: localTime(booking.startAt), amount: bucket.sum, revenue: bucket.revenueSum, lines: bucket.lines });
        }
    }
    const dayGroupEvents = (input.groupEvents ?? []).filter((e) => e.locationId === input.locationId && e.status === 'scheduled' && localDate(e.startAt) === input.date);
    for (const event of dayGroupEvents) {
        const scheme = input.schemes.get(event.staffId);
        if (!scheme?.personalServices.enabled)
            continue;
        const groupEvents = scheme.personalServices.groupEvents;
        if (!groupEvents.enabled)
            continue;
        const service = byService.get(event.serviceId);
        const settingsPrice = service?.priceMin ?? 0;
        const attendeeBookings = dayBookings.filter((b) => b.groupEventId === event.id);
        const attendeesCount = attendeeBookings.reduce((n, b) => n + Math.max(1, b.services[0]?.qty ?? 1), 0);
        const perAttendeeRate = payoutForTarget(scheme.personalServices, event.serviceId, service?.categoryId);
        const visitPrice = attendeesCount > 0 ? roundMoney(attendeeBookings.reduce((s, b) => s + (b.services[0]?.price ?? 0) * Math.max(1, b.services[0]?.qty ?? 1), 0) / attendeesCount) : settingsPrice;
        const amount = computeGroupEventPayout(attendeesCount, settingsPrice, groupEvents, perAttendeeRate, visitPrice);
        if (amount <= 0)
            continue;
        const label = service ? service.name : event.serviceId;
        if (!result.has(event.staffId))
            result.set(event.staffId, []);
        result.get(event.staffId).push({
            time: localTime(event.startAt),
            bookingId: event.id,
            label,
            amount,
            revenue: roundMoney(attendeeBookings.reduce((s, b) => s + b.total, 0)),
            lines: [{ kind: 'service', refId: `group:${event.id}`, label, amount, revenue: 0 }],
        });
    }
    for (const ops of result.values())
        ops.sort((a, b) => a.time.localeCompare(b.time));
    return result;
}
export function locationServicesTurnover(bookings, locationId, date) {
    return roundMoney(bookings.filter((b) => b.locationId === locationId && b.status === 'arrived' && !b.deletedAt && localDate(b.startAt) === date).reduce((sum, b) => sum + b.total, 0));
}
/** F-09-039/040: вознаграждение за КАЖДУЮ услугу в записи, которую сотрудник создал в этот день */
export function recordsRewardForDay(bookings, staffId, date, block, services) {
    if (!block.enabled)
        return 0;
    const byService = new Map(services.map((s) => [s.id, s]));
    let total = 0;
    for (const b of bookings) {
        if (b.deletedAt || b.createdByRef !== staffId || localDate(b.createdAt) !== date)
            continue;
        for (const line of b.services) {
            const service = byService.get(line.serviceId);
            const payout = payoutForTarget({ defaultPayout: block.perServicePayout, overrides: block.perServiceOverrides }, line.serviceId, service?.categoryId);
            total = roundMoney(total + applyPayout(roundMoney(line.price * line.qty), payout));
        }
    }
    return total;
}
/** F-09-041: вознаграждение за услугу в записи, закрытой из онлайн-виджета — платит тот, кто первым отметил «Пришёл» */
export function onlineWidgetRewardForDay(bookings, events, staffId, date, block, services) {
    if (!block.enabled || !block.onlineWidgetEnabled)
        return 0;
    let total = 0;
    for (const b of bookings) {
        if (b.deletedAt || b.status !== 'arrived' || b.source === 'journal')
            continue;
        if (localDate(b.startAt) !== date)
            continue;
        const firstArrived = events.find((e) => e.bookingId === b.id && e.kind === 'status' && e.toStatus === 'arrived');
        if (!firstArrived || firstArrived.byRef !== staffId)
            continue;
        for (const line of b.services) {
            total = roundMoney(total + applyPayout(roundMoney(line.price * line.qty), block.onlineWidgetPayout));
        }
    }
    void services;
    return total;
}
// ─────────────────────────── F-09-037/038: месячный оклад и гарантированный минимум ───────────────────────────
function monthIndex(y, m) {
    return y * 12 + (m - 1);
}
function monthFromIndex(idx) {
    return { y: Math.floor(idx / 12), m: (((idx % 12) + 12) % 12) + 1 };
}
function monthKey(y, m) {
    return `${y}-${String(m).padStart(2, '0')}`;
}
export function qualifyingMonthlySalaryMonths(from, to) {
    const [fy, fm] = from.split('-').map(Number);
    const [ty, tm] = to.split('-').map(Number);
    const startIdx = monthIndex(fy, fm) - 1;
    const endIdx = monthIndex(ty, tm);
    const months = [];
    for (let idx = startIdx; idx <= endIdx; idx++) {
        const cur = monthFromIndex(idx);
        const next = monthFromIndex(idx + 1);
        const firstOfNext = `${next.y}-${String(next.m).padStart(2, '0')}-01`;
        if (firstOfNext >= from && firstOfNext <= to)
            months.push(monthKey(cur.y, cur.m));
    }
    return months;
}
export function monthlySalaryQualifies(month, workedHoursInMonth, schemeCreatedAt) {
    if (workedHoursInMonth <= 0)
        return false;
    return schemeCreatedAt.slice(0, 10) <= `${month}-01`;
}
export function periodIsWholeMonth(from, to) {
    const [y, m] = from.split('-').map(Number);
    if (from.slice(8, 10) !== '01')
        return false;
    const next = monthFromIndex(monthIndex(y, m) + 1);
    const lastDay = new Date(Date.UTC(next.y, next.m - 1, 0)).getUTCDate();
    const expectedTo = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    return to === expectedTo;
}
export function applyMonthlyGuaranteedMinimum(computedTotal, min, from, to) {
    if (!min.enabled || min.amount <= 0 || min.period !== 'month')
        return computedTotal;
    if (!periodIsWholeMonth(from, to))
        return computedTotal;
    return Math.max(computedTotal, min.amount);
}
export function applyDailyGuaranteedMinimum(dayTotal, min) {
    if (!min.enabled || min.amount <= 0 || min.period !== 'day')
        return dayTotal;
    return Math.max(dayTotal, min.amount);
}
/** 🔒 F-09-042/043 демо (как в моке): «прибыль» = оборот × (1 − DEMO_EXPENSE_RATIO), пока finance/stock не
 * отдают настоящие расходы построчно. */
export const DEMO_EXPENSE_RATIO = 0.7;
export function extraRevenueAmount(turnover, block) {
    if (!block.enabled || block.percent <= 0)
        return 0;
    const base = block.base === 'profit' ? roundMoney(turnover * (1 - DEMO_EXPENSE_RATIO)) : turnover;
    return roundMoney((base * block.percent) / 100);
}
export function sumDayResult(r) {
    return roundMoney(r.servicesAmount + r.productsAmount + r.workdayAmount + r.recordsAmount + r.extraAmount);
}
export function evaluateCriterion(threshold, actualValue) {
    return actualValue > threshold;
}
/** F-09-052/054: только metric='turnover' подключён к реальным данным (как в моке — profit/count не построены) */
export function evaluateCriterionForStaff(criterion, bookings, staffId, locationId, periodFrom, periodTo) {
    if (criterion.metric !== 'turnover')
        return false;
    let turnover = 0;
    for (const b of bookings) {
        if (b.locationId !== locationId || b.deletedAt)
            continue;
        if (b.status !== 'arrived')
            continue;
        const day = localDate(b.startAt);
        if (day < periodFrom || day > periodTo)
            continue;
        for (const line of b.services) {
            if (criterion.scope === 'staff' && line.staffId !== staffId)
                continue;
            if (!criterion.byServices)
                continue;
            turnover = roundMoney(turnover + line.price * line.qty);
        }
    }
    return evaluateCriterion(criterion.threshold, turnover);
}
/** F-09-054: плановая схема — первый выполненный критерий сверху; если ни один — стандартное правило */
export function pickRuleForChart(chart, criterionMet) {
    if (chart.type === 'standard')
        return chart.standardRuleId ?? undefined;
    for (const row of chart.planRows) {
        if (criterionMet(row.criterionId))
            return row.ruleId;
    }
    return chart.standardRuleId ?? undefined;
}
/** F-09-055/099: назначение с наибольшей startDate ≤ date */
export function resolveActiveChartAssignment(assignments, staffId, date) {
    const forStaff = assignments.filter((a) => a.staffId === staffId && a.startDate <= date);
    if (forStaff.length === 0)
        return undefined;
    return forStaff.reduce((best, a) => (a.startDate > best.startDate ? a : best));
}
/** F-09-002/054/099: приводит правило классической модели к форме эффективной схемы — тот же движок расчёта */
export function ruleAsScheme(rule, staffId) {
    return {
        staffId,
        personalServices: rule.personalServices,
        productSales: rule.productSales,
        workday: rule.workday,
        records: rule.records,
        extraServiceRevenue: rule.extraServiceRevenue,
        extraProductRevenue: rule.extraProductRevenue,
        createdAt: rule.createdAt,
    };
}
export const STATEMENT_APPROVAL_ORDER = ['pendingReview', 'reviewed', 'approved', 'sentToStaff', 'signed', 'paid'];
export function nextApprovalStatus(current) {
    const idx = STATEMENT_APPROVAL_ORDER.indexOf(current);
    return idx >= 0 && idx < STATEMENT_APPROVAL_ORDER.length - 1 ? STATEMENT_APPROVAL_ORDER[idx + 1] : undefined;
}
export function canMarkPaid(status, approvalEnabled) {
    if (!approvalEnabled)
        return true;
    return status === 'signed';
}
export function settlementEntrySign(kind) {
    return kind === 'penalty' || kind === 'payout' ? -1 : 1;
}
export function settlementBalance(entries) {
    return roundMoney(entries.reduce((sum, e) => (e.status === 'draft' ? sum : sum + settlementEntrySign(e.kind) * e.amount), 0));
}
//# sourceMappingURL=payroll-engine.js.map