/**
 * Правила записи на сервере — перенос чистых функций фронта один в один (booking-platform/src/domain/rules/
 * booking-status.ts, booking-policy.ts, pricing.ts), чтобы экран и сервер решали одинаково. Решения владельца поверх
 * них (PLAN.md §3): В-03 срок подтверждения, В-04 сроки отмены/переноса и предоплата при поздней отмене, В-05 окно
 * «ждёт предоплату» 30 минут.
 */
import { addMinutesLocal } from '../availability/engine.js';

export type BookingStatus =
  | 'awaiting_confirmation'
  | 'awaiting_prepayment'
  | 'scheduled'
  | 'client_confirmed'
  | 'arrived'
  | 'no_show'
  | 'cancelled_by_client'
  | 'cancelled_by_master';

export const BOOKING_STATUSES: readonly BookingStatus[] = [
  'awaiting_confirmation',
  'awaiting_prepayment',
  'scheduled',
  'client_confirmed',
  'arrived',
  'no_show',
  'cancelled_by_client',
  'cancelled_by_master',
];

export type BookingSource = 'journal' | 'app' | 'link' | 'widget' | 'phone' | 'import' | 'external';
export const BOOKING_SOURCES: readonly BookingSource[] = ['journal', 'app', 'link', 'widget', 'phone', 'import', 'external'];

export const CANCELLED_STATUSES: readonly BookingStatus[] = ['cancelled_by_client', 'cancelled_by_master'];
export const ACTIVE_STATUSES: readonly BookingStatus[] = ['awaiting_confirmation', 'awaiting_prepayment', 'scheduled', 'client_confirmed'];

export const isCancelled = (s: string) => (CANCELLED_STATUSES as readonly string[]).includes(s);
export const isActiveStatus = (s: string) => (ACTIVE_STATUSES as readonly string[]).includes(s);
/** Запись держит время мастера: всё, кроме отменённых и удалённых */
export const occupiesTime = (b: { status: string; deletedAt?: unknown }) => !b.deletedAt && !isCancelled(b.status);

export function isOnlineSource(source: string): boolean {
  return source === 'app' || source === 'link' || source === 'widget';
}

export type StatusActor = 'business' | 'client' | 'system';

const CLIENT_TRANSITIONS: Partial<Record<BookingStatus, readonly BookingStatus[]>> = {
  awaiting_confirmation: ['cancelled_by_client'],
  awaiting_prepayment: ['cancelled_by_client'],
  scheduled: ['client_confirmed', 'cancelled_by_client'],
  client_confirmed: ['cancelled_by_client'],
};

const SYSTEM_TRANSITIONS: Partial<Record<BookingStatus, readonly BookingStatus[]>> = {
  awaiting_prepayment: ['cancelled_by_client'],
  awaiting_confirmation: ['cancelled_by_master'],
};

/** Сотрудник — любой статус в любой, кроме «ждёт предоплату»; клиент — подтвердить/отменить; система — снять по сроку */
export function canTransition(from: BookingStatus, to: BookingStatus, actor: StatusActor): boolean {
  if (from === to) return false;
  if (actor === 'business') return to !== 'awaiting_prepayment';
  const map = actor === 'client' ? CLIENT_TRANSITIONS : SYSTEM_TRANSITIONS;
  return map[from]?.includes(to) ?? false;
}

/** Вошли в «не пришёл» → +1 к неявкам, вышли → −1 (F-00-071) */
export function noShowDelta(from: string, to: string): -1 | 0 | 1 {
  if (from !== 'no_show' && to === 'no_show') return 1;
  if (from === 'no_show' && to !== 'no_show') return -1;
  return 0;
}

// ─────────────────────────── Правила отмены и переноса (В-04) ───────────────────────────

export interface BookingRules {
  allowCancel?: boolean;
  allowReschedule?: boolean;
  cancelWindowMin?: number;
  rescheduleWindowMin?: number;
  allowCancelPrepaid?: boolean;
  allowReschedulePrepaid?: boolean;
  /** В-04: предоплата при поздней отмене остаётся мастеру (галочка мастера, по умолчанию да) */
  keepPrepaymentOnLateCancel?: boolean;
}

