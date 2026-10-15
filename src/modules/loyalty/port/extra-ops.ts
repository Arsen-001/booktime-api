import type { Id } from './core-types.js';
import type { Certificate, CertificateType } from './domain.js';
import * as logic from './logic.js';
import { adjustMembership, getLoyaltyBookingSummary, getServiceAutoCharge, type LoyaltyHubOverview, type OnlineOrderInput, type OnlineSaleCatalogItem, type SellCertificateInput } from './logic.js';
import { ApiError, mutateArea, nowDateTime, readArea } from './shim.js';
import type { LoyaltyState } from './state.js';

/**
 * Функции, которых нет в src/api/loyalty.ts фронта, но которые живут на движке лояльности: автосписание с
 * абонемента участника группового события (F-16-062, src/api/resources.ts getBookingAutoCharge /
 * chargeBookingAutoDebit). Во фронте статус лежал в срезе resources; на сервере — рядом с настройкой услуги
 * (F-06-127), в тех же настройках лояльности, и списание со статусом идут одной транзакцией (два администратора
 * не спишут посещение дважды).
 */
export interface BookingAutoChargeInfo {
  applicable: boolean;
  freeCancelHours: number;
  status: 'pending' | 'charged' | 'not_charged';
  membershipId?: Id;
}

const area = () => readArea('loyalty') as LoyaltyState;

export async function getBookingAutoCharge(businessId: Id, bookingId: Id, serviceId: Id): Promise<BookingAutoChargeInfo> {
  const setting = await getServiceAutoCharge(businessId, serviceId);
  if (!setting.enabled) return { applicable: false, freeCancelHours: setting.freeCancelHours, status: 'pending' };
  const saved = area().autoChargeStatus[bookingId];
  if (saved) return { applicable: true, freeCancelHours: setting.freeCancelHours, status: saved.status, ...(saved.membershipId ? { membershipId: saved.membershipId } : {}) };
  return { applicable: true, freeCancelHours: setting.freeCancelHours, status: 'pending' };
}

export async function chargeBookingAutoDebit(businessId: Id, bookingId: Id, serviceId: Id, clientId: Id): Promise<BookingAutoChargeInfo> {
  const saved = area().autoChargeStatus[bookingId];
  if (saved?.status === 'charged') return { applicable: true, freeCancelHours: 0, status: 'charged', ...(saved.membershipId ? { membershipId: saved.membershipId } : {}) };
  const summary = (await getLoyaltyBookingSummary(businessId, clientId, [serviceId])) as { memberships: { id: Id; applicable: boolean; balanceVisits: number }[] };
  const usable = summary.memberships.find((m) => m.applicable && m.balanceVisits > 0);
  let result: BookingAutoChargeInfo;
  if (usable) {
    await adjustMembership(businessId, usable.id, { balanceVisits: usable.balanceVisits - 1 });
    result = { applicable: true, freeCancelHours: 0, status: 'charged', membershipId: usable.id };
  } else {
    result = { applicable: true, freeCancelHours: 0, status: 'not_charged' };
  }
  mutateArea('loyalty', (s) => {
    s.autoChargeStatus[bookingId] = { status: result.status as 'charged' | 'not_charged', ...(result.membershipId ? { membershipId: result.membershipId } : {}), at: nowDateTime() };
  });
  return result;
}

// ─────────────────────────── Сертификаты: архив типа и «продано» хаба (QA приложений 15.10.2026) ───────────────────────────
//
// Фасад фронта (logic.ts, генерируется из src/api/loyalty.ts) не умел архивировать тип сертификата — у типов карт
// и абонементов это есть (setCardTypeArchived / setMembershipTypeArchived), а у типа с проданными сертификатами
// «Удалить» недоступно (маршрут этапа 11 отвечает has_issued_cards). Здесь — то же правило, что у карт (F-06-030,
// В-40): архивный тип не продаётся (ни в кассе, ни онлайн), проданные сертификаты работают до конца срока, «Вернуть
// из архива» снимает флаг. Флаг лежит и в колонке certificate_types.archived (store.ts), её же читает продажа
// из окна записи (journal-more) и маршрут этапа 11 PUT certificate-types/:id/archive.

type ArchivableCertType = CertificateType & { archived?: boolean };

const isArchivedCertType = (businessId: Id, typeId: Id): boolean =>
  Boolean((area().certificateTypes as ArchivableCertType[]).find((t) => t.id === typeId && t.businessId === businessId)?.archived);

export async function setCertificateTypeArchived(businessId: Id, typeId: Id, archived: boolean): Promise<CertificateType> {
  let updated: ArchivableCertType | undefined;
  mutateArea('loyalty', (s) => {
    const type = (s.certificateTypes as ArchivableCertType[]).find((t) => t.id === typeId && t.businessId === businessId);
    if (!type) throw new ApiError('not_found');
    type.archived = archived || undefined;
    type.updatedAt = nowDateTime();
    updated = type;
  });
  if (!updated) throw new ApiError('not_found');
  return updated;
}

/** Продажа в кассе: тип в архиве — нельзя (как выдача карты архивного типа) */
export async function sellCertificate(businessId: Id, input: SellCertificateInput): Promise<Certificate> {
  if (isArchivedCertType(businessId, input.certTypeId)) throw new ApiError('validation');
  return logic.sellCertificate(businessId, input);
}

/** Витрина онлайн-продажи: архивные типы сертификатов не показываем (абонементы фасад уже отсеивает) */
export async function listOnlineSaleCatalog(businessId: Id, locale = 'ru'): Promise<OnlineSaleCatalogItem[]> {
  const items = await logic.listOnlineSaleCatalog(businessId, locale);
  return items.filter((i) => i.kind !== 'certificate' || !isArchivedCertType(businessId, i.typeId));
}

export async function createOnlineOrder(businessId: Id, input: OnlineOrderInput): Promise<Awaited<ReturnType<typeof logic.createOnlineOrder>>> {
  if (input.itemKind === 'certificate' && isArchivedCertType(businessId, input.itemTypeId)) throw new ApiError('not_found');
  return logic.createOnlineOrder(businessId, input);
}

/**
 * Хаб «Лояльность» (F-06-001): «продано N, на X» — без отменённых продаж и возвратов. Статус 'expired' у сертификата
 * ставят только «Отменить продажу» (voidCertificateSale) и возврат до нуля (refundCertificateAmount) — такие не
 * считаем; частичный возврат вычитаем из суммы (строки certificateRefund). Фасад фронта считал все экземпляры.
 */
export async function getLoyaltyHubOverview(businessId: Id): Promise<LoyaltyHubOverview> {
  const base = await logic.getLoyaltyHubOverview(businessId);
  const s = area();
  const refunded = new Map<Id, number>();
  for (const tx of s.transactions) {
    if (tx.businessId === businessId && tx.type === 'certificateRefund' && tx.certificateId) refunded.set(tx.certificateId, (refunded.get(tx.certificateId) ?? 0) + Math.abs(tx.amount));
  }
  const sold = s.certificates.filter((c) => c.businessId === businessId && c.status !== 'expired');
  return {
    ...base,
    certificates: {
      ...base.certificates,
      count: sold.length,
      sum: sold.reduce((sum, c) => sum + Math.max(0, c.nominal - (refunded.get(c.id) ?? 0)), 0),
    },
  };
}
