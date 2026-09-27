// @ts-nocheck — СГЕНЕРИРОВАНО scripts/sync-loyalty-port.mjs из booking-platform/src/api/loyalty.ts; руками не править.
// Типы проверяет tsc фронта (noUncheckedIndexedAccess у фронта выключен, у сервера включён — отсюда nocheck).
import { portNowDate } from './shim.js';
/**
 * API раздела «loyalty» (пачка b01 — каркас и главные списки). Принадлежит разделу.
 * Функции — async поверх request() из '@/api/request'; свой срез — readArea/mutateArea из '@/api/area';
 * сущности ядра — только чтение через readCore() (изменения ядра — через src/api/core.ts, здесь не нужны).
 */
import { ApiError, request } from './shim.js';
import { mutateArea, readArea, readCore } from './shim.js';
import { cancelBookingPayment, cancelPaymentLine, payBookingLines } from './stubs.js';
import { addBookingPromoDiscount, getBookingPaymentSummary, removeBookingPaymentLine } from './stubs.js';
import type { CoreData, Id } from './core-types.js';
import type { BookingExtras, JournalPaymentMethod } from './stubs.js';
import type { AccountOperation, AccountType, AutoApplySettings, CardType, Certificate, CertificateStatus, CertificateType, ClientAccount, DiscountNotifySettings, LoyaltyCard, LoyaltyPaymentLineInput, LoyaltyPaymentLineKind, LoyaltyTransaction, LoyaltyTxType, Membership, MembershipStatus, MembershipType, OnlineOrder, OnlineOrderItemKind, OnlineOrderStatus, OnlineSalePaymentSettings, OnlineSaleWidgetSettings, Promotion, PromotionKind, ReferralSettings, ServiceScope } from './domain.js';
import { chargeCertificate, defaultDiscountNotify, defaultOnlineSalePayment, defaultOnlineSaleWidget, isAccountTypeValid, isCertificateExpired, isDiscountKind, isPromotionActiveNow, maxAccountCharge, MEMBERSHIP_TRANSITIONS, membershipDisplayStatus, validatePromotion } from './domain.js';
import { dayjs, nowDateTime, toISODate, toISODateTime, today as todayISO } from './shim.js';
import { newId } from './shim.js';

const AREA = 'loyalty' as const;

type LoyaltyArea = ReturnType<typeof readArea<typeof AREA>>;

function clientOf(core: CoreData, clientId: Id) {
  return core.clients.find((c) => c.id === clientId);
}

function locationNameOf(core: CoreData, locationId: Id, locale: string): string {
  const loc = core.locations.find((l) => l.id === locationId);
  if (!loc) return '';
  return loc.name[locale as 'ru'] ?? loc.name.ru ?? '';
}

/**
 * F-06-074: общий откат строк оплаты лояльностью визита — явной кнопкой «Отменить оплату» (reverseLoyaltyPayment)
 * и самовосстановлением удалённых записей (reconcileDeletedBookingPayments). Возвращает балансы карт,
 * сертификатов (вместе со сгоревшим остатком однократного), абонементов и счетов, снимает бонус пригласившему
 * и — Л6 — начисленный за визит кэшбэк (includeAccruals): оплаты нет — нет и бонусов за неё.
 */
function reverseLoyaltyPaymentLines(s: LoyaltyArea, businessId: Id, bookingId: Id, includeAccruals: boolean): void {
  const hit = (tx: LoyaltyTransaction) => tx.businessId === businessId && tx.bookingId === bookingId && (includeAccruals || tx.type !== 'loyaltyAccrual');
  const lines = s.transactions.filter(hit);
  const ids = new Set(lines.map((tx) => tx.id));
  // порождённые строки (бонус пригласившему, сгоревший остаток) без bookingId у старых данных — тоже снимаем
  const children = s.transactions.filter((tx) => tx.parentTxId && ids.has(tx.parentTxId) && !ids.has(tx.id));
  for (const tx of [...lines, ...children]) undoLoyaltyTx(s, tx);
  for (const tx of children) ids.add(tx.id);
  s.transactions = s.transactions.filter((tx) => !ids.has(tx.id));
  s.paidBookingIds = s.paidBookingIds.filter((id) => id !== bookingId);
}

/** Не откатывать, пока не истекло окно «Отменить» тоста удаления записи (журнал, F-00-061 — 5000мс) */
const DELETE_UNDO_GRACE_MS = 6000;

/**
 * F-06-074: «удаление оплаченной абонементом/картой/сертификатом записи возвращает списанное» —
 * journal удаляет запись мягко в СВОЁМ срезе (Booking.deletedAt в ядре, только для чтения нам) и не
 * знает о paidBookingIds лояльности (чужой срез); окно записи не даёт хука «перед удалением» (см.
 * qa/requests/loyalty.md). Поэтому откат делаем лениво здесь, при следующем чтении своих данных, —
 * читает core.bookings (это автоматически подписывает запрос на её изменения через readTracker, поэтому
 * paidQ/списки обновляются реактивно в той же сессии сразу после удаления, без перезагрузки), пропускает
 * визиты моложе окна отмены «Вернуть», и один раз возвращает списанное, снимая визит из paidBookingIds.
 */
function reconcileDeletedBookingPayments(businessId: Id): void {
  const core = readCore();
  const nowMs = portNowDate().getTime();
  const toReverse = readArea(AREA).paidBookingIds.filter((id) => {
    const booking = core.bookings.find((b) => b.id === id && b.businessId === businessId);
    if (!booking?.deletedAt) return false;
    return nowMs - new Date(booking.deletedAt).getTime() >= DELETE_UNDO_GRACE_MS;
  });
  if (toReverse.length === 0) return;
  mutateArea(AREA, (s) => {
    for (const bookingId of toReverse) {
      if (s.paidBookingIds.includes(bookingId)) reverseLoyaltyPaymentLines(s, businessId, bookingId, true);
    }
  });
}

// ─────────────────────────── Типы карт (F-06-020) ───────────────────────────

export interface CardTypeRow extends CardType {
  issuedCount: number;
}

