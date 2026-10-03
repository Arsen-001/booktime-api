import { randomShortCode } from '../shortlinks/shortlinks.service.js';

/**
 * Заказы (03.10.2026, решение владельца): ателье, ремонт телефонов и техники, химчистка, детейлинг. Клиенты таких
 * мест всё время звонят «готово?» — бизнес принимает заказ, ведёт его по статусам, клиент получает «готов»
 * автоматически и видит статус по ссылке /o/<code> без входа. Здесь — чистые правила (без базы), их проверяют тесты.
 */

/** Сферы, где раздел «Заказы» включён по умолчанию (у остальных — выключен, владелец может включить сам) */
export const ORDER_SPHERES = ['tailor', 'repair', 'drycleaning', 'detailing'] as const;

/** Business.ordersEnabled: null — по сферам бизнеса */
export function ordersEnabledOf(stored: boolean | null | undefined, sphereIds: unknown): boolean {
  if (typeof stored === 'boolean') return stored;
  return Array.isArray(sphereIds) && sphereIds.some((s) => (ORDER_SPHERES as readonly string[]).includes(String(s)));
}

export const ORDER_STATUSES = ['received', 'in_progress', 'ready', 'issued', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
/** «Активные» в списке: ещё не выданы и не отменены */
export const ACTIVE_ORDER_STATUSES: readonly OrderStatus[] = ['received', 'in_progress', 'ready'];

/** Разрешённые переходы. issued и cancelled — конечные. ready → in_progress — «нашли недоделку» */
export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  received: ['in_progress', 'ready', 'cancelled'],
  in_progress: ['ready', 'cancelled'],
  ready: ['issued', 'in_progress'],
  issued: [],
  cancelled: [],
};

export function canTransition(from: string, to: string): boolean {
  return (ORDER_TRANSITIONS[from as OrderStatus] ?? []).includes(to as OrderStatus);
}

/** Первый номер заказа бизнеса */
export const FIRST_ORDER_NUMBER = 1001;

/** Публичный токен: 10 знаков base62 из crypto (62^10 ≈ 8·10^17 — не угадать перебором) */
export const ORDER_CODE_LENGTH = 10;
export const ORDER_CODE_RE = /^[0-9A-Za-z]{10}$/;
export function newOrderCode(): string {
  return randomShortCode(ORDER_CODE_LENGTH);
}

export interface OrderItem {
  title: string;
  qty: number;
  note?: string;
}
export interface OrderHistoryEntry {
  at: string;
  status: OrderStatus;
  by: string | null;
}

