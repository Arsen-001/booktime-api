// @ts-nocheck — СГЕНЕРИРОВАНО scripts/sync-loyalty-port.mjs из booking-platform/src/domain/loyalty.ts; руками не править.
// Типы проверяет tsc фронта (noUncheckedIndexedAccess у фронта выключен, у сервера включён — отсюда nocheck).
/**
 * Типы раздела «loyalty» (F-06-*, пачка b01 — каркас и главные списки).
 * Деньги — целые драмы (F-00-002, F-06-198): 1 бонус = 1 ֏, никакого отдельного курса.
 * Ссылки на сущности ядра — по Id (import type { Id } from './core-types.js').
 */
import type { Id, ISODate, ISODateTime, LocalizedText } from './core-types.js';

// ─────────────────────────── Уведомления (F-06-029, F-06-049, F-06-118…120, пачка b03) ───────────────────────────

/**
 * По решению F-00-120 канал — пуш в приложении клиента, а не SMS/чат-бот. У каждого события — 3 готовых
 * текста (шаблон подставляется словарём с переменными) или «свой» (customText на ru/en, F-00-172/§0.4).
 */
export type NotifyTemplateKind = 'template1' | 'template2' | 'template3' | 'custom';

export interface NotifyMessageSetting {
  enabled: boolean;
  templateKind: NotifyTemplateKind;
  customText?: LocalizedText;
}

export function defaultNotifySetting(): NotifyMessageSetting {
  return { enabled: false, templateKind: 'template1' };
}

// ─────────────────────────── Витрина онлайн-продаж (F-06-147) ───────────────────────────

/** Общая настройка «Доступно для продажи онлайн» у типа абонемента/сертификата */
export interface OnlineSaleSettings {
  enabled: boolean;
  title?: LocalizedText;
  imageUrl?: string;
  description?: LocalizedText;
  /** ֏; может отличаться от номинала/стоимости — у сертификата это даёт скидку в виджете (F-06-147) */
  price?: number;
}

export function defaultOnlineSale(): OnlineSaleSettings {
  return { enabled: false };
}

// ─────────────────────────── Типы карт и карты ───────────────────────────

/** F-06-022: откуда брать сумму продано/оплачено/визитов для накопительных акций с источником «Карта» */
export type CardSourceScope = 'network' | 'activeLocations';

/** F-06-024: кому выпускать карту автоматически */
export type AutoIssueMode = 'none' | 'anyLocation' | 'connected';

/** F-06-026: «все / ничего / некоторые» — общий вид для ограничения списания баллов */
export type ScopeLimitMode = 'all' | 'none' | 'some';

export interface CardType {
  id: Id;
  businessId: Id;
  name: string;
  /** «Действует в локациях» (F-06-023) — филиалы владельца, где картой можно пользоваться */
  locationIds: Id[];
  /** F-06-022, по умолчанию 'activeLocations' */
  sourceScope: CardSourceScope;
  /** F-06-024, по умолчанию 'none' */
  autoIssueMode: AutoIssueMode;
  /** F-06-025: дней с последнего визита до сгорания; undefined/0 = «не применять» */
  burnDays?: number;
  /** F-06-026 — услуги */
  serviceLimitMode: ScopeLimitMode;
  serviceLimitScope?: ServiceScope;
  /** F-06-026 — товары (упрощённо: своего каталога товаров у раздела нет, только режим) */
  productLimitMode: ScopeLimitMode;
  /** F-06-027, ֏, по умолчанию 0 = без ограничения */
  paymentLimitFixed: number;
  /** F-06-027, % от чека, по умолчанию 0 = без ограничения */
  paymentLimitPercent: number;
  /** F-06-028, по умолчанию true */
  cashbackVisibleInApp: boolean;
  /** Л16: бонусов на день рождения держателя, ֏; 0/нет — не начислять */
  birthdayBonus?: number;
  /** F-06-029 — уведомления о выпуске/начислении/списании (вкладка появляется после создания типа) */
  notify?: CardTypeNotify;
  /**
   * F-06-030/questions-q4 В-40: у типа с выданными картами «Удалить» недоступно — вместо каскадного
   * удаления «В архив»: не выдаётся и не продаётся, выданные карты работают до конца срока.
   */
  archived?: boolean;
  createdAt: ISODateTime;
  updatedAt?: ISODateTime;
}

/** F-06-029 */
export interface CardTypeNotify {
  issue: NotifyMessageSetting;
  accrual: NotifyMessageSetting;
  charge: NotifyMessageSetting;
}

export function defaultCardTypeNotify(): CardTypeNotify {
  return {
    issue: defaultNotifySetting(),
    accrual: defaultNotifySetting(),
    charge: defaultNotifySetting(),
  };
}