export function listCardTypes(businessId: Id): Promise<CardTypeRow[]> {
  return request(() => {
    const state = readArea(AREA);
    return state.cardTypes
      .filter((t) => t.businessId === businessId)
      .map((t) => ({
        ...t,
        issuedCount: state.cards.filter((c) => c.cardTypeId === t.id).length,
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });
}

export function getCardType(businessId: Id, typeId: Id): Promise<CardType> {
  return request(() => {
    const type = readArea(AREA).cardTypes.find((t) => t.id === typeId && t.businessId === businessId);
    if (!type) throw new ApiError('not_found');
    return type;
  });
}

export interface CardTypeInput {
  name: string;
  locationIds: Id[];
  sourceScope: CardType['sourceScope'];
  autoIssueMode: CardType['autoIssueMode'];
  burnDays?: number;
  serviceLimitMode: CardType['serviceLimitMode'];
  serviceLimitScope?: ServiceScope;
  productLimitMode: CardType['productLimitMode'];
  paymentLimitFixed: number;
  paymentLimitPercent: number;
  cashbackVisibleInApp: boolean;
  /** Л16 */
  birthdayBonus?: number;
  /** F-06-029 — тексты уведомлений (пачка b03) */
  notify?: CardType['notify'];
}

/** F-06-021: создание типа карты — обязательно только название (❓ обязательность прочих полей не отмечена в ТЗ) */
export function createCardType(businessId: Id, input: CardTypeInput): Promise<CardType> {
  return request(() => {
    if (!input.name.trim()) throw new ApiError('validation');
    const type: CardType = {
      id: newId('lct'),
      businessId,
      ...input,
      name: input.name.trim(),
      createdAt: nowDateTime(),
    };
    mutateArea(AREA, (s) => {
      s.cardTypes.push(type);
    });
    return type;
  });
}

/** F-06-030: правка типа — те же поля, что при создании */
export function updateCardType(businessId: Id, typeId: Id, input: CardTypeInput): Promise<CardType> {
  return request(() => {
    if (!input.name.trim()) throw new ApiError('validation');
    let updated: CardType | undefined;
    mutateArea(AREA, (s) => {
      const type = s.cardTypes.find((t) => t.id === typeId && t.businessId === businessId);
      if (!type) throw new ApiError('not_found');
      Object.assign(type, input, {
        name: input.name.trim(),
        updatedAt: nowDateTime(),
      });
      updated = type;
    });
    if (!updated) throw new ApiError('not_found');
    return updated;
  });
}

/**
 * F-06-030/questions-q4 В-40: «Удалить» доступно только для типа БЕЗ выданных карт — иначе `validation`
 * (экран показывает подсказку вместо кнопки и предлагает архив). Акции, ссылавшиеся на тип, остаются —
 * просто теряют этот cardTypeId, чтобы форма акции не падала на несуществующей ссылке.
 */
export function deleteCardType(businessId: Id, typeId: Id): Promise<void> {
  return request(() => {
    mutateArea(AREA, (s) => {
      const exists = s.cardTypes.some((t) => t.id === typeId && t.businessId === businessId);
      if (!exists) throw new ApiError('not_found');
      const issued = s.cards.some((c) => c.cardTypeId === typeId);
      if (issued) throw new ApiError('validation');
      s.cardTypes = s.cardTypes.filter((t) => t.id !== typeId);
      s.promotions = s.promotions.map((p) => ({
        ...p,
        cardTypeIds: p.cardTypeIds.filter((id) => id !== typeId),
      }));
    });
  });
}

/**
 * F-06-030/questions-q4 В-40: архивный тип не выдаётся и не продаётся, уже выданные карты работают до
 * конца срока; «Вернуть из архива» снимает флаг.
 */
export function setCardTypeArchived(businessId: Id, typeId: Id, archived: boolean): Promise<CardType> {
  return request(() => {
    let updated: CardType | undefined;
    mutateArea(AREA, (s) => {
      const type = s.cardTypes.find((t) => t.id === typeId && t.businessId === businessId);
      if (!type) throw new ApiError('not_found');
      type.archived = archived;
      type.updatedAt = nowDateTime();
      updated = type;
    });
    if (!updated) throw new ApiError('not_found');
    return updated;
  });
}

/**
 * F-06-048: «Продано» (сумма визитов по прайсу, без скидок) и «Оплачено» (то же за вычетом скидок и
 * списаний программы) для держателя карты, в локациях, где действует карта (F-06-023). Источник —
 * завершённые визиты ядра (status: 'arrived') и собственные транзакции скидок/бонусов раздела.
 */
export interface SoldPaid {
  sold: number;
  paid: number;
  /** F-06-053: число визитов держателя карты (только «Клиент пришёл») */
  visits: number;
  /** F-06-053/070: сумма бонусов, начисленных по программам лояльности («Кэшбэк (i)») — плитка на карте */
  cashback: number;
}

export function getCardSoldPaid(businessId: Id, cardId: Id): Promise<SoldPaid> {
  return request(() => {
    const core = readCore();
    const state = readArea(AREA);
    const card = state.cards.find((c) => c.id === cardId && c.businessId === businessId);
    if (!card) throw new ApiError('not_found');
    const type = state.cardTypes.find((t) => t.id === card.cardTypeId);
    const locationIds = new Set(type?.locationIds.length ? type.locationIds : core.locations.filter((l) => l.businessId === businessId).map((l) => l.id));
    const visitBookings = core.bookings.filter((b) => b.clientId === card.clientId && b.status === 'arrived' && locationIds.has(b.locationId));
    const sold = visitBookings.reduce((sum, b) => sum + b.total, 0);
    const discounts = state.transactions.filter((tx) => tx.cardId === cardId && (tx.type === 'promoDiscount' || tx.type === 'cardCharge')).reduce((sum, tx) => sum + Math.abs(tx.amount), 0);
    const cashback = state.transactions.filter((tx) => tx.cardId === cardId && tx.type === 'loyaltyAccrual').reduce((sum, tx) => sum + tx.amount, 0);
    return {
      sold,
      paid: Math.max(0, sold - discounts),
      visits: visitBookings.length,
      cashback,
    };
  });
}

/** F-06-052: 16 случайных цифр — начало пробуем сделать похожим на номер сети (первые ~7 цифр businessId-хеша), остальное случайно */
function genCardNumberSeed(businessId: Id): string {
  let h = 0;
  for (let i = 0; i < businessId.length; i++) h = (h * 31 + businessId.charCodeAt(i)) >>> 0;
  const prefix = String(h).padStart(7, '0').slice(0, 7);
  const rest = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10)).join('');
  return `${prefix}${rest}`;
}

/** F-06-052: пустой номер — генерируем уникальный; заполненный — проверяем, что такого ещё нет у бизнеса */
function resolveCardNumber(businessId: Id, cards: LoyaltyCard[], requested: string | undefined): string {
  const trimmed = requested?.trim();
  if (trimmed) {
    if (cards.some((c) => c.businessId === businessId && c.number === trimmed)) {
      throw new ApiError('validation');
    }
    return trimmed;
  }
  let candidate = genCardNumberSeed(businessId);
  while (cards.some((c) => c.number === candidate)) candidate = genCardNumberSeed(businessId);
  return candidate;
}

/** Макс. % и фикс. скидка карты — наибольшие среди акций, привязанных к её типу (для плиток F-06-053) */
function cardCaps(promotions: Promotion[], cardTypeId: Id): { maxPercentDiscount?: number; maxFixedDiscount?: number } {
  // Л12: «Макс. % скидки» — только по СКИДОЧНЫМ акциям типа карты; процент кэшбэка — не скидка. Для порогов —
  // самая высокая ступень. Считается при чтении, а не хранится с выдачи: правка акции видна сразу.
  const relevant = promotions.filter((p) => p.cardTypeIds.includes(cardTypeId) && isDiscountKind(p.kind)).map((p) => (p.thresholds?.length ? { ...p, value: Math.max(...p.thresholds.map((th) => th.value)) } : p));
  const percentValues = relevant.filter((p) => p.valueType === 'percent').map((p) => p.value);
  const fixedValues = relevant.filter((p) => p.valueType === 'fixed').map((p) => p.value);
  return {
    maxPercentDiscount: percentValues.length ? Math.max(...percentValues) : undefined,
    maxFixedDiscount: fixedValues.length ? Math.max(...fixedValues) : undefined,
  };
}

/**
 * F-06-051/F-06-052: выдача карты клиенту — из карточки клиента, окна записи или приложения. Номер —
 * ручной (после проверки уникальности) или сгенерированный. Клиенту можно выдать несколько карт разных типов
 * (добавлено проверкой 1); список типов на форме отфильтровывает уже выданные — сама фильтрация в UI.
 */
export function issueCard(businessId: Id, clientId: Id, cardTypeId: Id, number?: string): Promise<LoyaltyCard> {
  return request(() => {
    let created: LoyaltyCard | undefined;
    mutateArea(AREA, (s) => {
      const type = s.cardTypes.find((t) => t.id === cardTypeId && t.businessId === businessId);
      if (!type) throw new ApiError('not_found');
      // questions-q4 В-40: архивный тип карты больше не выдаётся
      if (type.archived) throw new ApiError('validation');
      const resolvedNumber = resolveCardNumber(businessId, s.cards, number);
      const caps = cardCaps(s.promotions, cardTypeId);
      const card: LoyaltyCard = {
        id: newId('lc'),
        businessId,
        cardTypeId,
        clientId,
        number: resolvedNumber,
        balance: 0,
        ...caps,
        createdAt: nowDateTime(),
      };
      s.cards.push(card);
      created = card;
    });
    return created!;
  });
}

/** F-06-056: снимает карту с клиента — подтверждение спрашивает UI; история транзакций остаётся (❓ судьба бонусов не описана в ТЗ) */
export function deleteCard(businessId: Id, cardId: Id): Promise<void> {
  return request(() => {
    mutateArea(AREA, (s) => {
      const exists = s.cards.some((c) => c.id === cardId && c.businessId === businessId);
      if (!exists) throw new ApiError('not_found');
      s.cards = s.cards.filter((c) => c.id !== cardId);
    });
  });
}

/** F-06-055: ручное начисление (amount > 0) или списание (amount < 0) бонусов на карту; создаёт запись в транзакциях */
export function adjustCardBalance(businessId: Id, cardId: Id, locationId: Id, amount: number): Promise<LoyaltyCard> {
  return request(() => {
    if (!amount) throw new ApiError('validation');
    let updated: LoyaltyCard | undefined;
    mutateArea(AREA, (s) => {
      const card = s.cards.find((c) => c.id === cardId && c.businessId === businessId);
      if (!card) throw new ApiError('not_found');
      card.balance = Math.max(0, card.balance + amount);
      s.transactions.push({
        id: newId('ltx'),
        businessId,
        locationId,
        type: amount > 0 ? 'manualTopup' : 'manualCharge',
        clientId: card.clientId,
        cardId: card.id,
        amount,
        createdAt: nowDateTime(),
      });
      updated = card;
    });
    return updated!;
  });
}

// ─────────────────────────── Акции (F-06-031) ───────────────────────────

export function listPromotions(businessId: Id): Promise<Promotion[]> {
  return request(() =>
    readArea(AREA)
      .promotions.filter((p) => p.businessId === businessId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  );
}

/**
 * F-06-172 «Отчёт «Акции»»: эффективность каждой акции за период — сколько раз применена
 * (транзакции с этим `promotionId`), скольким уникальным клиентам, на какую сумму скидки/бонуса и
 * оборот визитов, к которым применение привязано (по `bookingId`). Источник — те же транзакции, что
 * и «Журнал операций» (F-06-070) — отчёт лишь группирует их по акции, ничего не считает заново.
 */
export interface PromotionReportRow {
  promotionId: Id;
  promotionName: string;
  kind: PromotionKind;
  applyCount: number;
  uniqueClients: number;
  discountSum: number;
  accrualSum: number;
  turnover: number;
}

export function getPromotionsReport(businessId: Id, range?: { dateFrom?: string; dateTo?: string }): Promise<PromotionReportRow[]> {
  return request(() => {
    const core = readCore();
    const state = readArea(AREA);
    let txs = state.transactions.filter((tx) => tx.businessId === businessId && tx.promotionId);
    if (range?.dateFrom) txs = txs.filter((tx) => tx.createdAt >= range.dateFrom!);
    if (range?.dateTo) txs = txs.filter((tx) => tx.createdAt <= `${range.dateTo}T23:59:59`);
    const byPromo = new Map<Id, LoyaltyTransaction[]>();
    for (const tx of txs) {
      const list = byPromo.get(tx.promotionId!) ?? [];
      list.push(tx);
      byPromo.set(tx.promotionId!, list);
    }
    return state.promotions
      .filter((p) => p.businessId === businessId)
      .map((promo) => {
        const list = byPromo.get(promo.id) ?? [];
        const clients = new Set(list.map((tx) => tx.clientId));
        const bookingIds = new Set(list.map((tx) => tx.bookingId).filter((id): id is Id => Boolean(id)));
        const turnover = core.bookings.filter((b) => bookingIds.has(b.id)).reduce((sum, b) => sum + b.total, 0);
        return {
          promotionId: promo.id,
          promotionName: promo.name,
          kind: promo.kind,
          applyCount: list.length,
          uniqueClients: clients.size,
          discountSum: list.filter((tx) => tx.type === 'promoDiscount' || tx.type === 'cardCharge').reduce((sum, tx) => sum + Math.abs(tx.amount), 0),
          accrualSum: list.filter((tx) => tx.type === 'loyaltyAccrual').reduce((sum, tx) => sum + tx.amount, 0),
          turnover,
        };
      })
      .sort((a, b) => b.applyCount - a.applyCount);
  });
}

// ─────────────────────────── F-06-005: выбор услуг для программ ───────────────────────────

export interface ServiceScopeCategory {
  id: Id;
  name: string;
  serviceIds: Id[];
}

export interface ServiceScopeService {
  id: Id;
  name: string;
  categoryId: Id;
}

export interface ServiceScopeOptions {
  categories: ServiceScopeCategory[];
  services: ServiceScopeService[];
}

/**
 * F-06-005: весь каталог услуг владельца, доступный программам лояльности. По решению F-00-049 миграции
 * в сеть нет — у бизнеса с одним адресом услуги уже «общие», у владельца с филиалами это общий каталог
 * услуг владельца, поэтому здесь просто читаем core.services/core.serviceCategories по businessId, без
 * отдельного шага «перенести в сеть».
 */
export function listServiceScopeOptions(businessId: Id, locale = 'ru'): Promise<ServiceScopeOptions> {
  return request(() => {
    const core = readCore();
    const services = core.services.filter((s) => s.businessId === businessId && s.active);
    const categories = core.serviceCategories
      .filter((c) => c.businessId === businessId && services.some((s) => s.categoryId === c.id))
      .map((c) => ({
        id: c.id,
        name: c.name[locale as 'ru'] ?? c.name.ru ?? '',
        serviceIds: services.filter((s) => s.categoryId === c.id).map((s) => s.id),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      categories,
      services: services
        .map((s) => ({
          id: s.id,
          name: s.name[locale as 'ru'] ?? s.name.ru ?? '',
          categoryId: s.categoryId,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  });
}

export interface PromotionInput {
  name: string;
  kind: PromotionKind;
  cardTypeIds: Id[];
  valueType: Promotion['valueType'];
  value: number;
  thresholds?: Promotion['thresholds'];
  conditionCount?: number;
  conditionServiceIds?: Id[];
  sourceScope?: Promotion['sourceScope'];
  historyStartDate?: string;
  sumBasis?: Promotion['sumBasis'];
  applyFrequency?: number;
  applyLimit?: number;
  cancelAfterDays?: number;
  burnAfterDays?: number;
  notifyEnabled?: boolean;
  /** F-06-049 — тексты уведомлений (пачка b03) */
  notify?: Promotion['notify'];
  locationIds?: Id[];
  serviceScope?: ServiceScope;
  productLimitMode?: Promotion['productLimitMode'];
  /** F-06-183 */
  schedule?: Promotion['schedule'];
  /** F-06-183 — период действия акции (ISODate, включительно); без значения — бессрочно с этой стороны */
  validFrom?: Promotion['validFrom'];
  validTo?: Promotion['validTo'];
}

/** Обратная совместимость с пачкой b01 (модалка PromotionFormModal) — минимальный набор полей */
export type CreatePromotionInput = PromotionInput;

/**
 * F-06-004/F-06-005/F-06-082: создать акцию — минимум название; реферальную бонусную акцию нельзя
 * привязывать к типу карты (шаг 5 предупреждает в форме — здесь только предохранитель на случай, если
 * привязка всё же пришла: сохраняем без карт вместо ошибки, чтобы не потерять остальной ввод).
 */
export function createPromotion(businessId: Id, input: PromotionInput): Promise<Promotion> {
  return request(() => {
    // Л3: та же проверка, что в мастере и форме правки — прямой вызов api её не обходит
    if (Object.keys(validatePromotion(input)).length > 0) throw new ApiError('validation');
    const promo: Promotion = {
      id: newId('promo'),
      businessId,
      name: input.name.trim(),
      kind: input.kind,
      cardTypeIds: input.cardTypeIds,
      valueType: input.valueType,
      value: input.value,
      thresholds: input.thresholds,
      conditionCount: input.conditionCount,
      conditionServiceIds: input.conditionServiceIds,
      sourceScope: input.sourceScope,
      historyStartDate: input.historyStartDate,
      sumBasis: input.sumBasis,
      applyFrequency: input.applyFrequency,
      applyLimit: input.applyLimit,
      cancelAfterDays: input.cancelAfterDays,
      burnAfterDays: input.burnAfterDays,
      notifyEnabled: input.notifyEnabled,
      notify: input.notify,
      locationIds: input.locationIds,
      serviceScope: input.serviceScope,
      productLimitMode: input.productLimitMode,
      schedule: input.schedule,
      validFrom: input.validFrom,
      validTo: input.validTo,
      createdAt: nowDateTime(),
    };
    mutateArea(AREA, (s) => {
      s.promotions.push(promo);
    });
    return promo;
  });
}

export function getPromotion(businessId: Id, promotionId: Id): Promise<Promotion> {
  return request(() => {
    const promo = readArea(AREA).promotions.find((p) => p.id === promotionId && p.businessId === businessId);
    if (!promo) throw new ApiError('not_found');
    return promo;
  });
}

/** F-06-050: правка акции — теми же полями мастера */
export function updatePromotion(businessId: Id, promotionId: Id, input: PromotionInput): Promise<Promotion> {
  return request(() => {
    if (Object.keys(validatePromotion(input)).length > 0) throw new ApiError('validation');
    let updated: Promotion | undefined;
    mutateArea(AREA, (s) => {
      const promo = s.promotions.find((p) => p.id === promotionId && p.businessId === businessId);
      if (!promo) throw new ApiError('not_found');
      Object.assign(promo, input, {
        name: input.name.trim(),
        updatedAt: nowDateTime(),
      });
      updated = promo;
    });
    if (!updated) throw new ApiError('not_found');
    return updated;
  });
}

/** F-06-050: удаление акции — начисленное по ней (карты, транзакции) остаётся как есть */
export function deletePromotion(businessId: Id, promotionId: Id): Promise<void> {
  return request(() => {
    mutateArea(AREA, (s) => {
      const exists = s.promotions.some((p) => p.id === promotionId && p.businessId === businessId);
      if (!exists) throw new ApiError('not_found');
      s.promotions = s.promotions.filter((p) => p.id !== promotionId);
    });
  });
}

// ─────────────────────────── Карты лояльности сети (F-06-058, F-06-059) ───────────────────────────

export interface LoyaltyCardRow extends LoyaltyCard {
  cardTypeName: string;
  clientPhone: string;
  clientName: string;
  /** Л16: когда бонусы сгорят, если клиент не придёт; нет — не сгорают */
  burnsAt?: string;
}

export interface CardsFilter {
  cardTypeId?: Id;
  phone?: string;
  /** F-06-053/F-06-060: карты конкретного клиента (вкладка «Лояльность» в его карточке) */
  clientId?: Id;
}

export function listCards(businessId: Id, filter: CardsFilter = {}): Promise<LoyaltyCardRow[]> {
  return request(() => {
    reconcileDeletedBookingPayments(businessId);
    reconcileBirthdayBonus(businessId);
    reconcileBonusBurn(businessId);
    const core = readCore();
    const state = readArea(AREA);
    const typesById = new Map(state.cardTypes.map((t) => [t.id, t]));
    let rows = state.cards.filter((c) => c.businessId === businessId);
    if (filter.clientId) rows = rows.filter((c) => c.clientId === filter.clientId);
    if (filter.cardTypeId) rows = rows.filter((c) => c.cardTypeId === filter.cardTypeId);
    if (filter.phone?.trim()) {
      // F-06-058: плейсхолдер обещает поиск «Телефон или номер карты» — раньше фильтр смотрел только
      // на телефон клиента, и ввод настоящего номера карты давал ложное «Ничего не нашли».
      const raw = filter.phone.trim();
      const qDigits = raw.replace(/\D/g, '');
      const qLower = raw.toLowerCase();
      rows = rows.filter((c) => {
        const client = clientOf(core, c.clientId);
        const phoneMatch = qDigits ? Boolean(client?.phone.replace(/\D/g, '').includes(qDigits)) : false;
        const numberMatch = c.number.toLowerCase().includes(qLower);
        return phoneMatch || numberMatch;
      });
    }
    return rows
      .map((c) => {
        const client = clientOf(core, c.clientId);
        return {
          ...c,
          ...cardCaps(state.promotions, c.cardTypeId),
          burnsAt: cardBurnsAt(core, state, c),
          cardTypeName: typesById.get(c.cardTypeId)?.name ?? '',
          clientPhone: client?.phone ?? '',
          clientName: client?.name ?? '',
        };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });
}

export interface LoyaltyCardDetail extends LoyaltyCardRow {
  cardType?: CardType;
  promotions: Promotion[];
  transactions: LoyaltyTransaction[];
}

export function getCard(businessId: Id, cardId: Id): Promise<LoyaltyCardDetail> {
  return request(() => {
    const core = readCore();
    const state = readArea(AREA);
    const card = state.cards.find((c) => c.id === cardId && c.businessId === businessId);
    if (!card) throw new ApiError('not_found');
    const cardType = state.cardTypes.find((t) => t.id === card.cardTypeId);
    const client = clientOf(core, card.clientId);
    return {
      ...card,
      ...cardCaps(state.promotions, card.cardTypeId),
      burnsAt: cardBurnsAt(core, state, card),
      cardTypeName: cardType?.name ?? '',
      clientPhone: client?.phone ?? '',
      clientName: client?.name ?? '',
      cardType,
      promotions: state.promotions.filter((p) => p.cardTypeIds.includes(card.cardTypeId)),
      transactions: state.transactions.filter((t) => t.cardId === cardId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    };
  });
}

// ─────────────────────────── Блок «Лояльность» в окне записи (F-06-061, F-06-070, F-06-193) ───────────────────────────

export interface LoyaltyBookingSummaryCard {
  id: Id;
  number: string;
  cardTypeName: string;
  balance: number;
  maxPercentDiscount?: number;
  /** Л16: день, когда бонусы сгорят, если клиент не придёт; нет — не сгорают */
  burnsAt?: string;
}

export interface LoyaltyBookingSummaryCertificate {
  id: Id;
  code: string;
  typeName: string;
  balance: number;
  /** F-06-088/Л8: однократный — остаток сгорит после первой оплаты */
  single: boolean;
  /** F-06-090: сколько этого визита сертификат может закрыть (Infinity — услуги визита не переданы) */
  coverAmount: number;
}

export interface LoyaltyBookingSummaryMembership {
  id: Id;
  typeName: string;
  balanceVisits: number;
  totalVisits: number;
  /** F-06-066: применим ли к услугам визита (раздельный баланс — только к своим строкам; общий — всегда) */
  applicable: boolean;
  /** F-06-066/107: сколько этого визита абонемент закрывает (Infinity — услуги визита не переданы) */
  coverAmount: number;
}

export interface LoyaltyBookingSummary {
  cards: LoyaltyBookingSummaryCard[];
  certificates: LoyaltyBookingSummaryCertificate[];
  memberships: LoyaltyBookingSummaryMembership[];
}

export interface LoyaltyHubTileOverview {
  /** Есть хотя бы один тип — иначе нечего продавать/выдавать, хаб зовёт «Настроить» */
  hasTypes: boolean;
  count: number;
  /** Суммарная стоимость — нет у карт (это скидочный инструмент, не товар с ценой) */
  sum?: number;
}

export interface LoyaltyHubOverview {
  cards: LoyaltyHubTileOverview;
  certificates: LoyaltyHubTileOverview;
  memberships: LoyaltyHubTileOverview;
  deposits: LoyaltyHubTileOverview;
}

/**
 * F-06-001 (ux-best-c1 №1, ux-best-c3 №1): хаб раньше показывал одно и то же «Настроить» у каждого
 * блока, даже если он уже работает — владелец не видел, что уже продано 6 сертификатов и есть акция.
 * Отдельный лёгкий запрос (не тянет полные списки), только счётчики для плиток хаба.
 */
export function getLoyaltyHubOverview(businessId: Id): Promise<LoyaltyHubOverview> {
  return request(() => {
    const state = readArea(AREA);
    function own<T extends { businessId: Id }>(arr: T[]): T[] {
      return arr.filter((x) => x.businessId === businessId);
    }
    const cards = own(state.cards);
    const certs = own(state.certificates);
    const memberships = own(state.memberships);
    const accounts = own(state.accounts);
    return {
      cards: { hasTypes: own(state.cardTypes).length > 0, count: cards.length },
      certificates: { hasTypes: own(state.certificateTypes).length > 0, count: certs.length, sum: certs.reduce((s, c) => s + c.nominal, 0) },
      memberships: { hasTypes: own(state.membershipTypes).length > 0, count: memberships.length, sum: memberships.reduce((s, m) => s + m.price, 0) },
      deposits: { hasTypes: own(state.accountTypes).length > 0, count: accounts.length, sum: accounts.reduce((s, a) => s + a.balance, 0) },
    };
  });
}

/**
 * F-06-061/F-06-193: чем клиент (владелец номера — лояльность посетителя всегда берётся из блока
 * клиента, F-06-193) может заплатить — карты, активные сертификаты и абонементы с балансами.
 * F-06-066: serviceIds — услуги визита, чтобы отметить абонементы с раздельным балансом, не подходящие
 * к этому визиту (общий баланс подходит всегда); без serviceIds (черновик ещё без услуг) — все применимы.
 */
export function getLoyaltyBookingSummary(businessId: Id, clientId: Id, visitOrServiceIds: Id[] | LoyaltyVisit = [], todayIso = todayISO()): Promise<LoyaltyBookingSummary> {
  return request(() => {
    reconcileDeletedBookingPayments(businessId);
    reconcileFrozenMemberships(businessId);
    reconcileBirthdayBonus(businessId);
    reconcileBonusBurn(businessId);
    const core = readCore();
    const state = readArea(AREA);
    const serviceIds = Array.isArray(visitOrServiceIds) ? visitOrServiceIds : visitOrServiceIds.lines.map((l) => l.serviceId);
    const visit = Array.isArray(visitOrServiceIds) ? undefined : visitOrServiceIds;
    const cardTypeById = new Map(state.cardTypes.map((t) => [t.id, t]));
    const certTypeById = new Map(state.certificateTypes.map((t) => [t.id, t]));
    const membershipTypeById = new Map(state.membershipTypes.map((t) => [t.id, t]));
    return {
      cards: state.cards
        .filter((c) => c.businessId === businessId && c.clientId === clientId)
        .map((c) => ({
          id: c.id,
          number: c.number,
          cardTypeName: cardTypeById.get(c.cardTypeId)?.name ?? '',
          balance: c.balance,
          maxPercentDiscount: cardCaps(state.promotions, c.cardTypeId).maxPercentDiscount,
          burnsAt: cardBurnsAt(core, state, c),
        })),
      certificates: state.certificates
        .filter((c) => c.businessId === businessId && c.clientId === clientId && c.status === 'active' && c.balance > 0 && !isCertificateExpired(c.expiresAt, todayIso))
        .map((c) => ({
          id: c.id,
          code: c.code,
          typeName: certTypeById.get(c.certTypeId)?.name ?? '',
          balance: c.balance,
          single: certTypeById.get(c.certTypeId)?.chargeType === 'single',
          coverAmount: certificateCover(core, state, c, visit),
        })),
      memberships: state.memberships
        .filter((m) => m.businessId === businessId && m.clientId === clientId && ['active', 'issued'].includes(membershipStatus(m, todayIso)))
        .map((m) => {
          const type = membershipTypeById.get(m.membershipTypeId);
          const cover = membershipCover(core, state, m, visit);
          const applicable = visit ? cover > 0 : !type || serviceIds.length === 0 || type.balanceMode === 'shared' ? true : type.services.some((line) => line.serviceId && serviceIds.includes(line.serviceId));
          return {
            id: m.id,
            typeName: type?.name ?? '',
            balanceVisits: m.balanceVisits,
            totalVisits: m.totalVisits,
            applicable,
            coverAmount: cover,
          };
        }),
    };
  });
}

// ─────────────────────────── Транзакции (F-06-076, F-06-077, F-06-085) ───────────────────────────

export interface LoyaltyTransactionRow extends LoyaltyTransaction {
  clientName: string;
  clientPhone: string;
  promotionName?: string;
  locationName: string;
  cardNumber?: string;
}

export interface TransactionsFilter {
  type?: LoyaltyTxType;
  promotionId?: Id;
  locationId?: Id;
  dateFrom?: string;
  dateTo?: string;
}

export function listTransactions(businessId: Id, filter: TransactionsFilter = {}, locale = 'ru'): Promise<LoyaltyTransactionRow[]> {
  return request(() => {
    reconcileDeletedBookingPayments(businessId);
    const core = readCore();
    const state = readArea(AREA);
    const promosById = new Map(state.promotions.map((p) => [p.id, p]));
    const cardsById = new Map(state.cards.map((c) => [c.id, c]));
    let rows = state.transactions.filter((tx) => tx.businessId === businessId);
    if (filter.type) rows = rows.filter((tx) => tx.type === filter.type);
    if (filter.promotionId) rows = rows.filter((tx) => tx.promotionId === filter.promotionId);
    if (filter.locationId) rows = rows.filter((tx) => tx.locationId === filter.locationId);
    if (filter.dateFrom) rows = rows.filter((tx) => tx.createdAt >= filter.dateFrom!);
    if (filter.dateTo) rows = rows.filter((tx) => tx.createdAt <= `${filter.dateTo}T23:59:59`);
    return rows
      .map((tx) => {
        const client = clientOf(core, tx.clientId);
        return {
          ...tx,
          clientName: client?.name ?? '',
          clientPhone: client?.phone ?? '',
          promotionName: tx.promotionId ? promosById.get(tx.promotionId)?.name : undefined,
          locationName: locationNameOf(core, tx.locationId, locale),
          cardNumber: tx.cardId ? cardsById.get(tx.cardId)?.number : undefined,
        };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });
}

// ─────────────────────────── Автоприменение (F-06-078…080) ───────────────────────────

function defaultAutoApply(businessId: Id): AutoApplySettings {
  return {
    businessId,
    enabled: false,
    online: { when: 'firstOnly', scope: 'any' },
    journal: { when: 'firstOnly' },
  };
}

export function getAutoApply(businessId: Id): Promise<AutoApplySettings> {
  return request(() => readArea(AREA).autoApply[businessId] ?? defaultAutoApply(businessId));
}

export function setAutoApply(businessId: Id, settings: AutoApplySettings): Promise<AutoApplySettings> {
  return request(() => {
    mutateArea(AREA, (s) => {
      s.autoApply[businessId] = settings;
    });
    return settings;
  });
}

// ─────────────────────────── Уведомления о персональной скидке (F-06-015/016/017) ───────────────────────────

export function getDiscountNotify(businessId: Id): Promise<DiscountNotifySettings> {
  return request(() => readArea(AREA).discountNotify[businessId] ?? defaultDiscountNotify());
}

export function setDiscountNotify(businessId: Id, settings: DiscountNotifySettings): Promise<DiscountNotifySettings> {
  return request(() => {
    mutateArea(AREA, (s) => {
      s.discountNotify[businessId] = settings;
    });
    return settings;
  });
}

// ─────────────────────────── Реферальная программа (F-06-081) ───────────────────────────

function defaultReferral(businessId: Id): ReferralSettings {
  return { businessId, active: false };
}

export function getReferralSettings(businessId: Id): Promise<ReferralSettings> {
  return request(() => readArea(AREA).referral[businessId] ?? defaultReferral(businessId));
}

export function setReferralSettings(businessId: Id, settings: ReferralSettings): Promise<ReferralSettings> {
  return request(() => {
    // Л11: включённая программа обязана знать и скидку приглашённому, и бонус пригласившему
    if (settings.active && (!settings.inviteePromotionId || !settings.referrerPromotionId)) throw new ApiError('validation');
    mutateArea(AREA, (s) => {
      s.referral[businessId] = settings;
    });
    return settings;
  });
}

// ─────────────────────────── Сертификаты (F-06-086, F-06-100, F-06-188, F-06-195) ───────────────────────────

export interface CertificateTypeRow extends CertificateType {
  soldCount: number;
}

export function listCertificateTypes(businessId: Id): Promise<CertificateTypeRow[]> {
  return request(() => {
    const state = readArea(AREA);
    return state.certificateTypes
      .filter((t) => t.businessId === businessId)
      .map((t) => ({
        ...t,
        soldCount: state.certificates.filter((c) => c.certTypeId === t.id).length,
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });
}

export function getCertificateType(businessId: Id, typeId: Id): Promise<CertificateType> {
  return request(() => {
    const type = readArea(AREA).certificateTypes.find((t) => t.id === typeId && t.businessId === businessId);
    if (!type) throw new ApiError('not_found');
    return type;
  });
}

export interface CertificateTypeInput {
  name: string;
  nominal: number;
  chargeType: CertificateType['chargeType'];
  category: CertificateType['category'];
  applyServicesMode: CertificateType['applyServicesMode'];
  applyServiceScope?: ServiceScope;
  applyProductsAllowed: boolean;
  expiryMode: CertificateType['expiryMode'];
  expiryDate?: string;
  expiryPeriodValue?: number;
  expiryPeriodUnit?: CertificateType['expiryPeriodUnit'];
  allowNoCode: boolean;
  editLocationsMode: CertificateType['editLocationsMode'];
  onlineSale: CertificateType['onlineSale'];
  locationIds: Id[];
}

/** F-06-087: создание типа сертификата — обязательно название (❓ обязательность прочих не отмечена в ТЗ, как у типа карты в b02) */
export function createCertificateType(businessId: Id, input: CertificateTypeInput): Promise<CertificateType> {
  return request(() => {
    if (!input.name.trim()) throw new ApiError('validation');
    const type: CertificateType = {
      id: newId('lctt'),
      businessId,
      ...input,
      name: input.name.trim(),
      createdAt: nowDateTime(),
    };
    mutateArea(AREA, (s) => {
      s.certificateTypes.push(type);
    });
    return type;
  });
}

export function updateCertificateType(businessId: Id, typeId: Id, input: CertificateTypeInput): Promise<CertificateType> {
  return request(() => {
    if (!input.name.trim()) throw new ApiError('validation');
    let updated: CertificateType | undefined;
    mutateArea(AREA, (s) => {
      const type = s.certificateTypes.find((t) => t.id === typeId && t.businessId === businessId);
      if (!type) throw new ApiError('not_found');
      Object.assign(type, input, {
        name: input.name.trim(),
        updatedAt: nowDateTime(),
      });
      updated = type;
    });
    if (!updated) throw new ApiError('not_found');
    return updated;
  });
}

/** Удаление типа сертификата — проданные экземпляры остаются (историю не трогаем) */
export function deleteCertificateType(businessId: Id, typeId: Id): Promise<void> {
  return request(() => {
    mutateArea(AREA, (s) => {
      const exists = s.certificateTypes.some((t) => t.id === typeId && t.businessId === businessId);
      if (!exists) throw new ApiError('not_found');
      s.certificateTypes = s.certificateTypes.filter((t) => t.id !== typeId);
    });
  });
}

export interface CertificateRow extends Certificate {
  typeName: string;
  clientName: string;
  clientPhone: string;
  /** Место продажи (F-06-100) */
  locationName: string;
  /**
   * F-06-100: места использования — из строк `certificateCharge` (одна на каждое списание в визите), а не
   * только `usedLocationId` (тот пишется лишь когда сертификат закрылся до нуля, F-06-098) — иначе у
   * частично использованных сертификатов колонка всегда пустая, хотя списания уже были. Пусто = ни разу
   * не списывали.
   */
  usedLocationNames: string[];
}

export interface CertificatesFilter {
  status?: CertificateStatus;
  code?: string;
  phone?: string;
  clientId?: Id;
}

/** F-06-100: места использования сертификата — из строк `certificateCharge`, в порядке первого списания */
function usedLocationsOf(state: LoyaltyArea, core: CoreData, certId: Id, locale: string): string[] {
  const ids: Id[] = [];
  for (const tx of state.transactions) {
    if (tx.certificateId === certId && tx.type === 'certificateCharge' && !ids.includes(tx.locationId)) ids.push(tx.locationId);
  }
  return ids.map((id) => locationNameOf(core, id, locale)).filter(Boolean);
}

function certificateStatus(c: Certificate, todayIso: string): CertificateStatus {
  if (c.status === 'used') return 'used';
  if (c.expiresAt && c.expiresAt < todayIso) return 'expired';
  return c.balance <= 0 ? 'used' : 'active';
}

export function listCertificates(businessId: Id, filter: CertificatesFilter = {}, locale = 'ru'): Promise<CertificateRow[]> {
  return request(() => {
    reconcileDeletedBookingPayments(businessId);
    const core = readCore();
    const state = readArea(AREA);
    const typesById = new Map(state.certificateTypes.map((t) => [t.id, t]));
    const todayIso = todayISO();
    let rows = state.certificates.filter((c) => c.businessId === businessId);
    if (filter.clientId) rows = rows.filter((c) => c.clientId === filter.clientId);
    if (filter.status) rows = rows.filter((c) => certificateStatus(c, todayIso) === filter.status);
    if (filter.code?.trim()) rows = rows.filter((c) => c.code.toLowerCase().includes(filter.code!.toLowerCase()));
    if (filter.phone?.trim()) {
      const q = filter.phone.replace(/\D/g, '');
      rows = rows.filter((c) => {
        const client = c.clientId ? clientOf(core, c.clientId) : undefined;
        return client ? client.phone.replace(/\D/g, '').includes(q) : false;
      });
    }
    return rows
      .map((c) => {
        const client = c.clientId ? clientOf(core, c.clientId) : undefined;
        return {
          ...c,
          status: certificateStatus(c, todayIso),
          typeName: typesById.get(c.certTypeId)?.name ?? '',
          clientName: client?.name ?? '',
          clientPhone: client?.phone ?? '',
          locationName: locationNameOf(core, c.locationId, locale),
          usedLocationNames: usedLocationsOf(state, core, c.id, locale),
        };
      })
      .sort((a, b) => b.soldAt.localeCompare(a.soldAt));
  });
}

export interface CertificateDetail extends CertificateRow {
  transactions: LoyaltyTransaction[];
}

export function getCertificate(businessId: Id, certId: Id, locale = 'ru'): Promise<CertificateDetail> {
  return request(() => {
    const core = readCore();
    const state = readArea(AREA);
    const cert = state.certificates.find((c) => c.id === certId && c.businessId === businessId);
    if (!cert) throw new ApiError('not_found');
    const type = state.certificateTypes.find((t) => t.id === cert.certTypeId);
    const client = cert.clientId ? clientOf(core, cert.clientId) : undefined;
    return {
      ...cert,
      status: certificateStatus(cert, todayISO()),
      typeName: type?.name ?? '',
      clientName: client?.name ?? '',
      clientPhone: client?.phone ?? '',
      locationName: locationNameOf(core, cert.locationId, locale),
      usedLocationNames: usedLocationsOf(state, core, cert.id, locale),
      transactions: state.transactions.filter((t) => t.certificateId === certId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    };
  });
}

/** F-06-188/F-06-099: правка баланса и срока проданного сертификата из сети */
/**
 * F-06-077 (recheck-c3): правка баланса сертификата раньше меняла число молча — не было ни строки в
 * «Списаниях»/«Транзакциях», ни автора, ни времени, и номинал минус списания расходился с балансом без
 * объяснения. Теперь на разницу пишется та же `manualTopup`/`manualCharge`, что уже есть у ручной правки
 * карты (`adjustCardBalance`) — использует sale-локацию сертификата, раз своей у формы нет.
 */
export function adjustCertificate(businessId: Id, certId: Id, patch: { balance?: number; expiresAt?: string; byStaffId?: Id }): Promise<Certificate> {
  return request(() => {
    let result: Certificate | undefined;
    mutateArea(AREA, (s) => {
      const cert = s.certificates.find((c) => c.id === certId && c.businessId === businessId);
      if (!cert) throw new ApiError('not_found');
      if (patch.balance !== undefined) {
        const nextBalance = Math.max(0, Math.min(cert.nominal, patch.balance));
        const diff = nextBalance - cert.balance;
        // Транзакция всегда требует владельца (F-06-098) — у именного непроданного сертификата его нет,
        // тогда просто меняем баланс без строки в журнале (нечего/некому приписать).
        if (diff !== 0 && cert.clientId) {
          s.transactions.push({
            id: newId('ltx'),
            businessId,
            locationId: cert.locationId,
            type: diff > 0 ? 'manualTopup' : 'manualCharge',
            clientId: cert.clientId,
            certificateId: cert.id,
            amount: diff,
            createdAt: nowDateTime(),
            by: patch.byStaffId,
          });
        }
        cert.balance = nextBalance;
        if (cert.balance > 0 && cert.status === 'used') cert.status = 'active';
        if (cert.balance <= 0) cert.status = 'used';
      }
      if (patch.expiresAt !== undefined) cert.expiresAt = patch.expiresAt as Certificate['expiresAt'];
      result = cert;
    });
    return result!;
  });
}

/**
 * F-06-101/102: возврат/удаление продажи сертификата, способ 1 («отменить продажу»): сертификат
 * отвязывается и больше не работает — findLoyaltyByCode его не найдёт (status='expired', balance=0),
 * а из вкладки «Лояльность» клиента он пропадёт (clientId снят). F-06-102: если сертификатом уже
 * платили за визит (есть транзакция certificateCharge) — сначала нужно отменить ту оплату
 * (reverseLoyaltyPayment на записи), иначе касса «расходится незаметно»; в остальном certificateCharge —
 * это и есть «уже была оплата» независимо от визита (продажа товара, F-06-071).
 */
export function voidCertificateSale(businessId: Id, certId: Id, byStaffId?: Id): Promise<void> {
  return request(() => {
    mutateArea(AREA, (s) => {
      const cert = s.certificates.find((c) => c.id === certId && c.businessId === businessId);
      if (!cert) throw new ApiError('not_found');
      const hasCharge = s.transactions.some((tx) => tx.certificateId === certId && tx.type === 'certificateCharge');
      if (hasCharge) throw new ApiError('has_usage');
      if (cert.clientId) {
        s.transactions.push({
          id: newId('ltx'),
          businessId,
          locationId: cert.locationId,
          type: 'certificateRefund',
          clientId: cert.clientId,
          certificateId: cert.id,
          amount: -cert.balance,
          createdAt: nowDateTime(),
          by: byStaffId,
        });
      }
      cert.balance = 0;
      cert.status = 'expired';
      cert.clientId = undefined;
    });
  });
}

/**
 * F-06-101, способ 2: возврат (частичный или полный) расходной операцией на сумму — баланс сертификата
 * обнуляется/уменьшается, сам сертификат остаётся в истории клиента с комментарием в транзакции.
 * После полного возврата (balance=0) сертификат не принимается к оплате (status='expired').
 */
export function refundCertificateAmount(businessId: Id, certId: Id, amount: number, byStaffId?: Id): Promise<Certificate> {
  return request(() => {
    if (amount <= 0) throw new ApiError('validation');
    let result: Certificate | undefined;
    mutateArea(AREA, (s) => {
      const cert = s.certificates.find((c) => c.id === certId && c.businessId === businessId);
      if (!cert) throw new ApiError('not_found');
      const charged = Math.min(cert.balance, amount);
      cert.balance -= charged;
      if (cert.balance <= 0) cert.status = 'expired';
      if (cert.clientId) {
        s.transactions.push({
          id: newId('ltx'),
          businessId,
          locationId: cert.locationId,
          type: 'certificateRefund',
          clientId: cert.clientId,
          certificateId: cert.id,
          amount: -charged,
          createdAt: nowDateTime(),
          by: byStaffId,
        });
      }
      result = cert;
    });
    return result!;
  });
}

function certificateExpiryFor(type: CertificateType, soldAt: ReturnType<typeof dayjs>): string | undefined {
  if (type.expiryMode === 'fixedDate') return type.expiryDate;
  if (type.expiryMode === 'fixedPeriod' && type.expiryPeriodValue) {
    return toISODate(soldAt.add(type.expiryPeriodValue, type.expiryPeriodUnit ?? 'month'));
  }
  return undefined;
}

export interface SellCertificateInput {
  certTypeId: Id;
  clientId?: Id;
  code?: string;
  locationId: Id;
  sellerId?: Id;
  price?: number;
  discountPercent?: number;
}

/**
 * F-06-095/F-06-197: продажа сертификата — уникальный код обязателен, кроме именного типа (F-06-092), где
 * код можно не вводить, но тогда обязателен клиент (F-06-098: без кода привязан к покупателю намертво).
 */
export function sellCertificate(businessId: Id, input: SellCertificateInput): Promise<Certificate> {
  return request(() => {
    let created: Certificate | undefined;
    mutateArea(AREA, (s) => {
      const type = s.certificateTypes.find((t) => t.id === input.certTypeId && t.businessId === businessId);
      if (!type) throw new ApiError('not_found');
      const code = input.code?.trim();
      if (!code && !type.allowNoCode) throw new ApiError('validation');
      if (!code && !input.clientId) throw new ApiError('validation');
      if (code && s.certificates.some((c) => c.businessId === businessId && c.code === code)) throw new ApiError('validation');
      const soldAt = dayjs();
      const discountPercent = input.discountPercent ?? 0;
      const soldPrice = input.price ?? Math.round((type.nominal * (100 - discountPercent)) / 100);
      const cert: Certificate = {
        id: newId('lcert'),
        businessId,
        certTypeId: input.certTypeId,
        code: code ?? '',
        nominal: type.nominal,
        balance: type.nominal,
        status: 'active',
        clientId: input.clientId,
        locationId: input.locationId,
        soldAt: toISODateTime(soldAt),
        expiresAt: certificateExpiryFor(type, soldAt),
        soldPrice,
        discountPercent,
        sellerId: input.sellerId,
      };
      s.certificates.push(cert);
      created = cert;
    });
    return created!;
  });
}

// ─────────────────────────── Абонементы (F-06-105, F-06-129, F-06-187, F-06-194) ───────────────────────────

export interface MembershipTypeRow extends MembershipType {
  soldCount: number;
}

export function listMembershipTypes(businessId: Id): Promise<MembershipTypeRow[]> {
  return request(() => {
    const state = readArea(AREA);
    return state.membershipTypes
      .filter((t) => t.businessId === businessId)
      .map((t) => ({
        ...t,
        soldCount: state.memberships.filter((m) => m.membershipTypeId === t.id).length,
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });
}

export function getMembershipType(businessId: Id, typeId: Id): Promise<MembershipType> {
  return request(() => {
    const type = readArea(AREA).membershipTypes.find((t) => t.id === typeId && t.businessId === businessId);
    if (!type) throw new ApiError('not_found');
    return type;
  });
}

export interface MembershipTypeInput {
  name: string;
  balanceMode: MembershipType['balanceMode'];
  services: MembershipType['services'];
  sharedVisits?: number;
  price: number;
  durationValue: number;
  durationUnit: MembershipType['durationUnit'];
  activationMode: MembershipType['activationMode'];
  autoActivateEnabled: boolean;
  autoActivateDays?: number;
  editLocationsMode: MembershipType['editLocationsMode'];
  freezeAllowed: boolean;
  allowNoCode: boolean;
  recalcPriceOnPay: boolean;
  renewalKind: MembershipType['renewalKind'];
  onlineSale: MembershipType['onlineSale'];
  locationIds: Id[];
  notify?: MembershipType['notify'];
}

/** F-06-106: создание типа абонемента — обязательно название */
export function createMembershipType(businessId: Id, input: MembershipTypeInput): Promise<MembershipType> {
  return request(() => {
    if (!input.name.trim()) throw new ApiError('validation');
    const type: MembershipType = {
      id: newId('lmt'),
      businessId,
      archived: false,
      ...input,
      name: input.name.trim(),
      createdAt: nowDateTime(),
    };
    mutateArea(AREA, (s) => {
      s.membershipTypes.push(type);
    });
    return type;
  });
}

/**
 * F-06-115: после первой продажи/выдачи — цена и состав услуг заблокированы (форма их не шлёт, здесь —
 * предохранитель: тихо оставляем прежними, чтобы не потерять остальную правку при случайном обходе формы).
 */
export function updateMembershipType(businessId: Id, typeId: Id, input: MembershipTypeInput): Promise<MembershipType> {
  return request(() => {
    if (!input.name.trim()) throw new ApiError('validation');
    let updated: MembershipType | undefined;
    mutateArea(AREA, (s) => {
      const type = s.membershipTypes.find((t) => t.id === typeId && t.businessId === businessId);
      if (!type) throw new ApiError('not_found');
      const sold = s.memberships.some((m) => m.membershipTypeId === typeId);
      const patch: MembershipTypeInput = sold
        ? {
            ...input,
            price: type.price,
            services: type.services,
            balanceMode: type.balanceMode,
          }
        : input;
      Object.assign(type, patch, {
        name: input.name.trim(),
        updatedAt: nowDateTime(),
      });
      updated = type;
    });
    if (!updated) throw new ApiError('not_found');
    return updated;
  });
}

/** F-06-116: снимает тип с продажи, не трогая уже проданные абонементы */
export function setMembershipTypeArchived(businessId: Id, typeId: Id, archived: boolean): Promise<MembershipType> {
  return request(() => {
    let updated: MembershipType | undefined;
    mutateArea(AREA, (s) => {
      const type = s.membershipTypes.find((t) => t.id === typeId && t.businessId === businessId);
      if (!type) throw new ApiError('not_found');
      type.archived = archived;
      type.updatedAt = nowDateTime();
      updated = type;
    });
    if (!updated) throw new ApiError('not_found');
    return updated;
  });
}

/** F-06-115: копирует тип с «(2)» в названии — копию можно редактировать полностью (ничего не продано) */
export function duplicateMembershipType(businessId: Id, typeId: Id): Promise<MembershipType> {
  return request(() => {
    const state = readArea(AREA);
    const source = state.membershipTypes.find((t) => t.id === typeId && t.businessId === businessId);
    if (!source) throw new ApiError('not_found');
    const copy: MembershipType = {
      ...source,
      id: newId('lmt'),
      name: `${source.name} (2)`,
      archived: false,
      createdAt: nowDateTime(),
      updatedAt: undefined,
    };
    mutateArea(AREA, (s) => {
      s.membershipTypes.push(copy);
    });
    return copy;
  });
}

/**
 * F-06-117: удаление без подтверждения выглядело как ошибка (ТЗ 🐞) — у нас подтверждение всегда на
 * экране (useConfirm), а тип с уже проданными абонементами не удаляем (❓ в ТЗ решение открыто) — чтобы
 * не потерять историю визитов; для таких — только архивирование.
 */
export function deleteMembershipType(businessId: Id, typeId: Id): Promise<void> {
  return request(() => {
    mutateArea(AREA, (s) => {
      const exists = s.membershipTypes.some((t) => t.id === typeId && t.businessId === businessId);
      if (!exists) throw new ApiError('not_found');
      if (s.memberships.some((m) => m.membershipTypeId === typeId)) throw new ApiError('has_sales');
      s.membershipTypes = s.membershipTypes.filter((t) => t.id !== typeId);
    });
  });
}

function membershipStatus(m: Membership, todayIso: string): MembershipStatus {
  return membershipDisplayStatus(m, todayIso as Membership['expiresAt']);
}

/**
 * Л9: заморозка кончается сама — в день frozenUntil абонемент снова активен. Лениво, при чтении своих данных
 * (как reconcileDeletedBookingPayments): пишет «Разморожен» в историю один раз.
 */
function reconcileFrozenMemberships(businessId: Id): void {
  const todayIso = todayISO();
  const due = readArea(AREA).memberships.some((m) => m.businessId === businessId && m.status === 'frozen' && m.frozenUntil && m.frozenUntil <= todayIso);
  if (!due) return;
  mutateArea(AREA, (s) => {
    for (const m of s.memberships) {
      if (m.businessId !== businessId || m.status !== 'frozen' || !m.frozenUntil || m.frozenUntil > todayIso) continue;
      m.status = 'active';
      m.freezeHistory.push({ at: `${m.frozenUntil}T00:00`, days: 0, action: 'unfreeze' });
      m.frozenUntil = undefined;
    }
  });
}

export interface MembershipRow extends Membership {
  typeName: string;
  clientName: string;
  clientPhone: string;
  locationName: string;
}

export interface MembershipsFilter {
  status?: MembershipStatus;
  phone?: string;
  membershipTypeId?: Id;
  minVisitsLeft?: number;
  expiresBefore?: string;
  clientId?: Id;
}

export function listMemberships(businessId: Id, filter: MembershipsFilter = {}, locale = 'ru'): Promise<MembershipRow[]> {
  return request(() => {
    reconcileDeletedBookingPayments(businessId);
    reconcileFrozenMemberships(businessId);
    const core = readCore();
    const state = readArea(AREA);
    const typesById = new Map(state.membershipTypes.map((t) => [t.id, t]));
    const todayIso = todayISO();
    let rows = state.memberships.filter((m) => m.businessId === businessId);
    if (filter.clientId) rows = rows.filter((m) => m.clientId === filter.clientId);
    if (filter.membershipTypeId) rows = rows.filter((m) => m.membershipTypeId === filter.membershipTypeId);
    if (filter.status) rows = rows.filter((m) => membershipStatus(m, todayIso) === filter.status);
    if (filter.minVisitsLeft !== undefined) rows = rows.filter((m) => m.balanceVisits >= filter.minVisitsLeft!);
    if (filter.expiresBefore) rows = rows.filter((m) => m.expiresAt <= filter.expiresBefore!);
    if (filter.phone?.trim()) {
      const q = filter.phone.replace(/\D/g, '');
      rows = rows.filter((m) => clientOf(core, m.clientId)?.phone.replace(/\D/g, '').includes(q));
    }
    return rows
      .map((m) => {
        const client = clientOf(core, m.clientId);
        return {
          ...m,
          status: membershipStatus(m, todayIso),
          typeName: typesById.get(m.membershipTypeId)?.name ?? '',
          clientName: client?.name ?? '',
          clientPhone: client?.phone ?? '',
          locationName: locationNameOf(core, m.locationId, locale),
        };
      })
      .sort((a, b) => b.soldAt.localeCompare(a.soldAt));
  });
}

export interface MembershipDetail extends MembershipRow {
  transactions: LoyaltyTransaction[];
  /** F-06-112: тип запрещает заморозку — карточка не должна предлагать кнопку */
  typeFreezeAllowed: boolean;
  /** F-06-126/187: «История заморозок» с именем сотрудника, который заморозил/разморозил (по `by`) */
  freezeHistory: (Membership['freezeHistory'][number] & { byName?: string })[];
}

export function getMembership(businessId: Id, membershipId: Id, locale = 'ru'): Promise<MembershipDetail> {
  return request(() => {
    reconcileFrozenMemberships(businessId);
    const core = readCore();
    const state = readArea(AREA);
    const m = state.memberships.find((x) => x.id === membershipId && x.businessId === businessId);
    if (!m) throw new ApiError('not_found');
    const type = state.membershipTypes.find((t) => t.id === m.membershipTypeId);
    const client = clientOf(core, m.clientId);
    const staffName = (id: Id | undefined) => (id ? core.staff.find((s) => s.id === id)?.name : undefined);
    return {
      ...m,
      status: membershipStatus(m, todayISO()),
      typeName: type?.name ?? '',
      clientName: client?.name ?? '',
      clientPhone: client?.phone ?? '',
      locationName: locationNameOf(core, m.locationId, locale),
      typeFreezeAllowed: type?.freezeAllowed ?? false,
      freezeHistory: m.freezeHistory.map((entry) => ({
        ...entry,
        byName: staffName(entry.by),
      })),
      transactions: state.transactions.filter((t) => t.membershipId === membershipId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    };
  });
}

/**
 * F-06-126/187/194: заморозить/разморозить абонемент из сети; срок сдвигается на дни заморозки.
 * `days` — период заморозки, выбранный в диалоге (F-06-126 «период заморозки → Заморозить»);
 * `by` — сотрудник, который выполнил действие (пишется в «Историю заморозок», F-06-126/187).
 */
export function setMembershipFrozen(businessId: Id, membershipId: Id, frozen: boolean, days = 7, by?: Id): Promise<Membership> {
  return request(() => {
    let result: Membership | undefined;
    mutateArea(AREA, (s) => {
      const m = s.memberships.find((x) => x.id === membershipId && x.businessId === businessId);
      if (!m) throw new ApiError('not_found');
      const status = membershipStatus(m, todayISO());
      const allowed = MEMBERSHIP_TRANSITIONS[status];
      if (frozen) {
        // F-06-112: без разрешения в типе заморозка недоступна ни в сети, ни в карточке — проверка здесь,
        // а не только в UI, чтобы правило не обходилось прямым вызовом api.
        const type = s.membershipTypes.find((t) => t.id === m.membershipTypeId);
        if (!type?.freezeAllowed) throw new ApiError('freeze_not_allowed');
        if (!allowed.includes('frozen')) throw new ApiError('invalid_transition');
        if (!Number.isFinite(days) || days <= 0) throw new ApiError('invalid_days');
        m.status = 'frozen';
        m.frozenDays += days;
        m.frozenUntil = toISODate(dayjs(todayISO()).add(days, 'day'));
        m.expiresAt = toISODate(dayjs(m.expiresAt).add(days, 'day'));
        m.freezeHistory.push({ at: nowDateTime(), days, action: 'freeze', by });
      } else {
        if (m.status !== 'frozen') throw new ApiError('invalid_transition');
        // Л9: досрочная разморозка — неиспользованные дни заморозки не остаются подарком: срок и счётчик
        // дней заморозки уменьшаются на то, что не прошло. В истории — сколько дней фактически пробыл замороженным.
        const unused = m.frozenUntil ? Math.max(0, dayjs(m.frozenUntil).diff(dayjs(todayISO()), 'day')) : 0;
        if (unused > 0) {
          m.expiresAt = toISODate(dayjs(m.expiresAt).subtract(unused, 'day'));
          m.frozenDays = Math.max(0, m.frozenDays - unused);
        }
        const lastFreeze = [...m.freezeHistory].reverse().find((e) => e.action === 'freeze');
        m.status = 'active';
        m.frozenUntil = undefined;
        m.freezeHistory.push({
          at: nowDateTime(),
          days: lastFreeze ? Math.max(0, lastFreeze.days - unused) : 0,
          action: 'unfreeze',
          by,
        });
      }
      result = m;
    });
    return result!;
  });
}

/**
 * F-06-125/188: правка баланса визитов и срока проданного абонемента (карточка клиента в локации,
 * если тип разрешает; сеть — всегда). Баланс не может превышать общее число визитов и не уходит в минус.
 * Правка не шлёт уведомление о списании (F-06-120), но пишется транзакцией `membershipRecalc` —
 * «изменение видно в истории абонемента» (F-06-125 «Готово, когда»).
 */
export function adjustMembership(businessId: Id, membershipId: Id, patch: { balanceVisits?: number; expiresAt?: string }, by?: Id): Promise<Membership> {
  return request(() => {
    let result: Membership | undefined;
    mutateArea(AREA, (s) => {
      const m = s.memberships.find((x) => x.id === membershipId && x.businessId === businessId);
      if (!m) throw new ApiError('not_found');
      const prevVisits = m.balanceVisits;
      const prevExpiresAt = m.expiresAt;
      if (patch.balanceVisits !== undefined) m.balanceVisits = Math.max(0, Math.min(m.totalVisits, patch.balanceVisits));
      if (patch.expiresAt !== undefined) m.expiresAt = patch.expiresAt as Membership['expiresAt'];
      if (m.balanceVisits !== prevVisits || m.expiresAt !== prevExpiresAt) {
        s.transactions.push({
          id: newId('ltx'),
          businessId,
          locationId: m.locationId,
          type: 'membershipRecalc',
          clientId: m.clientId,
          membershipId: m.id,
          amount: m.balanceVisits - prevVisits,
          createdAt: nowDateTime(),
          by,
        });
      }
      result = m;
    });
    return result!;
  });
}

/**
 * F-06-102/132, способ 1 («отменить продажу»): полный возврат — абонемент исчезает у клиента и из
 * сети. Заблокирован, пока абонементом уже платили за визит (membershipUse) — «сначала удалить оплату,
 * потом продажу» (F-06-102): иначе баланс визитов и деньги разойдутся молча.
 */
export function deleteMembershipSale(businessId: Id, membershipId: Id): Promise<void> {
  return request(() => {
    mutateArea(AREA, (s) => {
      const m = s.memberships.find((x) => x.id === membershipId && x.businessId === businessId);
      if (!m) throw new ApiError('not_found');
      const hasUsage = s.transactions.some((tx) => tx.membershipId === membershipId && tx.type === 'membershipUse');
      if (hasUsage) throw new ApiError('has_usage');
      s.memberships = s.memberships.filter((x) => x.id !== membershipId);
    });
  });
}

/**
 * F-06-132, способ 2 (частичный возврат): остаток визитов обнуляется, а сумма возврата уходит расходной
 * транзакцией `membershipRefund` (стоит вместо отдельной операции в «Финансах», которых у раздела нет).
 */
export function refundMembershipPartial(businessId: Id, membershipId: Id, amount: number, byStaffId?: Id): Promise<Membership> {
  return request(() => {
    if (amount <= 0) throw new ApiError('validation');
    let result: Membership | undefined;
    mutateArea(AREA, (s) => {
      const m = s.memberships.find((x) => x.id === membershipId && x.businessId === businessId);
      if (!m) throw new ApiError('not_found');
      m.balanceVisits = 0;
      s.transactions.push({
        id: newId('ltx'),
        businessId,
        locationId: m.locationId,
        type: 'membershipRefund',
        clientId: m.clientId,
        membershipId: m.id,
        amount: -amount,
        createdAt: nowDateTime(),
        by: byStaffId,
      });
      result = m;
    });
    return result!;
  });
}

function membershipTotalVisits(type: MembershipType): number {
  return type.balanceMode === 'shared' ? (type.sharedVisits ?? 0) : type.services.reduce((sum, l) => sum + l.visits, 0);
}

export interface SellMembershipInput {
  membershipTypeId: Id;
  clientId: Id;
  code?: string;
  locationId: Id;
  sellerId?: Id;
  price?: number;
  discountPercent?: number;
}

/**
 * F-06-122/F-06-197: продажа абонемента — код обязателен, кроме типов с «Разрешить продажу без кода»
 * (F-06-113); цена/скидка/продавец фиксируются в строке продажи. Статус — 'issued' до активации по
 * настройке типа (F-06-109), иначе 'active' сразу.
 * F-06-121 (наше решение): абонемент — позиция каталога сама по себе, без движения по складу (Altegio
 * заводит его товаром на складе и уходит в минус без прихода — 🐞 в ТЗ). Продажа не трогает stock, поэтому
 * «докупить перед продажей» и складские отчёты по абонементам здесь не нужны — критерий выполняется тем,
 * что связи со складом просто нет.
 */
export function sellMembership(businessId: Id, input: SellMembershipInput): Promise<Membership> {
  return request(() => {
    let created: Membership | undefined;
    mutateArea(AREA, (s) => {
      const type = s.membershipTypes.find((t) => t.id === input.membershipTypeId && t.businessId === businessId);
      if (!type) throw new ApiError('not_found');
      const code = input.code?.trim();
      if (!code && !type.allowNoCode) throw new ApiError('validation');
      // F-06-067/123: код абонемента ищется в оплате визита — должен быть уникален у бизнеса, как у сертификата
      if (code && s.memberships.some((m) => m.businessId === businessId && m.code === code)) throw new ApiError('validation');
      const soldAt = dayjs();
      const totalVisits = membershipTotalVisits(type);
      const discountPercent = input.discountPercent ?? 0;
      const soldPrice = input.price ?? Math.round((type.price * (100 - discountPercent)) / 100);
      const m: Membership = {
        id: newId('lm'),
        businessId,
        membershipTypeId: input.membershipTypeId,
        clientId: input.clientId,
        status: type.activationMode === 'onSale' ? 'active' : 'issued',
        balanceVisits: totalVisits,
        totalVisits,
        price: soldPrice,
        locationId: input.locationId,
        soldAt: toISODateTime(soldAt),
        expiresAt: type.durationValue > 0 ? toISODate(soldAt.add(type.durationValue, type.durationUnit)) : toISODate(soldAt.add(100, 'year')),
        frozenDays: 0,
        freezeHistory: [],
        soldPrice,
        discountPercent,
        sellerId: input.sellerId,
        code,
      };
      s.memberships.push(m);
      created = m;
    });
    return created!;
  });
}

// ─────────────────────────── Счета клиентов / депозиты (F-06-135, F-06-141, F-06-142) ───────────────────────────

export function listAccountTypes(businessId: Id): Promise<AccountType[]> {
  return request(() =>
    readArea(AREA)
      .accountTypes.filter((t) => t.businessId === businessId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  );
}

export function getAccountType(businessId: Id, typeId: Id): Promise<AccountType> {
  return request(() => {
    const type = readArea(AREA).accountTypes.find((t) => t.id === typeId && t.businessId === businessId);
    if (!type) throw new ApiError('not_found');
    return type;
  });
}

export interface AccountTypeInput {
  name: string;
  locationIds: Id[];
  allowNegative: boolean;
  negativeLimit: number;
}

/** F-06-136: без лимита галочку «Разрешить оплату в минус» не сохранить */
export function createAccountType(businessId: Id, input: AccountTypeInput): Promise<AccountType> {
  return request(() => {
    if (!input.name.trim()) throw new ApiError('validation');
    if (!isAccountTypeValid(input.allowNegative, input.negativeLimit)) throw new ApiError('negative_limit_required');
    const type: AccountType = {
      id: newId('lat'),
      businessId,
      ...input,
      name: input.name.trim(),
      createdAt: nowDateTime(),
    };
    mutateArea(AREA, (s) => {
      s.accountTypes.push(type);
    });
    return type;
  });
}

export function updateAccountType(businessId: Id, typeId: Id, input: AccountTypeInput): Promise<AccountType> {
  return request(() => {
    if (!input.name.trim()) throw new ApiError('validation');
    if (!isAccountTypeValid(input.allowNegative, input.negativeLimit)) throw new ApiError('negative_limit_required');
    let updated: AccountType | undefined;
    mutateArea(AREA, (s) => {
      const type = s.accountTypes.find((t) => t.id === typeId && t.businessId === businessId);
      if (!type) throw new ApiError('not_found');
      Object.assign(type, input, {
        name: input.name.trim(),
        updatedAt: nowDateTime(),
      });
      updated = type;
    });
    if (!updated) throw new ApiError('not_found');
    return updated;
  });
}

// ─────────────────────────── Счета клиента (F-06-137/138/139/140/143/196, пачка b05) ───────────────────────────

export interface ClientAccountDetail extends ClientAccount {
  typeName: string;
  allowNegative: boolean;
  negativeLimit: number;
  maxCharge: number;
}

/** F-06-196: счета одного клиента для вкладки «Счета клиентов» в карточке клиента */
export function listClientAccounts(businessId: Id, clientId: Id): Promise<ClientAccountDetail[]> {
  return request(() => {
    const state = readArea(AREA);
    const typesById = new Map(state.accountTypes.map((t) => [t.id, t]));
    return state.accounts
      .filter((a) => a.businessId === businessId && a.clientId === clientId)
      .map((a) => {
        const type = typesById.get(a.accountTypeId);
        return {
          ...a,
          typeName: type?.name ?? '',
          allowNegative: type?.allowNegative ?? false,
          negativeLimit: type?.negativeLimit ?? 0,
          maxCharge: maxAccountCharge(a.balance, type ?? { allowNegative: false, negativeLimit: 0 }),
        };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });
}

/**
 * F-06-186: сумма остатков по всем счетам клиента (по всем типам) — для колонки «баланс депозита» и
 * фильтра «Баланс счета» в клиентской базе (файл раздела `clients`, см. qa/requests/loyalty.md).
 * Отдаёт карту clientId → баланс сразу для всех клиентов бизнеса, чтобы список не делал запрос на строку.
 */
export function listClientAccountBalances(businessId: Id): Promise<Record<Id, number>> {
  return request(() => {
    const state = readArea(AREA);
    const totals: Record<Id, number> = {};
    for (const a of state.accounts) {
      if (a.businessId !== businessId) continue;
      totals[a.clientId] = (totals[a.clientId] ?? 0) + a.balance;
    }
    return totals;
  });
}

export interface AccountOperationDetail extends AccountOperation {
  authorName?: string;
  /** F-06-196: остаток по счёту сразу после этой операции — считаем от старой операции к новой, отдаём новой сверху */
  balanceAfter: number;
}

/** История операций одного счёта — для «Развернуть» во вкладке «Счета клиентов» */
export function listAccountOperationsForAccount(businessId: Id, accountId: Id): Promise<AccountOperationDetail[]> {
  return request(() => {
    const core = readCore();
    const state = readArea(AREA);
    let running = 0;
    return state.accountOperations
      .filter((op) => op.businessId === businessId && op.accountId === accountId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((op) => {
        running += op.amount;
        return {
          ...op,
          balanceAfter: running,
          authorName: op.authorStaffId ? core.staff.find((s) => s.id === op.authorStaffId)?.name : undefined,
        };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });
}

/** F-06-137: открытие счёта клиенту — тип счёта уже должен существовать (создаётся в /biz/loyalty/deposits/types) */
export function openAccount(businessId: Id, clientId: Id, accountTypeId: Id, locationId: Id, authorStaffId?: Id): Promise<ClientAccount> {
  return request(() => {
    const state = readArea(AREA);
    if (!state.accountTypes.some((t) => t.id === accountTypeId && t.businessId === businessId)) throw new ApiError('not_found');
    if (state.accounts.some((a) => a.businessId === businessId && a.clientId === clientId && a.accountTypeId === accountTypeId)) throw new ApiError('account_already_open');
    const account: ClientAccount = {
      id: newId('lac'),
      businessId,
      accountTypeId,
      clientId,
      locationId,
      balance: 0,
      createdAt: nowDateTime(),
    };
    mutateArea(AREA, (s) => {
      s.accounts.push(account);
      s.accountOperations.push({
        id: newId('lop'),
        businessId,
        accountId: account.id,
        type: 'open',
        amount: 0,
        authorStaffId,
        createdAt: nowDateTime(),
      });
    });
    return account;
  });
}

/** F-06-138/143: пополнение счёта (не поштучный чек — «чек» здесь: printable-сводка через getAccountReceipt) */
export interface TopupResult {
  account: ClientAccount;
  operationId: Id;
}

export function topupAccount(businessId: Id, accountId: Id, amount: number, authorStaffId?: Id): Promise<TopupResult> {
  return request(() => {
    if (amount <= 0) throw new ApiError('validation');
    let updated: ClientAccount | undefined;
    let opId = '';
    mutateArea(AREA, (s) => {
      const account = s.accounts.find((a) => a.id === accountId && a.businessId === businessId);
      if (!account) throw new ApiError('not_found');
      account.balance += amount;
      opId = newId('lop');
      s.accountOperations.push({
        id: opId,
        businessId,
        accountId,
        type: 'topup',
        amount,
        authorStaffId,
        createdAt: nowDateTime(),
      });
      s.transactions.push({
        id: newId('ltx'),
        businessId,
        locationId: account.locationId,
        type: 'accountCharge',
        clientId: account.clientId,
        accountId,
        amount,
        createdAt: nowDateTime(),
      });
      updated = account;
    });
    if (!updated) throw new ApiError('not_found');
    return { account: updated, operationId: opId };
  });
}

/**
 * F-06-139/140: оплата визита со счёта — списывает не больше, чем разрешает `maxAccountCharge` (баланс +
 * лимит минуса типа счёта); коммит в реальный визит идёт через commitLoyaltyPayment (kind: 'account'), эта
 * функция — прямое списание вне визита (например, долг закрыт отдельно) и общий движок для обеих веток.
 */
export function chargeAccount(businessId: Id, accountId: Id, amount: number, authorStaffId?: Id, bookingId?: Id): Promise<ClientAccount> {
  return request(() => {
    if (amount <= 0) throw new ApiError('validation');
    const state = readArea(AREA);
    const account = state.accounts.find((a) => a.id === accountId && a.businessId === businessId);
    if (!account) throw new ApiError('not_found');
    const type = state.accountTypes.find((t) => t.id === account.accountTypeId);
    const max = maxAccountCharge(account.balance, type ?? { allowNegative: false, negativeLimit: 0 });
    if (amount > max) throw new ApiError('over_limit');
    let updated: ClientAccount | undefined;
    mutateArea(AREA, (s) => {
      const acc = s.accounts.find((a) => a.id === accountId)!;
      acc.balance -= amount;
      s.accountOperations.push({
        id: newId('lop'),
        businessId,
        accountId,
        type: 'charge',
        amount: -amount,
        authorStaffId,
        createdAt: nowDateTime(),
      });
      s.transactions.push({
        id: newId('ltx'),
        businessId,
        locationId: acc.locationId,
        type: 'accountCharge',
        clientId: acc.clientId,
        accountId,
        bookingId,
        amount: -amount,
        createdAt: nowDateTime(),
      });
      updated = acc;
    });
    return updated!;
  });
}

/**
 * F-06-144, полный возврат («отменить операцию пополнения»): убирает пополнение из истории и снимает
 * ту же сумму с баланса счёта. Только для операций типа `topup` — их и ищут в Финансах по статье
 * «Пополнение счета» (справка 174913).
 */
export function cancelAccountTopup(businessId: Id, accountId: Id, operationId: Id): Promise<ClientAccount> {
  return request(() => {
    let updated: ClientAccount | undefined;
    mutateArea(AREA, (s) => {
      const account = s.accounts.find((a) => a.id === accountId && a.businessId === businessId);
      if (!account) throw new ApiError('not_found');
      const op = s.accountOperations.find((o) => o.id === operationId && o.accountId === accountId);
      if (!op || op.type !== 'topup') throw new ApiError('not_found');
      account.balance -= op.amount;
      s.accountOperations = s.accountOperations.filter((o) => o.id !== operationId);
      updated = account;
    });
    return updated!;
  });
}

/**
 * F-06-144, частичный возврат: расходная операция на сумму (не ограничена «оплатой в минус» типа счёта —
 * это возврат клиенту, а не списание за визит), помечена отдельным типом транзакции `accountRefund`,
 * чтобы отличаться от обычного `chargeAccount` в отчётах.
 */
export function refundAccountAmount(businessId: Id, accountId: Id, amount: number, authorStaffId?: Id): Promise<ClientAccount> {
  return request(() => {
    if (amount <= 0) throw new ApiError('validation');
    let updated: ClientAccount | undefined;
    mutateArea(AREA, (s) => {
      const account = s.accounts.find((a) => a.id === accountId && a.businessId === businessId);
      if (!account) throw new ApiError('not_found');
      account.balance -= amount;
      s.accountOperations.push({
        id: newId('lop'),
        businessId,
        accountId,
        type: 'charge',
        amount: -amount,
        authorStaffId,
        createdAt: nowDateTime(),
      });
      s.transactions.push({
        id: newId('ltx'),
        businessId,
        locationId: account.locationId,
        type: 'accountRefund',
        clientId: account.clientId,
        accountId,
        amount: -amount,
        createdAt: nowDateTime(),
        by: authorStaffId,
      });
      updated = account;
    });
    return updated!;
  });
}

export interface AccountReceipt {
  operationId: Id;
  type: AccountOperation['type'];
  amount: number;
  balanceAfter: number;
  clientName: string;
  clientPhone: string;
  accountTypeName: string;
  businessName: string;
  createdAt: string;
}

/** F-06-143: чек при пополнении/оплате со счёта — сводка для печати (PDF-печать делает браузер, window.print) */
export function getAccountReceipt(businessId: Id, operationId: Id): Promise<AccountReceipt> {
  return request(() => {
    const core = readCore();
    const state = readArea(AREA);
    const op = state.accountOperations.find((o) => o.id === operationId && o.businessId === businessId);
    if (!op) throw new ApiError('not_found');
    const account = state.accounts.find((a) => a.id === op.accountId);
    const type = state.accountTypes.find((t) => t.id === account?.accountTypeId);
    const client = account ? clientOf(core, account.clientId) : undefined;
    const business = core.businesses.find((b) => b.id === businessId);
    return {
      operationId: op.id,
      type: op.type,
      amount: op.amount,
      balanceAfter: account?.balance ?? 0,
      clientName: client?.name ?? '',
      clientPhone: client?.phone ?? '',
      accountTypeName: type?.name ?? '',
      businessName: business?.name ?? '',
      createdAt: op.createdAt,
    };
  });
}

// ─────────────────────────── Абонемент и политика оплаты (F-06-131) ───────────────────────────

/** F-06-131: у клиента есть активный (или замороженный — держит место) абонемент с остатком визитов, применимый к услугам визита */
export function hasWaivingMembership(businessId: Id, clientId: Id, serviceIds: Id[] = []): Promise<boolean> {
  return request(() => {
    const state = readArea(AREA);
    const typesById = new Map(state.membershipTypes.map((t) => [t.id, t]));
    return state.memberships.some((m) => {
      if (m.businessId !== businessId || m.clientId !== clientId) return false;
      if (m.status !== 'active' && m.status !== 'frozen') return false;
      if (m.balanceVisits <= 0) return false;
      if (isCertificateLikeExpired(m.expiresAt)) return false;
      const type = typesById.get(m.membershipTypeId);
      if (!type) return false;
      if (serviceIds.length === 0 || type.balanceMode === 'shared') return true;
      return serviceIds.some((id) => type.services.some((line) => line.serviceId === id));
    });
  });
}

function isCertificateLikeExpired(expiresAt: string): boolean {
  return dayjs(expiresAt).isBefore(dayjs(), 'day');
}

// ─────────────────────────── Автосписание с абонемента у услуги (F-06-127) ───────────────────────────

export interface ServiceAutoCharge {
  enabled: boolean;
  freeCancelHours: number;
}

const DEFAULT_AUTO_CHARGE: ServiceAutoCharge = {
  enabled: false,
  freeCancelHours: 0,
};

export function getServiceAutoCharge(_businessId: Id, serviceId: Id): Promise<ServiceAutoCharge> {
  return request(() => readArea(AREA).serviceAutoCharge[serviceId] ?? DEFAULT_AUTO_CHARGE);
}

/** F-06-127: свои данные «о сущности ядра» (услуге) — своим срезом, по её id */
export function setServiceAutoCharge(_businessId: Id, serviceId: Id, value: ServiceAutoCharge): Promise<ServiceAutoCharge> {
  return request(() => {
    mutateArea(AREA, (s) => {
      s.serviceAutoCharge[serviceId] = value;
    });
    return value;
  });
}

// ─────────────────────────── Онлайн-запись только по абонементу (F-06-128) ───────────────────────────

export function getOnlineRequireMembership(_businessId: Id, serviceId: Id): Promise<boolean> {
  return request(() => readArea(AREA).onlineRequireMembership[serviceId] ?? false);
}

/** F-06-128: своя настройка услуги (по её id), тот же приём, что и serviceAutoCharge выше */
export function setOnlineRequireMembership(_businessId: Id, serviceId: Id, value: boolean): Promise<boolean> {
  return request(() => {
    mutateArea(AREA, (s) => {
      s.onlineRequireMembership[serviceId] = value;
    });
    return value;
  });
}

/**
 * F-06-128: проверка перед онлайн-записью — у клиента с этим телефоном должен быть подходящий
 * действующий абонемент (статусы active/issued/frozen — ТЗ прямо перечисляет «Активен, Выдан или
 * Заморожен»; остаток > 0; срок ещё не истёк). Клиента с таким телефоном ещё нет — считается «нет
 * абонемента» (иначе проверку можно было бы обойти, вписав любой номер).
 */
export function hasOnlineMembership(businessId: Id, phone: string, serviceId: Id, todayIso = todayISO()): Promise<boolean> {
  return request(() => {
    const core = readCore();
    const digits = phone.replace(/\D/g, '');
    if (!digits) return false;
    const client = core.clients.find((c) => c.businessId === businessId && c.phone.replace(/\D/g, '') === digits);
    if (!client) return false;
    const state = readArea(AREA);
    const typeById = new Map(state.membershipTypes.map((t) => [t.id, t]));
    return state.memberships.some((m) => {
      if (m.businessId !== businessId || m.clientId !== client.id) return false;
      if (m.status !== 'active' && m.status !== 'issued' && m.status !== 'frozen') return false;
      if (m.balanceVisits <= 0) return false;
      if (m.expiresAt < todayIso) return false;
      const type = typeById.get(m.membershipTypeId);
      return !type || type.balanceMode === 'shared' || type.services.some((line) => line.serviceId === serviceId);
    });
  });
}

export interface ClientAccountRow extends ClientAccount {
  typeName: string;
  clientName: string;
  clientPhone: string;
}

export interface AccountsFilter {
  accountTypeId?: Id;
  minBalance?: number;
  maxBalance?: number;
  query?: string;
}

export function listAccounts(businessId: Id, filter: AccountsFilter = {}): Promise<ClientAccountRow[]> {
  return request(() => {
    const core = readCore();
    const state = readArea(AREA);
    const typesById = new Map(state.accountTypes.map((t) => [t.id, t]));
    let rows = state.accounts.filter((a) => a.businessId === businessId);
    if (filter.accountTypeId) rows = rows.filter((a) => a.accountTypeId === filter.accountTypeId);
    if (filter.minBalance !== undefined) rows = rows.filter((a) => a.balance >= filter.minBalance!);
    if (filter.maxBalance !== undefined) rows = rows.filter((a) => a.balance <= filter.maxBalance!);
    if (filter.query?.trim()) {
      const q = filter.query.trim().toLowerCase();
      const qDigits = q.replace(/\D/g, '');
      rows = rows.filter((a) => {
        const client = clientOf(core, a.clientId);
        if (!client) return false;
        return client.name.toLowerCase().includes(q) || (qDigits && client.phone.replace(/\D/g, '').includes(qDigits));
      });
    }
    return rows
      .map((a) => {
        const client = clientOf(core, a.clientId);
        return {
          ...a,
          typeName: typesById.get(a.accountTypeId)?.name ?? '',
          clientName: client?.name ?? '',
          clientPhone: client?.phone ?? '',
        };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });
}

export interface AccountOperationRow extends AccountOperation {
  typeName: string;
  clientId?: Id;
  clientName: string;
  clientPhone: string;
  authorName?: string;
}

export interface AccountOperationsFilter {
  accountTypeId?: Id;
  type?: AccountOperation['type'];
  authorStaffId?: Id;
  dateFrom?: string;
  dateTo?: string;
}

// ─────────────────────────── Движок лояльности визита (F-06-062…070, 074, 083/084, 096…098, 123; Л1…Л8) ───────────────────────────
//
// Одно место правил для ОБЕИХ вкладок окна записи — «Лояльность» (LoyaltyPaymentPanel) и «Оплата» (journal
// PaymentSheet): применимость, расчёт скидки и кэшбэка, запись в транзакции лояльности, строки платежей визита
// (payBookingLines, refId строки = id транзакции лояльности) и откат одной строки. Поэтому «К оплате» на обеих
// вкладках — одна и та же сумма: total − строки платежей визита.

/** Услуга визита для расчёта: price — к оплате (после личной скидки клиента), listPrice — по прайсу */
export interface VisitServiceLine {
  serviceId: Id;
  price: number;
  listPrice?: number;
}

export interface LoyaltyVisit {
  lines: VisitServiceLine[];
  locationId?: Id;
  /** Сама запись — не «прошлый визит» в накопительных правилах и не свой же прошлый кэшбэк */
  bookingId?: Id;
}

export function visitSums(visit: LoyaltyVisit): { total: number; list: number; personalDiscount: number } {
  const total = visit.lines.reduce((sum, l) => sum + l.price, 0);
  const list = visit.lines.reduce((sum, l) => sum + (l.listPrice ?? l.price), 0);
  return { total, list, personalDiscount: Math.max(0, list - total) };
}

/** F-06-005/035: услуга в охвате программы; пустой охват — все услуги; категория разворачивается при использовании */
function inServiceScope(core: CoreData, scope: ServiceScope | undefined, serviceId: Id): boolean {
  if (!scope || (scope.categoryIds.length === 0 && scope.serviceIds.length === 0)) return true;
  if (scope.serviceIds.includes(serviceId)) return true;
  const svc = core.services.find((x) => x.id === serviceId);
  return Boolean(svc && scope.categoryIds.includes(svc.categoryId));
}

function scopedSum(core: CoreData, scope: ServiceScope | undefined, visit: LoyaltyVisit, field: 'price' | 'listPrice'): number {
  return visit.lines.filter((l) => inServiceScope(core, scope, l.serviceId)).reduce((sum, l) => sum + (field === 'listPrice' ? (l.listPrice ?? l.price) : l.price), 0);
}

/** F-06-036: «в каких локациях действует»; пусто — во всех */
function promoWorksAt(promo: Promotion, locationId: Id | undefined): boolean {
  return !locationId || !promo.locationIds?.length || promo.locationIds.includes(locationId);
}

/** «Действует в локациях» типа карты */
function cardWorksAt(state: LoyaltyArea, card: LoyaltyCard, locationId: Id | undefined): boolean {
  const type = state.cardTypes.find((t) => t.id === card.cardTypeId);
  return !locationId || !type?.locationIds.length || type.locationIds.includes(locationId);
}

function cardPromotions(state: LoyaltyArea, card: LoyaltyCard, family: 'discount' | 'cashback', locationId: Id | undefined, now: Date): Promotion[] {
  return state.promotions.filter(
    (p) =>
      p.businessId === card.businessId &&
      p.cardTypeIds.includes(card.cardTypeId) &&
      (family === 'discount' ? isDiscountKind(p.kind) : !isDiscountKind(p.kind)) &&
      isPromotionActiveNow(p, now) &&
      promoWorksAt(p, locationId),
  );
}

interface PastVisit {
  start: string;
  total: number;
  listTotal: number;
  serviceIds: Id[];
}

/**
 * F-06-045/047: история визитов держателя для накопительных правил — «Клиент пришёл», не удалённые, не эта
 * запись; с даты начала истории; по локациям акции, если источник — «активные локации». «Отмена накопленной
 * скидки через N дней без визитов»: счёт начинается заново после каждого такого перерыва и обнуляется, если
 * перерыв длится до сегодня.
 */
function pastVisits(core: CoreData, businessId: Id, clientId: Id, promo: Promotion, visit: LoyaltyVisit): PastVisit[] {
  const todayIso = todayISO();
  let rows = core.bookings.filter((b) => b.businessId === businessId && b.clientId === clientId && b.status === 'arrived' && !b.deletedAt && b.id !== visit.bookingId && b.start.slice(0, 10) <= todayIso);
  if (promo.historyStartDate) rows = rows.filter((b) => b.start.slice(0, 10) >= promo.historyStartDate!);
  if (promo.sourceScope === 'activeLocations' && promo.locationIds?.length) rows = rows.filter((b) => promo.locationIds!.includes(b.locationId));
  const sorted = [...rows]
    .sort((a, b) => a.start.localeCompare(b.start))
    .map((b) => ({
      start: b.start,
      total: b.total,
      listTotal: b.services.reduce((sum, l) => sum + (l.unitPrice !== undefined ? l.unitPrice * l.qty : l.price), 0) || b.total,
      serviceIds: b.services.map((l) => l.serviceId),
    }));
  if (!promo.cancelAfterDays || sorted.length === 0) return sorted;
  const gap = promo.cancelAfterDays;
  const last = sorted[sorted.length - 1];
  if (dayjs(todayIso).diff(dayjs(last.start.slice(0, 10)), 'day') > gap) return [];
  let from = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (dayjs(sorted[i].start.slice(0, 10)).diff(dayjs(sorted[i - 1].start.slice(0, 10)), 'day') > gap) from = i;
  }
  return sorted.slice(from);
}

function historySum(promo: Promotion, history: PastVisit[]): number {
  return history.reduce((sum, v) => sum + (promo.sumBasis === 'listPrice' ? v.listTotal : v.total), 0);
}

/** Таблица порогов: самая высокая ступень, до которой держатель дошёл */
function stepValue(promo: Promotion, basis: number): number | undefined {
  return [...(promo.thresholds ?? [])].filter((th) => th.from <= basis).sort((a, b) => b.from - a.from)[0]?.value;
}

function applyValue(valueType: Promotion['valueType'], value: number, base: number): number {
  if (base <= 0 || value <= 0) return 0;
  return valueType === 'percent' ? Math.round((base * Math.min(100, value)) / 100) : Math.min(value, base);
}

/** F-06-037/038/039/040: полная скидка акции на визит — от цены по прайсу услуг в её охвате */
function promotionDiscountFor(core: CoreData, promo: Promotion, visit: LoyaltyVisit, history: PastVisit[]): number {
  if (promo.kind === 'discountConditional') {
    // F-06-040: «настройка 5 = бесплатна 6-я» — услуги из условия считаются по прошлым визитам и дальше по этой записи
    const n = Math.max(1, promo.conditionCount ?? 1);
    const counted = (serviceId: Id) => !promo.conditionServiceIds?.length || promo.conditionServiceIds.includes(serviceId);
    let seen = history.reduce((sum, v) => sum + v.serviceIds.filter(counted).length, 0);
    let discount = 0;
    for (const line of visit.lines) {
      if (!counted(line.serviceId)) continue;
      seen += 1;
      if (seen % (n + 1) === 0) discount += applyValue(promo.valueType, promo.value, line.listPrice ?? line.price);
    }
    return discount;
  }
  const base = scopedSum(core, promo.serviceScope, visit, 'listPrice');
  if (promo.kind === 'discountFixed') return applyValue(promo.valueType, promo.value, base);
  const basis = promo.kind === 'discountAccumVisits' ? history.length : historySum(promo, history);
  const value = stepValue(promo, basis);
  return value === undefined ? 0 : applyValue(promo.valueType, value, base);
}

/**
 * F-06-041…046/070 (Л6): бонусы одной акции на карту за визит. База — часть, оплаченная деньгами (наличные,
 * карта, личный счёт), в доле услуг из охвата акции; бонусами, сертификатом, абонементом и скидкой оплаченное
 * кэшбэк не даёт. «Каждый N-й визит» и «не больше N раз» — по прошлым визитам и прошлым начислениям этой акции.
 */
function cashbackFor(core: CoreData, state: LoyaltyArea, promo: Promotion, card: LoyaltyCard, visit: LoyaltyVisit, moneyBase: number, history: PastVisit[]): number {
  if (moneyBase <= 0) return 0;
  const { total } = visitSums(visit);
  const base = total > 0 ? Math.round(moneyBase * Math.min(1, scopedSum(core, promo.serviceScope, visit, 'price') / total)) : moneyBase;
  if (base <= 0) return 0;
  const frequency = Math.max(1, promo.applyFrequency ?? 1);
  if ((history.length + 1) % frequency !== 0) return 0;
  if (promo.applyLimit) {
    const used = state.transactions.filter((tx) => tx.type === 'loyaltyAccrual' && tx.promotionId === promo.id && tx.cardId === card.id && tx.bookingId !== visit.bookingId).length;
    if (used >= promo.applyLimit) return 0;
  }
  let value: number | undefined;
  if (promo.kind === 'cashbackFixed') value = promo.value;
  else if (promo.kind === 'cashbackAccumVisits') value = stepValue(promo, history.length);
  else if (promo.kind === 'cashbackAccumSum') value = stepValue(promo, historySum(promo, history));
  else if (promo.kind === 'cashbackVisit') value = stepValue(promo, base); // «в рамках визита» — порог по сумме этого визита
  if (!value || value <= 0) return 0;
  return promo.valueType === 'percent' ? Math.round((base * Math.min(100, value)) / 100) : value;
}

export interface CashbackLine {
  cardId: Id;
  cardNumber: string;
  promotionId: Id;
  promotionName: string;
  amount: number;
}

/** На каждую карту — одна, самая выгодная бонусная акция её типа (как и скидка: одна на визит) */
function computeCashback(core: CoreData, state: LoyaltyArea, businessId: Id, clientId: Id, visit: LoyaltyVisit, moneyBase: number): CashbackLine[] {
  const now = portNowDate();
  const lines: CashbackLine[] = [];
  for (const card of state.cards.filter((c) => c.businessId === businessId && c.clientId === clientId && cardWorksAt(state, c, visit.locationId))) {
    let best: CashbackLine | undefined;
    for (const promo of cardPromotions(state, card, 'cashback', visit.locationId, now)) {
      const amount = cashbackFor(core, state, promo, card, visit, moneyBase, pastVisits(core, businessId, clientId, promo, visit));
      if (amount > 0 && (!best || amount > best.amount)) best = { cardId: card.id, cardNumber: card.number, promotionId: promo.id, promotionName: promo.name, amount };
    }
    if (best) lines.push(best);
  }
  return lines;
}

const MONEY_METHODS = new Set(['cash', 'card', 'personal_account']);

/** Л6: сколько визита оплачено деньгами — база кэшбэка */
export function moneyPaidOf(payments: { method: string; amount: number }[]): number {
  return payments.filter((p) => MONEY_METHODS.has(p.method)).reduce((sum, p) => sum + p.amount, 0);
}

export interface CashbackPreview {
  /** Сколько даст визит, если его оплатить деньгами на moneyBase */
  total: number;
  lines: CashbackLine[];
  /** Уже начислено за эту запись (visit.bookingId) */
  accrued: number;
}

/** Л7: сколько бонусов начислится, если оставшееся заплатить деньгами (moneyBase) — превью до оплаты */
export function previewCashback(businessId: Id, clientId: Id, visit: LoyaltyVisit, moneyBase: number): Promise<CashbackPreview> {
  return request(() => {
    const state = readArea(AREA);
    const lines = computeCashback(readCore(), state, businessId, clientId, visit, moneyBase);
    const accrued = visit.bookingId ? state.transactions.filter((tx) => tx.businessId === businessId && tx.bookingId === visit.bookingId && tx.type === 'loyaltyAccrual').reduce((sum, tx) => sum + tx.amount, 0) : 0;
    return { total: lines.reduce((sum, l) => sum + l.amount, 0), lines, accrued };
  });
}

/**
 * F-06-070 (Л6): кэшбэк визита всегда равен тому, что даёт ТЕКУЩАЯ оплата: зовётся после каждой оплаты и отмены
 * строки на любой вкладке. Отмена оплаты снимает начисленное, повторное сохранение второй раз не начисляет.
 */
export function syncBookingCashback(businessId: Id, locationId: Id, clientId: Id, bookingId: Id, payments: { method: string; amount: number }[], visit: LoyaltyVisit): Promise<number> {
  return request(() => {
    const core = readCore();
    const lines = computeCashback(core, readArea(AREA), businessId, clientId, { ...visit, locationId: visit.locationId ?? locationId, bookingId }, moneyPaidOf(payments));
    const total = lines.reduce((sum, l) => sum + l.amount, 0);
    const existing = readArea(AREA).transactions.filter((tx) => tx.businessId === businessId && tx.bookingId === bookingId && tx.type === 'loyaltyAccrual');
    const same = existing.length === lines.length && lines.every((l) => existing.some((tx) => tx.cardId === l.cardId && tx.promotionId === l.promotionId && tx.amount === l.amount));
    if (same) return total;
    mutateArea(AREA, (s) => {
      for (const tx of s.transactions) {
        if (tx.businessId !== businessId || tx.bookingId !== bookingId || tx.type !== 'loyaltyAccrual') continue;
        const card = s.cards.find((c) => c.id === tx.cardId);
        if (card) card.balance = Math.max(0, card.balance - tx.amount);
      }
      s.transactions = s.transactions.filter((tx) => !(tx.businessId === businessId && tx.bookingId === bookingId && tx.type === 'loyaltyAccrual'));
      for (const l of lines) {
        const card = s.cards.find((c) => c.id === l.cardId);
        if (!card) continue;
        card.balance += l.amount;
        s.transactions.push({
          id: newId('ltx'),
          businessId,
          locationId,
          type: 'loyaltyAccrual',
          clientId,
          cardId: l.cardId,
          promotionId: l.promotionId,
          bookingId,
          amount: l.amount,
          createdAt: nowDateTime(),
        });
      }
    });
    return total;
  });
}

// ─────────────────────────── Стоимость лояльности (Л16) ───────────────────────────

export interface LoyaltyCostReport {
  /** Скидки по акциям и «Приведи друга» за период, ֏ */
  discounts: number;
  /** Бонусы, начисленные за визиты, приглашения и дни рождения, ֏ */
  bonusesAccrued: number;
  /** Бонусы, которыми клиенты оплатили визиты, ֏ */
  bonusesSpent: number;
  /** Бонусы, сгоревшие без визитов, ֏ */
  bonusesBurnt: number;
  /** Долг бизнеса по бонусам: сколько сейчас лежит на картах, ֏ */
  bonusesOutstanding: number;
  /** Непогашенные сертификаты: сколько и на какую сумму ещё можно ими заплатить */
  certificatesOutstandingCount: number;
  certificatesOutstanding: number;
  /** Сертификаты, у которых остаток сгорел (однократные, истёкшие), ֏ */
  certificatesBurnt: number;
}

/** Л16: сколько стоит лояльность за период и что бизнес ещё должен клиентам — одним лёгким запросом */
export function getLoyaltyCostReport(businessId: Id, range?: { dateFrom?: string; dateTo?: string }): Promise<LoyaltyCostReport> {
  return request(() => {
    reconcileBonusBurn(businessId);
    const state = readArea(AREA);
    const todayIso = todayISO();
    let txs = state.transactions.filter((tx) => tx.businessId === businessId);
    if (range?.dateFrom) txs = txs.filter((tx) => tx.createdAt >= range.dateFrom!);
    if (range?.dateTo) txs = txs.filter((tx) => tx.createdAt <= `${range.dateTo}T23:59:59`);
    const sum = (types: LoyaltyTxType[], pred: (tx: LoyaltyTransaction) => boolean = () => true) => txs.filter((tx) => types.includes(tx.type) && pred(tx)).reduce((acc, tx) => acc + Math.abs(tx.amount), 0);
    const activeCerts = state.certificates.filter((c) => c.businessId === businessId && certificateStatus(c, todayIso) === 'active' && c.balance > 0);
    return {
      discounts: sum(['promoDiscount']),
      bonusesAccrued: sum(['loyaltyAccrual', 'referralAccrual']) + sum(['manualTopup'], (tx) => Boolean(tx.promotionId)),
      bonusesSpent: sum(['cardCharge']),
      bonusesBurnt: sum(['expiredBurn'], (tx) => Boolean(tx.cardId)),
      bonusesOutstanding: state.cards.filter((c) => c.businessId === businessId).reduce((acc, c) => acc + c.balance, 0),
      certificatesOutstandingCount: activeCerts.length,
      certificatesOutstanding: activeCerts.reduce((acc, c) => acc + c.balance, 0),
      certificatesBurnt: sum(['expiredBurn'], (tx) => Boolean(tx.certificateId)),
    };
  });
}

// ─────────────────────────── День рождения (Л16) ───────────────────────────

/**
 * Л16: бонус на день рождения — тип карты задаёт сумму (birthdayBonus). Лениво, при чтении своих данных:
 * в день рождения клиента (и до 7 дней после, если в тот день никто не открывал кабинет) — одно начисление в год.
 */
function reconcileBirthdayBonus(businessId: Id): void {
  const state = readArea(AREA);
  const types = new Map(state.cardTypes.filter((t) => t.businessId === businessId && (t.birthdayBonus ?? 0) > 0).map((t) => [t.id, t]));
  if (types.size === 0) return;
  const core = readCore();
  const todayIso = todayISO();
  const year = todayIso.slice(0, 4);
  const due: { cardId: Id; amount: number }[] = [];
  for (const card of state.cards) {
    const type = types.get(card.cardTypeId);
    if (card.businessId !== businessId || !type) continue;
    const birthday = clientOf(core, card.clientId)?.birthday;
    if (!birthday) continue;
    const thisYear = `${year}-${birthday.slice(5, 10)}`;
    const days = dayjs(todayIso).diff(dayjs(thisYear), 'day');
    if (days < 0 || days > 7) continue;
    const given = state.transactions.some((tx) => tx.cardId === card.id && tx.type === 'loyaltyAccrual' && tx.birthdayYear === year);
    if (!given) due.push({ cardId: card.id, amount: type.birthdayBonus! });
  }
  if (due.length === 0) return;
  mutateArea(AREA, (s) => {
    for (const d of due) {
      const card = s.cards.find((c) => c.id === d.cardId);
      if (!card) continue;
      card.balance += d.amount;
      s.transactions.push({
        id: newId('ltx'),
        businessId,
        locationId: core.locations.find((l) => l.businessId === businessId)?.id ?? '',
        type: 'loyaltyAccrual',
        clientId: card.clientId,
        cardId: card.id,
        amount: d.amount,
        birthdayYear: year,
        createdAt: nowDateTime(),
      });
    }
  });
}

// ─────────────────────────── Сгорание бонусов (F-06-025, F-06-047; Л5, Л16) ───────────────────────────

/** Через сколько дней без визитов сгорают бонусы карты: срок типа карты или самой строгой бонусной акции */
function cardBurnDays(state: LoyaltyArea, card: LoyaltyCard): number | undefined {
  const type = state.cardTypes.find((t) => t.id === card.cardTypeId);
  const days = [type?.burnDays, ...state.promotions.filter((p) => p.cardTypeIds.includes(card.cardTypeId) && !isDiscountKind(p.kind)).map((p) => p.burnAfterDays)].filter((d): d is number => Boolean(d && d > 0));
  return days.length ? Math.min(...days) : undefined;
}

function cardLastActivity(core: CoreData, state: LoyaltyArea, card: LoyaltyCard): string {
  const visits = core.bookings.filter((b) => b.clientId === card.clientId && b.businessId === card.businessId && b.status === 'arrived' && !b.deletedAt).map((b) => b.start.slice(0, 10));
  const accruals = state.transactions.filter((tx) => tx.cardId === card.id && tx.amount > 0).map((tx) => tx.createdAt.slice(0, 10));
  return [card.createdAt.slice(0, 10), ...visits, ...accruals].sort().at(-1)!;
}

/** Л16: когда сгорят бонусы карты, если клиент не придёт; нет срока/баланса — undefined */
function cardBurnsAt(core: CoreData, state: LoyaltyArea, card: LoyaltyCard): string | undefined {
  const days = cardBurnDays(state, card);
  if (!days || card.balance <= 0) return undefined;
  return toISODate(dayjs(cardLastActivity(core, state, card)).add(days, 'day'));
}

/** Л5: бонусы сгорают сами — лениво, при чтении своих данных, одной строкой «Сгорание» в журнале операций */
function reconcileBonusBurn(businessId: Id): void {
  const core = readCore();
  const state = readArea(AREA);
  const todayIso = todayISO();
  const due = state.cards.filter((c) => {
    if (c.businessId !== businessId) return false;
    const at = cardBurnsAt(core, state, c);
    return Boolean(at && at <= todayIso);
  });
  if (due.length === 0) return;
  mutateArea(AREA, (s) => {
    for (const d of due) {
      const card = s.cards.find((c) => c.id === d.id);
      if (!card || card.balance <= 0) continue;
      s.transactions.push({
        id: newId('ltx'),
        businessId,
        locationId: core.locations.find((l) => l.businessId === businessId)?.id ?? '',
        type: 'expiredBurn',
        clientId: card.clientId,
        cardId: card.id,
        amount: -card.balance,
        createdAt: nowDateTime(),
      });
      card.balance = 0;
    }
  });
}

// ─────────────────────────── Что можно применить к визиту ───────────────────────────

export interface ApplicablePromotionRow {
  id: Id;
  name: string;
  kind: PromotionKind;
  cardId: Id;
  cardNumber: string;
  /** Полная скидка акции от цены по прайсу */
  discount: number;
}

/**
 * F-06-063/064 (Л4, Л5, Л15): скидочные акции держателя для ЭТОГО визита — по составу услуг, а не по остатку
 * чека, поэтому список не перечитывается от каждой применённой строки. Одна акция на нескольких картах —
 * одной строкой (лучшей). От выгодной к менее выгодной: применяется одна, остальные — «Заменить».
 */
export function listApplicablePromotions(businessId: Id, clientId: Id, visit: LoyaltyVisit): Promise<ApplicablePromotionRow[]> {
  return request(() => {
    const core = readCore();
    const state = readArea(AREA);
    const now = portNowDate();
    const byPromo = new Map<Id, ApplicablePromotionRow>();
    for (const card of state.cards.filter((c) => c.businessId === businessId && c.clientId === clientId && cardWorksAt(state, c, visit.locationId))) {
      for (const promo of cardPromotions(state, card, 'discount', visit.locationId, now)) {
        const discount = promotionDiscountFor(core, promo, visit, pastVisits(core, businessId, clientId, promo, visit));
        const prev = byPromo.get(promo.id);
        if (discount > 0 && (!prev || discount > prev.discount)) byPromo.set(promo.id, { id: promo.id, name: promo.name, kind: promo.kind, cardId: card.id, cardNumber: card.number, discount });
      }
    }
    return [...byPromo.values()].sort((a, b) => b.discount - a.discount);
  });
}

export interface BonusChargeInfo {
  /** F-06-065/026/027: максимум, доступный к списанию сейчас (баланс × лимиты типа × остаток чека) */
  max: number;
  balance: number;
}

/** F-06-026/027: сколько бонусов карты можно списать — баланс, «товары/услуги», лимит ֏ и % от чека визита */
function bonusMax(core: CoreData, state: LoyaltyArea, card: LoyaltyCard, remaining: number, visit?: LoyaltyVisit): number {
  const type = state.cardTypes.find((t) => t.id === card.cardTypeId);
  let max = Math.min(card.balance, Math.max(0, remaining));
  if (type?.serviceLimitMode === 'none') return 0;
  if (visit && type?.serviceLimitMode === 'some') max = Math.min(max, scopedSum(core, type.serviceLimitScope, visit, 'price'));
  if (type?.paymentLimitFixed) max = Math.min(max, type.paymentLimitFixed);
  const check = visit ? visitSums(visit).total : remaining;
  if (type?.paymentLimitPercent) max = Math.min(max, Math.floor((check * type.paymentLimitPercent) / 100));
  return Math.max(0, max);
}

export function getBonusChargeInfo(businessId: Id, cardId: Id, remaining: number, visit?: LoyaltyVisit): Promise<BonusChargeInfo> {
  return request(() => {
    const state = readArea(AREA);
    const card = state.cards.find((c) => c.id === cardId && c.businessId === businessId);
    if (!card) throw new ApiError('not_found');
    return { max: bonusMax(readCore(), state, card, remaining, visit), balance: card.balance };
  });
}

/** F-06-090: сколько визита сертификат может закрыть — по услугам, которые разрешает его тип */
function certificateCover(core: CoreData, state: LoyaltyArea, cert: Certificate, visit: LoyaltyVisit | undefined): number {
  if (!visit || visit.lines.length === 0) return Number.POSITIVE_INFINITY;
  const type = state.certificateTypes.find((t) => t.id === cert.certTypeId);
  if (!type || type.applyServicesMode === 'all') return visitSums(visit).total;
  if (type.applyServicesMode === 'none') return 0;
  return scopedSum(core, type.applyServiceScope, visit, 'price');
}

/** F-06-066/107: сколько визита закрывает абонемент — раздельный баланс только свои услуги, общий — все */
function membershipCover(core: CoreData, state: LoyaltyArea, m: Membership, visit: LoyaltyVisit | undefined): number {
  if (!visit || visit.lines.length === 0) return Number.POSITIVE_INFINITY;
  const type = state.membershipTypes.find((t) => t.id === m.membershipTypeId);
  if (!type || type.balanceMode === 'shared') return visitSums(visit).total;
  return visit.lines
    .filter((l) => {
      const svc = core.services.find((x) => x.id === l.serviceId);
      return type.services.some((line) => (line.serviceId && line.serviceId === l.serviceId) || (line.categoryId && svc && line.categoryId === svc.categoryId));
    })
    .reduce((sum, l) => sum + l.price, 0);
}

export type LoyaltyCodeSearchResult = { kind: 'certificate'; certificate: CertificateRow } | { kind: 'membership'; membership: MembershipRow } | { kind: 'none' };

/**
 * F-06-067/096/098/123: «Сертификат или абонемент [Номер] 🔍» — находит ЛЮБОГО клиента бизнеса (не только
 * держателя записи, F-06-096 «чужой сертификат находится по коду»); именные (без кода, F-06-092/113) никогда
 * не находятся — у них code='' и не совпадёт ни с каким вводом (F-06-098 «только владельцу»); истёкшие/
 * погашенные не находятся (F-06-067 «неверный или истёкший код ничего не находит»).
 */
export function findLoyaltyByCode(businessId: Id, code: string, locale = 'ru'): Promise<LoyaltyCodeSearchResult> {
  return request(() => {
    const trimmed = code.trim();
    if (!trimmed) return { kind: 'none' };
    const core = readCore();
    const state = readArea(AREA);
    const todayIso = todayISO();
    const cert = state.certificates.find((c) => c.businessId === businessId && c.code && c.code.toLowerCase() === trimmed.toLowerCase());
    if (cert) {
      const status = certificateStatus(cert, todayIso);
      if (status === 'active') {
        const type = state.certificateTypes.find((t) => t.id === cert.certTypeId);
        const client = cert.clientId ? clientOf(core, cert.clientId) : undefined;
        return {
          kind: 'certificate',
          certificate: {
            ...cert,
            status,
            typeName: type?.name ?? '',
            clientName: client?.name ?? '',
            clientPhone: client?.phone ?? '',
            locationName: locationNameOf(core, cert.locationId, locale),
            usedLocationNames: usedLocationsOf(state, core, cert.id, locale),
          },
        };
      }
      return { kind: 'none' };
    }
    const membership = state.memberships.find((m) => m.businessId === businessId && m.code && m.code.toLowerCase() === trimmed.toLowerCase());
    if (membership) {
      const status = membershipStatus(membership, todayIso);
      if (status === 'active' || status === 'issued') {
        const type = state.membershipTypes.find((t) => t.id === membership.membershipTypeId);
        const client = clientOf(core, membership.clientId);
        return {
          kind: 'membership',
          membership: {
            ...membership,
            status,
            typeName: type?.name ?? '',
            clientName: client?.name ?? '',
            clientPhone: client?.phone ?? '',
            locationName: locationNameOf(core, membership.locationId, locale),
          },
        };
      }
      return { kind: 'none' };
    }
    return { kind: 'none' };
  });
}

export type ReferralEligibility =
  | {
      ok: true;
      referrerClientId: Id;
      referrerCardId: Id;
      inviteeDiscount: number;
      referrerBonus: number;
    }
  | {
      ok: false;
      reason: 'inactive' | 'notFound' | 'self' | 'notFirstVisit' | 'referrerNoCard';
    };

/**
 * F-06-083/084: рефералка активна и настроена, приглашённый — впервые в бизнесе (F-06-084: у клиента с
 * прошлым «пришёл»-визитом варианта рефералки нет), пригласивший найден по телефону и уже держит карту
 * типа, на который настроена реферальная бонусная акция (❓ ТЗ, assumed: без карты нужного типа — не начисляем).
 */
export function getReferralEligibility(businessId: Id, referrerPhone: string, inviteeClientId: Id, remaining: number, visit?: LoyaltyVisit): Promise<ReferralEligibility> {
  return request(() => {
    const core = readCore();
    const state = readArea(AREA);
    const settings = state.referral[businessId];
    if (!settings?.active || !settings.inviteePromotionId || !settings.referrerPromotionId) return { ok: false, reason: 'inactive' };
    const hadVisit = core.bookings.some((b) => b.clientId === inviteeClientId && b.status === 'arrived' && b.id !== visit?.bookingId);
    if (hadVisit) return { ok: false, reason: 'notFirstVisit' };
    const q = referrerPhone.replace(/\D/g, '');
    const referrer = q ? core.clients.find((c) => c.businessId === businessId && c.phone.replace(/\D/g, '') === q) : undefined;
    if (!referrer) return { ok: false, reason: 'notFound' };
    if (referrer.id === inviteeClientId) return { ok: false, reason: 'self' };
    const referrerPromo = state.promotions.find((p) => p.id === settings.referrerPromotionId);
    const inviteePromo = state.promotions.find((p) => p.id === settings.inviteePromotionId);
    const referrerCard = referrerPromo ? state.cards.find((c) => c.clientId === referrer.id && c.businessId === businessId) : undefined;
    if (!referrerCard || !referrerPromo) return { ok: false, reason: 'referrerNoCard' };
    const inviteeDiscount = inviteePromo ? (visit && visit.lines.length ? promotionDiscountFor(core, inviteePromo, visit, []) : applyValue(inviteePromo.valueType, inviteePromo.value, remaining)) : 0;
    const base = visit && visit.lines.length ? visitSums(visit).total : remaining;
    const referrerBonus = referrerPromo.valueType === 'percent' ? Math.round((base * referrerPromo.value) / 100) : referrerPromo.value;
    return {
      ok: true,
      referrerClientId: referrer.id,
      referrerCardId: referrerCard.id,
      inviteeDiscount,
      referrerBonus: Math.max(0, referrerBonus),
    };
  });
}

export interface LoyaltyPaymentSummary {
  committed: boolean;
  total: number;
  lines: LoyaltyTransactionRow[];
}

/** Строки уже проведённой оплаты лояльностью визита (F-06-074) */
export function getLoyaltyPaymentSummary(businessId: Id, bookingId: Id, locale = 'ru'): Promise<LoyaltyPaymentSummary> {
  return request(() => {
    reconcileDeletedBookingPayments(businessId);
    const state = readArea(AREA);
    const committed = state.paidBookingIds.includes(bookingId);
    if (!committed) return { committed: false, total: 0, lines: [] };
    const core = readCore();
    const promosById = new Map(state.promotions.map((p) => [p.id, p]));
    const cardsById = new Map(state.cards.map((c) => [c.id, c]));
    const rows = state.transactions
      .filter((tx) => tx.businessId === businessId && tx.bookingId === bookingId && tx.type !== 'loyaltyAccrual')
      .map((tx) => {
        const client = clientOf(core, tx.clientId);
        return {
          ...tx,
          clientName: client?.name ?? '',
          clientPhone: client?.phone ?? '',
          promotionName: tx.promotionId ? promosById.get(tx.promotionId)?.name : undefined,
          locationName: locationNameOf(core, tx.locationId, locale),
          cardNumber: tx.cardId ? cardsById.get(tx.cardId)?.number : undefined,
        };
      });
    const total = rows.filter((r) => r.amount < 0).reduce((sum, r) => sum + Math.abs(r.amount), 0);
    return { committed: true, total, lines: rows };
  });
}

/** Проведённая строка лояльности: её id — refId строки платежа визита */
export interface CommittedLoyaltyLine {
  txId: Id;
  kind: LoyaltyPaymentLineKind;
  amount: number;
}

/**
 * F-06-063…067/083/084/096…098/123: провести строки лояльности одной мутацией. Движок сам держит правила, а не
 * вызывающий экран: скидка — одна на визит (Л4), бонусы — не больше лимитов типа карты, сертификат и абонемент —
 * только в пределах услуг, которые они покрывают (сумма строки подрезается до допустимой), однократный
 * сертификат сгорает остатком (Л8). Возвращает проведённые строки с фактическими суммами.
 */
export function commitLoyaltyPayment(businessId: Id, locationId: Id, bookingId: Id, clientId: Id, lines: LoyaltyPaymentLineInput[], visit?: LoyaltyVisit): Promise<CommittedLoyaltyLine[]> {
  return request(() => {
    if (lines.length === 0) return [];
    const core = readCore();
    const todayIso = todayISO();
    const out: CommittedLoyaltyLine[] = [];
    mutateArea(AREA, (s) => {
      const isDiscountLine = (kind: LoyaltyPaymentLineKind) => kind === 'promo' || kind === 'referral';
      const hadDiscount = s.transactions.some((tx) => tx.businessId === businessId && tx.bookingId === bookingId && tx.type === 'promoDiscount');
      if (lines.filter((l) => isDiscountLine(l.kind)).length + (hadDiscount && lines.some((l) => isDiscountLine(l.kind)) ? 1 : 0) > 1) throw new ApiError('discount_exists');
      const base = { businessId, locationId, clientId, bookingId, createdAt: nowDateTime() };
      for (const line of lines) {
        let amount = Math.max(0, Math.round(line.amount));
        const id = newId('ltx');
        if (line.kind === 'promo') {
          if (amount <= 0) throw new ApiError('validation');
          s.transactions.push({ ...base, id, type: 'promoDiscount', cardId: line.cardId, promotionId: line.promotionId, amount: -amount });
        } else if (line.kind === 'bonus') {
          const card = s.cards.find((c) => c.id === line.cardId && c.businessId === businessId);
          if (!card) throw new ApiError('not_found');
          amount = Math.min(amount, bonusMax(core, s, card, amount, visit));
          if (amount <= 0) throw new ApiError('bonus_unavailable');
          card.balance -= amount;
          s.transactions.push({ ...base, id, type: 'cardCharge', cardId: card.id, amount: -amount });
        } else if (line.kind === 'certificate') {
          const cert = s.certificates.find((c) => c.id === line.certificateId && c.businessId === businessId);
          if (!cert || cert.status !== 'active' || isCertificateExpired(cert.expiresAt, todayIso)) throw new ApiError('not_found');
          amount = Math.min(amount, cert.balance, certificateCover(core, s, cert, visit));
          if (amount <= 0) throw new ApiError('certificate_not_applicable');
          const type = s.certificateTypes.find((t) => t.id === cert.certTypeId);
          const { remainingBalance } = chargeCertificate(cert.balance, type?.chargeType ?? 'multiple', amount);
          const burnt = cert.balance - amount - remainingBalance;
          cert.balance = remainingBalance;
          if (cert.balance <= 0) cert.status = 'used';
          cert.usedLocationId = locationId;
          cert.usedAt = nowDateTime();
          cert.clientId = clientId; // F-06-097: переходит к тому, кто заплатил
          s.transactions.push({ ...base, id, type: 'certificateCharge', certificateId: cert.id, amount: -amount });
          // Л8: однократный сертификат — остаток сгорает после первой оплаты; отдельной строкой, чтобы отмена вернула и его
          if (burnt > 0) s.transactions.push({ ...base, id: newId('ltx'), type: 'expiredBurn', certificateId: cert.id, amount: -burnt, parentTxId: id });
        } else if (line.kind === 'membership') {
          const m = s.memberships.find((x) => x.id === line.membershipId && x.businessId === businessId);
          if (!m || !['active', 'issued'].includes(membershipStatus(m, todayIso))) throw new ApiError('not_found');
          amount = Math.min(amount, membershipCover(core, s, m, visit));
          if (amount <= 0) throw new ApiError('membership_not_applicable');
          m.balanceVisits = Math.max(0, m.balanceVisits - 1);
          if (m.status === 'issued') m.status = 'active';
          m.clientId = clientId; // F-06-124: переходит к тому, кто заплатил
          s.transactions.push({ ...base, id, type: 'membershipUse', membershipId: m.id, amount: -amount });
        } else if (line.kind === 'account') {
          // F-06-139/140: оплата со счёта — в пределах баланса и разрешённого минуса типа счёта
          const account = s.accounts.find((a) => a.id === line.accountId && a.businessId === businessId);
          const type = account ? s.accountTypes.find((t) => t.id === account.accountTypeId) : undefined;
          if (!account || !type) throw new ApiError('not_found');
          amount = Math.min(amount, Math.max(0, maxAccountCharge(account.balance, type)));
          if (amount <= 0) throw new ApiError('validation');
          account.balance -= amount;
          s.accountOperations.push({ id: newId('lop'), businessId, accountId: account.id, type: 'charge', amount: -amount, createdAt: nowDateTime() });
          s.transactions.push({ ...base, id, type: 'accountCharge', accountId: account.id, amount: -amount });
        } else if (line.kind === 'referral') {
          if (amount <= 0) throw new ApiError('validation');
          s.transactions.push({ ...base, id, type: 'promoDiscount', promotionId: line.promotionId, amount: -amount });
          if (line.referrerCardId && line.referrerBonusAmount) {
            const referrerCard = s.cards.find((c) => c.id === line.referrerCardId);
            if (referrerCard) referrerCard.balance += line.referrerBonusAmount;
            s.transactions.push({ ...base, id: newId('ltx'), type: 'referralAccrual', clientId: line.referrerClientId!, cardId: line.referrerCardId, amount: line.referrerBonusAmount, parentTxId: id });
          }
        }
        out.push({ txId: id, kind: line.kind, amount });
      }
      if (!s.paidBookingIds.includes(bookingId)) s.paidBookingIds.push(bookingId);
    });
    return out;
  });
}

/** Вернуть то, что сделала одна транзакция оплаты (без удаления самой строки) */
function undoLoyaltyTx(s: LoyaltyArea, tx: LoyaltyTransaction): void {
  if (tx.type === 'cardCharge' && tx.cardId) {
    const card = s.cards.find((c) => c.id === tx.cardId);
    if (card) card.balance += Math.abs(tx.amount);
  } else if ((tx.type === 'certificateCharge' || tx.type === 'expiredBurn') && tx.certificateId) {
    const cert = s.certificates.find((c) => c.id === tx.certificateId);
    if (cert) {
      cert.balance = Math.min(cert.nominal, cert.balance + Math.abs(tx.amount));
      if (cert.balance > 0) cert.status = 'active';
    }
  } else if (tx.type === 'membershipUse' && tx.membershipId) {
    const m = s.memberships.find((x) => x.id === tx.membershipId);
    if (m) m.balanceVisits = Math.min(m.totalVisits, m.balanceVisits + 1);
  } else if (tx.type === 'accountCharge' && tx.accountId) {
    const account = s.accounts.find((a) => a.id === tx.accountId);
    if (account) account.balance += Math.abs(tx.amount);
    s.accountOperations.push({ id: newId('lop'), businessId: tx.businessId, accountId: tx.accountId, type: 'topup', amount: Math.abs(tx.amount), createdAt: nowDateTime() });
  } else if ((tx.type === 'referralAccrual' || tx.type === 'loyaltyAccrual') && tx.cardId) {
    const card = s.cards.find((c) => c.id === tx.cardId);
    if (card) card.balance = Math.max(0, card.balance - tx.amount);
  }
}

/**
 * F-06-074 (Л1): отменить одну строку оплаты лояльностью — вернуть списанное и снять порождённые ею строки
 * (сгоревший остаток сертификата, бонус пригласившему). Идемпотентно: уже отменённая — ничего не делает.
 */
export function reverseLoyaltyLine(businessId: Id, bookingId: Id, txId: Id): Promise<void> {
  return request(() => {
    mutateArea(AREA, (s) => {
      const tx = s.transactions.find((x) => x.id === txId && x.businessId === businessId);
      if (!tx) return;
      const group = [tx, ...s.transactions.filter((x) => x.parentTxId === txId)];
      for (const x of group) undoLoyaltyTx(s, x);
      const ids = new Set(group.map((x) => x.id));
      s.transactions = s.transactions.filter((x) => !ids.has(x.id));
      if (!s.transactions.some((x) => x.bookingId === bookingId && x.type !== 'loyaltyAccrual')) s.paidBookingIds = s.paidBookingIds.filter((id) => id !== bookingId);
    });
  });
}

/**
 * F-06-074: «Отменить оплату лояльностью» целиком — все строки визита и начисленный за него кэшбэк (Л6).
 * Идемпотентно: у визита без оплаты лояльностью ничего не делает.
 */
export function reverseLoyaltyPayment(businessId: Id, bookingId: Id): Promise<void> {
  return request(() => {
    mutateArea(AREA, (s) => {
      reverseLoyaltyPaymentLines(s, businessId, bookingId, true);
    });
  });
}

// ─────────────────────────── Оплата визита: лояльность + строки платежей (Л1) ───────────────────────────

const JOURNAL_METHOD: Record<LoyaltyPaymentLineKind, JournalPaymentMethod> = {
  promo: 'promotion',
  referral: 'promotion',
  bonus: 'card_bonus',
  certificate: 'certificate',
  membership: 'membership',
  account: 'personal_account',
};

/** Строка платежа визита, проведённая движком лояльности (refId — id её транзакции) */
export function isLoyaltyPaymentRef(refId: string | undefined): refId is string {
  return Boolean(refId && refId.startsWith('ltx_'));
}

/** Скидочная строка платежа визита (акция, «Приведи друга») — «одна скидка на визит» (Л4) */
export function isDiscountPayment(method: string): boolean {
  return method === 'promotion';
}

export interface PayVisitWithLoyaltyArgs {
  businessId: Id;
  locationId: Id;
  bookingId: Id;
  clientId: Id;
  lines: LoyaltyPaymentLineInput[];
  visit: LoyaltyVisit;
  /** Подпись строки платежа — на языке экрана */
  labelOf: (line: CommittedLoyaltyLine, index: number) => string;
  /** Подпись строки во вкладке «Оплата» (finance) — по умолчанию та же */
  financeLabelOf?: (line: CommittedLoyaltyLine, index: number) => string;
}

/**
 * Л1: провести лояльность и записать её строками в платежи визита — одна операция для обеих вкладок окна записи.
 * Если платёж визита не записался, списанное лояльностью возвращается (компенсация), кэшбэк пересчитывается.
 */
export async function payVisitWithLoyalty({ businessId, locationId, bookingId, clientId, lines, visit, labelOf, financeLabelOf = labelOf }: PayVisitWithLoyaltyArgs): Promise<BookingExtras> {
  const committed = await commitLoyaltyPayment(businessId, locationId, bookingId, clientId, lines, visit);
  let extras: BookingExtras;
  try {
    extras = await payBookingLines(
      bookingId,
      committed.map((c, i) => ({ method: JOURNAL_METHOD[c.kind], amount: c.amount, label: labelOf(c, i), refId: c.txId })),
    );
  } catch (error) {
    for (const c of committed) await reverseLoyaltyLine(businessId, bookingId, c.txId);
    throw error;
  }
  await mirrorToFinance(businessId, bookingId, committed.map((c, i) => ({ txId: c.txId, amount: c.amount, label: financeLabelOf(c, i) })));
  await syncBookingCashback(businessId, locationId, clientId, bookingId, await visitPaymentsForCashback(businessId, bookingId, extras.payments ?? []), visit);
  return extras;
}

/**
 * Л1: вкладка «Оплата» окна записи (раздел finance) ведёт свои строки платежей визита. Чтобы её «К оплате»
 * совпадало с вкладкой «Лояльность», каждая проведённая строка лояльности ложится туда строкой-скидкой
 * (addBookingPromoDiscount — вход, который finance даёт соседям), а её id запоминается в транзакции:
 * отмена строки лояльности снимает и её. Нет права/суммы в finance — оплата лояльностью всё равно проведена.
 */
async function mirrorToFinance(businessId: Id, bookingId: Id, lines: { txId: Id; amount: number; label: string }[]): Promise<void> {
  for (const line of lines) {
    try {
      const before = await getBookingPaymentSummary(businessId, bookingId);
      const known = new Set(before.payments.map((p) => p.id));
      const after = await addBookingPromoDiscount(businessId, bookingId, line.label, line.amount);
      const added = after.payments.find((p) => !known.has(p.id));
      if (added) await setTxFinanceLine(businessId, line.txId, added.id);
    } catch {
      // finance не принял строку (визит там уже закрыт) — лояльность проведена, расхождение видно в «Оплате»
    }
  }
}

function setTxFinanceLine(businessId: Id, txId: Id, financeLineId: Id): Promise<void> {
  return request(() => {
    mutateArea(AREA, (s) => {
      const tx = s.transactions.find((x) => x.id === txId && x.businessId === businessId);
      if (tx) tx.financeLineId = financeLineId;
    });
  });
}

function financeLinesOf(businessId: Id, bookingId: Id, txId?: Id): Promise<Id[]> {
  return request(() =>
    readArea(AREA)
      .transactions.filter((tx) => tx.businessId === businessId && tx.bookingId === bookingId && tx.financeLineId && (!txId || tx.id === txId))
      .map((tx) => tx.financeLineId!),
  );
}

/**
 * Л6: деньги за визит принимают и окно «Оплата визита» (journal), и вкладка «Оплата» (finance) — база кэшбэка
 * складывается из обоих; строки лояльности (скидки в finance) деньгами не считаются.
 */
export async function visitPaymentsForCashback(businessId: Id, bookingId: Id, journalPayments: { method: string; amount: number }[]): Promise<{ method: string; amount: number }[]> {
  try {
    const summary = await getBookingPaymentSummary(businessId, bookingId);
    const finance = summary.payments
      .filter((p) => !p.cancelled && p.kind !== 'discount')
      .map((p) => ({ method: p.kind === 'account' ? 'personal_account' : 'cash', amount: p.amount - (p.refundedAmount ?? 0) }));
    return [...journalPayments, ...finance];
  } catch {
    return journalPayments;
  }
}

async function unmirrorFromFinance(businessId: Id, lineIds: Id[]): Promise<void> {
  for (const id of lineIds) {
    try {
      await removeBookingPaymentLine(businessId, id);
    } catch {
      // строку уже сняли во вкладке «Оплата»
    }
  }
}

export interface CancelVisitPaymentArgs {
  businessId: Id;
  locationId: Id;
  bookingId: Id;
  clientId?: Id;
  visit: LoyaltyVisit;
}

/** Л1: убрать одну строку платежа визита; строка лояльности сначала возвращает списанное; кэшбэк — по новой оплате */
export async function cancelVisitPaymentLine({ businessId, locationId, bookingId, clientId, visit }: CancelVisitPaymentArgs, line: { id: Id; refId?: Id }): Promise<BookingExtras> {
  if (isLoyaltyPaymentRef(line.refId)) {
    const financeIds = await financeLinesOf(businessId, bookingId, line.refId);
    await reverseLoyaltyLine(businessId, bookingId, line.refId);
    await unmirrorFromFinance(businessId, financeIds);
  }
  const extras = await cancelPaymentLine(bookingId, line.id);
  if (clientId) await syncBookingCashback(businessId, locationId, clientId, bookingId, await visitPaymentsForCashback(businessId, bookingId, extras.payments ?? []), visit);
  return extras;
}

/** Л1/Л6: «Отменить оплату» визита целиком — лояльность возвращается, кэшбэк снимается */
export async function cancelVisitPayments({ businessId, bookingId }: CancelVisitPaymentArgs): Promise<BookingExtras> {
  const financeIds = await financeLinesOf(businessId, bookingId);
  await reverseLoyaltyPayment(businessId, bookingId);
  await unmirrorFromFinance(businessId, financeIds);
  return cancelBookingPayment(bookingId);
}

export function listAccountOperations(businessId: Id, filter: AccountOperationsFilter = {}): Promise<AccountOperationRow[]> {
  return request(() => {
    const core = readCore();
    const state = readArea(AREA);
    const accountsById = new Map(state.accounts.map((a) => [a.id, a]));
    const typesById = new Map(state.accountTypes.map((t) => [t.id, t]));
    let rows = state.accountOperations.filter((op) => op.businessId === businessId);
    if (filter.type) rows = rows.filter((op) => op.type === filter.type);
    if (filter.authorStaffId) rows = rows.filter((op) => op.authorStaffId === filter.authorStaffId);
    if (filter.dateFrom) rows = rows.filter((op) => op.createdAt >= filter.dateFrom!);
    if (filter.dateTo) rows = rows.filter((op) => op.createdAt <= `${filter.dateTo}T23:59:59`);
    if (filter.accountTypeId) rows = rows.filter((op) => accountsById.get(op.accountId)?.accountTypeId === filter.accountTypeId);
    return rows
      .map((op) => {
        const account = accountsById.get(op.accountId);
        const client = account ? clientOf(core, account.clientId) : undefined;
        const author = op.authorStaffId ? core.staff.find((s) => s.id === op.authorStaffId) : undefined;
        return {
          ...op,
          typeName: account ? (typesById.get(account.accountTypeId)?.name ?? '') : '',
          clientId: account?.clientId,
          clientName: client?.name ?? '',
          clientPhone: client?.phone ?? '',
          authorName: author?.name,
        };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });
}

// ─────────────────────────── Онлайн-продажи (F-06-148/149/151/152/153, пачка b05) ───────────────────────────

export function getOnlineSalePayment(businessId: Id): Promise<OnlineSalePaymentSettings> {
  return request(() => readArea(AREA).onlineSalePayment[businessId] ?? defaultOnlineSalePayment());
}

export function setOnlineSalePayment(businessId: Id, value: OnlineSalePaymentSettings): Promise<OnlineSalePaymentSettings> {
  return request(() => {
    mutateArea(AREA, (s) => {
      s.onlineSalePayment[businessId] = value;
    });
    return value;
  });
}

export function getOnlineSaleWidget(businessId: Id): Promise<OnlineSaleWidgetSettings> {
  return request(() => readArea(AREA).onlineSaleWidget[businessId] ?? defaultOnlineSaleWidget());
}

export function setOnlineSaleWidget(businessId: Id, value: OnlineSaleWidgetSettings): Promise<OnlineSaleWidgetSettings> {
  return request(() => {
    mutateArea(AREA, (s) => {
      s.onlineSaleWidget[businessId] = value;
    });
    return value;
  });
}

export interface OnlineSaleCatalogItem {
  kind: OnlineOrderItemKind;
  typeId: Id;
  name: string;
  price: number;
  imageUrl?: string;
  description?: string;
}

/** F-06-149/151: каталог витрины — типы сертификатов/абонементов с включённым «Доступно для продажи онлайн» (F-06-147) */
export function listOnlineSaleCatalog(businessId: Id, locale = 'ru'): Promise<OnlineSaleCatalogItem[]> {
  return request(() => {
    const state = readArea(AREA);
    const loc = locale as 'ru';
    const certs: OnlineSaleCatalogItem[] = state.certificateTypes
      .filter((t) => t.businessId === businessId && t.onlineSale.enabled)
      .map((t) => ({
        kind: 'certificate' as const,
        typeId: t.id,
        name: (t.onlineSale.title?.[loc] ?? t.onlineSale.title?.ru) || t.name,
        price: t.onlineSale.price ?? t.nominal,
        imageUrl: t.onlineSale.imageUrl,
        description: t.onlineSale.description?.[loc] ?? t.onlineSale.description?.ru,
      }));
    const memberships: OnlineSaleCatalogItem[] = state.membershipTypes
      .filter((t) => t.businessId === businessId && !t.archived && t.onlineSale.enabled)
      .map((t) => ({
        kind: 'membership' as const,
        typeId: t.id,
        name: (t.onlineSale.title?.[loc] ?? t.onlineSale.title?.ru) || t.name,
        price: t.onlineSale.price ?? t.price,
        imageUrl: t.onlineSale.imageUrl,
        description: t.onlineSale.description?.[loc] ?? t.onlineSale.description?.ru,
      }));
    return [...certs, ...memberships];
  });
}

export interface OnlineOrderInput {
  itemKind: OnlineOrderItemKind;
  itemTypeId: Id;
  clientId?: Id;
  clientName: string;
  clientPhone: string;
  locationId: Id;
}

/** F-06-151: покупка клиентом онлайн — создаёт заказ «Ждёт оплаты» (пока безнал выключен — всегда этот путь, F-06-148) */
export function createOnlineOrder(businessId: Id, input: OnlineOrderInput): Promise<OnlineOrder> {
  return request(() => {
    if (!input.clientName.trim() || !input.clientPhone.trim()) throw new ApiError('validation');
    const state = readArea(AREA);
    const item = input.itemKind === 'certificate' ? state.certificateTypes.find((t) => t.id === input.itemTypeId && t.businessId === businessId && t.onlineSale.enabled) : state.membershipTypes.find((t) => t.id === input.itemTypeId && t.businessId === businessId && t.onlineSale.enabled);
    if (!item) throw new ApiError('not_found');
    const price = item.onlineSale.price ?? (input.itemKind === 'certificate' ? (item as CertificateType).nominal : (item as MembershipType).price);
    const order: OnlineOrder = {
      id: newId('loo'),
      businessId,
      itemKind: input.itemKind,
      itemTypeId: input.itemTypeId,
      itemName: item.name,
      price,
      clientId: input.clientId,
      clientName: input.clientName.trim(),
      clientPhone: input.clientPhone.trim(),
      locationId: input.locationId,
      status: 'pendingPayment',
      createdAt: nowDateTime(),
    };
    mutateArea(AREA, (s) => {
      s.onlineOrders.push(order);
    });
    return order;
  });
}

export interface OnlineOrdersFilter {
  status?: OnlineOrderStatus;
}

/** F-06-152: список заказов для обработки («Другой способ» — без платёжной системы, поэтому решение вручную) */
export function listOnlineOrders(businessId: Id, filter: OnlineOrdersFilter = {}): Promise<OnlineOrder[]> {
  return request(() => {
    let rows = readArea(AREA).onlineOrders.filter((o) => o.businessId === businessId);
    if (filter.status) rows = rows.filter((o) => o.status === filter.status);
    return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });
}

/**
 * F-06-152: «Подтвердить» — деньги пришли «Другим способом»: выпускаем сертификат/абонемент клиенту через
 * те же sellCertificate/sellMembership, что и ручная продажа (единая точка правды для номера/срока/движка).
 */
export async function confirmOnlineOrder(businessId: Id, orderId: Id, sellerId?: Id): Promise<OnlineOrder> {
  const state = readArea(AREA);
  const order = state.onlineOrders.find((o) => o.id === orderId && o.businessId === businessId);
  if (!order) throw new ApiError('not_found');
  if (order.status !== 'pendingPayment') throw new ApiError('validation');
  let issuedId: Id;
  if (order.itemKind === 'certificate') {
    const type = state.certificateTypes.find((t) => t.id === order.itemTypeId)!;
    if (!order.clientId && !type.allowNoCode) throw new ApiError('validation');
    const created = await sellCertificate(businessId, {
      certTypeId: order.itemTypeId,
      clientId: order.clientId,
      code: order.clientId ? undefined : `ON-${order.id.slice(-6).toUpperCase()}`,
      locationId: order.locationId,
      sellerId,
      price: order.price,
    });
    issuedId = created.id;
  } else {
    const type = state.membershipTypes.find((t) => t.id === order.itemTypeId)!;
    if (!order.clientId) throw new ApiError('validation'); // F-06-151: абонемент — именной, нужен клиент базы
    const created = await sellMembership(businessId, {
      membershipTypeId: order.itemTypeId,
      clientId: order.clientId,
      code: type.allowNoCode ? undefined : `ON-${order.id.slice(-6).toUpperCase()}`,
      locationId: order.locationId,
      sellerId,
      price: order.price,
    });
    issuedId = created.id;
  }
  return request(() => {
    let updated: OnlineOrder | undefined;
    mutateArea(AREA, (s) => {
      const o = s.onlineOrders.find((x) => x.id === orderId)!;
      o.status = 'confirmed';
      o.processedAt = nowDateTime();
      o.issuedId = issuedId;
      updated = o;
    });
    return updated!;
  });
}

/** F-06-152: «Отклонить» заказ, не дошедший до оплаты */
export function rejectOnlineOrder(businessId: Id, orderId: Id): Promise<OnlineOrder> {
  return request(() => {
    let updated: OnlineOrder | undefined;
    mutateArea(AREA, (s) => {
      const order = s.onlineOrders.find((o) => o.id === orderId && o.businessId === businessId);
      if (!order) throw new ApiError('not_found');
      if (order.status !== 'pendingPayment') throw new ApiError('validation');
      order.status = 'rejected';
      order.processedAt = nowDateTime();
      updated = order;
    });
    return updated!;
  });
}

/** F-06-152: возврат уже подтверждённого заказа (деньги вернули вручную — «Другой способ») */
export function refundOnlineOrder(businessId: Id, orderId: Id): Promise<OnlineOrder> {
  return request(() => {
    let updated: OnlineOrder | undefined;
    mutateArea(AREA, (s) => {
      const order = s.onlineOrders.find((o) => o.id === orderId && o.businessId === businessId);
      if (!order) throw new ApiError('not_found');
      if (order.status !== 'confirmed') throw new ApiError('validation');
      order.status = 'refunded';
      order.processedAt = nowDateTime();
      updated = order;
    });
    return updated!;
  });
}

// ─────────────────────────── Altegio.me: лояльность клиента в приложении (F-06-158/162, пачка b05) ───────────────────────────

export interface MyLoyaltyCard {
  id: Id;
  cardTypeName: string;
  number: string;
  balance: number;
}

export interface MyLoyaltyCertificate {
  id: Id;
  typeName: string;
  balance: number;
  nominal: number;
  expiresAt?: string;
  status: CertificateStatus;
}

export interface MyLoyaltyMembership {
  id: Id;
  typeName: string;
  balanceVisits: number;
  totalVisits: number;
  expiresAt: string;
  status: MembershipStatus;
  /**
   * F-06-160 «Напоминание об окончании абонемента в Altegio.me»: тот же порог, что владелец задал в
   * настройках типа (`notify.expiry.daysBefore`, вкладка «Уведомления» — F-06-118/119, уже построена);
   * здесь только читаем его, чтобы решить, показывать ли предупреждение в профиле клиента.
   */
  expiringSoon: boolean;
}

export interface MyLoyaltyBusiness {
  businessId: Id;
  businessName: string;
  businessSlug: string;
  cards: MyLoyaltyCard[];
  certificates: MyLoyaltyCertificate[];
  memberships: MyLoyaltyMembership[];
  /** F-06-156: сумма баланса всех бонусных карт клиента в этом бизнесе («кэшбэк» — F-06-028 cashbackVisibleInApp уже отфильтровал скрытые) */
  cashbackTotal: number;
}

/**
 * F-06-158/162: вся лояльность клиента приложения по бизнесам, где у него есть карта/абонемент/сертификат —
 * appUser связан со «своим» client-профилем каждого бизнеса через Client.appUserId (ядро). Бизнесы без
 * лояльности клиента в список не попадают (пустое приложение показывает EmptyState).
 */
export function listMyLoyalty(appUserId: Id): Promise<MyLoyaltyBusiness[]> {
  return request(() => {
    const core = readCore();
    const state = readArea(AREA);
    const myClients = core.clients.filter((c) => c.appUserId === appUserId);
    const result: MyLoyaltyBusiness[] = [];
    for (const client of myClients) {
      const cardTypesById = new Map(state.cardTypes.filter((t) => t.businessId === client.businessId).map((t) => [t.id, t]));
      const certTypesById = new Map(state.certificateTypes.filter((t) => t.businessId === client.businessId).map((t) => [t.id, t]));
      const memTypesById = new Map(state.membershipTypes.filter((t) => t.businessId === client.businessId).map((t) => [t.id, t]));
      // F-00-130/В-06: карта, чей тип выключил показ баланса клиенту (cashbackVisibleInApp: false),
      // в приложении клиента не показывается вовсе — салон вправе не раскрывать программу лояльности.
      const cards = state.cards
        .filter((c) => c.businessId === client.businessId && c.clientId === client.id && cardTypesById.get(c.cardTypeId)?.cashbackVisibleInApp !== false)
        .map((c) => ({
          id: c.id,
          cardTypeName: cardTypesById.get(c.cardTypeId)?.name ?? '',
          number: c.number,
          balance: c.balance,
        }));
      const certificates = state.certificates
        .filter((c) => c.businessId === client.businessId && c.clientId === client.id)
        .map((c) => ({
          id: c.id,
          typeName: certTypesById.get(c.certTypeId)?.name ?? '',
          balance: c.balance,
          nominal: c.nominal,
          expiresAt: c.expiresAt,
          status: c.status,
        }));
      const memberships = state.memberships
        .filter((m) => m.businessId === client.businessId && m.clientId === client.id)
        .map((m) => {
          const daysBefore = memTypesById.get(m.membershipTypeId)?.notify?.expiry.daysBefore;
          const status = membershipStatus(m, todayISO());
          const expiringSoon = status === 'active' && Boolean(daysBefore) && dayjs(m.expiresAt).diff(dayjs(), 'day') <= daysBefore!;
          return {
            id: m.id,
            typeName: memTypesById.get(m.membershipTypeId)?.name ?? '',
            balanceVisits: m.balanceVisits,
            totalVisits: m.totalVisits,
            expiresAt: m.expiresAt,
            status,
            expiringSoon,
          };
        });
      if (cards.length === 0 && certificates.length === 0 && memberships.length === 0) continue;
      const business = core.businesses.find((b) => b.id === client.businessId);
      result.push({
        businessId: client.businessId,
        businessName: business?.name ?? '',
        businessSlug: business?.slug ?? '',
        cards,
        certificates,
        memberships,
        cashbackTotal: cards.reduce((sum, c) => sum + c.balance, 0),
      });
    }
    return result;
  });
}

export { financeLinesOf, setTxFinanceLine };
