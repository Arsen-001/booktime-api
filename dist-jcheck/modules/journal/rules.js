/**
 * Правила записи на сервере — перенос чистых функций фронта один в один (booking-platform/src/domain/rules/
 * booking-status.ts, booking-policy.ts, pricing.ts), чтобы экран и сервер решали одинаково. Решения владельца поверх
 * них (PLAN.md §3): В-03 срок подтверждения, В-04 сроки отмены/переноса и предоплата при поздней отмене, В-05 окно
 * «ждёт предоплату» 30 минут.
 */
import { addMinutesLocal } from '../availability/engine.js';
export const BOOKING_STATUSES = [
    'awaiting_confirmation',
    'awaiting_prepayment',
    'scheduled',
    'client_confirmed',
    'arrived',
    'no_show',
    'cancelled_by_client',
    'cancelled_by_master',
];
export const BOOKING_SOURCES = ['journal', 'app', 'link', 'widget', 'phone', 'import', 'external'];
export const CANCELLED_STATUSES = ['cancelled_by_client', 'cancelled_by_master'];
export const ACTIVE_STATUSES = ['awaiting_confirmation', 'awaiting_prepayment', 'scheduled', 'client_confirmed'];
export const isCancelled = (s) => CANCELLED_STATUSES.includes(s);
export const isActiveStatus = (s) => ACTIVE_STATUSES.includes(s);
/** Запись держит время мастера: всё, кроме отменённых и удалённых */
export const occupiesTime = (b) => !b.deletedAt && !isCancelled(b.status);
export function isOnlineSource(source) {
    return source === 'app' || source === 'link' || source === 'widget';
}
const CLIENT_TRANSITIONS = {
    awaiting_confirmation: ['cancelled_by_client'],
    awaiting_prepayment: ['cancelled_by_client'],
    scheduled: ['client_confirmed', 'cancelled_by_client'],
    client_confirmed: ['cancelled_by_client'],
};
const SYSTEM_TRANSITIONS = {
    awaiting_prepayment: ['cancelled_by_client'],
    awaiting_confirmation: ['cancelled_by_master'],
};
/** Сотрудник — любой статус в любой, кроме «ждёт предоплату»; клиент — подтвердить/отменить; система — снять по сроку */
export function canTransition(from, to, actor) {
    if (from === to)
        return false;
    if (actor === 'business')
        return to !== 'awaiting_prepayment';
    const map = actor === 'client' ? CLIENT_TRANSITIONS : SYSTEM_TRANSITIONS;
    return map[from]?.includes(to) ?? false;
}
/** Вошли в «не пришёл» → +1 к неявкам, вышли → −1 (F-00-071) */
export function noShowDelta(from, to) {
    if (from !== 'no_show' && to === 'no_show')
        return 1;
    if (from === 'no_show' && to !== 'no_show')
        return -1;
    return 0;
}
/** В-04: отдельные сроки отмены и переноса, по умолчанию 3 ч; предоплата при поздней отмене — мастеру */
export const DEFAULT_BOOKING_RULES = {
    allowCancel: true,
    allowReschedule: true,
    cancelWindowMin: 180,
    rescheduleWindowMin: 180,
    allowCancelPrepaid: false,
    allowReschedulePrepaid: false,
    keepPrepaymentOnLateCancel: true,
};
/** В-04: срок 0…48 ч */
export const MAX_POLICY_WINDOW_MIN = 48 * 60;
export function effectiveBookingRules(business, staff) {
    const out = { ...DEFAULT_BOOKING_RULES };
    for (const layer of [business, staff]) {
        if (!layer)
            continue;
        for (const key of Object.keys(layer)) {
            const value = layer[key];
            if (value !== undefined && value !== null)
                out[key] = value;
        }
    }
    out.cancelWindowMin = Math.min(MAX_POLICY_WINDOW_MIN, Math.max(0, out.cancelWindowMin));
    out.rescheduleWindowMin = Math.min(MAX_POLICY_WINDOW_MIN, Math.max(0, out.rescheduleWindowMin));
    return out;
}
export function clientCancelOutcome(b, rules, now) {
    if (b.deletedAt || !isActiveStatus(b.status))
        return { allowed: false, reason: 'not_active' };
    if (b.start <= now)
        return { allowed: false, reason: 'started' };
    if (!rules.allowCancel)
        return { allowed: false, reason: 'not_allowed' };
    if (b.prepayment?.paid && !rules.allowCancelPrepaid)
        return { allowed: false, reason: 'prepaid_locked' };
    const freeUntil = addMinutesLocal(b.start, -rules.cancelWindowMin);
    return { allowed: true, late: now >= freeUntil, freeUntil };
}
export function canReschedule(b, rules, now) {
    const until = addMinutesLocal(b.start, -rules.rescheduleWindowMin);
    if (b.deletedAt || !isActiveStatus(b.status))
        return { allowed: false, reason: 'not_active' };
    if (b.start <= now)
        return { allowed: false, reason: 'started' };
    if (!rules.allowReschedule)
        return { allowed: false, reason: 'not_allowed' };
    if (b.prepayment?.paid && !rules.allowReschedulePrepaid)
        return { allowed: false, reason: 'prepaid_locked' };
    if (now >= until)
        return { allowed: false, reason: 'too_late' };
    return { allowed: true };
}
/** В-05: окно «ждёт предоплату» держится 30 минут (если мастер не задал своё) */
export const PREPAYMENT_HOLD_MIN = 30;
export function requiresPrepayment(source, prepayment, prepaymentPaid = false) {
    return isOnlineSource(source) && Boolean(prepayment && prepayment.amount > 0) && !prepaymentPaid;
}
export function newBookingStatus(input) {
    if (!isOnlineSource(input.source))
        return 'scheduled';
    if (input.workplace === 'visit')
        return 'awaiting_confirmation';
    if (requiresPrepayment(input.source, input.staff.prepayment, input.prepaymentPaid))
        return 'awaiting_prepayment';
    if (input.staff.calendarVisibility === 'mine' && input.isOwnClient === false)
        return 'awaiting_confirmation';
    if (input.staff.confirmMode === 'manual')
        return 'awaiting_confirmation';
    return 'scheduled';
}
export function prepaymentAmount(rule, total) {
    if (!rule || rule.amount <= 0)
        return 0;
    return total > 0 ? Math.min(rule.amount, total) : rule.amount;
}
/** В-03: мастер отвечает на заявку 2 ч, но не позже чем за час до начала (моменты — UTC) */
export const CONFIRM_WAIT_MIN = 120;
export const CONFIRM_BEFORE_START_MIN = 60;
export function confirmDeadlineOf(createdAt, startAt) {
    const a = createdAt.getTime() + CONFIRM_WAIT_MIN * 60_000;
    const b = startAt.getTime() - CONFIRM_BEFORE_START_MIN * 60_000;
    return new Date(Math.max(createdAt.getTime(), Math.min(a, b)));
}
export function bookedDuration(s) {
    return s.durationMax && s.durationMax > s.durationMin ? s.durationMax : s.durationMin;
}
export function clampPct(pct) {
    if (!pct || !Number.isFinite(pct))
        return 0;
    return Math.min(100, Math.max(0, pct));
}
export function applyDiscount(amount, pct) {
    return Math.round((amount * (100 - clampPct(pct))) / 100);
}
export function makeServiceLine(s, staffId, opts = {}) {
    const unit = opts.unitPrice ?? s.priceMin;
    const pct = clampPct(opts.discountPct);
    return {
        serviceId: s.id,
        staffId,
        durationMin: opts.durationMin ?? bookedDuration(s),
        qty: Math.max(1, opts.qty ?? 1),
        price: applyDiscount(unit, pct),
        ...(pct > 0 ? { unitPrice: unit, discountPct: pct } : {}),
    };
}
export const linesDuration = (lines) => lines.reduce((sum, l) => sum + l.durationMin * l.qty, 0);
export const linesTotal = (lines) => lines.reduce((sum, l) => sum + l.price * l.qty, 0);
export const EMPTY_EXTRAS = { categoryIds: [], customFieldValues: {}, goodsLines: [], serviceLineExtras: [], paidAmount: 0 };
export function extrasOf(raw) {
    const e = (raw && typeof raw === 'object' ? raw : {});
    return { ...EMPTY_EXTRAS, ...e };
}
//# sourceMappingURL=rules.js.map