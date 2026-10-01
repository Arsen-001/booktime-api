import { isLocale, t, type Locale } from '../common/i18n/i18n.js';
import type { PrismaService } from '../common/prisma.service.js';
import { DEFAULT_TZ, utcToLocal } from '../common/time/time.js';
import { customTemplateOf } from '../modules/notify/notify-types.service.js';
import { notifyKindOf } from '../modules/notify/kinds.js';
import { TYPE_REGISTRY } from '../modules/notify/notify-type-registry.js';
import { enqueueClientNotification } from '../modules/notify/outbox.js';
import { enqueueTelegramReminders } from '../modules/telegram/telegram-reminders.js';

const WINDOWS: { kind: 'reminder24h' | 'reminder2h'; hoursBefore: number }[] = [
  { kind: 'reminder24h', hoursBefore: 24 },
  { kind: 'reminder2h', hoursBefore: 2 },
];
/** Ширина окна выборки — шире шага задачи (каждые 5 мин, worker.ts), чтобы дрожание крона не пропустило запись */
const WINDOW_MIN = 10;

const ACTIVE_FOR_REMINDER = ['scheduled', 'client_confirmed'];

function pickRu(v: unknown): string | undefined {
  return (v as Record<string, string> | null | undefined)?.ru;
}

/** Сколько вперёд смотреть: «Отправлять за» не больше 720 ч (notify.schemas), обычно часы — берём максимум из настроек */
const MAX_HOURS = 720;

/**
 * Напоминание о визите (тип 1). Решение владельца 01.10.2026: пуш уходит за время из настройки салона «Отправлять за»
 * (своё у услуги → у записи → у типа, по умолчанию 1 ч) — тот же расчёт, что журнал уведомлений (notify-log-derive.ts
 * timeBased) и мок. Telegram — клиенту без приложения, всегда за 24 ч и за 2 ч (`telegram-reminders.ts`); остальных
 * закрывает доска F-00-121 «клиентам без приложения мастер напоминает сам».
 */
export async function notifyBookingReminders(prisma: PrismaService): Promise<{ sent: number; candidates: number }> {
  const now = new Date();
  let sent = 0;
  let candidates = 0;
  for (const w of WINDOWS) {
    const from = new Date(now.getTime() + w.hoursBefore * 3_600_000);
    const to = new Date(from.getTime() + WINDOW_MIN * 60_000);
    const tg = await enqueueTelegramReminders(prisma, w.kind, from, to);
    sent += tg.sent;
    candidates += tg.candidates;
  }
  const push = await pushReminders(prisma, now);
  return { sent: sent + push.sent, candidates: candidates + push.candidates };
}