export interface LoyaltyCard {
  id: Id;
  businessId: Id;
  cardTypeId: Id;
  clientId: Id;
  number: string;
  /** Баланс бонусов, ֏ (F-06-198) */
  balance: number;
  maxPercentDiscount?: number;
  maxFixedDiscount?: number;
  createdAt: ISODateTime;
}

// ─────────────────────────── Акции ───────────────────────────

export type PromotionKind = 'discountFixed' | 'discountAccumVisits' | 'discountAccumSum' | 'discountConditional' | 'cashbackFixed' | 'cashbackAccumVisits' | 'cashbackAccumSum' | 'cashbackVisit';

export const PROMOTION_KINDS: PromotionKind[] = ['discountFixed', 'discountAccumVisits', 'discountAccumSum', 'discountConditional', 'cashbackFixed', 'cashbackAccumVisits', 'cashbackAccumSum', 'cashbackVisit'];

/** Скидка выражается в акции; бонусные виды («cashback…») дают кэшбэк, а не мгновенную скидку */
export function isDiscountKind(kind: PromotionKind): boolean {
  return kind.startsWith('discount');
}

/**
 * F-06-005: на какие услуги/товары действует программа. По нашему решению F-00-049 миграции в сеть нет —
 * каталог услуг у владельца общий сразу, поэтому здесь просто id категорий/услуг из его каталога.
 * Пустой categoryIds + пустой serviceIds = «все услуги» (по умолчанию для старых акций без ограничения).
 * Категория целиком — это её id в categoryIds, а не список услуг на момент сохранения: услугу, добавленную
 * в категорию позже, программа подхватывает сама (разворачивается при использовании, не при сохранении).
 */
export interface ServiceScope {
  categoryIds: Id[];
  serviceIds: Id[];
}

/** F-06-034: размер задан процентом от суммы или фиксированной суммой */
export type PromotionValueType = 'percent' | 'fixed';

/** F-06-039: какую сумму копить в накопительных правилах — по прайсу или с учётом скидок */
export type PromotionSumBasis = 'listPrice' | 'afterDiscounts';

/** F-06-045: источник данных для истории визитов/сумм накопительных акций */
export type PromotionSourceScope = 'network' | 'activeLocations' | 'card';

/** Строка таблицы порогов (F-06-038, F-06-039, F-06-042, F-06-043, F-06-044): «от N → размер» */
export interface PromotionThreshold {
  from: number;
  value: number;
}

/** Виды акций, у которых на шаге 3 есть таблица порогов вместо одного размера */
export const ACCUMULATING_KINDS: PromotionKind[] = ['discountAccumVisits', 'discountAccumSum', 'cashbackAccumVisits', 'cashbackAccumSum', 'cashbackVisit'];

/** «Продано / Оплачено» как базу считают только виды, где на шаге 3 выбирают сумму (F-06-039, F-06-048) */
export const SUM_BASIS_KINDS: PromotionKind[] = ['discountAccumSum', 'cashbackAccumSum', 'cashbackVisit'];

/** Бонусные виды, где применимы частота/лимит применений (F-06-046) */
export const FREQUENCY_LIMIT_KINDS: PromotionKind[] = ['cashbackFixed', 'cashbackAccumVisits', 'cashbackAccumSum', 'cashbackVisit'];

