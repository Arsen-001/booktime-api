import type { Business, CoreData, Id, LocalizedText } from './core-types.js';
import type { CardType, Certificate, CertificateType, LoyaltyCard, Membership, MembershipType, Promotion } from './domain.js';
import { isCertificateExpired, isPromotionActiveNow, membershipDisplayStatus } from './domain.js';
import { issueCard, setMembershipFrozen } from './logic.js';
import { ApiError, dayjs, mutateArea, portNowDate, readArea, readCore, today } from './shim.js';
import type { LoyaltyState } from './state.js';

/**
 * Этап 21, лейн client-loyalty: абонементы, сертификаты и кэшбэк В ПРИЛОЖЕНИИ КЛИЕНТА (src/api/client.ts фронта,
 * F-14-018…054, F-14-098/102, В-17) — над теми же строками лояльности, что кабинет (port/store.ts). Своих правил
 * здесь нет: статус абонемента — `membershipDisplayStatus`, истечение сертификата — `isCertificateExpired`,
 * заморозка — `setMembershipFrozen`, выдача карты — `issueCard` фасада лояльности. Этот файл только переводит
 * сущности раздела «Лояльность» в формы приложения клиента (domain/client.ts: Membership/GiftCertificate/
 * CashbackCard/…Template) и находит «свои» по `Client.appUserId`.
 *
 * Заявки на покупку (В-17, `pending_confirmation`/`rejected`) в срез раздела не входят (store.ts) — их строки
 * читает client-loyalty.service.ts и передаёт сюда аргументом `pending` (только сервер, не тело запроса).
 */

// ─────────── формы приложения клиента (booking-platform/src/domain/client.ts) ───────────

type PurchaseStatus = 'pendingConfirmation' | 'confirmed' | 'rejected';

export interface AppMembership {
  id: Id;
  appUserId: Id;
  businessId: Id;
  title: LocalizedText;
  number: string;
  visitsTotal: number;
  visitsLeft: number;
  price: number;
  validUntil: string;
  frozen: boolean;
  freezeDaysAvailable?: number;
  serviceNames: string[];
  imageUrl?: string;
  onSale: boolean;
  autoRenew: boolean;
  purchasedAt: string;
  active: boolean;
  purchaseStatus: PurchaseStatus;
  paymentSentAt?: string;
}

export interface AppCertificate {
  id: Id;
  appUserId: Id;
  businessId: Id;
  number: string;
  faceValue: number;
  balance: number;
  usesLimit: 'once' | 'multiple';
  validUntil: string;
  appliesTo: 'anything' | 'services' | 'products';
  imageUrl?: string;
  purchasedAt: string;
  active: boolean;
  purchaseStatus: PurchaseStatus;
  paymentSentAt?: string;
}

type EarnKind = 'fixed' | 'per_visit_count' | 'per_spend_sum' | 'per_visit_spend';
export interface AppCashbackCard {
  id: Id;
  appUserId: Id;
  businessId: Id;
  cardNumber: string;
  balance: number;
  visible: boolean;
  spendScope: 'anything' | 'services' | 'products' | 'blocked';
  spendLimitedToServiceNames?: string[];
  spendLimitMoney?: number;
  spendLimitPercent?: number;
  earnRules: { kind: EarnKind; rate: number; isPercent: boolean; toNextLevel?: number; limitedToServiceNames?: string[] }[];
  discountText?: string;
}

interface NetworkLocationsInfo {
  networkId: Id;
  networkName: string;
  locations: { businessId: Id; name: string }[];
}
type WithBusiness<T> = T & { businessName: string; businessLogoUrl?: string; network?: NetworkLocationsInfo };

/** Строка заявки В-17 (не в срезе раздела) — собирает client-loyalty.service.ts из таблиц этапа 11 */
export interface PendingRow {
  kind: 'membership' | 'certificate';
  id: Id;
  businessId: Id;
  typeId: Id;
  appUserId: Id;
  code: string;
  status: 'pendingConfirmation' | 'rejected';
  soldAt: string;
  expiresAt: string;
  total: number;
  totalVisits: number;
  paymentSentAt?: string;
}

/** Поля приложения, которых нет у сущности раздела — лежат в той же `data` строки абонемента */
type AppMembershipExtras = { appAutoRenew?: boolean; appReminderSeen?: boolean };

