import type { Prisma } from '../../../generated/prisma/client.js';
import { ApiError } from '../../../common/errors/api-error.js';
import { DEFAULT_TZ, isLocalDate, isLocalDateTime, localToUtc, utcToLocal } from '../../../common/time/time.js';
import type { Id } from './core-types.js';
import type {
  AccountOperation,
  AccountType,
  CardType,
  Certificate,
  CertificateType,
  ClientAccount,
  LoyaltyCard,
  LoyaltyTransaction,
  Membership,
  MembershipStatus,
  MembershipType,
  OnlineOrder,
  Promotion,
} from './domain.js';
import { defaultMembershipNotify, defaultOnlineSale } from './domain.js';
import { emptyState, SETTINGS_KEYS, type LoyaltyState, type SettingsBag } from './state.js';

/**
 * Срез «loyalty» фронта ↔ таблицы лояльности (этап 11 + колонка `data`, этап 21 лейн loyalty).
 *
 * Каждая сущность хранится строкой своей таблицы этапа 11: колонки — её проекция (их читают клиентское
 * приложение /v1/me/loyalty, заявки В-17 и маршруты этапа 11), `data` — полная форма фронта (domain/loyalty.ts).
 * Строки без `data` (созданы маршрутами этапа 11: покупка из приложения, подтверждение заявки) собираются из
 * колонок с умолчаниями домена; «ждут подтверждения»/«отклонены» (В-17) в срез не попадают — это очередь
 * заявок, не выданные экземпляры. Колонки, которые меняют маршруты этапа 11 (балансы, статус, имя, архив),
 * побеждают `data` при чтении, поэтому обе дороги видят одно и то же.
 *
 * Запись — разницей: что изменилось по сравнению с прочитанным, то и пишется (upsert/delete), остальное не трогается.
 * Настройки (автоприменение, рефералка, онлайн-продажи, уведомления, флаги услуг, оплаченные визиты) —
 * `business_settings` area='loyalty-port', одна строка на бизнес; её же строка — замок запроса (runner.ts).
 */

type Db = Prisma.TransactionClient;
export const SETTINGS_AREA = 'loyalty-port';

const FAR_FUTURE = new Date(Date.UTC(2099, 11, 31, 20, 0));
const n = (v: bigint | number | null | undefined): number => (v === null || v === undefined ? 0 : Number(v));

/** Местная дата/дата-время фронта → момент UTC; мусор — сейчас (не «истёк») */
export function toUtc(value: string | undefined | null, fallback: Date = new Date()): Date {
  if (!value) return fallback;
  if (isLocalDateTime(value)) return localToUtc(value, DEFAULT_TZ);
  if (isLocalDate(value)) return localToUtc(`${value}T00:00`, DEFAULT_TZ);
  const cut = value.slice(0, 16);
  if (isLocalDateTime(cut)) return localToUtc(cut, DEFAULT_TZ);
  return fallback;
}
const local = (d: Date): string => utcToLocal(d, DEFAULT_TZ);
const localDate = (d: Date): string => utcToLocal(d, DEFAULT_TZ).slice(0, 10);
/** Конец местного дня — срок «до даты включительно» в колонке */
const endOfDay = (date: string | undefined): Date => (date && isLocalDate(date) ? localToUtc(`${date}T23:59`, DEFAULT_TZ) : FAR_FUTURE);

const UNIT_DAYS: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 };
const periodDays = (value: number | undefined, unit: string | undefined): number => Math.max(0, Math.round((value ?? 0) * (UNIT_DAYS[unit ?? 'day'] ?? 1)));

function dataOf<T>(v: unknown): T | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as T) : undefined;
}
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

// ─────────── Снимок прочитанного (для записи разницей) ───────────

type Coll = 'cardTypes' | 'cards' | 'promotions' | 'transactions' | 'certificateTypes' | 'certificates' | 'membershipTypes' | 'memberships' | 'accountTypes' | 'accounts' | 'accountOperations' | 'onlineOrders';
const COLLS: Coll[] = ['cardTypes', 'cards', 'promotions', 'transactions', 'certificateTypes', 'certificates', 'membershipTypes', 'memberships', 'accountTypes', 'accounts', 'accountOperations', 'onlineOrders'];