export interface Promotion {
  id: Id;
  businessId: Id;
  name: string;
  kind: PromotionKind;
  /** Акция = правило на ТИПЕ карты (F-06-004); одна акция может стоять на нескольких типах (F-06-082: у рефералки — ни одного) */
  cardTypeIds: Id[];
  /** F-06-034 */
  valueType: PromotionValueType;
  /** % или ֏ — размер для нетаблично заданных видов (discountFixed, cashbackFixed) */
  value: number;
  /** F-06-038, F-06-039, F-06-042, F-06-043, F-06-044 — таблица порогов для накопительных видов */
  thresholds?: PromotionThreshold[];
  /** F-06-040 — «за какое количество услуг выдавать скидку» (n−1: настройка 5 = бесплатна 6-я) */
  conditionCount?: number;
  /** F-06-040 — по каким услугам копятся посещения */
  conditionServiceIds?: Id[];
  /** F-06-045 — только для накопительных видов */
  sourceScope?: PromotionSourceScope;
  /** F-06-045 */
  historyStartDate?: ISODate;
  /** F-06-039 — обязательно для «накопительная скидка от суммы» и любых бонусов «от суммы»/«в рамках визита» */
  sumBasis?: PromotionSumBasis;
  /** F-06-046 — 1 = каждый визит, 3 = каждый третий; по умолчанию 1 */
  applyFrequency?: number;
  /** F-06-046 — 0 = без лимита */
  applyLimit?: number;
  /** F-06-047 — дней с последнего визита до отмены накопленной скидки; undefined = не отменять */
  cancelAfterDays?: number;
  /** F-06-047 — дней до сгорания неиспользованных бонусов; undefined = не сжигать */
  burnAfterDays?: number;
  /** F-06-049/шаг 5 — включены ли уведомления акции (содержимое шаблонов — пачка b03) */
  notifyEnabled?: boolean;
  /** F-06-036 — «в каких локациях действует»; нет поля/пусто = во всех локациях сети */
  locationIds?: Id[];
  /** F-06-035 — услуги, которыми можно оплатить скидкой/на которые действует бонус */
  serviceScope?: ServiceScope;
  /** F-06-035 — товары, упрощённо (без каталога товаров у раздела) */
  productLimitMode?: ScopeLimitMode;
  /** F-06-049/шаг 5 — тексты уведомлений (только для доступных виду типов: discountChange/cashbackChange
   *  всегда, cancelSoon только если задан cancelAfterDays, burnSoon только если задан burnAfterDays) */
  notify?: PromotionNotify;
  /**
   * F-06-183 «Акции по расписанию» (упоминание на сайте Altegio, без отдельного ТЗ-блока — 1:1 по названию,
   * ❓ решаем как «действует по дням недели и часам»): без расписания (enabled=false) — акция действует всегда
   * в эти дни/часы, пока активна.
   */
  schedule?: PromotionSchedule;
  /**
   * F-06-183 «Готово, когда»: «акцию можно ограничить датами действия» — отдельно от расписания по дням недели
   * выше: `validFrom`/`validTo` (ISODate, включительно) — период, в который акция вообще действует; без них —
   * бессрочно. Например: «Скидка ко Дню города» с 1 по 10 сентября, но только с 12:00 до 18:00 каждый день —
   * оба ограничения сочетаются в `isPromotionActiveNow`.
   */
  validFrom?: ISODate;
  validTo?: ISODate;
  createdAt: ISODateTime;
  updatedAt?: ISODateTime;
}

/**
 * Л3: одна проверка акции для мастера, формы правки и createPromotion/updatePromotion. Ключ — поле формы,
 * значение — ключ текста ошибки в loyalty.json → promotionWizard.errors.*.
 */
export type PromotionValidationField = 'name' | 'value' | 'thresholds' | 'conditionCount' | 'validTo' | 'applyFrequency' | 'days';
export type PromotionValidationErrors = Partial<Record<PromotionValidationField, string>>;

export function validatePromotion(
  input: Pick<Promotion, 'name' | 'kind' | 'valueType' | 'value' | 'thresholds' | 'conditionCount' | 'validFrom' | 'validTo' | 'applyFrequency' | 'applyLimit' | 'cancelAfterDays' | 'burnAfterDays'>,
): PromotionValidationErrors {
  const errors: PromotionValidationErrors = {};
  if (!input.name.trim()) errors.name = 'nameRequired';
  const accumulating = ACCUMULATING_KINDS.includes(input.kind);
  const badValue = (v: number) => !Number.isFinite(v) || v <= 0 || (input.valueType === 'percent' && v > 100);
  if (accumulating) {
    const rows = input.thresholds ?? [];
    if (rows.length === 0) errors.thresholds = 'thresholdsEmpty';
    else if (rows.some((r) => !Number.isFinite(r.from) || r.from < 0)) errors.thresholds = 'thresholdFromNegative';
    else if (rows.some((r) => badValue(r.value))) errors.thresholds = input.valueType === 'percent' ? 'percentRange' : 'valuePositive';
    else if (new Set(rows.map((r) => r.from)).size !== rows.length) errors.thresholds = 'thresholdsDuplicate';
    else {
      // пороги по возрастанию «от» не должны давать МЕНЬШЕ: больше потратил — не меньше скидка/бонус
      const sorted = [...rows].sort((a, b) => a.from - b.from);
      if (sorted.some((r, i) => i > 0 && r.value < sorted[i - 1].value)) errors.thresholds = 'thresholdsDecreasing';
    }
  } else if (badValue(input.value)) {
    errors.value = input.valueType === 'percent' ? 'percentRange' : 'valuePositive';
  }
  if (input.kind === 'discountConditional' && (!input.conditionCount || input.conditionCount < 1)) errors.conditionCount = 'conditionCount';
  if (input.validFrom && input.validTo && input.validTo < input.validFrom) errors.validTo = 'validToBeforeFrom';
  if (input.applyFrequency !== undefined && input.applyFrequency < 1) errors.applyFrequency = 'applyFrequency';
  if ((input.applyLimit !== undefined && input.applyLimit < 0) || (input.cancelAfterDays !== undefined && input.cancelAfterDays < 1) || (input.burnAfterDays !== undefined && input.burnAfterDays < 1)) errors.days = 'daysPositive';
  return errors;
}