/** Сколько дней клиент может заморозить абонемент сам из приложения (F-14-038; как в демо) — тип только разрешает */
const APP_FREEZE_DAYS = 14;
/** F-14-046: напоминание — за столько дней до конца срока или на последнем визите */
const REMINDER_DAYS = 5;

const area = (): LoyaltyState => readArea('loyalty');

// ─────────── общие переводы ───────────

function myClientIds(core: CoreData, appUserId: Id): Map<Id, Id> {
  return new Map(core.clients.filter((c) => c.appUserId === appUserId).map((c) => [c.id, c.businessId]));
}

function businessNetwork(core: CoreData, business: Business | undefined) {
  if (!business?.networkId) return undefined;
  const net = core.networks.find((n) => n.id === business.networkId);
  return net && net.businessIds.length > 1 ? net : undefined;
}

function attachBusiness<T extends { businessId: Id }>(core: CoreData, item: T): WithBusiness<T> {
  const business = core.businesses.find((b) => b.id === item.businessId);
  const net = businessNetwork(core, business);
  const main = net ? core.businesses.find((b) => b.id === net.businessIds[0]) : undefined;
  const businessLogoUrl = net ? (main?.logoUrl ?? business?.logoUrl) : business?.logoUrl;
  return {
    ...item,
    businessName: business?.name ?? '',
    ...(businessLogoUrl ? { businessLogoUrl } : {}),
    ...(net
      ? {
          network: {
            networkId: net.id,
            networkName: net.name,
            locations: net.businessIds
              .map((id) => core.businesses.find((b) => b.id === id))
              .filter((b): b is Business => Boolean(b))
              .map((b) => ({ businessId: b.id, name: b.name })),
          },
        }
      : {}),
  };
}

const UNIT_DAYS: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 };
const periodDays = (value: number | undefined, unit: string | undefined): number => Math.max(0, Math.round((value ?? 0) * (UNIT_DAYS[unit ?? 'day'] ?? 1)));

function typeTotalVisits(type: MembershipType | undefined): number {
  if (!type) return 0;
  return type.balanceMode === 'shared' ? (type.sharedVisits ?? 0) : type.services.reduce((sum, l) => sum + l.visits, 0);
}

function typeServiceNames(core: CoreData, type: MembershipType | undefined): string[] {
  if (!type) return [];
  const names: string[] = [];
  for (const line of type.services) {
    if (line.serviceId) {
      const s = core.services.find((x) => x.id === line.serviceId);
      if (s) names.push(s.name.ru);
    } else if (line.categoryId) {
      for (const s of core.services.filter((x) => x.categoryId === line.categoryId)) names.push(s.name.ru);
    }
  }
  return [...new Set(names)];
}

const onSale = (t: { archived?: boolean; onlineSale?: { enabled: boolean } }): boolean => Boolean(t.onlineSale?.enabled) && !t.archived;

function membershipTitle(type: MembershipType | undefined): LocalizedText {
  const t = type?.onlineSale?.title;
  const name = type?.name ?? '';
  return t?.ru ? { ...t } : { ru: name };
}

function membershipView(core: CoreData, s: LoyaltyState, m: Membership & AppMembershipExtras, appUserId: Id): AppMembership {
  const type = s.membershipTypes.find((t) => t.id === m.membershipTypeId);
  const status = membershipDisplayStatus(m, today());
  return {
    id: m.id,
    appUserId,
    businessId: m.businessId,
    title: membershipTitle(type),
    number: m.code || m.id,
    visitsTotal: m.totalVisits,
    visitsLeft: m.balanceVisits,
    price: m.soldPrice ?? m.price,
    validUntil: m.expiresAt,
    frozen: status === 'frozen',
    ...(type?.freezeAllowed ? { freezeDaysAvailable: APP_FREEZE_DAYS } : {}),
    serviceNames: typeServiceNames(core, type),
    ...(type?.onlineSale?.imageUrl ? { imageUrl: type.onlineSale.imageUrl } : {}),
    onSale: type ? onSale(type) : false,
    autoRenew: Boolean(m.appAutoRenew),
    purchasedAt: m.soldAt,
    active: status === 'active' || status === 'issued' || status === 'frozen',
    purchaseStatus: 'confirmed',
  };
}