export interface Snapshot {
  businessIds: Id[];
  owners: Map<Id, Id>;
  entities: Record<Coll, Map<Id, string>>;
  settings: Map<Id, string>;
}

const MEMBERSHIP_STATUSES: MembershipStatus[] = ['issued', 'active', 'frozen', 'used', 'expired', 'deactivated'];

// ─────────── Чтение ───────────

export async function loadState(db: Db, businessIds: Id[]): Promise<{ state: LoyaltyState; snapshot: Snapshot }> {
  const state = emptyState();
  const where = { businessId: { in: businessIds } };
  const [businesses, cardTypes, cards, promotions, txs, certTypes, certs, memTypes, mems, accTypes, accounts, orders, settings] = await Promise.all([
    db.business.findMany({ where: { id: { in: businessIds } }, select: { id: true, networkId: true } }),
    db.loyaltyCardType.findMany({ where, orderBy: { createdAt: 'asc' } }),
    db.loyaltyCard.findMany({ where, orderBy: { createdAt: 'asc' } }),
    db.promotion.findMany({ where, orderBy: { createdAt: 'asc' } }),
    db.loyaltyTx.findMany({ where, orderBy: { createdAt: 'asc' } }),
    db.certificateType.findMany({ where, orderBy: { createdAt: 'asc' } }),
    db.certificate.findMany({ where: { ...where, status: { notIn: ['pending_confirmation', 'rejected'] } }, orderBy: { createdAt: 'asc' } }),
    db.membershipType.findMany({ where, orderBy: { createdAt: 'asc' } }),
    db.membershipSale.findMany({ where: { ...where, status: { notIn: ['pending_confirmation', 'rejected'] } }, orderBy: { createdAt: 'asc' } }),
    db.clientAccountType.findMany({ where, orderBy: { createdAt: 'asc' } }),
    db.clientAccount.findMany({ where, orderBy: { createdAt: 'asc' } }),
    db.loyaltyOnlineOrder.findMany({ where, orderBy: { createdAt: 'asc' } }),
    db.businessSetting.findMany({ where: { businessId: { in: businessIds }, area: SETTINGS_AREA } }),
  ]);
  const accountIds = accounts.map((a) => a.id);
  const ops = accountIds.length ? await db.clientAccountOp.findMany({ where: { accountId: { in: accountIds } }, orderBy: { createdAt: 'asc' } }) : [];
  const accountBiz = new Map(accounts.map((a) => [a.id, a.businessId]));
  const memTypePrice = new Map(memTypes.map((t) => [t.id, n(t.price)]));

  for (const r of cardTypes) {
    const d = dataOf<CardType>(r.data);
    const base: CardType = d ?? {
      id: r.id,
      businessId: r.businessId,
      name: r.name,
      locationIds: [],
      sourceScope: r.networkWide ? 'network' : 'activeLocations',
      autoIssueMode: 'none',
      serviceLimitMode: 'all',
      productLimitMode: 'all',
      paymentLimitFixed: 0,
      paymentLimitPercent: 0,
      cashbackVisibleInApp: true,
      createdAt: local(r.createdAt),
    };
    state.cardTypes.push({
      ...base,
      name: r.name,
      archived: r.archived || undefined,
      paymentLimitFixed: n(r.paymentLimitFixed),
      paymentLimitPercent: r.paymentLimitPercent,
      cashbackVisibleInApp: r.cashbackVisibleInApp,
      burnDays: r.burnDays ?? undefined,
    });
  }
  for (const r of cards) {
    const d = dataOf<LoyaltyCard>(r.data);
    if (!d && !r.clientId) continue; // карта только приложения (без карточки CRM) — вне среза кабинета
    const base: LoyaltyCard = d ?? { id: r.id, businessId: r.businessId, cardTypeId: r.cardTypeId, clientId: r.clientId!, number: r.number, balance: 0, createdAt: local(r.createdAt) };
    state.cards.push({ ...base, number: r.number, balance: n(r.balance), ...(r.clientId ? { clientId: r.clientId } : {}) });
  }
  for (const r of promotions) {
    const d = dataOf<Promotion>(r.data);
    const base: Promotion = d ?? {
      id: r.id,
      businessId: r.businessId,
      name: r.name,
      kind: r.kind as Promotion['kind'],
      cardTypeIds: arr<Id>(r.cardTypeIds),
      valueType: r.valueType as Promotion['valueType'],
      value: r.value,
      ...(r.thresholds ? { thresholds: arr(r.thresholds) } : {}),
      ...(r.serviceScope ? { serviceScope: r.serviceScope as unknown as Promotion['serviceScope'] } : {}),
      createdAt: local(r.createdAt),
    };
    state.promotions.push({ ...base, name: r.name });
  }
  for (const r of txs) {
    const d = dataOf<LoyaltyTransaction>(r.data) ?? synthTx(r);
    if (d) state.transactions.push(d);
  }
  for (const r of certTypes) {
    const d = dataOf<CertificateType>(r.data);
    const base: CertificateType = d ?? {
      id: r.id,
      businessId: r.businessId,
      name: r.name,
      nominal: n(r.faceValue),
      chargeType: 'multiple',
      category: 'none',
      applyServicesMode: 'all',
      applyProductsAllowed: true,
      expiryMode: r.validDays > 0 ? 'fixedPeriod' : 'none',
      ...(r.validDays > 0 ? { expiryPeriodValue: r.validDays, expiryPeriodUnit: 'day' as const } : {}),
      allowNoCode: false,
      editLocationsMode: 'none',
      onlineSale: defaultOnlineSale(),
      locationIds: [],
      createdAt: local(r.createdAt),
    };
    state.certificateTypes.push({ ...base, name: r.name });
  }
  for (const r of certs) {
    const d = dataOf<Certificate>(r.data);
    const status = (['active', 'used', 'expired'] as const).find((s) => s === r.status);
    if (!d && !status) continue; // «возвращён» без формы фронта — только история этапа 11
    const base: Certificate = d ?? {
      id: r.id,
      businessId: r.businessId,
      certTypeId: r.typeId,
      code: r.code,
      nominal: n(r.total),
      balance: 0,
      status: status!,
      ...(r.clientId ? { clientId: r.clientId } : {}),
      locationId: r.businessId,
      soldAt: local(r.soldAt),
      ...(r.expiresAt < FAR_FUTURE ? { expiresAt: localDate(r.expiresAt) } : {}),
    };
    state.certificates.push({ ...base, balance: n(r.balance), ...(status ? { status } : {}), ...(r.clientId ? { clientId: r.clientId } : {}) });
  }
  for (const r of memTypes) {
    const d = dataOf<MembershipType>(r.data);
    const base: MembershipType = d ?? {
      id: r.id,
      businessId: r.businessId,
      name: r.name,
      archived: r.archived,
      balanceMode: 'shared',
      services: [],
      sharedVisits: r.totalVisits ?? 0,
      price: n(r.price),
      durationValue: r.validDays,
      durationUnit: 'day',
      activationMode: 'onSale',
      autoActivateEnabled: false,
      editLocationsMode: 'none',
      freezeAllowed: true,
      allowNoCode: false,
      recalcPriceOnPay: false,
      renewalKind: 'standard',
      onlineSale: defaultOnlineSale(),
      locationIds: [],
      notify: defaultMembershipNotify(),
      createdAt: local(r.createdAt),
    };
    state.membershipTypes.push({ ...base, name: r.name, archived: r.archived });
  }
  for (const r of mems) {
    const d = dataOf<Membership>(r.data);
    const colStatus: MembershipStatus | undefined = r.status === 'refunded' ? 'deactivated' : MEMBERSHIP_STATUSES.find((s) => s === r.status);
    if (!d && (!colStatus || !r.clientId)) continue;
    const base: Membership = d ?? {
      id: r.id,
      businessId: r.businessId,
      membershipTypeId: r.typeId,
      clientId: r.clientId!,
      status: colStatus!,
      balanceVisits: r.remainingVisits ?? 0,
      totalVisits: r.totalVisits ?? 0,
      price: memTypePrice.get(r.typeId) ?? 0,
      locationId: r.businessId,
      soldAt: local(r.soldAt),
      expiresAt: localDate(r.expiresAt),
      frozenDays: 0,
      freezeHistory: [],
      code: r.code,
    };
    state.memberships.push({
      ...base,
      ...(r.remainingVisits !== null ? { balanceVisits: r.remainingVisits } : {}),
      ...(colStatus ? { status: colStatus } : {}),
      ...(r.frozenUntil ? { frozenUntil: localDate(r.frozenUntil) } : colStatus && colStatus !== 'frozen' ? { frozenUntil: undefined } : {}),
    });
  }
  for (const r of accTypes) {
    const d = dataOf<AccountType>(r.data);
    const base: AccountType = d ?? { id: r.id, businessId: r.businessId, name: r.name, locationIds: [], allowNegative: false, negativeLimit: 0, createdAt: local(r.createdAt) };
    state.accountTypes.push({ ...base, name: r.name });
  }
  for (const r of accounts) {
    const d = dataOf<ClientAccount>(r.data);
    const base: ClientAccount = d ?? { id: r.id, businessId: r.businessId, accountTypeId: r.typeId, clientId: r.clientId, locationId: r.businessId, balance: 0, createdAt: local(r.createdAt) };
    state.accounts.push({ ...base, balance: n(r.balance) });
  }
  for (const r of ops) {
    const d = dataOf<AccountOperation>(r.data);
    if (d) {
      state.accountOperations.push(d);
      continue;
    }
    if (r.kind !== 'topup' && r.kind !== 'charge' && r.kind !== 'open') continue;
    state.accountOperations.push({
      id: r.id,
      businessId: accountBiz.get(r.accountId) ?? businessIds[0]!,
      accountId: r.accountId,
      type: r.kind,
      amount: r.kind === 'charge' ? -Math.abs(n(r.amount)) : n(r.amount),
      ...(r.staffId ? { authorStaffId: r.staffId } : {}),
      createdAt: local(r.createdAt),
    });
  }
  for (const r of orders) {
    const d = dataOf<OnlineOrder>(r.data);
    if (d) state.onlineOrders.push({ ...d, status: r.status as OnlineOrder['status'] });
  }
  const settingsSnap = new Map<Id, string>();
  for (const r of settings) {
    const bag = (dataOf<SettingsBag>(r.data) ?? {}) as SettingsBag;
    settingsSnap.set(r.businessId, canonical(bag));
    for (const key of SETTINGS_KEYS) Object.assign(state[key] as object, bag[key] ?? {});
    for (const id of bag.paidBookingIds ?? []) if (!state.paidBookingIds.includes(id)) state.paidBookingIds.push(id);
  }

  const snapshot: Snapshot = {
    businessIds,
    owners: new Map(businesses.map((b) => [b.id, b.networkId ?? b.id])),
    entities: Object.fromEntries(COLLS.map((c) => [c, new Map((state[c] as { id: Id }[]).map((e) => [e.id, JSON.stringify(e)]))])) as Record<Coll, Map<Id, string>>,
    settings: settingsSnap,
  };
  return { state, snapshot };
}