export type EffectiveBookingRules = Required<BookingRules>;

/** В-04: отдельные сроки отмены и переноса, по умолчанию 3 ч; предоплата при поздней отмене — мастеру */
export const DEFAULT_BOOKING_RULES: EffectiveBookingRules = {
  allowCancel: true,
  allowReschedule: true,
  cancelWindowMin: 180,
  rescheduleWindowMin: 180,
  allowCancelPrepaid: true,
  allowReschedulePrepaid: false,
  keepPrepaymentOnLateCancel: true,
};

/** В-04: срок 0…48 ч */
export const MAX_POLICY_WINDOW_MIN = 48 * 60;

export function effectiveBookingRules(business: BookingRules | null | undefined, staff: BookingRules | null | undefined): EffectiveBookingRules {
  const out: EffectiveBookingRules = { ...DEFAULT_BOOKING_RULES };
  for (const layer of [business, staff]) {
    if (!layer) continue;
    for (const key of Object.keys(layer) as (keyof BookingRules)[]) {
      const value = layer[key];
      if (value !== undefined && value !== null) (out as Record<string, unknown>)[key] = value;
    }
  }
  out.cancelWindowMin = Math.min(MAX_POLICY_WINDOW_MIN, Math.max(0, out.cancelWindowMin));
  out.rescheduleWindowMin = Math.min(MAX_POLICY_WINDOW_MIN, Math.max(0, out.rescheduleWindowMin));
  return out;
}

export interface PolicyBooking {
  start: string;
  status: string;
  deletedAt?: unknown;
  prepayment?: { paid?: boolean } | null;
}

export type ClientActionDenied = 'not_active' | 'started' | 'not_allowed' | 'prepaid_locked' | 'too_late';

export function clientCancelOutcome(
  b: PolicyBooking,
  rules: EffectiveBookingRules,
  now: string,
): { allowed: false; reason: ClientActionDenied } | { allowed: true; late: boolean; freeUntil: string } {
  if (b.deletedAt || !isActiveStatus(b.status)) return { allowed: false, reason: 'not_active' };
  if (b.start <= now) return { allowed: false, reason: 'started' };
  if (!rules.allowCancel) return { allowed: false, reason: 'not_allowed' };
  if (b.prepayment?.paid && !rules.allowCancelPrepaid) return { allowed: false, reason: 'prepaid_locked' };
  const freeUntil = addMinutesLocal(b.start, -rules.cancelWindowMin);
  return { allowed: true, late: now >= freeUntil, freeUntil };
}

export function canReschedule(b: PolicyBooking, rules: EffectiveBookingRules, now: string): { allowed: true } | { allowed: false; reason: ClientActionDenied } {
  const until = addMinutesLocal(b.start, -rules.rescheduleWindowMin);
  if (b.deletedAt || !isActiveStatus(b.status)) return { allowed: false, reason: 'not_active' };
  if (b.start <= now) return { allowed: false, reason: 'started' };
  if (!rules.allowReschedule) return { allowed: false, reason: 'not_allowed' };
  if (b.prepayment?.paid && !rules.allowReschedulePrepaid) return { allowed: false, reason: 'prepaid_locked' };
  if (now >= until) return { allowed: false, reason: 'too_late' };
  return { allowed: true };
}

// ─────────────────────────── Статус новой записи (В-03, F-00-079, F-00-097, F-00-065) ───────────────────────────

export interface PrepaymentRule {
  /** Фиксированная сумма; не действует, если задан `percent` */
  amount: number;
  /** ⭐ Процент от суммы записи (1–100) — ставит мастер; клиент выбирает «только предоплату» или «всю сумму сразу» */
  percent?: number;
  timeoutMin?: number;
  requisites?: string;
  /**
   * ⭐ Предоплата только от тех, кто уже не приходил (владелец, 01.10.2026; фронт — PrepaymentRule.onlyAfterNoShows):
   * нет поля — со всех; есть — только с клиента, который не пришёл к ЭТОМУ мастеру `count` раз за `months` месяцев (В-07)
   */
  onlyAfterNoShows?: { count: number; months: number } | null;
}

