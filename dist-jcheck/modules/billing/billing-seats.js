import dayjs from 'dayjs';
import { ApiError } from '../../common/errors/api-error.js';
import { DEFAULT_TZ, utcToLocalDate } from '../../common/time/time.js';
/**
 * Кто занимает платные места (06 §3.1, F-00-013/014/016, В-11, В-12) — та же формула, что `computeSeats` фронта:
 * - индивидуал — одна цена;
 * - мастер салона — платный, кроме «только ассистента» (F-09-044);
 * - владелец/администратор платный как мастер, если у него есть услуга И график в этом месяце (В-11: «не блокируем,
 *   досчитываем»);
 * - первый администратор бесплатно (В-12 — на каждый салон, филиал сети = свой бизнес), остальные +adminExtraSeat;
 * - у салона минимум minPaidMasters платных мастеров;
 * - уволенные и отключённые места не занимают (F-00-016).
 */
export async function computeSeats(db, businessId, prices) {
    const biz = await db.business.findUnique({ where: { id: businessId }, select: { kind: true } });
    if (!biz)
        throw new ApiError('not_found', 'Business not found');
    const staff = await db.staff.findMany({
        where: { businessId, deletedAt: null, status: { notIn: ['fired', 'disabled'] } },
        select: { id: true, name: true, role: true, assistantOnly: true, serviceIds: true, hiredAt: true },
        orderBy: [{ hiredAt: 'asc' }, { id: 'asc' }],
    });
    if (biz.kind === 'individual') {
        const owner = staff.find((s) => s.role === 'owner');
        return {
            kind: 'individual',
            seats: owner ? [{ staffId: owner.id, name: owner.name, role: 'owner', paid: true, price: prices.individual, reasonKey: 'individual' }] : [],
            breakdown: [{ labelKey: 'billing.breakdown.individual', count: 1, unitPrice: prices.individual, amount: prices.individual }],
            monthlyTotal: prices.individual,
            paidMasters: 1,
            paidAdmins: 0,
        };
    }
    const monthStart = utcToLocalDate(dayjs().tz(DEFAULT_TZ).startOf('month').toDate());
    const withSchedule = new Set((await db.workSchedule.findMany({
        where: { businessId, OR: [{ openUntil: null }, { openUntil: { gte: monthStart } }] },
        select: { staffId: true },
    })).map((w) => w.staffId));
    const billable = (s) => Array.isArray(s.serviceIds) && s.serviceIds.length > 0 && withSchedule.has(s.id);
    const seats = [];
    let masters = 0;
    const admins = staff.filter((s) => s.role === 'admin');
    for (const s of staff) {
        if (s.role === 'owner') {
            const paid = billable(s);
            if (paid)
                masters++;
            seats.push({ staffId: s.id, name: s.name, role: 'owner', paid, price: paid ? prices.masterSeat : 0, reasonKey: paid ? 'ownerAsMaster' : 'ownerFree' });
        }
        else if (s.role === 'admin') {
            const first = admins[0]?.id === s.id;
            seats.push({ staffId: s.id, name: s.name, role: 'admin', paid: !first, price: first ? 0 : prices.adminExtraSeat, reasonKey: first ? 'adminFirstFree' : 'adminExtra' });
        }
        else if (s.assistantOnly) {
            seats.push({ staffId: s.id, name: s.name, role: 'master', paid: false, price: 0, reasonKey: 'assistantFree' });
        }
        else {
            masters++;
            seats.push({ staffId: s.id, name: s.name, role: 'master', paid: true, price: prices.masterSeat, reasonKey: 'master' });
        }
    }
    const paidAdmins = Math.max(admins.length - 1, 0);
    const breakdown = [];
    if (masters > 0)
        breakdown.push({ labelKey: 'billing.breakdown.masters', count: masters, unitPrice: prices.masterSeat, amount: masters * prices.masterSeat });
    if (masters < prices.minPaidMasters) {
        const n = prices.minPaidMasters - masters;
        breakdown.push({ labelKey: 'billing.breakdown.minimum', count: n, unitPrice: prices.masterSeat, amount: n * prices.masterSeat });
    }
    if (paidAdmins > 0)
        breakdown.push({ labelKey: 'billing.breakdown.admins', count: paidAdmins, unitPrice: prices.adminExtraSeat, amount: paidAdmins * prices.adminExtraSeat });
    return {
        kind: 'salon',
        seats,
        breakdown,
        monthlyTotal: breakdown.reduce((sum, l) => sum + l.amount, 0),
        paidMasters: Math.max(masters, prices.minPaidMasters),
        paidAdmins,
    };
}
/** Калькулятор до регистрации (F-15-178) — та же формула без привязки к бизнесу */
export function calculateForPlan(prices, input) {
    const months = Math.max(1, Math.round(input.months));
    if (input.kind === 'individual') {
        const breakdown = [{ labelKey: 'billing.breakdown.individual', count: 1, unitPrice: prices.individual, amount: prices.individual }];
        return { kind: 'individual', months, breakdown, monthlyTotal: prices.individual, regularTotal: prices.individual * months, total: prices.individual * months };
    }
    const billed = Math.max(Math.max(0, Math.round(input.masters)), prices.minPaidMasters);
    const paidAdmins = Math.max(Math.round(input.admins) - 1, 0);
    const breakdown = [{ labelKey: 'billing.breakdown.masters', count: billed, unitPrice: prices.masterSeat, amount: billed * prices.masterSeat }];
    if (paidAdmins > 0)
        breakdown.push({ labelKey: 'billing.breakdown.admins', count: paidAdmins, unitPrice: prices.adminExtraSeat, amount: paidAdmins * prices.adminExtraSeat });
    const monthlyTotal = breakdown.reduce((s, l) => s + l.amount, 0);
    return { kind: 'salon', months, breakdown, monthlyTotal, regularTotal: monthlyTotal * months, total: monthlyTotal * months };
}
//# sourceMappingURL=billing-seats.js.map