/** Строка журнала этапа 11 без формы фронта → транзакция фронта; не переводится — не в срезе */
function synthTx(r: { id: string; businessId: string; clientId: string | null; source: string; refId: string; kind: string; amount: bigint; bookingId: string | null; staffId: string | null; createdAt: Date }): LoyaltyTransaction | undefined {
  if (!r.clientId) return undefined;
  const key = `${r.source}:${r.kind}`;
  const type = (
    {
      'card:accrual': 'loyaltyAccrual',
      'card:charge': 'cardCharge',
      'card:apply': 'cardCharge',
      'card:topup': 'manualTopup',
      'certificate:charge': 'certificateCharge',
      'certificate:apply': 'certificateCharge',
      'certificate:refund': 'certificateRefund',
      'membership:charge': 'membershipUse',
      'membership:apply': 'membershipUse',
      'membership:refund': 'membershipRefund',
      'account:charge': 'accountCharge',
      'account:apply': 'accountCharge',
      'account:refund': 'accountRefund',
    } as Record<string, LoyaltyTransaction['type']>
  )[key];
  if (!type) return undefined;
  const ref: Partial<LoyaltyTransaction> =
    r.source === 'card' ? { cardId: r.refId } : r.source === 'certificate' ? { certificateId: r.refId } : r.source === 'membership' ? { membershipId: r.refId } : { accountId: r.refId };
  const amount = n(r.amount);
  return {
    id: r.id,
    businessId: r.businessId,
    locationId: r.businessId,
    type,
    clientId: r.clientId,
    ...ref,
    ...(r.bookingId ? { bookingId: r.bookingId } : {}),
    amount: r.kind === 'accrual' || r.kind === 'topup' ? Math.abs(amount) : -Math.abs(amount),
    createdAt: local(r.createdAt),
    ...(r.staffId ? { by: r.staffId } : {}),
  };
}

