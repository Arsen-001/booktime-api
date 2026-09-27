import type { Client } from '../../generated/prisma/client.js';
import { moneyToJson } from '../../common/money/money.js';

type Json = unknown;
const arr = <T = string>(v: Json): T[] => (Array.isArray(v) ? (v as T[]) : []);
const obj = <T = Record<string, string>>(v: Json): T | undefined => (v && typeof v === 'object' ? (v as T) : undefined);

/**
 * Строка клиента (F-04-*, ClientRow фронта). «Продано/оплачено/баланс/визиты/первый-последний визит/неявки/
 * отмены/рассылки» считаются из bookings/loyalty/notify — этих таблиц ещё нет (этапы 7/10/11), поэтому здесь
 * честный 0/пусто вместо выдуманной точности (тот же приём, что deleteImpact.futureBookings в services этапа 4):
 * sold = imported_sold, paid = paid_amount (внесённое сверх визитов), balance = paid − sold, visits/dates/неявки —
 * реальные при появлении bookings, cancelCount/broadcastDates — до notify/journal тоже 0/[].
 */
export function clientRowView(c: Client) {
  const sold = moneyToJson(c.importedSold);
  const paid = moneyToJson(c.paidAmount);
  return {
    id: c.id,
    businessId: c.businessId,
    name: c.name,
    phone: c.phone,
    email: c.email ?? undefined,
    gender: c.gender as 'male' | 'female' | 'unknown',
    birthday: c.birthday ?? undefined,
    note: c.note ?? undefined,
    tags: arr<string>(c.tags),
    appUserId: c.appUserId ?? undefined,
    noShowCount: c.noShowCount,
    // Отмены считаются из bookings — этап 7; до тех пор 0 (см. комментарий выше)
    cancelCount: 0,
    blocked: c.blocked ?? undefined,
    createdAt: c.createdAt.toISOString(),
    cardNumber: c.cardNumber ?? undefined,
    discount: c.discountPercent,
    importanceClass: (c.importanceClass ?? undefined) as 'gold' | 'silver' | 'bronze' | undefined,
    sold,
    paid,
    balance: paid - sold,
    visits: 0,
    firstVisit: undefined as string | undefined,
    lastVisit: undefined as string | undefined,
    broadcastDates: [] as string[],
    lastName: c.lastName ?? undefined,
    middleName: c.middleName ?? undefined,
    additionalPhone: c.additionalPhone ?? undefined,
    avatar: c.avatarUrl ?? undefined,
    nationalId: c.nationalId ?? undefined,
    consent: obj<{ given: boolean; at: string; method: string; recordedBy?: string }>(c.adConsent),
    birthdayGreetingOptOut: c.birthdayGreetingOptOut ?? undefined,
    locale: c.locale ?? undefined,
    preferredContact: (c.preferredContact ?? undefined) as 'call' | 'wa' | 'tg' | 'viber' | undefined,
    version: c.version,
  };
}
export type ClientRowView = ReturnType<typeof clientRowView>;

/** Телефоны маскируются без права clients.phones (03 §2, F-10-093) */
export function maskClientPhones<T extends { phone: string; additionalPhone?: string }>(row: T): T {
  const mask = (p: string) => (p.length > 6 ? `${p.slice(0, 4)}•••••${p.slice(-2)}` : '•••');
  return { ...row, phone: mask(row.phone), additionalPhone: row.additionalPhone ? mask(row.additionalPhone) : undefined };
}