function pendingMembershipView(core: CoreData, s: LoyaltyState, p: PendingRow): AppMembership {
  const type = s.membershipTypes.find((t) => t.id === p.typeId);
  return {
    id: p.id,
    appUserId: p.appUserId,
    businessId: p.businessId,
    title: membershipTitle(type),
    number: p.code,
    visitsTotal: p.totalVisits || typeTotalVisits(type),
    visitsLeft: p.totalVisits || typeTotalVisits(type),
    price: type?.onlineSale?.price ?? type?.price ?? p.total,
    validUntil: p.expiresAt,
    frozen: false,
    ...(type?.freezeAllowed ? { freezeDaysAvailable: APP_FREEZE_DAYS } : {}),
    serviceNames: typeServiceNames(core, type),
    ...(type?.onlineSale?.imageUrl ? { imageUrl: type.onlineSale.imageUrl } : {}),
    onSale: type ? onSale(type) : false,
    autoRenew: false,
    purchasedAt: p.soldAt,
    active: false,
    purchaseStatus: p.status,
    ...(p.paymentSentAt ? { paymentSentAt: p.paymentSentAt } : {}),
  };
}

function appliesTo(type: CertificateType | undefined): AppCertificate['appliesTo'] {
  if (!type) return 'anything';
  if (type.applyServicesMode === 'none') return 'products';
  if (!type.applyProductsAllowed) return 'services';
  return 'anything';
}

function certificateView(s: LoyaltyState, c: Certificate, appUserId: Id): AppCertificate {
  const type = s.certificateTypes.find((t) => t.id === c.certTypeId);
  const expired = isCertificateExpired(c.expiresAt, today());
  return {
    id: c.id,
    appUserId,
    businessId: c.businessId,
    number: c.code || c.id,
    faceValue: c.nominal,
    balance: c.balance,
    usesLimit: type?.chargeType === 'single' ? 'once' : 'multiple',
    validUntil: c.expiresAt ?? '',
    appliesTo: appliesTo(type),
    ...(type?.onlineSale?.imageUrl ? { imageUrl: type.onlineSale.imageUrl } : {}),
    purchasedAt: c.soldAt,
    active: c.status === 'active' && c.balance > 0 && !expired,
    purchaseStatus: 'confirmed',
  };
}

function pendingCertificateView(s: LoyaltyState, p: PendingRow): AppCertificate {
  const type = s.certificateTypes.find((t) => t.id === p.typeId);
  return {
    id: p.id,
    appUserId: p.appUserId,
    businessId: p.businessId,
    number: p.code,
    faceValue: p.total,
    balance: p.total,
    usesLimit: type?.chargeType === 'single' ? 'once' : 'multiple',
    validUntil: p.expiresAt,
    appliesTo: appliesTo(type),
    ...(type?.onlineSale?.imageUrl ? { imageUrl: type.onlineSale.imageUrl } : {}),
    purchasedAt: p.soldAt,
    active: false,
    purchaseStatus: p.status,
    ...(p.paymentSentAt ? { paymentSentAt: p.paymentSentAt } : {}),
  };
}

const EARN_KIND: Partial<Record<Promotion['kind'], EarnKind>> = {
  cashbackFixed: 'fixed',
  cashbackAccumVisits: 'per_visit_count',
  cashbackAccumSum: 'per_spend_sum',
  cashbackVisit: 'per_visit_spend',
};

function scopeServiceNames(core: CoreData, scope: { categoryIds: Id[]; serviceIds: Id[] } | undefined): string[] | undefined {
  if (!scope || (scope.categoryIds.length === 0 && scope.serviceIds.length === 0)) return undefined;
  const names = core.services.filter((s) => scope.serviceIds.includes(s.id) || scope.categoryIds.includes(s.categoryId)).map((s) => s.name.ru);
  return names.length ? [...new Set(names)] : undefined;
}

