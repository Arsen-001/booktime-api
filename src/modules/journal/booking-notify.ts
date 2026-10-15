import type { Booking as BookingRow, Prisma } from '../../generated/prisma/client.js';
import { newId } from '../../common/ids/ids.js';
import { isLocale, t, type Locale } from '../../common/i18n/i18n.js';
import { whenPhrase } from '../../common/i18n/when.js';
import type { PrismaService } from '../../common/prisma.service.js';
import { utcToLocal } from '../../common/time/time.js';
import { notifyKindOf } from '../notify/kinds.js';
import { isStaffEventEnabled } from '../notify/notify-staff-prefs.service.js';
import { customTemplateOf } from '../notify/notify-types.service.js';
import { enqueueClientNotification, enqueueOutbox } from '../notify/outbox.js';
import { journalUrl } from '../notify/staff-notices.js';
import { isCancelled, isOnlineSource, type ServiceLine } from './rules.js';

/**
 * Пуши о записи, которые ставит BookingsService.logEvents (вынесено из сервиса 15.10.2026, чтобы проверять без базы):
 *  · клиенту — действие салона с его записью (лента /v1/me/inbox + пуш, этап 9/10);
 *  · персоналу — действие клиента или онлайн-канала (05 §3.2).
 * Нажатие на пуш открывает запись (QA приложений 15.10.2026: пуши шли без data.url и открывали только входящие):
 * клиенту — `/bookings/<id>`, персоналу — `/biz/journal?date=<день>&booking=<id>` (тот же адрес, что у staff-notices.ts;
 * его разбирают сайт, NativeAppBridge и приложения iOS/Android). Время в тексте — с днём, если запись не сегодня
 * (whenPhrase: «завтра в 12:00», «16 окт в 12:00»). Заголовок пуша персоналу — название бизнеса, а не «BookTime».
 */

type Tx = Prisma.TransactionClient;
type Event = Prisma.BookingEventCreateManyInput;

const arr = <T = string>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const pickRu = (v: unknown): string | undefined => (v as Record<string, string> | null | undefined)?.ru;
const renderTemplate = (template: string, params: Record<string, string>): string => template.replace(/\{(\w+)\}/g, (_, name: string) => params[name] ?? `{${name}}`);

/** Пуш клиенту → тип каталога (журнал отправок, выключатель): 8 — записан салоном, 74 — перенесён, 4 — отменён/удалён */
const CLIENT_KIND_TYPE: Record<string, number | undefined> = { booking_created: 8, salon_moved: 74, salon_deleted: 4, cancelled_by_master: 4 };

/** Пуш сотруднику о действии клиента → тип каталога: 10/11 — новая онлайн-запись, 12 — отмена, 41 — перенос */
function staffKindType(eventKey: 'new_booking' | 'client_cancelled' | 'client_rescheduled', isOwnMaster: boolean): number | undefined {
  if (eventKey === 'new_booking') return isOwnMaster ? 11 : 10;
  // 12 и 41 — типы «Администратору»; мастеру о своей записи — только его матрица (F-05-056)
  return isOwnMaster ? undefined : eventKey === 'client_cancelled' ? 12 : 41;
}

export function clientBookingUrl(bookingId: string): string {
  return `/bookings/${bookingId}`;
}

/**
 * Лента `/v1/me/inbox` (F-14-055, этап 9): те же переходы, что уже пишет `logEvents` в `booking_events`, но
 * персистентно и с собственным `readAt` на клиента — не переизобретаем правило перехода, только маппим kind.
 * Своё же действие клиента (`by === 'client'`, F-00-130-соседнее: не уведомлять человека о его собственном клике)
 * не заводит запись «создано»/«перенесено»; статусы, которые может выставить только бизнес/система, — заводят всегда.
 * Пишется в той же транзакции, что и booking_events; живой SSE не шлём до коммита (см. BookingsService.publish).
 */
