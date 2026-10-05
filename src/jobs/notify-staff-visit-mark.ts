import type { PrismaService } from '../common/prisma.service.js';
import { DEFAULT_TZ } from '../common/time/time.js';
import { inQuietHours } from '../modules/notify/quiet-hours.js';
import {
  bookingVars,
  enqueueStaffNotice,
  journalUrl,
  serviceName,
  STAFF_NOTICES,
  STAFF_RECIPIENT_SELECT,
  StaffNoticeContext,
  type StaffRecipient,
} from '../modules/notify/staff-notices.js';

/**
 * Сколько назад смотреть: визит закончился вечером (тихие часы с 21:00) — утренний проход в 10:00 ещё спросит.
 * Дальше — уже не «после визита»: такие записи ждут в «Клиенты → Ждут отметки» и «Требует внимания» журнала.
 */
export const VISIT_MARK_LOOKBACK_H = 16;
/** Ещё не отмеченные: «пришёл» / «не пришёл» / отмены — уже итог визита */
const OPEN_STATUSES = ['scheduled', 'client_confirmed'];
/** Скрытые услуги «Заказов»: сдача и выдача закрываются своими кнопками («Принять заказ», «Выдан» → «Пришёл») */
const SKIP_SERVICE_KINDS = new Set(['intake', 'pickup']);

/**
 * ⭐ F-00-127 (06.10.2026): после конца записи мастеру пуш «Визит в HH:MM закончился (клиент, услуга). Клиент пришёл?
 * Отметьте «пришёл · сумма» или «не пришёл»» — тап открывает запись в журнале, где отметка ставится в одно-два нажатия
 * («Пришёл» с суммой / «Не пришёл»). Без отметки не считаются выручка, неявки (F-00-071) и «пора снова».
 *  · кому — мастер записи с аккаунтом (у мастера без аккаунта записи отмечает администратор в «Ждут отметки»);
 *  · что — записи «Записан» / «Клиент подтвердил», конец которых наступил не позже VISIT_MARK_LOOKBACK_H часов назад;
 *    групповые события и сдача/выдача заказов — нет;
 *  · раз на запись (ключ `staff:visit_mark:<запись>:<адресат>`); отметили раньше прохода — не спрашиваем;
 *  · тихие часы (21:00–10:00) — проход пропускается, утром спросит про вечерние визиты, если отметки так и нет;
 *  · настройки — staff-notices.ts (вид «Отключено», вид очереди staff_visit_mark выключен).
 * Каждые 5 минут (worker.ts).
 */
export async function staffVisitMarkPrompts(prisma: PrismaService, now = new Date()): Promise<{ sent: number; candidates: number; quiet?: boolean }> {
  if (inQuietHours(now)) return { sent: 0, candidates: 0, quiet: true };
  const from = new Date(now.getTime() - VISIT_MARK_LOOKBACK_H * 3_600_000);
  const rows = await prisma.booking.findMany({
    where: { status: { in: OPEN_STATUSES }, deletedAt: null, groupEventId: null, endAt: { gte: from, lte: now } },
  });
  if (!rows.length) return { sent: 0, candidates: 0 };

  const serviceIds = [...new Set(rows.flatMap((b) => ((b.services as { serviceId?: string }[] | null) ?? []).map((l) => l.serviceId).filter((v): v is string => Boolean(v))))];
  const [services, staff, locations, clients] = await Promise.all([
    serviceIds.length ? prisma.service.findMany({ where: { id: { in: serviceIds } }, select: { id: true, name: true, kind: true } }) : Promise.resolve([]),
    prisma.staff.findMany({ where: { id: { in: [...new Set(rows.map((b) => b.staffId))] } }, select: STAFF_RECIPIENT_SELECT }),
    prisma.location.findMany({ where: { id: { in: [...new Set(rows.map((b) => b.locationId))] } }, select: { id: true, tz: true } }),
    prisma.client.findMany({ where: { id: { in: rows.map((b) => b.clientId).filter((v): v is string => Boolean(v)) } }, select: { id: true, name: true } }),
  ]);
  const serviceById = new Map(services.map((s) => [s.id, s]));
  const staffById = new Map(staff.map((s) => [s.id, s as StaffRecipient]));
  const tzOf = new Map(locations.map((l) => [l.id, l.tz || DEFAULT_TZ]));
  const clientName = new Map(clients.map((c) => [c.id, c.name]));
  const ctx = new StaffNoticeContext(prisma);

  let sent = 0;
  let candidates = 0;
  for (const b of rows) {
    const lines = ((b.services as { serviceId?: string }[] | null) ?? []).map((l) => (l.serviceId ? serviceById.get(l.serviceId) : undefined));
    if (lines.some((s) => s && SKIP_SERVICE_KINDS.has(s.kind))) continue;
    const master = staffById.get(b.staffId);
    if (!master?.userId) continue;
    candidates++;
    const tz = tzOf.get(b.locationId) ?? DEFAULT_TZ;
    const created = await enqueueStaffNotice(ctx, {
      def: STAFF_NOTICES.visitMark,
      to: master,
      vars: bookingVars(b.startAt, tz, { clientName: (b.clientId && clientName.get(b.clientId)) || b.visitorName, service: serviceName(lines[0]?.name), staff: master.name }),
      url: journalUrl(b.id, b.startAt, tz),
      dedupeKey: `staff:visit_mark:${b.id}:${master.userId}`,
      sendAt: now,
      meta: { bookingId: b.id },
    });
    if (created) sent++;
  }
  return { sent, candidates };
}