/** Карта раздела → карта кэшбэка приложения (F-14-048…054): правила начисления — бонусные акции её типа */
function cashbackView(core: CoreData, s: LoyaltyState, card: LoyaltyCard, appUserId: Id): AppCashbackCard {
  const type: CardType | undefined = s.cardTypes.find((t) => t.id === card.cardTypeId);
  const now = portNowDate();
  const promos = s.promotions.filter((p) => p.cardTypeIds.includes(card.cardTypeId) && isPromotionActiveNow(p, now));
  const earnRules = promos.flatMap((p) => {
    const kind = EARN_KIND[p.kind];
    if (!kind) return [];
    // накопительные — текущая ступень считается при оплате визита (previewCashback); здесь — первая ступень таблицы
    const rate = p.thresholds?.length ? (p.thresholds[0]?.value ?? p.value) : p.value;
    const limited = scopeServiceNames(core, p.serviceScope);
    return [{ kind, rate, isPercent: p.valueType === 'percent', ...(limited ? { limitedToServiceNames: limited } : {}) }];
  });
  const discount = promos.find((p) => p.kind.startsWith('discount'));
  const svcMode = type?.serviceLimitMode ?? 'all';
  const prodMode = type?.productLimitMode ?? 'all';
  const spendScope: AppCashbackCard['spendScope'] = svcMode === 'none' && prodMode === 'none' ? 'blocked' : svcMode === 'none' ? 'products' : prodMode === 'none' ? 'services' : 'anything';
  const limitedNames = svcMode === 'some' ? scopeServiceNames(core, type?.serviceLimitScope) : undefined;
  return {
    id: card.id,
    appUserId,
    businessId: card.businessId,
    cardNumber: card.number,
    balance: card.balance,
    visible: type?.cashbackVisibleInApp !== false,
    spendScope,
    ...(limitedNames ? { spendLimitedToServiceNames: limitedNames } : {}),
    ...(type?.paymentLimitFixed ? { spendLimitMoney: type.paymentLimitFixed } : {}),
    ...(type?.paymentLimitPercent && !type.paymentLimitFixed ? { spendLimitPercent: type.paymentLimitPercent } : {}),
    earnRules,
    ...(discount ? { discountText: `${discount.name}: ${discount.value}${discount.valueType === 'percent' ? '%' : ' ֏'}` } : {}),
  };
}

function myMemberships(appUserId: Id): Array<{ m: Membership & AppMembershipExtras; view: AppMembership }> {
  const core = readCore();
  const s = area();
  const mine = myClientIds(core, appUserId);
  return s.memberships.filter((m) => mine.get(m.clientId) === m.businessId).map((m) => ({ m, view: membershipView(core, s, m, appUserId) }));
}

function myCertificates(appUserId: Id): AppCertificate[] {
  const s = area();
  const mine = myClientIds(readCore(), appUserId);
  return s.certificates.filter((c) => c.clientId && mine.get(c.clientId) === c.businessId).map((c) => certificateView(s, c, appUserId));
}

function myCards(appUserId: Id): AppCashbackCard[] {
  const core = readCore();
  const s = area();
  const mine = myClientIds(core, appUserId);
  return s.cards.filter((c) => mine.get(c.clientId) === c.businessId).map((c) => cashbackView(core, s, c, appUserId));
}

// ─────────── клиент приложения (/v1/me) — appUserId всегда из сессии ───────────

/** F-14-037: действующие + заявки (ждут/отклонены) */
export async function appListMemberships(appUserId: Id, pending: PendingRow[] = []): Promise<WithBusiness<AppMembership>[]> {
  const core = readCore();
  const s = area();
  const confirmed = myMemberships(appUserId).map((x) => x.view).filter((v) => v.active);
  const requests = pending.filter((p) => p.kind === 'membership').map((p) => pendingMembershipView(core, s, p));
  return [...confirmed, ...requests].map((v) => attachBusiness(core, v));
}

/** F-14-019/037: по id — и израсходованный; чужой — undefined */
export async function appGetMembership(appUserId: Id, id: Id, pending: PendingRow[] = []): Promise<WithBusiness<AppMembership> | undefined> {
  const core = readCore();
  const own = myMemberships(appUserId).find((x) => x.m.id === id)?.view;
  const req = pending.find((p) => p.kind === 'membership' && p.id === id);
  const view = own ?? (req ? pendingMembershipView(core, area(), req) : undefined);
  return view ? attachBusiness(core, view) : undefined;
}

/** F-14-038: заморозка самим клиентом — только если тип разрешает (правило и сдвиг срока — setMembershipFrozen) */
export async function appToggleMembershipFreeze(appUserId: Id, id: Id): Promise<AppMembership> {
  const own = myMemberships(appUserId).find((x) => x.m.id === id);
  if (!own) throw new ApiError('not_found');
  await setMembershipFrozen(own.m.businessId, id, !own.view.frozen, APP_FREEZE_DAYS);
  const next = myMemberships(appUserId).find((x) => x.m.id === id);
  if (!next) throw new ApiError('not_found');
  return next.view;
}