export async function notifyClientOfBooking(
  tx: Tx,
  prisma: PrismaService,
  input: { next: BookingRow; events: Event[]; appUserId: string; by: string; tz: string; now?: Date },
): Promise<void> {
  const { next, events, appUserId, by, tz } = input;
  const rows: Prisma.InboxItemCreateManyInput[] = [];
  const pushable: { eventId: string; kind: string; startLocal: string; bookingId?: string }[] = [];
  for (const e of events) {
    let kind: string | undefined;
    let bookingId: string | undefined = e.bookingId;
    if (e.kind === 'created' && by !== 'client') kind = 'booking_created';
    else if (e.kind === 'deleted') {
      kind = 'salon_deleted';
      bookingId = undefined; // запись уже удалена — ссылка на неё клиенту ничего не откроет (как мок)
    } else if (e.kind === 'moved' && by !== 'client') kind = 'salon_moved';
    else if (e.kind === 'status') {
      if (e.toStatus === 'scheduled' && e.fromStatus === 'awaiting_confirmation') kind = 'salon_confirmed';
      else if (e.toStatus === 'cancelled_by_master') kind = 'cancelled_by_master';
      else if (e.reason === 'prepayment_expired') kind = 'prepayment_expired';
    }
    if (!kind) continue;
    rows.push({ id: newId('inboxItem'), appUserId, kind, businessId: e.businessId, staffId: e.staffId, bookingId, params: { start: e.startLocal } as Prisma.InputJsonValue });
    pushable.push({ eventId: e.id as string, kind, startLocal: e.startLocal as string, bookingId });
  }
  if (rows.length) await tx.inboxItem.createMany({ data: rows });
  // Этап 10 (05 §3.1): те же переходы шлют настоящий push, а не только тихую строку в ленте. Один и тот же dedupeKey
  // на bookingEvent.id — повторный вызов транзакции не задвоит.
  if (!pushable.length) return;
  const [business, user] = await Promise.all([
    tx.business.findUnique({ where: { id: next.businessId }, select: { name: true } }),
    tx.user.findUnique({ where: { id: appUserId }, select: { locale: true } }),
  ]);
  const locale: Locale = isLocale(user?.locale) ? user!.locale : 'ru';
  const serviceId = arr<ServiceLine>(next.services)[0]?.serviceId;
  const service = serviceId ? await tx.service.findUnique({ where: { id: serviceId }, select: { name: true } }) : null;
  const serviceName = pickRu(service?.name) ?? '';
  const businessName = business?.name ?? 'BookTime';
  const today = utcToLocal(input.now ?? new Date(), tz);
  for (const p of pushable) {
    const def = notifyKindOf(p.kind);
    if (!def) continue;
    const time = p.startLocal.slice(11, 16);
    const params = { service: serviceName, time, when: whenPhrase(locale, p.startLocal, today), date: `${p.startLocal.slice(8, 10)}.${p.startLocal.slice(5, 7)}`, place: businessName };
    // Свой текст салона пишет «{time}» сам (с предлогом) — ему остаётся время; {when} и {date} тоже доступны
    const custom = await customTemplateOf(prisma, next.businessId, p.kind, locale);
    const body = custom ? renderTemplate(custom, params) : t(locale, def.messageKey, params);
    await enqueueClientNotification(tx, {
      businessId: next.businessId,
      kind: p.kind,
      appUserId,
      title: businessName,
      body,
      // Удалённая запись не откроется — без ссылки (приложение откроет входящие)
      url: p.bookingId ? clientBookingUrl(p.bookingId) : undefined,
      dedupeKey: `client:${p.kind}:${p.eventId}`,
      // Журнал отправок (запись, клиент) и выключатели каталога у отправителя очереди (catalog-gate.ts): 8, 74, 4;
      // «Запись подтверждена» (9) уходит и при выключенном типе (F-05-026 п. 2) — без typeCode
      meta: { bookingId: next.id, clientId: next.clientId ?? undefined, typeCode: CLIENT_KIND_TYPE[p.kind] },
    });
  }
}

