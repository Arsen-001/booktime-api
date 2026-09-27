import type { Id } from './core-types.js';
import { adjustMembership, getLoyaltyBookingSummary, getServiceAutoCharge } from './logic.js';
import { mutateArea, nowDateTime, readArea } from './shim.js';
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