async function pushReminders(prisma: PrismaService, now: Date): Promise<{ sent: number; candidates: number }> {
  const t1Def = TYPE_REGISTRY.find((d) => d.code === 1)!;
  const [overrides, serviceHourRows] = await Promise.all([
    prisma.notifyTypeOverride.findMany({ where: { code: 1 } }),
    prisma.businessSetting.findMany({ where: { area: 'notify-service-reminder-hours' }, select: { businessId: true, data: true } }),
  ]);
  const overrideByBiz = new Map(overrides.map((o) => [o.businessId, o]));
  const serviceHoursByBiz = new Map(serviceHourRows.map((r) => [r.businessId, (r.data as Record<string, number> | null) ?? {}]));
  const typeHoursOf = (businessId: string): number => {
    const c = overrideByBiz.get(businessId)?.conditions as { timingHours?: number } | null | undefined;
    return c?.timingHours ?? t1Def.conditionsDefault?.timingHours ?? 1;
  };
  const pushOn = (businessId: string): boolean => {
    const o = overrideByBiz.get(businessId);
    if ((o?.enabled ?? t1Def.enabledDefault) === false) return false;
    const stored = (o?.channels as { channel: string; scenario: string }[] | null | undefined)?.find((c) => c.channel === 'push')?.scenario;
    const scenario = stored ?? t1Def.defaultScenario.push ?? 'off';
    return scenario !== 'off';
  };
  let horizon = 1;
  for (const o of overrides) horizon = Math.max(horizon, (o.conditions as { timingHours?: number } | null)?.timingHours ?? 0);
  for (const m of serviceHoursByBiz.values()) for (const h of Object.values(m)) horizon = Math.max(horizon, Number(h) || 0);
  horizon = Math.min(Math.max(horizon, t1Def.conditionsDefault?.timingHours ?? 1), MAX_HOURS);

  const rows = await prisma.booking.findMany({
    where: { status: { in: ACTIVE_FOR_REMINDER }, deletedAt: null, appUserId: { not: null }, startAt: { gt: now, lte: new Date(now.getTime() + horizon * 3_600_000) } },
    select: { id: true, businessId: true, staffId: true, locationId: true, startAt: true, services: true, appUserId: true, notifyOverride: true },
  });
  // Пора: start − часы ≤ сейчас. Опоздавшие (запись сделана позже момента напоминания) получают его сразу; повтор — нет (dedupeKey)
  const bookings = rows.filter((b) => {
    if (!pushOn(b.businessId)) return false;
    const ov = (b.notifyOverride as { pushEnabled?: boolean; pushTimingHours?: number } | null) ?? null;
    if (ov?.pushEnabled === false) return false;
    const firstService = (b.services as { serviceId?: string }[] | null)?.[0]?.serviceId;
    const svcHours = firstService ? serviceHoursByBiz.get(b.businessId)?.[firstService] : undefined;
    const hours = ov?.pushTimingHours ?? svcHours ?? typeHoursOf(b.businessId);
    return b.startAt.getTime() - hours * 3_600_000 <= now.getTime();
  });
  const candidates = bookings.length;
  if (!bookings.length) return { sent: 0, candidates };
  let sent = 0;
  const def = notifyKindOf('reminder24h')!;
  const businessIds = [...new Set(bookings.map((b) => b.businessId))];
  const locationIds = [...new Set(bookings.map((b) => b.locationId))];
  const serviceIds = [...new Set(bookings.flatMap((b) => (b.services as { serviceId?: string }[] | null)?.map((l) => l.serviceId).filter((v): v is string => Boolean(v)) ?? []))];
  const userIds = [...new Set(bookings.map((b) => b.appUserId!))];
  const [businesses, locations, services, users] = await Promise.all([
    prisma.business.findMany({ where: { id: { in: businessIds } }, select: { id: true, name: true } }),
    prisma.location.findMany({ where: { id: { in: locationIds } }, select: { id: true, tz: true } }),
    serviceIds.length ? prisma.service.findMany({ where: { id: { in: serviceIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
    prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, locale: true } }),
  ]);
  const businessById = new Map(businesses.map((b) => [b.id, b]));
  const tzById = new Map(locations.map((l) => [l.id, l.tz || DEFAULT_TZ]));
  const serviceById = new Map(services.map((s) => [s.id, s]));
  const localeByUser = new Map(users.map((u) => [u.id, isLocale(u.locale) ? u.locale : ('ru' as Locale)]));
  for (const b of bookings) {
    const business = businessById.get(b.businessId);
    const tz = tzById.get(b.locationId) ?? DEFAULT_TZ;
    const local = utcToLocal(b.startAt, tz);
    const time = local.slice(11, 16);
    const serviceId = (b.services as { serviceId?: string }[] | null)?.[0]?.serviceId;
    const serviceName = pickRu(serviceById.get(serviceId ?? '')?.name) ?? '';
    const locale = localeByUser.get(b.appUserId!) ?? 'ru';
    const businessName = business?.name ?? 'BookTime';
    // Текст по дню визита: сегодня — «скоро увидимся», завтра — «завтра», дальше — с датой
    const today = utcToLocal(now, tz).slice(0, 10);
    const tomorrow = utcToLocal(new Date(now.getTime() + 86_400_000), tz).slice(0, 10);
    const day = local.slice(0, 10);
    const messageKey = day === today ? 'booking.reminder2h' : day === tomorrow ? 'booking.reminder24h' : 'booking.reminderOn';
    const custom = await customTemplateOf(prisma, b.businessId, 'reminder24h', locale);
    const params = { service: serviceName, time, place: businessName, date: `${day.slice(8, 10)}.${day.slice(5, 7)}` };
    const body = custom ? custom.replace(/\{(\w+)\}/g, (_, name: string) => (params as Record<string, string>)[name] ?? `{${name}}`) : t(locale, messageKey as typeof def.messageKey, params);
    const created = await enqueueClientNotification(prisma, {
      businessId: b.businessId,
      kind: 'reminder24h',
      appUserId: b.appUserId!,
      title: businessName,
      body,
      dedupeKey: `client:reminder:${b.id}:${local}`,
      inbox: { kind: 'booking_reminder', businessId: b.businessId, staffId: b.staffId, bookingId: b.id, params: { start: local } },
    });
    if (created) sent++;
  }
  return { sent, candidates };
}