/** F-06-183: 0 = воскресенье … 6 = суббота (как dayjs().day()); часы — «ЧЧ:мм» локального времени точки */
export interface PromotionSchedule {
  enabled: boolean;
  days: number[];
  fromTime: string;
  toTime: string;
}

export function defaultPromotionSchedule(): PromotionSchedule {
  return {
    enabled: false,
    days: [1, 2, 3, 4, 5],
    fromTime: '09:00',
    toTime: '21:00',
  };
}

/** F-06-183: даты действия акции (включительно); без границы с этой стороны — не ограничено */
export function isPromotionWithinDateRange(validFrom: ISODate | undefined, validTo: ISODate | undefined, at: Date): boolean {
  const today = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
  if (validFrom && today < validFrom) return false;
  if (validTo && today > validTo) return false;
  return true;
}

/** F-06-183: акция без расписания действует всегда; с расписанием — только в свои дни/часы */
export function isPromotionScheduleActiveNow(schedule: PromotionSchedule | undefined, at: Date): boolean {
  if (!schedule || !schedule.enabled) return true;
  const day = at.getDay();
  if (!schedule.days.includes(day)) return false;
  const hm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  return hm >= schedule.fromTime && hm <= schedule.toTime;
}

/** F-06-183: сочетание обоих ограничений — даты действия (validFrom/validTo) И расписание дней/часов */
export function isPromotionActiveNow(promo: Pick<Promotion, 'validFrom' | 'validTo' | 'schedule'>, at: Date): boolean {
  return isPromotionWithinDateRange(promo.validFrom, promo.validTo, at) && isPromotionScheduleActiveNow(promo.schedule, at);
}

/** F-06-049 */
export interface PromotionNotify {
  discountChange: NotifyMessageSetting;
  cashbackChange: NotifyMessageSetting;
  cancelSoon: NotifyMessageSetting;
  burnSoon: NotifyMessageSetting;
}

export function defaultPromotionNotify(): PromotionNotify {
  return {
    discountChange: defaultNotifySetting(),
    cashbackChange: defaultNotifySetting(),
    cancelSoon: defaultNotifySetting(),
    burnSoon: defaultNotifySetting(),
  };
}

// ─────────────────────────── Транзакции ───────────────────────────

/** F-06-077: 12 перечисленных в ТЗ типов операций лояльности + возвраты (F-06-101/132/144) */
export type LoyaltyTxType =
  | 'cardTopup'
  | 'cardCharge'
  | 'promoDiscount'
  | 'loyaltyAccrual'
  | 'referralAccrual'
  | 'manualTopup'
  | 'manualCharge'
  | 'expiredBurn'
  | 'certificateCharge'
  | 'membershipUse'
  | 'membershipRecalc'
  | 'accountCharge'
  | 'certificateRefund'
  | 'membershipRefund'
  | 'accountRefund';

export const LOYALTY_TX_TYPES: LoyaltyTxType[] = [
  'cardTopup',
  'cardCharge',
  'promoDiscount',
  'loyaltyAccrual',
  'referralAccrual',
  'manualTopup',
  'manualCharge',
  'expiredBurn',
  'certificateCharge',
  'membershipUse',
  'membershipRecalc',
  'accountCharge',
  'certificateRefund',
  'membershipRefund',
  'accountRefund',
];

export interface LoyaltyTransaction {
  id: Id;
  businessId: Id;
  locationId: Id;
  type: LoyaltyTxType;
  clientId: Id;
  promotionId?: Id;
  cardId?: Id;
  certificateId?: Id;
  membershipId?: Id;
  accountId?: Id;
  /** F-06-070: запись, за оплату которой начислен кэшбэк — не даёт начислить дважды при повторном сохранении */
  bookingId?: Id;
  /** ֏; списание/скидка хранится отрицательным числом, начисление — положительным */
  amount: number;
  createdAt: ISODateTime;
  /** F-06-125: сотрудник, выполнивший ручную правку (membershipRecalc и т. п.) */
  by?: Id;
  /**
   * Л1/Л8: строка, порождённая другой строкой той же оплаты — сгорание остатка однократного сертификата
   * (expiredBurn) или бонус пригласившему (referralAccrual). Отмена родителя отменяет и её.
   */
  parentTxId?: Id;
  /** Л16: начисление «на день рождения» — год, чтобы давать его раз в год */
  birthdayYear?: string;
  /** Л1: строка этой оплаты во вкладке «Оплата» (finance bookingPayments) — снимается вместе с транзакцией */
  financeLineId?: Id;
  /** F-06-097/124: чей был сертификат/абонемент и в каком статусе до оплаты — отмена оплаты возвращает как было */
  prevOwnerId?: Id;
  prevStatus?: string;
  /** F-06-144: операция пополнения счёта — отмена пополнения снимает и эту транзакцию */
  accountOperationId?: Id;
}