/** Строка таблицы orders в том виде, в каком её отдаёт Prisma (только нужные поля — тестам проще) */
export interface OrderRow {
  id: string;
  businessId: string;
  locationId: string | null;
  number: number;
  code: string;
  clientId: string | null;
  clientName: string;
  clientPhone: string;
  items: unknown;
  photos: unknown;
  staffId: string | null;
  status: string;
  dueDate: string | null;
  price: number;
  prepaid: number;
  comment: string | null;
  history: unknown;
  readyNotifiedAt: Date | null;
  issuedAt: Date | null;
  /** Сколько авто-напоминаний «заказ ждёт вас» ушло за этот «Готов» (сбрасывается при новом переходе в ready) */
  pickupReminderCount?: number;
  pickupRemindedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/** Заказ для кабинета бизнеса. Даты-время — ISO (UTC), срок — 'YYYY-MM-DD' */
export function orderView(r: OrderRow) {
  return {
    id: r.id,
    businessId: r.businessId,
    locationId: r.locationId,
    number: r.number,
    code: r.code,
    clientId: r.clientId,
    clientName: r.clientName,
    clientPhone: r.clientPhone,
    items: arr<OrderItem>(r.items).map((i) => (i.note ? { title: i.title, qty: i.qty, note: i.note } : { title: i.title, qty: i.qty })),
    photos: arr<string>(r.photos),
    staffId: r.staffId,
    status: r.status as OrderStatus,
    dueDate: r.dueDate,
    price: r.price,
    prepaid: r.prepaid,
    comment: r.comment,
    history: arr<OrderHistoryEntry>(r.history),
    readyNotifiedAt: r.readyNotifiedAt?.toISOString() ?? null,
    issuedAt: r.issuedAt?.toISOString() ?? null,
    pickupReminderCount: r.pickupReminderCount ?? 0,
    pickupRemindedAt: r.pickupRemindedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}
export type OrderView = ReturnType<typeof orderView>;

/** Когда заказ стал готов: отметка уведомления, иначе последний переход в ready из истории */
export function readyAtOf(r: Pick<OrderRow, 'readyNotifiedAt' | 'history'>): string | null {
  if (r.readyNotifiedAt) return r.readyNotifiedAt.toISOString();
  const last = arr<OrderHistoryEntry>(r.history).filter((h) => h.status === 'ready').pop();
  return last?.at ?? null;
}

export interface PublicBusinessInfo {
  name: string;
  phone: string;
  address: string;
  slug: string;
}

/**
 * Публичный вид /o/<code>: только то, что нужно клиенту. Никогда — телефон клиента, внутренний комментарий, id
 * сотрудников, фото (могут содержать личное) и id самого заказа.
 */
export function publicOrderView(r: OrderRow, business: PublicBusinessInfo) {
  return {
    number: r.number,
    status: r.status as OrderStatus,
    items: arr<OrderItem>(r.items).map((i) => ({ title: i.title, qty: i.qty })),
    dueDate: r.dueDate,
    readyAt: readyAtOf(r),
    price: r.price,
    prepaid: r.prepaid,
    business: { name: business.name, phone: business.phone, address: business.address, slug: business.slug },
  };
}
export type PublicOrderView = ReturnType<typeof publicOrderView>;

/** Поиск q: номер (с «№»/«#» или без), имя клиента, телефон (по цифрам), названия вещей */
export function orderMatches(r: Pick<OrderRow, 'number' | 'clientName' | 'clientPhone' | 'items'>, q: string): boolean {
  const text = q.trim().toLowerCase();
  if (!text) return true;
  const numeric = text.replace(/^[№#]\s*/, '');
  if (/^\d+$/.test(numeric) && String(r.number).includes(numeric)) return true;
  if (r.clientName.toLowerCase().includes(text)) return true;
  const digits = text.replace(/\D/g, '');
  if (digits.length >= 3 && r.clientPhone.replace(/\D/g, '').includes(digits)) return true;
  return arr<OrderItem>(r.items).some((i) => String(i.title ?? '').toLowerCase().includes(text));
}

/** Адрес ссылки статуса для клиента */
export function orderStatusUrl(siteUrl: string, code: string): string {
  return `${siteUrl.replace(/\/+$/, '')}/o/${code}`;
}

// ─────────── напоминание «заказ ждёт вас» (04.10.2026) ───────────

/**
 * Напоминание клиенту, который не забрал готовый заказ: выключено / через 3 дня / через 3 и 7 дней после «Готов».
 * Хранится в Business.orderPickupReminders; null — по умолчанию «3 и 7».
 */
export const PICKUP_REMINDER_MODES = ['off', '3', '3_7'] as const;
export type PickupReminderMode = (typeof PICKUP_REMINDER_MODES)[number];
export const DEFAULT_PICKUP_REMINDER_MODE: PickupReminderMode = '3_7';

export function pickupReminderModeOf(stored: string | null | undefined): PickupReminderMode {
  return (PICKUP_REMINDER_MODES as readonly string[]).includes(String(stored)) ? (stored as PickupReminderMode) : DEFAULT_PICKUP_REMINDER_MODE;
}

/** Через сколько дней после «Готов» — каждое напоминание по порядку */
export function pickupReminderDays(mode: PickupReminderMode): readonly number[] {
  return mode === 'off' ? [] : mode === '3' ? [3] : [3, 7];
}

const DAY_MS = 86_400_000;
/** Бизнес сам нажал «Отправить ещё раз» меньше суток назад — авто-напоминание подождёт (не два сообщения подряд) */
const MANUAL_RESEND_GAP_MS = DAY_MS;

/** Когда заказ последний раз стал «Готов» — по истории (ручное «Отправить ещё раз» срок не сдвигает) */
export function lastReadyAt(r: Pick<OrderRow, 'readyNotifiedAt' | 'history'>): Date | null {
  const last = arr<OrderHistoryEntry>(r.history).filter((h) => h.status === 'ready').pop();
  if (last?.at) {
    const d = new Date(last.at);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return r.readyNotifiedAt ?? null;
}

export interface PickupReminderPlan {
  /** Сколько напоминаний будет «отправлено» после этого (новое значение pickupReminderCount) */
  nextCount: number;
}

/**
 * Пора ли напомнить. null — нет: заказ не «Готов» (выдан, отменён, в работе), напоминания выключены, все уже ушли, срок
 * не настал, или бизнес сам напоминал меньше суток назад. Воркер лежал и прошли оба срока — одно сообщение, а не два
 * подряд: nextCount сразу перескакивает через все наступившие сроки.
 */
export function pickupReminderDue(
  r: Pick<OrderRow, 'status' | 'readyNotifiedAt' | 'history'> & { pickupReminderCount: number },
  mode: PickupReminderMode,
  now: Date,
): PickupReminderPlan | null {
  if (r.status !== 'ready') return null;
  const days = pickupReminderDays(mode);
  const done = Math.max(0, r.pickupReminderCount || 0);
  if (done >= days.length) return null;
  const readyAt = lastReadyAt(r);
  if (!readyAt) return null;
  const elapsed = now.getTime() - readyAt.getTime();
  if (elapsed < days[done]! * DAY_MS) return null;
  if (r.readyNotifiedAt && r.readyNotifiedAt.getTime() > readyAt.getTime() && now.getTime() - r.readyNotifiedAt.getTime() < MANUAL_RESEND_GAP_MS) return null;
  let nextCount = done + 1;
  while (nextCount < days.length && elapsed >= days[nextCount]! * DAY_MS) nextCount++;
  return { nextCount };
}
