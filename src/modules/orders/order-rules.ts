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

/**
 * Можно ли перевести заказ. Клиент отказался от сметы (estimateStatus = 'declined') — вещь отдают без ремонта:
 * из «Принят» / «В работе» сразу в «Выдан».
 */
export function canTransition(from: string, to: string, estimateStatus?: string | null): boolean {
  if (to === 'issued' && estimateStatus === 'declined' && (ESTIMATE_ORDER_STATUSES as readonly string[]).includes(from)) return true;
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
/** События сметы в истории заказа (status у такой строки — статус заказа в тот момент) */
export const ORDER_HISTORY_EVENTS = ['estimate_sent', 'estimate_approved', 'estimate_declined'] as const;
export type OrderHistoryEvent = (typeof ORDER_HISTORY_EVENTS)[number];

export interface OrderHistoryEntry {
  at: string;
  status: OrderStatus;
  /** Сотрудник; null — система или клиент (ответ по ссылке) */
  by: string | null;
  /** Нет — смена статуса; есть — событие сметы */
  event?: OrderHistoryEvent;
  /** Сумма сметы (estimate_sent) */
  amount?: number;
  /** Комментарий клиента к ответу по смете */
  note?: string;
}

/** Строка истории — смена статуса (а не событие сметы) */
export const isStatusEntry = (h: OrderHistoryEntry) => !h.event;

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
  /** Смета (05.10.2026) — см. OrderEstimateData; null — сметы нет */
  estimate?: unknown;
  estimateStatus?: string | null;
  estimateSentAt?: Date | null;
  estimateRemindedAt?: Date | null;
  /** ⭐ Запись на сдачу (05.10.2026): заказ принят по этой записи журнала */
  bookingId?: string | null;
  /** ⭐ Выдача по времени (06.10.2026): запись клиента «Выдача заказа» (последняя; отменённая — значит, записи нет) */
  pickupBookingId?: string | null;
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
    estimate: estimateView(r),
    bookingId: r.bookingId ?? null,
    pickupBookingId: r.pickupBookingId ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}
export type OrderView = ReturnType<typeof orderView>;

