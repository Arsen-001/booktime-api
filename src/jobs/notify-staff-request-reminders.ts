import type { PrismaService } from '../common/prisma.service.js';
import { DEFAULT_TZ, utcToLocal } from '../common/time/time.js';
import { inQuietHours } from '../modules/notify/quiet-hours.js';
import {
  bookingVars,
  enqueueStaffNotice,
  firstServiceName,
  journalUrl,
  STAFF_NOTICES,
  STAFF_RECIPIENT_SELECT,
  StaffNoticeContext,
  type StaffRecipient,
} from '../modules/notify/staff-notices.js';

/** Через сколько минут без ответа напомнить о заявке и шаг между повторами — как мок (api/journal-offers.ts) */
export const REQUEST_REMINDER_AFTER_MIN = 30;
/** Больше трёх напоминаний на одну заявку — уже шум */
export const REQUEST_REMINDER_MAX = 3;
export const REQUEST_REMINDER_KIND = STAFF_NOTICES.requestReminderStaff.kind;
const PREFIX = 'staff:req_remind:';
/** Строки очереди, которые считаются «напомнили» (skipped/failed — пуш не дошёл, «напомнили в HH:MM» было бы неправдой) */
const DELIVERED = ['queued', 'sent'];

/** Ключ дубля напоминания: заявка + номер напоминания + адресат — повторный проход и гонка двух проходов не дублируют */
export function requestReminderKey(bookingId: string, step: number, userId: string): string {
  return `${PREFIX}${bookingId}:${step}:${userId}`;
}

export function parseRequestReminderKey(key: string): { bookingId: string; step: number } | null {
  if (!key.startsWith(PREFIX)) return null;
  const [bookingId, step] = key.slice(PREFIX.length).split(':');
  const n = Number(step);
  return bookingId && Number.isInteger(n) ? { bookingId, step: n } : null;
}

interface ReminderRow {
  dedupeKey: string;
  createdAt: Date;
  status: string;
  meta: unknown;
  id: string;
}

const atOf = (r: ReminderRow): Date => {
  const at = (r.meta as { at?: string } | null)?.at;
  return at ? new Date(at) : r.createdAt;
};

/**
 * ⭐ F-00-067 (мок с 29.09.2026, сервер с 06.10.2026): заявка («ждёт подтверждения») без ответа 30 минут — мастеру
 * и администраторам салона пуш «Заявка ждёт ответа … ответьте до HH:MM», дальше не чаще раза в 30 минут и не больше
 * трёх раз. Правило то же, что у мока: отсчёт от создания заявки или от прошлого напоминания; визит уже начался —
 * напоминать поздно. Каждые 5 минут (worker.ts); в тихие часы (21:00–10:00) не запускается — утром первый проход
 * напомнит один раз, следующий шаг — через 30 минут, а не три пуша подряд.
 *
 * Идемпотентно: номер напоминания считается по уже поставленным строкам очереди этого вида (ключ дубля —
 * `staff:req_remind:<запись>:<шаг>:<адресат>`), повтор прохода ничего не пишет. Настройки адресатов — staff-notices.ts
 * (строка матрицы «Создание записи клиентом», вид «Для администратора» у администраторов, личный выключатель).
 */
