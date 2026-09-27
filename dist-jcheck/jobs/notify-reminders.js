import { isLocale, t } from '../common/i18n/i18n.js';
import { DEFAULT_TZ, utcToLocal } from '../common/time/time.js';
import { customTemplateOf } from '../modules/notify/notify-types.service.js';
import { notifyKindOf } from '../modules/notify/kinds.js';
import { enqueueClientNotification } from '../modules/notify/outbox.js';
const WINDOWS = [
    { kind: 'reminder24h', hoursBefore: 24 },
    { kind: 'reminder2h', hoursBefore: 2 },
];
/** Ширина окна выборки — шире шага задачи (каждые 5 мин, worker.ts), чтобы дрожание крона не пропустило запись */
const WINDOW_MIN = 10;
const ACTIVE_FOR_REMINDER = ['scheduled', 'client_confirmed'];
function pickRu(v) {
    return v?.ru;
}
/**
 * Напоминания 24ч и 2ч до визита (E1, docs/backend/05 §3.1, зафиксировано PLAN.md §6 №10 — «за сколько часов»
 * больше не открытый вопрос, владелец решил в PLAN). Только клиенту с приложением (появился appUserId) — доска
 * F-00-121 «клиентам без приложения мастер напоминает сам» закрывает остальных.
 */
export async function notifyBookingReminders(prisma) {
    const now = new Date();
    let sent = 0;
    let candidates = 0;
    for (const w of WINDOWS) {
        const from = new Date(now.getTime() + w.hoursBefore * 3_600_000);
        const to = new Date(from.getTime() + WINDOW_MIN * 60_000);
        const bookings = await prisma.booking.findMany({
            where: { status: { in: ACTIVE_FOR_REMINDER }, deletedAt: null, appUserId: { not: null }, startAt: { gte: from, lt: to } },
            select: { id: true, businessId: true, staffId: true, locationId: true, startAt: true, services: true, appUserId: true },
        });
        candidates += bookings.length;
        if (!bookings.length)
            continue;
        const def = notifyKindOf(w.kind);
        const businessIds = [...new Set(bookings.map((b) => b.businessId))];
        const locationIds = [...new Set(bookings.map((b) => b.locationId))];
        const serviceIds = [...new Set(bookings.flatMap((b) => b.services?.map((l) => l.serviceId).filter((v) => Boolean(v)) ?? []))];
        const userIds = [...new Set(bookings.map((b) => b.appUserId))];
        const [businesses, locations, services, users] = await Promise.all([
            prisma.business.findMany({ where: { id: { in: businessIds } }, select: { id: true, name: true } }),
            prisma.location.findMany({ where: { id: { in: locationIds } }, select: { id: true, tz: true } }),
            serviceIds.length ? prisma.service.findMany({ where: { id: { in: serviceIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
            prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, locale: true } }),
        ]);
        const businessById = new Map(businesses.map((b) => [b.id, b]));
        const tzById = new Map(locations.map((l) => [l.id, l.tz || DEFAULT_TZ]));
        const serviceById = new Map(services.map((s) => [s.id, s]));
        const localeByUser = new Map(users.map((u) => [u.id, isLocale(u.locale) ? u.locale : 'ru']));
        for (const b of bookings) {
            const business = businessById.get(b.businessId);
            const tz = tzById.get(b.locationId) ?? DEFAULT_TZ;
            const local = utcToLocal(b.startAt, tz);
            const time = local.slice(11, 16);
            const serviceId = b.services?.[0]?.serviceId;
            const serviceName = pickRu(serviceById.get(serviceId ?? '')?.name) ?? '';
            const locale = localeByUser.get(b.appUserId) ?? 'ru';
            const businessName = business?.name ?? 'BookTime';
            const custom = await customTemplateOf(prisma, b.businessId, w.kind, locale);
            const params = { service: serviceName, time, place: businessName };
            const body = custom ? custom.replace(/\{(\w+)\}/g, (_, name) => params[name] ?? `{${name}}`) : t(locale, def.messageKey, params);
            const created = await enqueueClientNotification(prisma, {
                businessId: b.businessId,
                kind: w.kind,
                appUserId: b.appUserId,
                title: businessName,
                body,
                dedupeKey: `client:${w.kind}:${b.id}`,
                inbox: { kind: 'booking_reminder', businessId: b.businessId, staffId: b.staffId, bookingId: b.id, params: { start: local } },
            });
            if (created)
                sent++;
        }
    }
    return { sent, candidates };
}
//# sourceMappingURL=notify-reminders.js.map