/** F-14-047: только отметка (списания с карты нет, F-00-028) — хранится в `data` строки абонемента */
export async function appToggleMembershipAutoRenew(appUserId: Id, id: Id): Promise<AppMembership> {
  const own = myMemberships(appUserId).find((x) => x.m.id === id);
  if (!own) throw new ApiError('not_found');
  mutateArea('loyalty', (s) => {
    const m = s.memberships.find((x) => x.id === id) as (Membership & AppMembershipExtras) | undefined;
    if (m) m.appAutoRenew = !m.appAutoRenew;
  });
  return myMemberships(appUserId).find((x) => x.m.id === id)!.view;
}

/** F-14-040: действующие + заявки */
export async function appListCertificates(appUserId: Id, pending: PendingRow[] = []): Promise<WithBusiness<AppCertificate>[]> {
  const core = readCore();
  const s = area();
  const confirmed = myCertificates(appUserId).filter((c) => c.active);
  const requests = pending.filter((p) => p.kind === 'certificate').map((p) => pendingCertificateView(s, p));
  return [...confirmed, ...requests].map((v) => attachBusiness(core, v));
}

export async function appGetCertificate(appUserId: Id, id: Id, pending: PendingRow[] = []): Promise<WithBusiness<AppCertificate> | undefined> {
  const core = readCore();
  const own = myCertificates(appUserId).find((c) => c.id === id);
  const req = pending.find((p) => p.kind === 'certificate' && p.id === id);
  const view = own ?? (req ? pendingCertificateView(area(), req) : undefined);
  return view ? attachBusiness(core, view) : undefined;
}

/** F-14-054: все карты клиента */
export async function appListLoyaltyCards(appUserId: Id): Promise<WithBusiness<AppCashbackCard>[]> {
  const core = readCore();
  return myCards(appUserId).map((c) => attachBusiness(core, c));
}

/** F-14-048…053: видимая карта с бонусной программой, наибольший баланс; равенство — последняя выданная */
export async function appGetCashbackForBusiness(appUserId: Id, businessId: Id): Promise<AppCashbackCard | undefined> {
  const cards = myCards(appUserId).filter((c) => c.businessId === businessId && c.visible && c.earnRules.length > 0);
  if (!cards.length) return undefined;
  return cards.reduce((best, c) => (c.balance >= best.balance ? c : best));
}

/**
 * F-14-165: абонемент, которым можно оплатить эту услугу при записи. Покрытие — правило раздела (F-06-107): общий
 * баланс покрывает любую услугу, раздельный — только свои услуги/категории; плюс действует, не заморожен, есть визиты.
 */
export async function appGetBookingMembershipOption(appUserId: Id, businessId: Id, serviceId: Id): Promise<AppMembership | undefined> {
  const core = readCore();
  const s = area();
  const service = core.services.find((x) => x.id === serviceId);
  if (!service) return undefined;
  const todayIso = today();
  return myMemberships(appUserId).find(({ m }) => {
    if (m.businessId !== businessId) return false;
    const status = membershipDisplayStatus(m, todayIso);
    if ((status !== 'active' && status !== 'issued') || m.balanceVisits <= 0) return false;
    const type = s.membershipTypes.find((t) => t.id === m.membershipTypeId);
    if (!type) return false;
    if (type.balanceMode === 'shared') return true;
    return type.services.some((l) => (l.serviceId && l.serviceId === serviceId) || (l.categoryId && l.categoryId === service.categoryId));
  })?.view;
}

/** F-14-046: скоро кончится (≤5 дней или последний визит) и напоминание ещё не видел; продление — тот же тип, если продаётся */
export async function appListPendingMembershipReminders(appUserId: Id): Promise<Array<WithBusiness<AppMembership> & { renewTemplateId?: Id }>> {
  const core = readCore();
  const s = area();
  const now = dayjs(today());
  return myMemberships(appUserId)
    .filter(({ m, view }) => view.active && !view.frozen && !m.appReminderSeen)
    .filter(({ view }) => view.visitsLeft <= 1 || dayjs(view.validUntil).diff(now, 'day') <= REMINDER_DAYS)
    .map(({ m, view }) => {
      const type = s.membershipTypes.find((t) => t.id === m.membershipTypeId);
      return { ...attachBusiness(core, view), ...(type && onSale(type) ? { renewTemplateId: type.id } : {}) };
    });
}

export async function appMarkMembershipReminderSeen(appUserId: Id, membershipId: Id): Promise<void> {
  if (!myMemberships(appUserId).some((x) => x.m.id === membershipId)) return;
  mutateArea('loyalty', (s) => {
    const m = s.memberships.find((x) => x.id === membershipId) as (Membership & AppMembershipExtras) | undefined;
    if (m) m.appReminderSeen = true;
  });
}