export async function staffRequestReminders(prisma: PrismaService, now = new Date()): Promise<{ sent: number; bookings: number; quiet?: boolean }> {
  if (inQuietHours(now)) return { sent: 0, bookings: 0, quiet: true };
  const dueBefore = new Date(now.getTime() - REQUEST_REMINDER_AFTER_MIN * 60_000);
  const rows = await prisma.booking.findMany({
    where: { status: 'awaiting_confirmation', deletedAt: null, groupEventId: null, startAt: { gt: now }, createdAt: { lte: dueBefore } },
  });
  if (!rows.length) return { sent: 0, bookings: 0 };

  const businessIds = [...new Set(rows.map((b) => b.businessId))];
  const oldest = new Date(Math.min(...rows.map((b) => b.createdAt.getTime())));
  const prior = (await prisma.notifyOutbox.findMany({
    where: { kind: REQUEST_REMINDER_KIND, businessId: { in: businessIds }, createdAt: { gte: oldest } },
    select: { id: true, dedupeKey: true, createdAt: true, status: true, meta: true },
  })) as ReminderRow[];
  const last = new Map<string, { step: number; at: Date }>();
  for (const r of prior) {
    const k = parseRequestReminderKey(r.dedupeKey);
    if (!k) continue;
    const cur = last.get(k.bookingId);
    const at = atOf(r);
    if (!cur || k.step > cur.step || (k.step === cur.step && at > cur.at)) last.set(k.bookingId, { step: k.step, at });
  }

  const due = rows.filter((b) => {
    const l = last.get(b.id);
    if (l && l.step >= REQUEST_REMINDER_MAX) return false;
    return (l?.at ?? b.createdAt).getTime() <= dueBefore.getTime();
  });
  if (!due.length) return { sent: 0, bookings: 0 };

  const [staff, locations, clients] = await Promise.all([
    prisma.staff.findMany({
      where: { OR: [{ id: { in: [...new Set(due.map((b) => b.staffId))] } }, { businessId: { in: businessIds }, role: { in: ['owner', 'admin'] }, status: 'active', userId: { not: null }, deletedAt: null }] },
      select: STAFF_RECIPIENT_SELECT,
    }),
    prisma.location.findMany({ where: { id: { in: [...new Set(due.map((b) => b.locationId))] } }, select: { id: true, tz: true } }),
    prisma.client.findMany({ where: { id: { in: due.map((b) => b.clientId).filter((v): v is string => Boolean(v)) } }, select: { id: true, name: true } }),
  ]);
  const staffById = new Map(staff.map((s) => [s.id, s as StaffRecipient]));
  const adminsOf = (businessId: string) => staff.filter((s) => s.businessId === businessId && (s.role === 'owner' || s.role === 'admin')) as StaffRecipient[];
  const tzOf = new Map(locations.map((l) => [l.id, l.tz || DEFAULT_TZ]));
  const clientName = new Map(clients.map((c) => [c.id, c.name]));
  const ctx = new StaffNoticeContext(prisma);

  let sent = 0;
  let bookings = 0;
  for (const b of due) {
    const step = (last.get(b.id)?.step ?? 0) + 1;
    const tz = tzOf.get(b.locationId) ?? DEFAULT_TZ;
    const master = staffById.get(b.staffId);
    const vars = bookingVars(b.startAt, tz, { clientName: (b.clientId && clientName.get(b.clientId)) || b.visitorName, service: await firstServiceName(prisma, b.services), staff: master?.name });
    // Срок ответа уже прошёл — без «ответьте до HH:MM» (иначе «ответьте до 12:04» в 15:51), как мок
    const deadlineOk = b.confirmDeadline && b.confirmDeadline.getTime() > now.getTime();
    if (deadlineOk) vars.deadline = utcToLocal(b.confirmDeadline!, tz).slice(11, 16);
    const messageKey = deadlineOk ? 'staff.requestReminder' : 'staff.requestReminderLate';
    const recipients: [StaffRecipient, typeof STAFF_NOTICES.requestReminderStaff | typeof STAFF_NOTICES.requestReminderAdmin][] = [];
    if (master) recipients.push([master, STAFF_NOTICES.requestReminderStaff]);
    for (const a of adminsOf(b.businessId)) if (a.id !== b.staffId && a.userId !== master?.userId) recipients.push([a, STAFF_NOTICES.requestReminderAdmin]);
    let any = false;
    const seenUsers = new Set<string>();
    for (const [to, def] of recipients) {
      if (!to.userId || seenUsers.has(to.userId)) continue;
      seenUsers.add(to.userId);
      const created = await enqueueStaffNotice(ctx, {
        def,
        to,
        vars,
        messageKey,
        url: journalUrl(b.id, b.startAt, tz),
        dedupeKey: requestReminderKey(b.id, step, to.userId),
        sendAt: now,
        meta: { bookingId: b.id, step, at: now.toISOString() },
      });
      if (created) {
        sent++;
        any = true;
      }
    }
    if (any) bookings++;
  }
  return { sent, bookings };
}

/**
 * «напомнили в HH:MM» (строка заявки в «Требует внимания» журнала): bookingId → когда последний раз напомнили (местное
 * 'YYYY-MM-DDTHH:mm'). Только
 * дошедшие до очереди напоминания (queued/sent) за последнюю неделю — заявка дольше не живёт.
 */