// ─────────────────────────── Автоприменение и рефералка ───────────────────────────

export type AutoApplyWhen = 'every' | 'firstOnly';
export type AutoApplyOnlineScope = 'any' | 'appOnly';

export interface AutoApplySettings {
  businessId: Id;
  enabled: boolean;
  online: {
    promotionId?: Id;
    when: AutoApplyWhen;
    scope: AutoApplyOnlineScope;
  };
  journal: { promotionId?: Id; when: AutoApplyWhen };
}

export interface ReferralSettings {
  businessId: Id;
  active: boolean;
  inviteePromotionId?: Id;
  referrerPromotionId?: Id;
}

// ─────────────────────────── Сертификаты ───────────────────────────

/** F-06-088: многократный — остаток живёт до конца, однократный — остаток сгорает после первой оплаты */
export type CertificateChargeType = 'multiple' | 'single';

/** F-06-090: 5 вариантов — пересечение «какие услуги» × «пускать ли товары» (конкретные товары не выбираются) */
export type CertificateServicesMode = 'all' | 'some' | 'none';

/** F-06-091 */
export type CertificateExpiryMode = 'none' | 'fixedDate' | 'fixedPeriod';
export type ExpiryPeriodUnit = 'day' | 'week' | 'month' | 'year';

/** F-06-093: где сеть разрешает локации менять баланс/срок уже проданного сертификата */
export type EditLocationsMode = 'none' | 'saleLocation' | 'allLocations';

/**
 * F-06-089: справка отсылает к статье о категориях, которой в скачанной базе нет (❓ где создаются и на
 * что влияют — не решено в ТЗ). Группировка нужна только для витрины (F-06-149) — сделали фиксированным
 * списком назначений подарка вместо отдельного справочника категорий, который создавать было бы негде.
 */
export type CertificateCategory = 'none' | 'gift' | 'birthday' | 'holiday' | 'corporate';
export const CERTIFICATE_CATEGORIES: CertificateCategory[] = ['none', 'gift', 'birthday', 'holiday', 'corporate'];

export interface CertificateType {
  id: Id;
  businessId: Id;
  name: string;
  nominal: number;
  /** F-06-088, по умолчанию 'multiple' */
  chargeType: CertificateChargeType;
  /** F-06-089, по умолчанию 'none' = «Без категории» */
  category: CertificateCategory;
  /** F-06-090 — услуги: по умолчанию 'all' (любые) */
  applyServicesMode: CertificateServicesMode;
  applyServiceScope?: ServiceScope;
  /** F-06-090 — товары: по умолчанию true (разрешены); services='none' + products=false недопустимо */
  applyProductsAllowed: boolean;
  /** F-06-091, по умолчанию 'none' */
  expiryMode: CertificateExpiryMode;
  expiryDate?: ISODate;
  expiryPeriodValue?: number;
  expiryPeriodUnit?: ExpiryPeriodUnit;
  /** F-06-092, по умолчанию false — «Разрешить продажу сертификата без кода» (именной) */
  allowNoCode: boolean;
  /** F-06-093, по умолчанию 'none' */
  editLocationsMode: EditLocationsMode;
  /** F-06-147 */
  onlineSale: OnlineSaleSettings;
  /** «Действует в локациях» */
  locationIds: Id[];
  createdAt: ISODateTime;
  updatedAt?: ISODateTime;
}

/**
 * F-06-088: сколько списывается с сертификата за чек и остаток. Однократный — остаток всегда сгорает,
 * даже если номинал больше чека (используется только 1 раз); многократный — списывает не больше остатка,
 * остаток живёт дальше.
 */
export function chargeCertificate(balance: number, chargeType: CertificateChargeType, checkAmount: number): { charged: number; remainingBalance: number } {
  const charged = Math.min(balance, Math.max(0, checkAmount));
  return {
    charged,
    remainingBalance: chargeType === 'single' ? 0 : balance - charged,
  };
}

/** F-06-091: истёкший сертификат нельзя принять к оплате (день ПОСЛЕ срока — уже истёк, день срока — ещё можно) */
export function isCertificateExpired(expiresAt: ISODate | undefined, todayIso: ISODate): boolean {
  return Boolean(expiresAt) && expiresAt! < todayIso;
}

/** F-06-195: активен, погашен (использован/исчерпан) или истёк по сроку */
export type CertificateStatus = 'active' | 'used' | 'expired';

