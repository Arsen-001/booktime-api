import { moneyToJson } from '../../common/money/money.js';
const arr = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v && typeof v === 'object' ? v : undefined);
/**
 * Строка клиента (F-04-*, ClientRow фронта). «Продано/оплачено/баланс/визиты/первый-последний визит/неявки/
 * отмены/рассылки» считаются из bookings/loyalty/notify — этих таблиц ещё нет (этапы 7/10/11), поэтому здесь
 * честный 0/пусто вместо выдуманной точности (тот же приём, что deleteImpact.futureBookings в services этапа 4):
 * sold = imported_sold, paid = paid_amount (внесённое сверх визитов), balance = paid − sold, visits/dates/неявки —
 * реальные при появлении bookings, cancelCount/broadcastDates — до notify/journal тоже 0/[].
 */
export function clientRowView(c) {
    const sold = moneyToJson(c.importedSold);
    const paid = moneyToJson(c.paidAmount);
    return {
        id: c.id,
        businessId: c.businessId,
        name: c.name,
        phone: c.phone,
        email: c.email ?? undefined,
        gender: c.gender,
        birthday: c.birthday ?? undefined,
        note: c.note ?? undefined,
        tags: arr(c.tags),
        appUserId: c.appUserId ?? undefined,
        noShowCount: c.noShowCount,
        // Визиты, отмены и деньги из записей дописывает clients.visits.ts (withVisits)
        cancelCount: 0,
        blocked: c.blocked ?? undefined,
        createdAt: c.createdAt.toISOString(),
        cardNumber: c.cardNumber ?? undefined,
        discount: c.discountPercent,
        importanceClass: (c.importanceClass ?? undefined),
        sold,
        paid,
        balance: paid - sold,
        visits: 0,
        firstVisit: undefined,
        lastVisit: undefined,
        broadcastDates: [],
        lastName: c.lastName ?? undefined,
        middleName: c.middleName ?? undefined,
        additionalPhone: c.additionalPhone ?? undefined,
        avatar: c.avatarUrl ?? undefined,
        nationalId: c.nationalId ?? undefined,
        consent: obj(c.adConsent),
        birthdayGreetingOptOut: c.birthdayGreetingOptOut ?? undefined,
        locale: c.locale ?? undefined,
        preferredContact: (c.preferredContact ?? undefined),
        version: c.version,
    };
}
/** Телефоны маскируются без права clients.phones (03 §2, F-10-093) */
export function maskClientPhones(row) {
    const mask = (p) => (p.length > 6 ? `${p.slice(0, 4)}•••••${p.slice(-2)}` : '•••');
    return { ...row, phone: mask(row.phone), additionalPhone: row.additionalPhone ? mask(row.additionalPhone) : undefined };
}
//# sourceMappingURL=clients.views.js.map