/** Форма заявки для ответа покупки (В-17) — только что созданная строка */
export async function appPendingView(pending: PendingRow): Promise<AppMembership | AppCertificate> {
  return pending.kind === 'membership' ? pendingMembershipView(readCore(), area(), pending) : pendingCertificateView(area(), pending);
}

// ─────────── страница места (без входа) ───────────

/**
 * F-14-044: чьи онлайн-продажи показывать. В сети — первый филиал (порядок Network.businessIds), где хоть один тип
 * «Доступно для продажи онлайн» (F-06-147); иначе основная локация сети; вне сети — сам бизнес.
 */
function salesSourceBusinessId(businessId: Id): Id {
  const core = readCore();
  const s = area();
  const net = businessNetwork(
    core,
    core.businesses.find((b) => b.id === businessId),
  );
  if (!net) return businessId;
  const hasOnSale = (id: Id) => s.membershipTypes.some((t) => t.businessId === id && onSale(t)) || s.certificateTypes.some((t) => t.businessId === id && onSale(t));
  return net.businessIds.find(hasOnSale) ?? net.businessIds[0] ?? businessId;
}

function membershipTemplate(core: CoreData, t: MembershipType) {
  return {
    id: t.id,
    businessId: t.businessId,
    title: membershipTitle(t),
    visitsTotal: typeTotalVisits(t),
    price: t.onlineSale?.price ?? t.price,
    validDays: t.durationValue > 0 ? periodDays(t.durationValue, t.durationUnit) : 3650,
    serviceNames: typeServiceNames(core, t),
    ...(t.onlineSale?.imageUrl ? { imageUrl: t.onlineSale.imageUrl } : {}),
    onSale: onSale(t),
  };
}

function certificateValidDays(t: CertificateType): number {
  if (t.expiryMode === 'fixedPeriod') return periodDays(t.expiryPeriodValue, t.expiryPeriodUnit) || 3650;
  if (t.expiryMode === 'fixedDate' && t.expiryDate) return Math.max(0, dayjs(t.expiryDate).diff(dayjs(today()), 'day'));
  return 3650;
}

export async function appListPurchasableMemberships(businessId: Id) {
  const core = readCore();
  const source = salesSourceBusinessId(businessId);
  return area()
    .membershipTypes.filter((t) => t.businessId === source && onSale(t))
    .map((t) => membershipTemplate(core, t));
}

export async function appListPurchasableCertificates(businessId: Id) {
  const source = salesSourceBusinessId(businessId);
  return area()
    .certificateTypes.filter((t) => t.businessId === source && onSale(t))
    .map((t) => ({
      id: t.id,
      businessId: t.businessId,
      faceValue: t.nominal,
      validDays: certificateValidDays(t),
      usesLimit: t.chargeType === 'single' ? ('once' as const) : ('multiple' as const),
      appliesTo: appliesTo(t),
      onSale: true,
    }));
}

/** F-14-045 «Renew»: тот же тип (по названию) этого бизнеса, если он ещё продаётся */
export async function appFindRenewTemplate(businessId: Id, title: LocalizedText) {
  const core = readCore();
  const t = area().membershipTypes.find((x) => x.businessId === businessId && onSale(x) && membershipTitle(x).ru === title?.ru);
  return t ? membershipTemplate(core, t) : undefined;
}

/** Тип, который клиент покупает (В-17): только продающийся онлайн — проверка здесь, не только в витрине */
export async function appSaleTypeInfo(kind: 'membership' | 'certificate', typeId: Id): Promise<{ businessId: Id; price: number; validDays: number; totalVisits: number }> {
  const s = area();
  if (kind === 'membership') {
    const t = s.membershipTypes.find((x) => x.id === typeId);
    if (!t) throw new ApiError('not_found');
    if (!onSale(t)) throw new ApiError('not_active');
    return { businessId: t.businessId, price: t.onlineSale?.price ?? t.price, validDays: t.durationValue > 0 ? periodDays(t.durationValue, t.durationUnit) : 3650, totalVisits: typeTotalVisits(t) };
  }
  const t = s.certificateTypes.find((x) => x.id === typeId);
  if (!t) throw new ApiError('not_found');
  if (!onSale(t)) throw new ApiError('not_active');
  return { businessId: t.businessId, price: t.nominal, validDays: certificateValidDays(t), totalVisits: 0 };
}