export interface Certificate {
  id: Id;
  businessId: Id;
  certTypeId: Id;
  code: string;
  nominal: number;
  balance: number;
  status: CertificateStatus;
  clientId?: Id;
  /** Место продажи (F-06-100) */
  locationId: Id;
  /** Место использования — заполнено, только если хоть раз списывали (F-06-100) */
  usedLocationId?: Id;
  soldAt: ISODateTime;
  expiresAt?: ISODate;
  usedAt?: ISODateTime;
  /** F-06-197: цена продажи (может отличаться от номинала при скидке), скидка и продавец в строке продажи */
  soldPrice?: number;
  discountPercent?: number;
  sellerId?: Id;
}

// ─────────────────────────── Абонементы ───────────────────────────

/** F-06-107: раздельный — списывается визит именно оказанной услуги; общий — любой визит из общего числа */
export type MembershipBalanceMode = 'separate' | 'shared';

/** F-06-107: строка «услуга/категория → количество визитов» для раздельного баланса */
export interface MembershipServiceLine {
  serviceId?: Id;
  categoryId?: Id;
  visits: number;
}

/** F-06-109 */
export type MembershipActivationMode = 'firstVisit' | 'onSale';

/** F-06-134: у нас — только как классификация типа (сама подписка/автосписание отложены, F-00-028) */
export type MembershipRenewalKind = 'standard' | 'autoRenew';

/** F-06-118…120 */
export interface MembershipTypeNotify {
  expiry: NotifyMessageSetting & { daysBefore?: number; atVisitsLeft?: number };
  charge: NotifyMessageSetting;
}

export function defaultMembershipNotify(): MembershipTypeNotify {
  return {
    expiry: { ...defaultNotifySetting(), daysBefore: 3 },
    charge: defaultNotifySetting(),
  };
}

export interface MembershipType {
  id: Id;
  businessId: Id;
  name: string;
  archived: boolean;
  /** F-06-107, по умолчанию 'separate' */
  balanceMode: MembershipBalanceMode;
  /** F-06-107 — заполняется для 'separate'; для 'shared' используется sharedVisits */
  services: MembershipServiceLine[];
  sharedVisits?: number;
  /** F-06-108, ֏, по умолчанию 0 */
  price: number;
  /** F-06-108 — 0 = бессрочно, по умолчанию 1 месяц */
  durationValue: number;
  durationUnit: ExpiryPeriodUnit;
  /** F-06-109, по умолчанию 'firstVisit' */
  activationMode: MembershipActivationMode;
  /** F-06-110 — поле видно только при activationMode='firstVisit' */
  autoActivateEnabled: boolean;
  autoActivateDays?: number;
  /** F-06-111, по умолчанию 'none' */
  editLocationsMode: EditLocationsMode;
  /** F-06-112, по умолчанию false */
  freezeAllowed: boolean;
  /** F-06-113, по умолчанию false */
  allowNoCode: boolean;
  /** F-06-114, по умолчанию false */
  recalcPriceOnPay: boolean;
  /** F-06-134, по умолчанию 'standard' */
  renewalKind: MembershipRenewalKind;
  /** F-06-147 */
  onlineSale: OnlineSaleSettings;
  /** «Действует в локациях» */
  locationIds: Id[];
  /** F-06-118…120 */
  notify?: MembershipTypeNotify;
  createdAt: ISODateTime;
  updatedAt?: ISODateTime;
}

/**
 * F-06-107: визит какой услуги списывается. Раздельный — своя строка; общий — из общего остатка
 * независимо от услуги (undefined serviceId допустим — используется одна общая запись).
 */
export function membershipLineFor(services: MembershipServiceLine[], serviceId: Id, categoryId?: Id): MembershipServiceLine | undefined {
  return services.find((l) => l.serviceId === serviceId) ?? (categoryId ? services.find((l) => l.categoryId === categoryId) : undefined);
}

/** F-06-114: цена услуги при оплате абонементом = стоимость / число визитов в балансе (округление вниз до ֏) */
export function recalcMembershipVisitPrice(price: number, totalVisits: number): number {
  if (totalVisits <= 0) return 0;
  return Math.floor(price / totalVisits);
}

/** F-06-194; 'used' — все визиты списаны (Л10: «0 из 11» — уже не «Активен») */
export type MembershipStatus = 'issued' | 'active' | 'frozen' | 'used' | 'expired' | 'deactivated';

export const MEMBERSHIP_STATUSES: MembershipStatus[] = ['issued', 'active', 'frozen', 'used', 'expired', 'deactivated'];

/**
 * Л9/Л10: статус абонемента, как его видит человек сегодня — единое правило для списков, карточки клиента и
 * окна записи. Заморозка кончается сама в день frozenUntil; истёкший срок — «Истёк»; ноль визитов — «Использован».
 */