/**
 * Бизнесу (05 §3.2): новая онлайн-запись клиента + клиент сам отменил/перенёс — мастеру и админам салона.
 * Только события, где действующее лицо — клиент или сам онлайн-канал; правку персонала себе не шлём.
 */
export async function notifyStaffOfClientAction(
  tx: Tx,
  prisma: PrismaService,
  input: { next: BookingRow; events: Event[]; by: string; tz: string; now?: Date },
): Promise<void> {
  const { next, events, by, tz } = input;
  let eventKey: 'new_booking' | 'client_cancelled' | 'client_rescheduled' | undefined;
  let eventId: string | undefined;
  for (const e of events) {
    if (e.kind === 'created' && isOnlineSource(next.source)) {
      eventKey = 'new_booking';
      eventId = e.id as string;
    } else if (e.kind === 'status' && by === 'client' && e.toStatus && isCancelled(e.toStatus)) {
      eventKey = 'client_cancelled';
      eventId = e.id as string;
    } else if (e.kind === 'moved' && by === 'client') {
      eventKey = 'client_rescheduled';
      eventId = e.id as string;
    }
  }
  if (!eventKey || !eventId) return;
  const [staff, admins, client, business] = await Promise.all([
    tx.staff.findUnique({ where: { id: next.staffId }, select: { id: true, userId: true } }),
    tx.staff.findMany({ where: { businessId: next.businessId, role: { in: ['owner', 'admin'] }, status: 'active', userId: { not: null } }, select: { id: true, userId: true } }),
    next.clientId ? tx.client.findUnique({ where: { id: next.clientId }, select: { name: true } }) : Promise.resolve(null),
    tx.business.findUnique({ where: { id: next.businessId }, select: { name: true } }),
  ]);
  const recipients = new Map<string, string>(); // userId -> staffId (для проверки StaffNotifyPref)
  if (staff?.userId) recipients.set(staff.userId, staff.id);
  for (const a of admins) if (a.userId) recipients.set(a.userId, a.id);
  if (recipients.size === 0) return;
  const def = notifyKindOf(`staff_${eventKey}`);
  if (!def) return;
  const startLocal = utcToLocal(next.startAt, tz);
  const today = utcToLocal(input.now ?? new Date(), tz);
  const serviceId = arr<ServiceLine>(next.services)[0]?.serviceId;
  const [service, users] = await Promise.all([
    serviceId ? tx.service.findUnique({ where: { id: serviceId }, select: { name: true } }) : Promise.resolve(null),
    tx.user.findMany({ where: { id: { in: [...recipients.keys()] } }, select: { id: true, locale: true } }),
  ]);
  const localeByUser = new Map(users.map((u) => [u.id, isLocale(u.locale) ? u.locale : ('ru' as Locale)]));
  const url = journalUrl(next.id, next.startAt, tz);
  for (const [userId, staffId] of recipients) {
    if (!(await isStaffEventEnabled(prisma, staffId, eventKey))) continue;
    const locale = localeByUser.get(userId) ?? 'ru';
    const params = { client: client?.name ?? 'Client', service: pickRu(service?.name) ?? '', time: startLocal.slice(11, 16), when: whenPhrase(locale, startLocal, today) };
    await enqueueOutbox(tx, {
      businessId: next.businessId,
      app: 'business',
      kind: def.kind,
      recipientUserId: userId,
      title: business?.name || 'BookTime',
      body: t(locale, def.messageKey, params),
      url,
      dedupeKey: `staff:${def.kind}:${eventId}:${userId}`,
      // Тип каталога: «Клиент записался онлайн» администратору (10) / «Клиент записался к вам» мастеру (11), отмена (12)
      // и перенос (41) онлайн-записи — выключатель и канал adminApp проверяет отправитель очереди (catalog-gate.ts)
      meta: { bookingId: next.id, staffId, typeCode: staffKindType(eventKey, staffId === next.staffId) },
    });
  }
}