// ─────────── кабинет: визит-приложение и настройки (/v1/biz) ───────────

/** F-14-098: число программ лояльности клиента визита — действующие абонементы, сертификаты и видимая карта */
export async function appCountVisitLoyaltyOptions(businessId: Id, appUserId: Id | undefined): Promise<number> {
  if (!appUserId) return 0;
  const todayIso = today();
  const core = readCore();
  const s = area();
  const clientIds = new Set(core.clients.filter((c) => c.businessId === businessId && c.appUserId === appUserId).map((c) => c.id));
  if (!clientIds.size) return 0;
  const memberships = s.memberships.filter((m) => m.businessId === businessId && clientIds.has(m.clientId) && ['active', 'issued', 'frozen'].includes(membershipDisplayStatus(m, todayIso))).length;
  const certificates = s.certificates.filter(
    (c) => c.businessId === businessId && c.clientId && clientIds.has(c.clientId) && c.status === 'active' && c.balance > 0 && !isCertificateExpired(c.expiresAt, todayIso),
  ).length;
  const cashback = s.cards.some((c) => c.businessId === businessId && clientIds.has(c.clientId) && s.cardTypes.find((t) => t.id === c.cardTypeId)?.cashbackVisibleInApp !== false) ? 1 : 0;
  return memberships + certificates + cashback;
}

/**
 * F-14-102: «+» в «Customer loyalty» визита — карта клиенту приложения. Тип — первый действующий тип карты
 * бизнеса, у которого есть бонусная акция (иначе первый действующий); выдача и номер — issueCard раздела.
 */
export async function appIssueLoyaltyCard(businessId: Id, appUserId: Id, cardNumber?: string): Promise<AppCashbackCard> {
  const core = readCore();
  const s = area();
  const client = core.clients.find((c) => c.businessId === businessId && c.appUserId === appUserId);
  if (!client) throw new ApiError('not_found', 'Client not found');
  const types = s.cardTypes.filter((t) => t.businessId === businessId && !t.archived);
  const withCashback = types.find((t) => s.promotions.some((p) => p.cardTypeIds.includes(t.id) && EARN_KIND[p.kind]));
  const type = withCashback ?? types[0];
  if (!type) throw new ApiError('not_found', 'No card type');
  const card = await issueCard(businessId, client.id, type.id, cardNumber?.trim() || undefined);
  return cashbackView(readCore(), area(), card, appUserId);
}

/** F-14-098: сертификат (действующий) или карта по номеру — любого клиента бизнеса (подарок предъявляют по коду) */
export async function appFindLoyaltyByCode(businessId: Id, code: string) {
  const query = code.trim().toLowerCase();
  if (!query) return undefined;
  const core = readCore();
  const s = area();
  const clientOf = (id: Id | undefined) => (id ? core.clients.find((c) => c.id === id) : undefined);
  const todayIso = today();
  const cert = s.certificates.find((c) => c.businessId === businessId && c.status === 'active' && !isCertificateExpired(c.expiresAt, todayIso) && c.code?.toLowerCase() === query);
  if (cert) {
    const client = clientOf(cert.clientId);
    return { kind: 'certificate' as const, id: cert.id, code: cert.code, appUserId: client?.appUserId ?? '', clientName: client?.name ?? '—', balance: cert.balance };
  }
  const card = s.cards.find((c) => c.businessId === businessId && c.number.toLowerCase() === query);
  if (card) {
    const client = clientOf(card.clientId);
    return { kind: 'cashback' as const, id: card.id, code: card.number, appUserId: client?.appUserId ?? '', clientName: client?.name ?? '—', balance: card.balance };
  }
  return undefined;
}

/** F-14-053 = F-06-028 «Показывать кэшбэк в приложении» — у всех типов карт бизнеса разом */
export async function appSetCashbackVisibleForBusiness(businessId: Id, visible: boolean): Promise<void> {
  mutateArea('loyalty', (s) => {
    for (const t of s.cardTypes) if (t.businessId === businessId) t.cashbackVisibleInApp = visible;
  });
}

export async function appGetCashbackVisibleForBusiness(businessId: Id): Promise<boolean> {
  const types = area().cardTypes.filter((t) => t.businessId === businessId);
  return types.length ? types.every((t) => t.cashbackVisibleInApp !== false) : true;
}