export function membershipDisplayStatus(m: Pick<Membership, 'status' | 'balanceVisits' | 'expiresAt' | 'frozenUntil'>, todayIso: ISODate): MembershipStatus {
  if (m.status === 'deactivated') return 'deactivated';
  if (m.status === 'frozen') {
    if (m.frozenUntil && m.frozenUntil <= todayIso) {
      // заморозка закончилась — дальше как активный
    } else return 'frozen';
  }
  if (m.balanceVisits <= 0) return 'used';
  if (m.expiresAt < todayIso) return 'expired';
  return m.status === 'frozen' ? 'active' : m.status;
}

export interface MembershipFreezeEntry {
  at: ISODateTime;
  days: number;
  action: 'freeze' | 'unfreeze';
  /** F-06-126/187: кто заморозил/разморозил — сотрудник из src/domain/core.ts Staff; undefined — снятые старые записи */
  by?: Id;
}

export interface Membership {
  id: Id;
  businessId: Id;
  membershipTypeId: Id;
  clientId: Id;
  status: MembershipStatus;
  balanceVisits: number;
  totalVisits: number;
  price: number;
  locationId: Id;
  soldAt: ISODateTime;
  expiresAt: ISODate;
  frozenDays: number;
  /** Л9: последний день заморозки (не включительно — в этот день абонемент снова активен); нет — не заморожен */
  frozenUntil?: ISODate;
  freezeHistory: MembershipFreezeEntry[];
  /** F-06-197: цена продажи (из типа, но правится правом), скидка и продавец в строке продажи */
  soldPrice?: number;
  discountPercent?: number;
  sellerId?: Id;
  /**
   * F-06-113/F-06-122/F-06-067/F-06-123: код продажи — как у сертификата (F-06-092), обязателен, кроме типов
   * с «Разрешить продажу без кода» (именной); пустая строка/undefined = именной — не находится поиском по коду
   * («Именной сертификат/абонемент — только владельцу», F-06-098).
   */
  code?: string;
}

/** F-06-194: разрешённые переходы статуса абонемента */
export const MEMBERSHIP_TRANSITIONS: Record<MembershipStatus, MembershipStatus[]> = {
  issued: ['active', 'expired'],
  active: ['frozen', 'expired'],
  frozen: ['active'],
  used: [],
  expired: [],
  deactivated: [],
};

// ─────────────────────────── Счета клиентов (депозиты) ───────────────────────────

export interface AccountType {
  id: Id;
  businessId: Id;
  name: string;
  locationIds: Id[];
  allowNegative: boolean;
  negativeLimit: number;
  createdAt: ISODateTime;
  updatedAt?: ISODateTime;
}

/** F-06-136: без лимита галочку «Разрешить оплату в минус» не сохранить */
export function isAccountTypeValid(allowNegative: boolean, negativeLimit: number): boolean {
  return !allowNegative || negativeLimit > 0;
}

/** F-06-136: оплату со счёта можно провести не больше, чем баланс + разрешённый минус */
export function maxAccountCharge(balance: number, type: Pick<AccountType, 'allowNegative' | 'negativeLimit'>): number {
  return balance + (type.allowNegative ? type.negativeLimit : 0);
}

export interface ClientAccount {
  id: Id;
  businessId: Id;
  accountTypeId: Id;
  clientId: Id;
  locationId: Id;
  balance: number;
  createdAt: ISODateTime;
}

export type AccountOpType = 'open' | 'topup' | 'charge';

// ─────────────────────────── Оплата лояльностью в визите (F-06-062…067, 074, 083/084, 096…098, 123) ───────────────────────────

/**
 * Строка оплаты лояльностью, которую вклад «Лояльность» окна записи копит локально до сохранения (пока у
 * journal/finance нет хоста построчной оплаты — см. qa/requests/loyalty.md) и записывает в свой срез шагом
 * «после сохранения». 'promo' — скидка по акции карты (F-06-063/064); 'bonus' — списание бонусов карты
 * (F-06-065); 'certificate'/'membership' — оплата сертификатом/абонементом (F-06-096/123), в т.ч. найденным
 * по коду чужого клиента (F-06-067/097/098/124 — переход к плательщику при коммите); 'referral' — реферальная
 * скидка приглашённому + бонус пригласившему (F-06-083/084); 'account' — оплата с личного счёта клиента
 * (F-06-139), в т.ч. в минус, если тип счёта это разрешает (F-06-140).
 */
export type LoyaltyPaymentLineKind = 'promo' | 'bonus' | 'certificate' | 'membership' | 'referral' | 'account';