// ─────────── Колонки из формы фронта ───────────

const TX_KIND: Record<LoyaltyTransaction['type'], string> = {
  cardTopup: 'topup',
  manualTopup: 'topup',
  loyaltyAccrual: 'accrual',
  referralAccrual: 'accrual',
  cardCharge: 'charge',
  manualCharge: 'charge',
  certificateCharge: 'charge',
  accountCharge: 'charge',
  membershipUse: 'charge',
  promoDiscount: 'apply',
  expiredBurn: 'burn',
  membershipRecalc: 'adjust',
  certificateRefund: 'refund',
  membershipRefund: 'refund',
  accountRefund: 'refund',
};

/** Сравнение настроек без учёта порядка ключей (MySQL JSON переставляет ключи) */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) => (val && typeof val === 'object' && !Array.isArray(val) ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : val));
}

function json(v: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(v ?? null)) as Prisma.InputJsonValue;
}

function membershipTotal(t: MembershipType): number | null {
  if (t.balanceMode === 'shared') return t.sharedVisits ?? null;
  const sum = (t.services ?? []).reduce((acc, l) => acc + (l.visits ?? 0), 0);
  return sum > 0 ? sum : null;
}

/** Код продажи обязателен и уникален в бизнесе; именной (без кода) — служебный из id */
const codeOf = (code: string | undefined, id: Id): string => (code && code.trim() ? code.trim() : `#${id}`).slice(0, 40);