/** Порог по умолчанию «не пришёл 2 раза за 12 месяцев» и пределы (как domain/rules/booking-policy.ts фронта) */
export const DEFAULT_NO_SHOW_PREPAYMENT = { count: 2, months: 12 } as const;
export const NO_SHOW_PREPAYMENT_LIMITS = { count: { min: 1, max: 10 }, months: { min: 1, max: 24 } } as const;

export function normalizeNoShowRule(rule: { count?: number; months?: number } | null | undefined): { count: number; months: number } {
  const clamp = (v: number | undefined, d: number, lim: { min: number; max: number }) =>
    Math.min(lim.max, Math.max(lim.min, Math.round(typeof v === 'number' && Number.isFinite(v) ? v : d)));
  return {
    count: clamp(rule?.count, DEFAULT_NO_SHOW_PREPAYMENT.count, NO_SHOW_PREPAYMENT_LIMITS.count),
    months: clamp(rule?.months, DEFAULT_NO_SHOW_PREPAYMENT.months, NO_SHOW_PREPAYMENT_LIMITS.months),
  };
}

export type PrepaymentNeed = { reason: 'all' } | { reason: 'no_shows'; noShows: number; count: number; months: number };

/** Нужна ли предоплата этому клиенту: всем / только тому, кто не пришёл ≥ порога раз (счётчик — у этого мастера) */
export function prepaymentNeed(rule: PrepaymentRule | null | undefined, clientNoShows = 0): PrepaymentNeed | undefined {
  if (!rule || !hasPrepayment(rule)) return undefined;
  if (!rule.onlyAfterNoShows) return { reason: 'all' };
  const { count, months } = normalizeNoShowRule(rule.onlyAfterNoShows);
  return clientNoShows >= count ? { reason: 'no_shows', noShows: clientNoShows, count, months } : undefined;
}