export interface LoyaltyPaymentLineInput {
  kind: LoyaltyPaymentLineKind;
  /** ֏: скидка/списание по визиту (для 'membership' — сумма, которую списание закрывает, обычно = остаток) */
  amount: number;
  cardId?: Id;
  promotionId?: Id;
  certificateId?: Id;
  membershipId?: Id;
  /** 'account' (F-06-139/140) */
  accountId?: Id;
  /** 'referral' — держатель бонуса, который получает начисление за приглашение */
  referrerClientId?: Id;
  referrerCardId?: Id;
  /** 'referral' без карты у пригласившего: какой тип карты выдать ему при начислении (getReferralEligibility) */
  referrerCardTypeId?: Id;
  referrerBonusAmount?: number;
}

export interface AccountOperation {
  id: Id;
  businessId: Id;
  accountId: Id;
  type: AccountOpType;
  amount: number;
  authorStaffId?: Id;
  createdAt: ISODateTime;
}

// ─────────────────────────── Онлайн-продажи (F-06-148/149/151/152/153, пачка b05) ───────────────────────────

/** F-06-148: способ оплаты онлайн-продаж — пока только «Другой способ» (безнал выключен до решения F-00-028) */
export interface OnlineSalePaymentSettings {
  otherMethodEnabled: boolean;
  otherMethodDetails?: string;
  /** F-06-153: филиал, в выручку которого падают онлайн-продажи (для сети — обязателен) */
  revenueLocationId?: Id;
  notifyEmail?: string;
}

export function defaultOnlineSalePayment(): OnlineSalePaymentSettings {
  return { otherMethodEnabled: true, otherMethodDetails: '', notifyEmail: '' };
}

/** F-06-149: оформление и включение витрины-виджета онлайн-продаж */
export interface OnlineSaleWidgetSettings {
  enabled: boolean;
  title: LocalizedText;
  /** Индекс токена chart-N (1..8, см. ColorPicker) — своих hex-цветов раздел не заводит (CONVENTIONS §0.3) */
  accentColorIndex: number;
}

export function defaultOnlineSaleWidget(): OnlineSaleWidgetSettings {
  return {
    enabled: false,
    title: {
      ru: 'Подарочные сертификаты и абонементы',
      en: 'Gift certificates & memberships',
    },
    accentColorIndex: 3,
  };
}

export type OnlineOrderItemKind = 'certificate' | 'membership';
export type OnlineOrderStatus = 'pendingPayment' | 'confirmed' | 'rejected' | 'refunded';

/** F-06-151/152: заказ, оформленный клиентом на витрине онлайн-продаж, до и после обработки бизнесом */
export interface OnlineOrder {
  id: Id;
  businessId: Id;
  itemKind: OnlineOrderItemKind;
  itemTypeId: Id;
  itemName: string;
  price: number;
  clientId?: Id;
  clientName: string;
  clientPhone: string;
  locationId: Id;
  status: OnlineOrderStatus;
  createdAt: ISODateTime;
  processedAt?: ISODateTime;
  /** F-06-152: после подтверждения — выпущенный экземпляр (для перехода на страницу сертификата/абонемента) */
  issuedId?: Id;
}

// ─────────────────────────── Правки редкого (F-06-125/126/131, пачка b05) ───────────────────────────

/**
 * F-06-131: активный абонемент, у которого его тип разрешает списание в этом визите (покрывает услугу),
 * снимает требование предоплаты по политике оплаты локации — используется online/finance при расчёте,
 * нужна ли предоплата для онлайн-записи/визита (см. qa/requests/loyalty.md — сигнатура для чужих хостов).
 */
export function membershipWaivesPrepayment(hasApplicableActiveMembership: boolean): boolean {
  return hasApplicableActiveMembership;
}

// ─────────────────────────── Персональная скидка/важность клиента (F-06-006…019) ───────────────────────────

/**
 * F-06-015/016/017: уведомления клиенту о персональной скидке. Правила самой скидки/класса/категорий
 * (F-06-006…014) уже построены разделом «clients» как «Программа лояльности» локации (F-04-114…122,
 * `src/areas/clients/LoyaltyProgramScreen.tsx`) — та же вкладка «Клиенты → Программа лояльности», что
 * описывает 06-loyalty.md; см. qa/requests/loyalty.md. Здесь — то, что «clients» не строил: два типа
 * push-уведомлений и переменные их шаблонов (F-00-120: пуш вместо SMS).
 */
export interface DiscountNotifySettings {
  newDiscount: NotifyMessageSetting;
  discountEnding: NotifyMessageSetting;
  /** F-06-012/016: «уведомлять за N дней» — то же число, что в настройках отмены скидки локации */
  warnDaysBefore: number;
}

export function defaultDiscountNotify(): DiscountNotifySettings {
  return { newDiscount: defaultNotifySetting(), discountEnding: defaultNotifySetting(), warnDaysBefore: 5 };
}