type Writer = {
  upsert: (e: never) => Promise<unknown>;
  remove: (ids: Id[]) => Promise<unknown>;
};

function writers(db: Db, owners: Map<Id, Id>, actor: string): Record<Coll, Writer> {
  const ownerOf = (businessId: Id) => owners.get(businessId) ?? businessId;
  const audit = { updatedBy: actor };
  return {
    cardTypes: {
      upsert: (e: CardType) => {
        const cols = {
          ownerId: ownerOf(e.businessId),
          businessId: e.businessId,
          name: e.name.slice(0, 160),
          networkWide: e.sourceScope === 'network',
          paymentLimitPercent: Math.round(e.paymentLimitPercent ?? 0),
          paymentLimitFixed: BigInt(Math.round(e.paymentLimitFixed ?? 0)),
          cashbackVisibleInApp: e.cashbackVisibleInApp !== false,
          burnDays: e.burnDays || null,
          archived: Boolean(e.archived),
          data: json(e),
          ...audit,
        };
        return db.loyaltyCardType.upsert({ where: { id: e.id }, create: { id: e.id, ...cols, createdAt: toUtc(e.createdAt), createdBy: actor }, update: { ...cols, version: { increment: 1 } } });
      },
      remove: (ids) => db.loyaltyCardType.deleteMany({ where: { id: { in: ids } } }),
    },
    cards: {
      upsert: (e: LoyaltyCard) => {
        const cols = { cardTypeId: e.cardTypeId, businessId: e.businessId, clientId: e.clientId || null, number: e.number.slice(0, 40), balance: BigInt(Math.round(e.balance)), data: json(e), ...audit };
        return db.loyaltyCard.upsert({ where: { id: e.id }, create: { id: e.id, ...cols, createdAt: toUtc(e.createdAt), createdBy: actor }, update: { ...cols, version: { increment: 1 } } });
      },
      remove: (ids) => db.loyaltyCard.deleteMany({ where: { id: { in: ids } } }),
    },
    promotions: {
      upsert: (e: Promotion) => {
        const cols = {
          ownerId: ownerOf(e.businessId),
          businessId: e.businessId,
          name: e.name.slice(0, 160),
          kind: e.kind,
          cardTypeIds: json(e.cardTypeIds ?? []),
          valueType: e.valueType,
          value: Math.round(e.value ?? 0),
          thresholds: e.thresholds ? json(e.thresholds) : undefined,
          serviceScope: e.serviceScope ? json(e.serviceScope) : undefined,
          active: true,
          data: json(e),
          ...audit,
        };
        return db.promotion.upsert({ where: { id: e.id }, create: { id: e.id, ...cols, createdAt: toUtc(e.createdAt), createdBy: actor }, update: { ...cols, version: { increment: 1 } } });
      },
      remove: (ids) => db.promotion.deleteMany({ where: { id: { in: ids } } }),
    },
    transactions: {
      upsert: (e: LoyaltyTransaction) => {
        const [source, refId] = e.cardId
          ? ['card', e.cardId]
          : e.certificateId
            ? ['certificate', e.certificateId]
            : e.membershipId
              ? ['membership', e.membershipId]
              : e.accountId
                ? ['account', e.accountId]
                : ['promotion', e.promotionId ?? e.id];
        const cols = {
          businessId: e.businessId,
          clientId: e.clientId || null,
          source,
          refId,
          kind: TX_KIND[e.type] ?? 'adjust',
          amount: BigInt(Math.round(e.amount)),
          bookingId: e.bookingId ?? null,
          staffId: e.by ?? null,
          data: json(e),
        };
        return db.loyaltyTx.upsert({ where: { id: e.id }, create: { id: e.id, ...cols, createdAt: toUtc(e.createdAt) }, update: cols });
      },
      remove: (ids) => db.loyaltyTx.deleteMany({ where: { id: { in: ids } } }),
    },
    certificateTypes: {
      upsert: (e: CertificateType) => {
        const validDays = e.expiryMode === 'fixedPeriod' ? periodDays(e.expiryPeriodValue, e.expiryPeriodUnit) : 0;
        const cols = { ownerId: ownerOf(e.businessId), businessId: e.businessId, name: e.name.slice(0, 160), faceValue: BigInt(Math.round(e.nominal ?? 0)), validDays, data: json(e), ...audit };
        return db.certificateType.upsert({ where: { id: e.id }, create: { id: e.id, ...cols, createdAt: toUtc(e.createdAt), createdBy: actor }, update: { ...cols, version: { increment: 1 } } });
      },
      remove: (ids) => db.certificateType.deleteMany({ where: { id: { in: ids } } }),
    },
    certificates: {
      upsert: (e: Certificate) => {
        const cols = {
          typeId: e.certTypeId,
          businessId: e.businessId,
          clientId: e.clientId ?? null,
          code: codeOf(e.code, e.id),
          total: BigInt(Math.round(e.nominal ?? 0)),
          balance: BigInt(Math.round(e.balance ?? 0)),
          status: e.status,
          soldAt: toUtc(e.soldAt),
          expiresAt: endOfDay(e.expiresAt),
          data: json(e),
          ...audit,
        };
        return db.certificate.upsert({ where: { id: e.id }, create: { id: e.id, ...cols, createdBy: actor }, update: { ...cols, version: { increment: 1 } } });
      },
      remove: (ids) => db.certificate.deleteMany({ where: { id: { in: ids } } }),
    },
    membershipTypes: {
      upsert: (e: MembershipType) => {
        const cols = {
          ownerId: ownerOf(e.businessId),
          businessId: e.businessId,
          name: e.name.slice(0, 160),
          totalVisits: membershipTotal(e),
          price: BigInt(Math.round(e.price ?? 0)),
          validDays: e.durationValue > 0 ? periodDays(e.durationValue, e.durationUnit) : 3650,
          serviceIds: json((e.services ?? []).map((l) => l.serviceId).filter(Boolean)),
          archived: Boolean(e.archived),
          data: json(e),
          ...audit,
        };
        return db.membershipType.upsert({ where: { id: e.id }, create: { id: e.id, ...cols, createdAt: toUtc(e.createdAt), createdBy: actor }, update: { ...cols, version: { increment: 1 } } });
      },
      remove: (ids) => db.membershipType.deleteMany({ where: { id: { in: ids } } }),
    },
    memberships: {
      upsert: (e: Membership) => {
        const cols = {
          typeId: e.membershipTypeId,
          businessId: e.businessId,
          clientId: e.clientId || null,
          code: codeOf(e.code, e.id),
          totalVisits: e.totalVisits ?? null,
          remainingVisits: e.balanceVisits ?? null,
          status: e.status,
          soldAt: toUtc(e.soldAt),
          expiresAt: endOfDay(e.expiresAt),
          frozenUntil: e.status === 'frozen' && e.frozenUntil ? toUtc(e.frozenUntil) : null,
          data: json(e),
          ...audit,
        };
        return db.membershipSale.upsert({ where: { id: e.id }, create: { id: e.id, ...cols, createdBy: actor }, update: { ...cols, version: { increment: 1 } } });
      },
      remove: async (ids) => {
        await db.membershipFreeze.deleteMany({ where: { membershipId: { in: ids } } });
        return db.membershipSale.deleteMany({ where: { id: { in: ids } } });
      },
    },
    accountTypes: {
      upsert: (e: AccountType) => {
        const cols = { ownerId: ownerOf(e.businessId), businessId: e.businessId, name: e.name.slice(0, 160), data: json(e), ...audit };
        return db.clientAccountType.upsert({ where: { id: e.id }, create: { id: e.id, ...cols, createdAt: toUtc(e.createdAt), createdBy: actor }, update: { ...cols, version: { increment: 1 } } });
      },
      remove: (ids) => db.clientAccountType.deleteMany({ where: { id: { in: ids } } }),
    },
    accounts: {
      upsert: (e: ClientAccount) => {
        const cols = { typeId: e.accountTypeId, businessId: e.businessId, clientId: e.clientId, balance: BigInt(Math.round(e.balance)), data: json(e), ...audit };
        return db.clientAccount.upsert({ where: { id: e.id }, create: { id: e.id, ...cols, createdAt: toUtc(e.createdAt), createdBy: actor }, update: { ...cols, version: { increment: 1 } } });
      },
      remove: async (ids) => {
        await db.clientAccountOp.deleteMany({ where: { accountId: { in: ids } } });
        return db.clientAccount.deleteMany({ where: { id: { in: ids } } });
      },
    },
    accountOperations: {
      upsert: (e: AccountOperation) => {
        const cols = { accountId: e.accountId, kind: e.type, amount: BigInt(Math.round(e.amount)), staffId: e.authorStaffId ?? null, data: json(e) };
        return db.clientAccountOp.upsert({ where: { id: e.id }, create: { id: e.id, ...cols, createdAt: toUtc(e.createdAt) }, update: cols });
      },
      remove: (ids) => db.clientAccountOp.deleteMany({ where: { id: { in: ids } } }),
    },
    onlineOrders: {
      upsert: (e: OnlineOrder) => {
        const cols = { businessId: e.businessId, status: e.status, data: json(e) };
        return db.loyaltyOnlineOrder.upsert({ where: { id: e.id }, create: { id: e.id, ...cols, createdAt: toUtc(e.createdAt) }, update: { ...cols, version: { increment: 1 } } });
      },
      remove: (ids) => db.loyaltyOnlineOrder.deleteMany({ where: { id: { in: ids } } }),
    },
  } as unknown as Record<Coll, Writer>;
}