/** Когда заказ стал готов: отметка уведомления, иначе последний переход в ready из истории */
export function readyAtOf(r: Pick<OrderRow, 'readyNotifiedAt' | 'history'>): string | null {
  if (r.readyNotifiedAt) return r.readyNotifiedAt.toISOString();
  const last = arr<OrderHistoryEntry>(r.history).filter((h) => isStatusEntry(h) && h.status === 'ready').pop();
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
export function publicOrderView(r: OrderRow, business: PublicBusinessInfo, pickup: PublicPickupView | null = null) {
  const est = estimateView(r);
  return {
    number: r.number,
    status: r.status as OrderStatus,
    items: arr<OrderItem>(r.items).map((i) => ({ title: i.title, qty: i.qty })),
    dueDate: r.dueDate,
    readyAt: readyAtOf(r),
    price: r.price,
    prepaid: r.prepaid,
    // Смета — то, что мастерская отправила клиенту (без того, кто из сотрудников её составил и когда напоминали)
    estimate:
      est && r.status !== 'cancelled'
        ? { status: est.status, version: est.version, lines: est.lines, total: est.total, comment: est.comment, sentAt: est.sentAt, decidedAt: est.decidedAt, clientComment: est.clientComment }
        : null,
    business: { name: business.name, phone: business.phone, address: business.address, slug: business.slug },
    // ⭐ Выдача по времени (06.10.2026) — только у готового заказа
    pickup: r.status === 'ready' ? pickup : null,
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
  const last = arr<OrderHistoryEntry>(r.history).filter((h) => isStatusEntry(h) && h.status === 'ready').pop();
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

// ─────────── ⭐ смета и согласование цены (05.10.2026) ───────────

/**
 * Мастерская приняла вещь, посмотрела (диагностика) и отправляет смету: работы и запчасти с ценами или одна сумма с
 * комментарием. Клиент по ссылке /o/<code> отвечает «Согласен» (заказ идёт в работу, цена = смета) или «Отказаться»
 * (вещь выдают без ремонта). Сотрудник может отметить ответ, полученный по телефону. Новая смета — новая версия:
 * ответ на старую не принимается (клиент мог смотреть устаревшую страницу).
 */
export const ESTIMATE_STATUSES = ['pending', 'approved', 'declined'] as const;
export type EstimateStatus = (typeof ESTIMATE_STATUSES)[number];
export type EstimateDecision = 'approve' | 'decline';

/** Смету отправляют, пока вещь у мастера и не готова: после приёма (диагностика) или по ходу работы («нашли ещё») */
export const ESTIMATE_ORDER_STATUSES: readonly OrderStatus[] = ['received', 'in_progress'];

export function canSendEstimate(status: string): boolean {
  return (ESTIMATE_ORDER_STATUSES as readonly string[]).includes(status);
}

export interface EstimateLine {
  title: string;
  price: number;
}

/** Что лежит в orders.estimate (JSON); статус, время отправки и напоминания — отдельными столбцами */
export interface OrderEstimateData {
  version: number;
  lines: EstimateLine[];
  total: number;
  comment: string | null;
  decidedAt: string | null;
  /** client — по ссылке, staff — сотрудник отметил ответ по телефону */
  decidedBy: 'client' | 'staff' | null;
  clientComment: string | null;
}

/** Итог сметы: сумма строк; без строк — одна сумма, которую ввёл мастер */
export function estimateTotalOf(lines: readonly EstimateLine[], total: number | null | undefined): number {
  return lines.length ? lines.reduce((s, l) => s + l.price, 0) : Math.max(0, Math.round(total ?? 0));
}

export function estimateView(r: Pick<OrderRow, 'estimate' | 'estimateStatus' | 'estimateSentAt' | 'estimateRemindedAt'>) {
  const d = r.estimate as OrderEstimateData | null | undefined;
  if (!d || !r.estimateStatus || !(ESTIMATE_STATUSES as readonly string[]).includes(r.estimateStatus)) return null;
  return {
    status: r.estimateStatus as EstimateStatus,
    version: d.version ?? 1,
    lines: arr<EstimateLine>(d.lines).map((l) => ({ title: l.title, price: l.price })),
    total: d.total ?? 0,
    comment: d.comment ?? null,
    sentAt: r.estimateSentAt?.toISOString() ?? null,
    remindedAt: r.estimateRemindedAt?.toISOString() ?? null,
    decidedAt: d.decidedAt ?? null,
    decidedBy: d.decidedBy ?? null,
    clientComment: d.clientComment ?? null,
  };
}
export type EstimateView = NonNullable<ReturnType<typeof estimateView>>;

export type EstimateDecisionPlan =
  /** Записать ответ */
  | { kind: 'apply'; status: Exclude<EstimateStatus, 'pending'>; orderStatus: OrderStatus }
  /** Тот же ответ на ту же смету уже записан — повтор нажатия, ничего не меняем */
  | { kind: 'same' }
  | { kind: 'error'; code: 'estimate_not_pending' | 'estimate_changed' | 'estimate_already_decided' };

/**
 * Ответ на смету. version — версия, которую видел клиент (сотрудник отвечает на текущую). Согласие на смету
 * «Принятого» заказа сразу переводит его в работу; в работе — остаётся в работе.
 */
export function planEstimateDecision(
  r: Pick<OrderRow, 'status' | 'estimate' | 'estimateStatus'>,
  decision: EstimateDecision,
  version: number | null,
): EstimateDecisionPlan {
  const d = r.estimate as OrderEstimateData | null | undefined;
  if (!d || !r.estimateStatus) return { kind: 'error', code: 'estimate_not_pending' };
  if (version !== null && version !== (d.version ?? 1)) return { kind: 'error', code: 'estimate_changed' };
  const wanted = decision === 'approve' ? 'approved' : 'declined';
  if (r.estimateStatus !== 'pending') return r.estimateStatus === wanted ? { kind: 'same' } : { kind: 'error', code: 'estimate_already_decided' };
  if (!canSendEstimate(r.status)) return { kind: 'error', code: 'estimate_not_pending' };
  return { kind: 'apply', status: wanted, orderStatus: decision === 'approve' && r.status === 'received' ? 'in_progress' : (r.status as OrderStatus) };
}

/** Клиент не ответил на смету за сутки — одно напоминание на версию сметы */
export const ESTIMATE_REMINDER_AFTER_MS = DAY_MS;

export function estimateReminderDue(r: Pick<OrderRow, 'status' | 'estimateStatus' | 'estimateSentAt' | 'estimateRemindedAt'>, now: Date): boolean {
  if (r.estimateStatus !== 'pending' || !canSendEstimate(r.status) || r.estimateRemindedAt || !r.estimateSentAt) return false;
  return now.getTime() - r.estimateSentAt.getTime() >= ESTIMATE_REMINDER_AFTER_MS;
}

// ─────────── ⭐ запись на сдачу по времени (05.10.2026) ───────────
// Мастерская включает «Запись на сдачу»: клиент на /b/<slug> выбирает короткое окно, когда принесёт вещь, — это обычная
// запись журнала на скрытую услугу «Приём заказа» (Service.kind = 'intake': в каталоге, поиске и выборе услуг её нет),
// описание вещи — комментарий записи. При визите мастер одним нажатием принимает заказ по записи (Order.bookingId).

export const INTAKE_KIND = 'intake';
/** Длина окна приёма, мин — выбор в настройках заказов */
export const INTAKE_SLOT_OPTIONS = [10, 15, 20, 30, 45, 60] as const;
export const DEFAULT_INTAKE_SLOT_MIN = 15;

/** Название скрытой услуги — его видят клиент (в записи и напоминаниях) и журнал */
export const INTAKE_SERVICE_NAME = { ru: 'Приём заказа', hy: 'Պատվերի ընդունում', en: 'Order drop-off' } as const;

/** Длина окна: из списка, иначе ближайшее разрешённое (старое значение или ручная правка услуги) */
export function intakeSlotOf(min: number | null | undefined): number {
  if (!min || !Number.isFinite(min)) return DEFAULT_INTAKE_SLOT_MIN;
  return [...INTAKE_SLOT_OPTIONS].sort((a, b) => Math.abs(a - min) - Math.abs(b - min) || a - b)[0]!;
}

/** Настройки «Записи на сдачу» из строки услуги (нет услуги — выключено, окно по умолчанию) */
export function intakeSettingsView(svc: { id: string; active: boolean; onlineBookable: boolean; durationMin: number; staffIds: unknown } | null) {
  return {
    enabled: Boolean(svc && svc.active && svc.onlineBookable),
    slotMin: svc ? intakeSlotOf(svc.durationMin) : DEFAULT_INTAKE_SLOT_MIN,
    staffIds: svc && Array.isArray(svc.staffIds) ? (svc.staffIds as string[]) : [],
    serviceId: svc?.id ?? null,
  };
}
export type IntakeSettingsView = ReturnType<typeof intakeSettingsView>;

/** Запись — «Приём заказа»: среди строк записи есть услуга мастерской intake */
export function isIntakeBooking(services: unknown, intakeServiceId: string | null | undefined): boolean {
  if (!intakeServiceId || !Array.isArray(services)) return false;
  return (services as { serviceId?: string }[]).some((l) => l?.serviceId === intakeServiceId);
}

/** Из записи на сдачу — в заказ можно, пока запись не отменена и не удалена (опоздал после «не пришёл» — тоже можно) */
export const INTAKE_CLOSED_STATUSES: readonly string[] = ['cancelled_by_client', 'cancelled_by_master'];

// ─────────── ⭐ выдача по времени (06.10.2026) ───────────
// Заказ «Готов» — клиент на /o/<code> сам выбирает, когда придёт забрать: то же окно, что у приёма («Запись на сдачу»:
// длина, кто принимает, часы), но запись — на вторую скрытую услугу «Выдача заказа» (Service.kind = 'pickup'). Её нет в
// каталоге, на странице мастерской и в общем потоке онлайн-записи (onlineBookable = false): записаться на неё можно
// только по ссылке заказа — по одной активной записи на заказ (Order.pickupBookingId). В журнале — «Выдача: №…», в
// «Заказах» — «Забирают сегодня» с кнопкой «Выдать». «Сдают сегодня» её не видит: там только услуга intake.

export const PICKUP_KIND = 'pickup';
/** Скрытые услуги раздела «Заказы»: в каталоге, поиске, выборе услуг и на публичной странице их нет */
export const ORDER_SERVICE_KINDS: readonly string[] = [INTAKE_KIND, PICKUP_KIND];
export const isOrderServiceKind = (kind: string | null | undefined) => ORDER_SERVICE_KINDS.includes(String(kind));

/** Название второй скрытой услуги — его видят клиент (в своих записях и напоминаниях) и журнал */
export const PICKUP_SERVICE_NAME = { ru: 'Выдача заказа', hy: 'Պատվերի ստացում', en: 'Order pickup' } as const;

/** На сколько дней вперёд (включая сегодня) клиент выбирает время, когда заберёт */
export const PICKUP_DAYS = 7;

/** Запись — «Выдача заказа»: среди строк записи есть услуга мастерской pickup (тот же признак, что у приёма) */
export const isPickupBooking = isIntakeBooking;

/**
 * Онлайн-запись (ссылка, виджет, приложение) на услугу: «Выдача заказа» — только по ссылке заказа (orderPickup, его
 * ставит лишь OrderPickupService) и никакая другая услуга с orderPickup; «Приём заказа» — только пока у бизнеса включены
 * «Заказы»; остальное — если услуга онлайн.
 */
export function onlineServiceAllowed(svc: { kind?: string | null; onlineBookable: boolean }, orderPickup: boolean, ordersOn: boolean): boolean {
  const pickup = svc.kind === PICKUP_KIND;
  if (pickup !== orderPickup) return false;
  if (pickup) return ordersOn;
  if (svc.kind === INTAKE_KIND && !ordersOn) return false;
  return svc.onlineBookable;
}

/** Выбрать время выдачи можно только у готового заказа */
export const canBookPickup = (status: string) => status === 'ready';

/** Комментарий записи на выдачу — что забирают: «№1024 · iPhone 14 — замена экрана» (не длиннее 150 знаков) */
export const PICKUP_COMMENT_MAX = 150;
export function pickupBookingComment(number: number, items: unknown): string {
  const what = arr<OrderItem>(items)
    .map((i) => (i.qty > 1 ? `${i.title} ×${i.qty}` : i.title))
    .join(' · ');
  const text = what ? `№${number} · ${what}` : `№${number}`;
  return text.length > PICKUP_COMMENT_MAX ? `${text.slice(0, PICKUP_COMMENT_MAX - 1)}…` : text;
}

/**
 * Что видит клиент на /o/<code> про выдачу: null — выбирать нечего (заказ не готов, или выдача по времени выключена и
 * записи нет). enabled — можно выбрать/поменять время; booking — его активная запись (время местное, Ереван).
 */
export interface PublicPickupView {
  enabled: boolean;
  slotMin: number;
  booking: { start: string; status: string } | null;
}