/** Начало периода «последние M месяцев» (UTC-момент; день месяца прижимается к концу месяца) */
export function noShowPeriodStart(now: Date, months: number): Date {
  const d = new Date(now.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

/** Мастер берёт предоплату: задан процент или сумма больше нуля */
export function hasPrepayment(rule: PrepaymentRule | null | undefined): boolean {
  return Boolean(rule && ((rule.percent ?? 0) > 0 || rule.amount > 0));
}

/** В-05: окно «ждёт предоплату» держится 30 минут (если мастер не задал своё) */
export const PREPAYMENT_HOLD_MIN = 30;

export function requiresPrepayment(source: string, prepayment: PrepaymentRule | null | undefined, prepaymentPaid = false, clientNoShows = 0): boolean {
  return isOnlineSource(source) && !prepaymentPaid && prepaymentNeed(prepayment, clientNoShows) !== undefined;
}

export function newBookingStatus(input: {
  source: string;
  staff: { confirmMode: string; prepayment: PrepaymentRule | null; calendarVisibility: string };
  workplace: string;
  isOwnClient?: boolean;
  prepaymentPaid?: boolean;
  /** ⭐ Сколько раз клиент не пришёл к этому мастеру за период правила; нет — 0 */
  clientNoShows?: number;
}): BookingStatus {
  if (!isOnlineSource(input.source)) return 'scheduled';
  if (input.workplace === 'visit') return 'awaiting_confirmation';
  if (requiresPrepayment(input.source, input.staff.prepayment, input.prepaymentPaid, input.clientNoShows)) return 'awaiting_prepayment';
  if (input.staff.calendarVisibility === 'mine' && input.isOwnClient === false) return 'awaiting_confirmation';
  if (input.staff.confirmMode === 'manual') return 'awaiting_confirmation';
  return 'scheduled';
}

/**
 * Сумма предоплаты — не больше суммы записи; процент — от суммы записи, вверх до 100 ֏; `full` — клиент выбрал
 * «Оплатить всё сразу» (как у фронта, domain/rules/pricing.ts).
 */
export function prepaymentAmount(rule: PrepaymentRule | null | undefined, total: number, full = false): number {
  if (!rule || !hasPrepayment(rule)) return 0;
  if (full && total > 0) return total;
  if (rule.percent) return total > 0 ? Math.min(total, Math.ceil((total * Math.min(rule.percent, 100)) / 100 / 100) * 100) : 0;
  return total > 0 ? Math.min(rule.amount, total) : rule.amount;
}

/** «Всю сумму сразу» имеет смысл: цена точная (без «от–до») и предоплата меньше суммы записи */
export function canPayInFull(rule: PrepaymentRule | null | undefined, total: number, exactPrice: boolean): boolean {
  return exactPrice && total > 0 && hasPrepayment(rule) && prepaymentAmount(rule, total) < total;
}

/** В-03: мастер отвечает на заявку 2 ч, но не позже чем за час до начала (моменты — UTC) */
export const CONFIRM_WAIT_MIN = 120;
export const CONFIRM_BEFORE_START_MIN = 60;

export function confirmDeadlineOf(createdAt: Date, startAt: Date): Date {
  const a = createdAt.getTime() + CONFIRM_WAIT_MIN * 60_000;
  const b = startAt.getTime() - CONFIRM_BEFORE_START_MIN * 60_000;
  return new Date(Math.max(createdAt.getTime(), Math.min(a, b)));
}

// ─────────────────────────── Цена и длительность (F-00-057) ───────────────────────────

export interface ServiceLine {
  serviceId: string;
  staffId: string;
  price: number;
  durationMin: number;
  qty: number;
  unitPrice?: number;
  discountPct?: number;
  resourceId?: string;
  /** ⭐ Допродажа при записи (01.10.2026): строка добавлена как «сопутствующая» к этой услуге — для счётчика «Допродано» */
  upsellOf?: string;
}

export function bookedDuration(s: { durationMin: number; durationMax: number | null }): number {
  return s.durationMax && s.durationMax > s.durationMin ? s.durationMax : s.durationMin;
}

export function clampPct(pct: number | undefined): number {
  if (!pct || !Number.isFinite(pct)) return 0;
  return Math.min(100, Math.max(0, pct));
}

export function applyDiscount(amount: number, pct?: number): number {
  return Math.round((amount * (100 - clampPct(pct))) / 100);
}

export function makeServiceLine(
  s: { id: string; durationMin: number; durationMax: number | null; priceMin: number },
  staffId: string,
  opts: { qty?: number; discountPct?: number; unitPrice?: number; durationMin?: number } = {},
): ServiceLine {
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

export const linesDuration = (lines: readonly { durationMin: number; qty: number }[]) => lines.reduce((sum, l) => sum + l.durationMin * l.qty, 0);
export const linesTotal = (lines: readonly { price: number; qty: number }[]) => lines.reduce((sum, l) => sum + l.price * l.qty, 0);

// ─────────────────────────── Доп. данные визита (срез journal.extras) ───────────────────────────

export interface BookingExtras {
  categoryIds: string[];
  colorIndex?: number;
  customFieldValues: Record<string, string | number | null>;
  goodsLines: { id: string; itemId: string; qty: number; price: number; discountPct: number; sellerId: string; code?: string; upsellOf?: string }[];
  serviceLineExtras: { discountPct: number; assistants?: { staffId: string; sharePct: number }[] }[];
  paidAmount: number;
  autoWriteoff?: { status: string; amountDue: number; subscriptionId?: string };
  consumablesDeducted?: boolean;
  techCardOverrides?: Record<number, string>;
  packageGroupId?: string;
  payments?: { id: string; method: string; amount: number; label: string; cashRegister?: string; refId?: string; at: string }[];
  prepaymentDecision?: { kept: boolean; reason: string; decidedBy: string; decidedAt: string; auto?: boolean };
  /** F-01-032: технический перерыв под записью, мин */
  breakOverrideMin?: number;
}

export const EMPTY_EXTRAS: BookingExtras = { categoryIds: [], customFieldValues: {}, goodsLines: [], serviceLineExtras: [], paidAmount: 0 };

export function extrasOf(raw: unknown): BookingExtras {
  const e = (raw && typeof raw === 'object' ? raw : {}) as Partial<BookingExtras>;
  return { ...EMPTY_EXTRAS, ...e };
}