/** Порядок: родители раньше детей при создании, дети раньше родителей при удалении */
const UPSERT_ORDER: Coll[] = ['cardTypes', 'cards', 'promotions', 'certificateTypes', 'certificates', 'membershipTypes', 'memberships', 'accountTypes', 'accounts', 'accountOperations', 'transactions', 'onlineOrders'];

export interface SaveResult {
  written: number;
  removed: number;
}

/**
 * Записать разницу среза. `homeBusinessId` — бизнес запроса: настройки, у которых нет своего бизнеса
 * (флаги услуги без услуги в ядре), ложатся в его строку. `serviceBusiness` — чей это сервис (флаги услуги).
 */
export async function saveState(db: Db, snapshot: Snapshot, state: LoyaltyState, homeBusinessId: Id, serviceBusiness: (serviceId: Id) => Id | undefined, actor: string): Promise<SaveResult> {
  const w = writers(db, snapshot.owners, actor);
  const scope = new Set(snapshot.businessIds);
  let written = 0;
  let removed = 0;
  const toRemove: Partial<Record<Coll, Id[]>> = {};
  for (const c of UPSERT_ORDER) {
    const before = snapshot.entities[c];
    const after = state[c] as { id: Id; businessId?: Id }[];
    const seen = new Set<Id>();
    for (const e of after) {
      seen.add(e.id);
      const j = JSON.stringify(e);
      if (before.get(e.id) === j) continue;
      if (e.businessId && !scope.has(e.businessId)) throw new ApiError('forbidden', `loyalty: ${c} ${e.id} belongs to another business`);
      if (e.id.length > 32) throw new ApiError('validation', `loyalty: id too long ${e.id}`);
      await w[c].upsert(e as never);
      written++;
    }
    const gone = [...before.keys()].filter((id) => !seen.has(id));
    if (gone.length) toRemove[c] = gone;
  }
  for (const c of [...UPSERT_ORDER].reverse()) {
    const ids = toRemove[c];
    if (!ids?.length) continue;
    await w[c].remove(ids);
    removed += ids.length;
  }

  // настройки: раскладываем по бизнесам-владельцам ключа
  const bags = new Map<Id, SettingsBag>(snapshot.businessIds.map((id) => [id, {}]));
  const bagOf = (id: Id | undefined): SettingsBag => bags.get(id && scope.has(id) ? id : homeBusinessId) ?? bags.get(homeBusinessId)!;
  for (const key of SETTINGS_KEYS) {
    const byService = key === 'serviceAutoCharge' || key === 'onlineRequireMembership';
    for (const [k, v] of Object.entries(state[key] as Record<Id, unknown>)) {
      const bag = bagOf(byService ? serviceBusiness(k) : k) as Record<string, Record<Id, unknown>>;
      (bag[key] ??= {})[k] = v;
    }
  }
  const txBiz = new Map(state.transactions.filter((t) => t.bookingId).map((t) => [t.bookingId!, t.businessId]));
  for (const id of state.paidBookingIds) (bagOf(txBiz.get(id)).paidBookingIds ??= []).push(id);
  for (const [businessId, bag] of bags) {
    const j = canonical(bag);
    const prev = snapshot.settings.get(businessId) ?? canonical({});
    if (prev === j) continue;
    await db.businessSetting.upsert({
      where: { businessId_area: { businessId, area: SETTINGS_AREA } },
      create: { businessId, area: SETTINGS_AREA, data: json(bag), updatedBy: actor },
      update: { data: json(bag), updatedBy: actor, version: { increment: 1 } },
    });
    written++;
  }
  return { written, removed };
}