export async function requestReminderTimes(prisma: PrismaService, businessId: string, now = new Date()): Promise<Record<string, string>> {
  const rows = (await prisma.notifyOutbox.findMany({
    where: { businessId, kind: REQUEST_REMINDER_KIND, status: { in: DELIVERED }, createdAt: { gte: new Date(now.getTime() - 7 * 86_400_000) } },
    select: { id: true, dedupeKey: true, createdAt: true, status: true, meta: true },
  })) as ReminderRow[];
  const latest = new Map<string, Date>();
  for (const r of rows) {
    const k = parseRequestReminderKey(r.dedupeKey);
    if (!k) continue;
    const at = atOf(r);
    const cur = latest.get(k.bookingId);
    if (!cur || at > cur) latest.set(k.bookingId, at);
  }
  if (!latest.size) return {};
  // Время — местное по поясу филиала записи ('YYYY-MM-DDTHH:mm'), как все времена журнала (format.time фронта)
  const bookings = await prisma.booking.findMany({ where: { id: { in: [...latest.keys()] } }, select: { id: true, locationId: true } });
  const locations = await prisma.location.findMany({ where: { id: { in: [...new Set(bookings.map((b) => b.locationId))] } }, select: { id: true, tz: true } });
  const tzOfLocation = new Map(locations.map((l) => [l.id, l.tz || DEFAULT_TZ]));
  const tzOfBooking = new Map(bookings.map((b) => [b.id, tzOfLocation.get(b.locationId) ?? DEFAULT_TZ]));
  const out: Record<string, string> = {};
  for (const [bookingId, at] of latest) out[bookingId] = utcToLocal(at, tzOfBooking.get(bookingId) ?? DEFAULT_TZ);
  return out;
}

export interface RequestReminderInboxEvent {
  id: string;
  bookingId: string;
  createdAt: string;
  date: string;
  kind: 'awaitingReminder';
  start: string;
  deadline?: string;
}

/**
 * Колокольчик кабинета (F-05-061): строка на каждое напоминание о заявке, пока заявка ждёт ответа — ответили, и строка
 * уходит (как мок, api/notify.ts::inboxEvents). id строки — id первой строки очереди этого шага (стабилен, влезает в
 * biz_inbox_read.event_id).
 */
export async function requestReminderInboxEvents(prisma: PrismaService, businessId: string, now = new Date()): Promise<RequestReminderInboxEvent[]> {
  const rows = (await prisma.notifyOutbox.findMany({
    where: { businessId, kind: REQUEST_REMINDER_KIND, status: { in: DELIVERED }, createdAt: { gte: new Date(now.getTime() - 7 * 86_400_000) } },
    select: { id: true, dedupeKey: true, createdAt: true, status: true, meta: true },
  })) as ReminderRow[];
  const steps = new Map<string, { bookingId: string; step: number; id: string; at: Date }>();
  for (const r of rows) {
    const k = parseRequestReminderKey(r.dedupeKey);
    if (!k) continue;
    const key = `${k.bookingId}:${k.step}`;
    const cur = steps.get(key);
    if (!cur || r.id < cur.id) steps.set(key, { ...k, id: r.id, at: atOf(r) });
  }
  if (!steps.size) return [];
  const bookings = await prisma.booking.findMany({
    where: { id: { in: [...new Set([...steps.values()].map((s) => s.bookingId))] }, status: 'awaiting_confirmation', deletedAt: null },
    select: { id: true, startAt: true, locationId: true, confirmDeadline: true },
  });
  const byId = new Map(bookings.map((b) => [b.id, b]));
  const locations = bookings.length ? await prisma.location.findMany({ where: { id: { in: [...new Set(bookings.map((b) => b.locationId))] } }, select: { id: true, tz: true } }) : [];
  const tzOf = new Map(locations.map((l) => [l.id, l.tz || DEFAULT_TZ]));
  const out: RequestReminderInboxEvent[] = [];
  for (const s of steps.values()) {
    const b = byId.get(s.bookingId);
    if (!b) continue;
    const tz = tzOf.get(b.locationId) ?? DEFAULT_TZ;
    const start = utcToLocal(b.startAt, tz);
    out.push({
      id: s.id,
      bookingId: b.id,
      createdAt: s.at.toISOString(),
      date: start.slice(0, 10),
      kind: 'awaitingReminder',
      start,
      ...(b.confirmDeadline && b.confirmDeadline > s.at ? { deadline: utcToLocal(b.confirmDeadline, tz) } : {}),
    });
  }
  return out;
}
