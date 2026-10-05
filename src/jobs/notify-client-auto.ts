import type { BusinessMessenger } from '../adapters/business-sms/business-sms.js';
import { env } from '../common/config/env.js';
import { LOCALES, type Locale } from '../common/i18n/i18n.js';
import { logger } from '../common/logging/logger.js';
import type { PrismaService } from '../common/prisma.service.js';
import { DEFAULT_TZ, utcToLocal } from '../common/time/time.js';
import {
  appUsersByPhone,
  clientPrefsOf,
  ClientTypeConfigs,
  firstName,
  localText,
  sendClientAuto,
  type ClientAutoOutcome,
  type VarsByLocale,
} from '../modules/notify/client-auto.js';
import { inQuietHours } from '../modules/notify/quiet-hours.js';

/**
 * ⭐ Автоматические уведомления клиенту из каталога типов (06.10.2026) — то, что экран «Уведомления» давно настраивал, а
 * сервер не слал (охват ТЗ 06.10, п. 3.2). Две задачи воркера, обе пропускают тихие часы 21:00–10:00 по Еревану (проход
 * утром подхватывает всё наступившее за ночь — окна поиска больше ночи):
 *  · notify.client-events (каждые 5 мин) — от событий записей: «Клиент записался онлайн» (2, и в тихие часы), «Клиент не пришёл» (75), «Зовём вернуться» (72),
 *    «Спрашиваем впечатление» (6 — онлайн-запись, 20 — запись из журнала);
 *  · notify.client-daily (каждые 30 мин) — по календарю: «С днём рождения» (3), «Пора снова» (55).
 * Как слать (каналы, настройки клиента, журнал, «один раз») — modules/notify/client-auto.ts.
 */

const H = 3_600_000;
const DAY = 24 * H;
/** Насколько назад искать наступившие события: больше тихих часов (13 ч) и простоя воркера на ночь */
const LOOKBACK_MS = 48 * H;
const CANCELLED = ['cancelled_by_client', 'cancelled_by_master'];
const ACTIVE = ['awaiting_confirmation', 'awaiting_prepayment', 'scheduled', 'client_confirmed'];
/** Онлайн-запись (тип 6) — всё, что записал сам клиент; остальное — из журнала (тип 20), как журнал отправок */
const VIA_WIDGET = new Set(['app', 'link', 'widget']);

export type ClientAutoTally = Partial<Record<ClientAutoOutcome, number>>;

export interface ClientAutoResult {
  quiet: boolean;
  booked: ClientAutoTally;
  noShow: ClientAutoTally;
  noShowInvite: ClientAutoTally;
  review: ClientAutoTally;
}

export interface ClientDailyResult {
  quiet: boolean;
  birthday: ClientAutoTally;
  repeat: ClientAutoTally;
}

type Ctx = {
  db: PrismaService;
  messenger: BusinessMessenger;
  now: Date;
  configs: ClientTypeConfigs;
};

type BookingRow = {
  id: string;
  businessId: string;
  locationId: string;
  staffId: string;
  clientId: string | null;
  appUserId: string | null;
  startAt: Date;
  endAt: Date;
  status: string;
  services: unknown;
  source: string;
  deletedAt: Date | null;
  notifyOverride: unknown;
  reminderOverride?: unknown;
};

const serviceIdsOf = (b: { services: unknown }): string[] =>
  (Array.isArray(b.services) ? (b.services as { serviceId?: string }[]) : []).map((l) => l.serviceId).filter((v): v is string => Boolean(v));

function tally(t: ClientAutoTally, o: ClientAutoOutcome) {
  t[o] = (t[o] ?? 0) + 1;
}

/** Бизнесы, клиенты, мастера, услуги, пояса — одной пачкой на проход */
async function loadRefs(db: PrismaService, bookings: { businessId: string; locationId?: string; clientId: string | null; staffId?: string; services?: unknown }[], extraClientIds: string[] = []) {
  const businessIds = [...new Set(bookings.map((b) => b.businessId))];
  const clientIds = [...new Set([...bookings.map((b) => b.clientId).filter((v): v is string => Boolean(v)), ...extraClientIds])];
  const staffIds = [...new Set(bookings.map((b) => b.staffId).filter((v): v is string => Boolean(v)))];
  const serviceIds = [...new Set(bookings.flatMap((b) => serviceIdsOf({ services: b.services })))];
  const locationIds = [...new Set(bookings.map((b) => b.locationId).filter((v): v is string => Boolean(v)))];
  const [businesses, clients, staff, services, locations, prefs] = await Promise.all([
    businessIds.length ? db.business.findMany({ where: { id: { in: businessIds } }, select: { id: true, name: true, brandName: true, slug: true, leftAt: true } }) : [],
    clientIds.length ? db.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, name: true, phone: true, locale: true, appUserId: true, deletedAt: true, purgedAt: true } }) : [],
    staffIds.length ? db.staff.findMany({ where: { id: { in: staffIds } }, select: { id: true, name: true } }) : [],
    serviceIds.length ? db.service.findMany({ where: { id: { in: serviceIds } }, select: { id: true, name: true, repeatIntervalDays: true, winbackReminder: true } }) : [],
    locationIds.length ? db.location.findMany({ where: { id: { in: locationIds } }, select: { id: true, tz: true } }) : [],
    clientPrefsOf(db, clientIds),
  ]);
  const clientById = new Map(clients.map((c) => [c.id, c]));
  const byPhone = await appUsersByPhone(db, clients.filter((c) => !c.appUserId).map((c) => c.phone));
  return {
    business: new Map(businesses.map((b) => [b.id, b])),
    client: clientById,
    staff: new Map(staff.map((s) => [s.id, s])),
    service: new Map(services.map((s) => [s.id, s])),
    tz: new Map(locations.map((l) => [l.id, l.tz || DEFAULT_TZ])),
    prefs,
    appUserOf: (clientId: string | null, bookingAppUserId?: string | null): string | null => {
      if (bookingAppUserId) return bookingAppUserId;
      const c = clientId ? clientById.get(clientId) : undefined;
      return c?.appUserId ?? (c ? (byPhone.get(c.phone) ?? null) : null);
    },
  };
}
type Refs = Awaited<ReturnType<typeof loadRefs>>;

const site = () => env.PUBLIC_SITE_URL;
const bookingLinkOf = (slug: string | null | undefined) => (slug ? `${site()}/b/${slug}/book` : site());

/** Переменные шаблона (имена — как в редакторе типа и журнале отправок, notify-log-derive.ts::bookingVarsFor) */
function varsFor(refs: Refs, businessId: string, extra: (lang: Locale) => Record<string, string>, b?: BookingRow, clientId?: string | null): VarsByLocale {
  const biz = refs.business.get(businessId);
  const client = clientId ? refs.client.get(clientId) : undefined;
  const companyName = biz?.brandName || biz?.name || 'BookTime';
  const out = {} as VarsByLocale;
  for (const lang of LOCALES) {
    let bookingPart: Record<string, string> = {};
    if (b) {
      const local = utcToLocal(b.startAt, refs.tz.get(b.locationId) ?? DEFAULT_TZ);
      const names = serviceIdsOf(b).map((id) => localText(refs.service.get(id)?.name, lang)).filter(Boolean);
      const date = `${local.slice(8, 10)}.${local.slice(5, 7)}`;
      const time = local.slice(11, 16);
      bookingPart = {
        date,
        time,
        dateTime: `${date} ${time}`,
        service: names[0] ?? '',
        visitServices: names.join(', '),
        staff: refs.staff.get(b.staffId)?.name ?? '',
        link: `${site()}/bookings/${b.id}`,
        reviewLink: `${site()}/bookings/${b.id}`,
      };
    }
    out[lang] = {
      companyName,
      place: companyName,
      bookingLink: bookingLinkOf(biz?.slug),
      clientName: firstName(client?.name),
      clientPhone: client?.phone ?? '',
      ...bookingPart,
      ...extra(lang),
    };
  }
  return out;
}

function liveBusiness(refs: Refs, businessId: string) {
  const biz = refs.business.get(businessId);
  return biz && !biz.leftAt ? biz : undefined;
}

function liveClient(refs: Refs, clientId: string | null) {
  const c = clientId ? refs.client.get(clientId) : undefined;
  return c && !c.deletedAt && !c.purgedAt && c.phone ? c : undefined;
}

// ─────────── «Клиент записался онлайн» (тип 2, F-05-024) ───────────

/** Сколько назад искать новые онлайн-записи: простой воркера; дальше подтверждать запись поздно */
const BOOKED_LOOKBACK_MS = 6 * H;

/**
 * Клиент сам записался (приложение, ссылка, виджет) — «Вы записаны: услуга, дата, время» по каталогу (тип 2): пуш в
 * приложение, без приложения — Telegram-бот на номере, иначе SMS провайдера бизнеса (сценарий SMS в типе). Это
 * подтверждение действия клиента, а не реклама: тихие часы не ждёт (как подтверждение и отмена записи). Запись уже
 * отменена, удалена или визит начался — не шлём. Запись из журнала — тип 8 (bookings.service.ts, booking_created).
 */
async function onlineBookedNotices(ctx: Ctx): Promise<ClientAutoTally> {
  const res: ClientAutoTally = {};
  const events = await ctx.db.bookingEvent.findMany({ where: { kind: 'created', at: { gte: new Date(ctx.now.getTime() - BOOKED_LOOKBACK_MS), lte: ctx.now } } });
  if (!events.length) return res;
  const bookings = (await ctx.db.booking.findMany({ where: { id: { in: [...new Set(events.map((e) => e.bookingId))] } } })) as BookingRow[];
  const fresh = bookings.filter((b) => VIA_WIDGET.has(b.source) && !b.deletedAt && ACTIVE.includes(b.status) && b.startAt.getTime() > ctx.now.getTime());
  if (!fresh.length) return res;
  const refs = await loadRefs(ctx.db, fresh);
  for (const b of fresh) {
    const biz = liveBusiness(refs, b.businessId);
    const client = liveClient(refs, b.clientId);
    if (!biz || !client) continue;
    const type = await ctx.configs.get(b.businessId, 2);
    tally(
      res,
      await sendClientAuto(ctx.db, ctx.messenger, {
        businessId: b.businessId,
        businessName: biz.brandName || biz.name,
        type,
        kind: 'online_booked',
        client,
        appUserId: refs.appUserOf(b.clientId, b.appUserId),
        prefs: refs.prefs.get(client.id),
        vars: varsFor(refs, b.businessId, () => ({}), b, b.clientId),
        dedupe: `2:${b.id}`,
        url: `/bookings/${b.id}`,
        staffId: b.staffId,
        bookingId: b.id,
        bookingOverride: b.notifyOverride as ClientAutoInputOverride,
        now: ctx.now,
      }),
    );
  }
  return res;
}

// ─────────── «Клиент не пришёл» (тип 75, F-05-031) ───────────

/**
 * Статус «Не пришёл» поставлен ДО начала визита → клиенту сообщение (после начала — ничего, правило Altegio 1:1, как журнал
 * отправок). Запись с тех пор вернули в другой статус — не шлём. Один раз на запись.
 */
async function noShowNotices(ctx: Ctx): Promise<ClientAutoTally> {
  const res: ClientAutoTally = {};
  const events = await ctx.db.bookingEvent.findMany({ where: { kind: 'status', toStatus: 'no_show', at: { gte: new Date(ctx.now.getTime() - LOOKBACK_MS), lte: ctx.now } } });
  if (!events.length) return res;
  const bookings = (await ctx.db.booking.findMany({ where: { id: { in: [...new Set(events.map((e) => e.bookingId))] } } })) as BookingRow[];
  const byId = new Map(bookings.map((b) => [b.id, b]));
  const refs = await loadRefs(ctx.db, bookings);
  for (const e of events) {
    const b = byId.get(e.bookingId);
    if (!b || b.deletedAt || b.status !== 'no_show' || e.at.getTime() > b.startAt.getTime()) continue;
    const biz = liveBusiness(refs, b.businessId);
    const client = liveClient(refs, b.clientId);
    if (!biz || !client) continue;
    const type = await ctx.configs.get(b.businessId, 75);
    tally(
      res,
      await sendClientAuto(ctx.db, ctx.messenger, {
        businessId: b.businessId,
        businessName: biz.brandName || biz.name,
        type,
        kind: 'client_no_show',
        client,
        appUserId: refs.appUserOf(b.clientId, b.appUserId),
        prefs: refs.prefs.get(client.id),
        vars: varsFor(refs, b.businessId, () => ({}), b, b.clientId),
        dedupe: `75:${b.id}`,
        url: `/places/${b.businessId}`,
        staffId: b.staffId,
        bookingId: b.id,
        bookingOverride: b.notifyOverride as ClientAutoInputOverride,
        now: ctx.now,
      }),
    );
  }
  return res;
}
type ClientAutoInputOverride = { pushEnabled?: boolean; telegramEnabled?: boolean; smsEnabled?: boolean } | null;

// ─────────── «Зовём вернуться того, кто не дошёл» (тип 72, F-05-032) ───────────

/**
 * Запись отменена (клиентом или сотрудником, в том числе удалена) или «Не пришёл» — через «Когда отправлять» (inviteAfterHours:
 * сразу / N часов / N дней) приглашаем записаться снова, если у клиента нет будущих записей в этом бизнесе. «Статус записи
 * для отправки» — inviteStatusFilter. Снятые системой заявки (не оплатил предоплату, мастер не ответил) — не «отмена»:
 * им свои сообщения. Клиент отказался от рекламных сообщений (marketingOptOut) — не зовём. Один раз на клиента в день.
 */
async function noShowInvites(ctx: Ctx): Promise<ClientAutoTally> {
  const res: ClientAutoTally = {};
  // «через N дней» — до 7 суток (F-05-032); окно событий — это плюс запас на ночь
  const from = new Date(ctx.now.getTime() - 7 * DAY - LOOKBACK_MS);
  const raw = await ctx.db.bookingEvent.findMany({ where: { kind: { in: ['status', 'deleted'] }, at: { gte: from, lte: ctx.now } } });
  const events = raw.filter((e) => e.byRef !== 'system' && (e.kind === 'deleted' || CANCELLED.includes(e.toStatus ?? '') || e.toStatus === 'no_show'));
  if (!events.length) return res;
  const bookings = (await ctx.db.booking.findMany({ where: { id: { in: [...new Set(events.map((e) => e.bookingId))] } } })) as BookingRow[];
  const byId = new Map(bookings.map((b) => [b.id, b]));
  const refs = await loadRefs(ctx.db, bookings);
  const clientIds = [...new Set(bookings.map((b) => b.clientId).filter((v): v is string => Boolean(v)))];
  const future = clientIds.length
    ? await ctx.db.booking.findMany({ where: { clientId: { in: clientIds }, deletedAt: null, status: { in: ACTIVE }, startAt: { gt: ctx.now } }, select: { clientId: true, businessId: true } })
    : [];
  const hasFuture = new Set(future.map((f) => `${f.businessId}:${f.clientId}`));

  for (const e of events) {
    const b = byId.get(e.bookingId);
    if (!b?.clientId) continue;
    const noShow = e.kind === 'status' && e.toStatus === 'no_show';
    // Запись с тех пор восстановили или вернули в работу — события уже нет
    if (e.kind === 'deleted' ? !b.deletedAt : b.deletedAt || b.status !== e.toStatus) continue;
    const type = await ctx.configs.get(b.businessId, 72);
    if (!type.enabled) continue;
    const filter = type.conditions?.inviteStatusFilter ?? 'all';
    if ((filter === 'cancelled' && noShow) || (filter === 'noShow' && !noShow)) continue;
    const dueAt = e.at.getTime() + Math.max(0, type.conditions?.inviteAfterHours ?? 0) * H;
    if (dueAt > ctx.now.getTime() || dueAt < ctx.now.getTime() - LOOKBACK_MS) continue;
    if (hasFuture.has(`${b.businessId}:${b.clientId}`)) continue;
    const biz = liveBusiness(refs, b.businessId);
    const client = liveClient(refs, b.clientId);
    if (!biz || !client) continue;
    const prefs = refs.prefs.get(client.id);
    if (prefs?.marketingOptOut) continue;
    const day = utcToLocal(new Date(dueAt), refs.tz.get(b.locationId) ?? DEFAULT_TZ).slice(0, 10);
    tally(
      res,
      await sendClientAuto(ctx.db, ctx.messenger, {
        businessId: b.businessId,
        businessName: biz.brandName || biz.name,
        type,
        kind: 'noshow_invite',
        client,
        appUserId: refs.appUserOf(b.clientId, b.appUserId),
        prefs,
        vars: varsFor(refs, b.businessId, () => ({}), b, b.clientId),
        dedupe: `72:${client.id}:${day}`,
        url: `/places/${b.businessId}`,
        staffId: b.staffId,
        bookingId: b.id,
        now: ctx.now,
      }),
    );
  }
  return res;
}

// ─────────── «Спрашиваем впечатление» (типы 6 и 20, F-05-033, ⭐ F-00-116) ───────────

/**
 * После визита «Пришёл» — через «Отправлять уведомление» (reviewDelayMinutes, по умолчанию 5 мин) после конца визита
 * спрашиваем «понравилось? ★» со ссылкой на запись в приложении (там звёздочка, F-00-116). Тип 6 — онлайн-запись,
 * тип 20 — запись из журнала, настраиваются отдельно.
 *  · ★ ставит только человек приложения по своей записи (me.service.ts::rateStaff) — у записи без appUserId спрашивать
 *    не о чем, такие пропускаем;
 *  · отметку «Пришёл» поставили позже момента — спрашиваем при отметке, но не позже суток после конца визита (решение:
 *    Altegio в этом случае не шлёт вовсе, у нас отметки часто ставят после — F-00-127 «Ждут отметки»; отметки задним
 *    числом через неделю — уже не спрашиваем);
 *  · «Не отправлять, если»: в визите исключённая услуга; клиент уже оценил — место (любая ★ / отзыв в этом бизнесе),
 *    мастера, услугу (★ / отзыв по визиту с этой услугой). ★ этому мастеру уже стоит — второй раз не поставить, не спрашиваем.
 */
async function reviewRequests(ctx: Ctx): Promise<ClientAutoTally> {
  const res: ClientAutoTally = {};
  const MAX_DELAY = DAY;
  const bookings = (await ctx.db.booking.findMany({
    where: { status: 'arrived', deletedAt: null, appUserId: { not: null }, endAt: { gte: new Date(ctx.now.getTime() - LOOKBACK_MS - MAX_DELAY - DAY), lte: ctx.now } },
  })) as BookingRow[];
  if (!bookings.length) return res;
  const arrivals = await ctx.db.bookingEvent.findMany({ where: { bookingId: { in: bookings.map((b) => b.id) }, kind: { in: ['status', 'created'] } } });
  const arrivedAt = new Map<string, number>();
  for (const e of arrivals) {
    if (e.kind === 'status' && e.toStatus !== 'arrived') continue;
    if (e.kind === 'created' && e.toStatus !== 'arrived') continue;
    arrivedAt.set(e.bookingId, Math.max(arrivedAt.get(e.bookingId) ?? 0, e.at.getTime()));
  }
  const refs = await loadRefs(ctx.db, bookings);
  const userIds = [...new Set(bookings.map((b) => b.appUserId!))];
  const [stars, staffReviews, placeReviews] = await Promise.all([
    ctx.db.starRating.findMany({ where: { appUserId: { in: userIds } }, select: { appUserId: true, staffId: true, bookingId: true } }),
    ctx.db.staffReview.findMany({ where: { appUserId: { in: userIds } }, select: { appUserId: true, staffId: true, businessId: true, bookingId: true } }),
    ctx.db.locationReview.findMany({ where: { appUserId: { in: userIds } }, select: { appUserId: true, businessId: true, bookingId: true } }),
  ]);
  const ratedBookingIds = [...new Set([...stars, ...staffReviews, ...placeReviews].map((r) => r.bookingId))];
  const rated = ratedBookingIds.length
    ? await ctx.db.booking.findMany({ where: { id: { in: ratedBookingIds } }, select: { id: true, businessId: true, services: true } })
    : [];
  const ratedById = new Map(rated.map((r) => [r.id, r]));
  const ratingsOf = (appUserId: string) =>
    [...stars, ...staffReviews, ...placeReviews]
      .filter((r) => r.appUserId === appUserId)
      .map((r) => ({ staffId: 'staffId' in r ? r.staffId : undefined, booking: ratedById.get(r.bookingId) }));

  for (const b of bookings) {
    const type = await ctx.configs.get(b.businessId, VIA_WIDGET.has(b.source) ? 6 : 20);
    if (!type.enabled) continue;
    const c = type.conditions ?? {};
    const delay = Math.min(Math.max(c.reviewDelayMinutes ?? 5, 0), MAX_DELAY / 60_000) * 60_000;
    const marked = arrivedAt.get(b.id) ?? b.endAt.getTime();
    if (marked > b.endAt.getTime() + DAY) continue;
    const dueAt = Math.max(b.endAt.getTime() + delay, marked);
    if (dueAt > ctx.now.getTime() || dueAt < ctx.now.getTime() - LOOKBACK_MS) continue;
    const services = serviceIdsOf(b);
    if ((c.reviewExcludeServiceIds ?? []).some((id) => services.includes(id))) continue;
    const mine = ratingsOf(b.appUserId!).filter((r) => r.booking?.businessId === b.businessId && r.booking.id !== b.id);
    const ex = c.reviewExcludeIfReviewed ?? {};
    if (ex.location && mine.length) continue;
    if (ex.staff && mine.some((r) => r.staffId === b.staffId)) continue;
    if (ex.service && mine.some((r) => r.booking && serviceIdsOf(r.booking).some((id) => services.includes(id)))) continue;
    if (stars.some((s) => s.appUserId === b.appUserId && s.staffId === b.staffId)) continue;
    const biz = liveBusiness(refs, b.businessId);
    if (!biz) continue;
    const client = liveClient(refs, b.clientId);
    const user = client ? undefined : await ctx.db.user.findUnique({ where: { id: b.appUserId! }, select: { phone: true, locale: true } });
    const recipient = client ?? (user?.phone ? { id: null, phone: user.phone, locale: user.locale } : undefined);
    if (!recipient) continue;
    tally(
      res,
      await sendClientAuto(ctx.db, ctx.messenger, {
        businessId: b.businessId,
        businessName: biz.brandName || biz.name,
        type,
        kind: 'review_request',
        client: { id: recipient.id, phone: recipient.phone, locale: recipient.locale },
        appUserId: b.appUserId,
        prefs: client ? refs.prefs.get(client.id) : undefined,
        vars: varsFor(refs, b.businessId, () => ({}), b, b.clientId),
        dedupe: `review:${b.id}`,
        url: `/bookings/${b.id}`,
        inbox: { kind: 'review_request', staffId: b.staffId, bookingId: b.id },
        staffId: b.staffId,
        bookingId: b.id,
        bookingOverride: b.notifyOverride as ClientAutoInputOverride,
        now: ctx.now,
      }),
    );
  }
  return res;
}

export async function notifyClientEvents(db: PrismaService, messenger: BusinessMessenger, now: Date = new Date()): Promise<ClientAutoResult> {
  const ctx: Ctx = { db, messenger, now, configs: new ClientTypeConfigs(db) };
  const run = async (name: string, fn: (c: Ctx) => Promise<ClientAutoTally>) => {
    try {
      return await fn(ctx);
    } catch (err) {
      logger.error({ err }, `notify.client-events: ${name} упал`);
      return {};
    }
  };
  // «Вы записаны» (2) — ответ на действие клиента, уходит и в тихие часы; остальное — нет
  const booked = await run('2', onlineBookedNotices);
  if (inQuietHours(now)) return { quiet: true, booked, noShow: {}, noShowInvite: {}, review: {} };
  return { quiet: false, booked, noShow: await run('75', noShowNotices), noShowInvite: await run('72', noShowInvites), review: await run('6/20', reviewRequests) };
}

// ─────────── «С днём рождения» (тип 3, F-05-034) ───────────

function addDays(date: string, days: number): string {
  const [y = 1970, m = 1, d = 1] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/**
 * В выбранный день («В день рождения» или «за N дней», 1…14) в выбранный час (по поясу филиала, по умолчанию 10:00)
 * клиенту с датой рождения в карточке — поздравление. 29 февраля в невисокосный год — 28-го. Клиент отказался от
 * поздравлений в карточке (birthdayGreetingOptOut) или от рекламных сообщений — не шлём. Один раз в год.
 */
async function birthdays(ctx: Ctx): Promise<ClientAutoTally> {
  const res: ClientAutoTally = {};
  const MAX_BEFORE = 14;
  // Даты рождения «MM-DD», которые могут наступить в ближайшие 14 дней (+1 день на разницу поясов)
  const today = utcToLocal(ctx.now, DEFAULT_TZ).slice(0, 10);
  const mds = new Set<string>();
  for (let i = -1; i <= MAX_BEFORE + 1; i++) {
    const day = addDays(today, i);
    mds.add(day.slice(5));
    if (day.slice(5) === '02-28' && !isLeap(Number(day.slice(0, 4)))) mds.add('02-29');
  }
  const clients = await ctx.db.client.findMany({
    where: { deletedAt: null, purgedAt: null, OR: [...mds].map((md) => ({ birthday: { endsWith: `-${md}` } })) },
    select: { id: true, businessId: true, name: true, phone: true, locale: true, appUserId: true, birthday: true, birthdayGreetingOptOut: true, discountPercent: true },
  });
  const list = clients.filter((c) => c.birthday && /^\d{4}-\d{2}-\d{2}$/.test(c.birthday) && c.birthdayGreetingOptOut !== true && c.phone);
  if (!list.length) return res;
  const businessIds = [...new Set(list.map((c) => c.businessId))];
  const [locations, refs] = await Promise.all([
    ctx.db.location.findMany({ where: { businessId: { in: businessIds } }, select: { id: true, businessId: true, tz: true } }),
    loadRefs(ctx.db, list.map((c) => ({ businessId: c.businessId, clientId: c.id }))),
  ]);
  const tzOfBiz = new Map<string, string>();
  for (const l of locations) if (!tzOfBiz.has(l.businessId)) tzOfBiz.set(l.businessId, l.tz || DEFAULT_TZ);

  for (const c of list) {
    const type = await ctx.configs.get(c.businessId, 3);
    if (!type.enabled) continue;
    const cond = type.conditions ?? {};
    const before = cond.birthdayMode === 'daysBefore' ? Math.min(Math.max(cond.birthdayDaysBefore ?? 3, 1), MAX_BEFORE) : 0;
    const local = utcToLocal(ctx.now, tzOfBiz.get(c.businessId) ?? DEFAULT_TZ);
    const at = /^\d{2}:\d{2}$/.test(cond.birthdayTimeOfDay ?? '') ? cond.birthdayTimeOfDay! : '10:00';
    if (local.slice(11, 16) < at) continue;
    const target = addDays(local.slice(0, 10), before); // день рождения, к которому шлём
    const md = c.birthday!.slice(5);
    const matches = md === target.slice(5) || (md === '02-29' && target.slice(5) === '02-28' && !isLeap(Number(target.slice(0, 4))));
    if (!matches) continue;
    const biz = liveBusiness(refs, c.businessId);
    if (!biz) continue;
    const prefs = refs.prefs.get(c.id);
    if (prefs?.marketingOptOut) continue;
    tally(
      res,
      await sendClientAuto(ctx.db, ctx.messenger, {
        businessId: c.businessId,
        businessName: biz.brandName || biz.name,
        type,
        kind: 'birthday',
        client: c,
        appUserId: refs.appUserOf(c.id),
        prefs,
        vars: varsFor(refs, c.businessId, () => ({ discount: String(c.discountPercent ?? 0), days: String(before) }), undefined, c.id),
        dedupe: `3:${c.id}:${target.slice(0, 4)}`,
        url: `/places/${c.businessId}`,
        inbox: { kind: 'birthday_greeting', params: { discountPercent: c.discountPercent ?? 0 } },
        now: ctx.now,
      }),
    );
  }
  return res;
}

// ─────────── «Пора снова» (тип 55, F-05-037, ⭐ F-00-119 / F-00-084) ───────────

/**
 * Правило мока (client.ts::synthesizeRepeatInvites): по каждой паре «клиент × мастер» берём последний визит «Пришёл»;
 * срок наступил (дата визита + интервал), а нового визита к этому мастеру (не отменённого) нет — зовём «пора снова» с
 * кнопкой записи к этому мастеру на ту же услугу. Сверх мока, по ТЗ F-05-037:
 *  · интервал: свой у записи (окно визита / карточка клиента → «Пригласить на повтор через», F-04-100) → у услуги
 *    («Не отправлять после визита» — не зовём; «Пора снова через N дней», F-00-084) → общий срок типа 55 (14 дней);
 *  · новая запись на ту же услугу к другому мастеру — тоже «уже записался»;
 *  · несколько визитов созрели в один день — одно сообщение со всеми услугами;
 *  · клиент отказался от рекламных сообщений — не зовём. Срок прошёл больше 3 дней назад — уже не шлём (не досылаем
 *    историю при первом запуске).
 */
async function repeatInvites(ctx: Ctx): Promise<ClientAutoTally> {
  const res: ClientAutoTally = {};
  const MAX_INTERVAL_DAYS = 370;
  const GRACE = 3 * DAY;
  const arrived = (await ctx.db.booking.findMany({
    where: { status: 'arrived', deletedAt: null, clientId: { not: null }, groupEventId: null, startAt: { gte: new Date(ctx.now.getTime() - MAX_INTERVAL_DAYS * DAY), lte: ctx.now } },
  })) as BookingRow[];
  if (!arrived.length) return res;
  const last = new Map<string, BookingRow>();
  for (const b of arrived) {
    const key = `${b.businessId}:${b.clientId}:${b.staffId}`;
    const cur = last.get(key);
    if (!cur || b.startAt > cur.startAt) last.set(key, b);
  }
  const candidates = [...last.values()];
  const refs = await loadRefs(ctx.db, candidates);
  const reminders = await ctx.db.bookingReminder.findMany({ where: { bookingId: { in: candidates.map((b) => b.id) } }, select: { bookingId: true, revisitInviteDays: true } });
  const ownDays = new Map(reminders.map((r) => [r.bookingId, r.revisitInviteDays ?? 0]));

  type Due = { b: BookingRow; dueAt: number; serviceId: string };
  const due: Due[] = [];
  for (const b of candidates) {
    const serviceId = serviceIdsOf(b)[0];
    if (!serviceId) continue;
    const service = refs.service.get(serviceId);
    const own = ownDays.get(b.id) || (b.reminderOverride as { revisitInviteDays?: number } | null)?.revisitInviteDays || 0;
    let days = own > 0 ? own : 0;
    if (!days) {
      if (service?.winbackReminder === 'off') continue;
      if (service?.repeatIntervalDays && service.repeatIntervalDays > 0) days = service.repeatIntervalDays;
      else {
        const type = await ctx.configs.get(b.businessId, 55);
        days = type.conditions?.winbackAfterDays ?? 14;
      }
    }
    if (!(days > 0)) continue;
    const dueAt = b.startAt.getTime() + days * DAY;
    if (dueAt > ctx.now.getTime() || dueAt < ctx.now.getTime() - GRACE) continue;
    due.push({ b, dueAt, serviceId });
  }
  if (!due.length) return res;

  const later = await ctx.db.booking.findMany({
    where: { clientId: { in: [...new Set(due.map((d) => d.b.clientId!))] }, deletedAt: null, status: { notIn: CANCELLED }, startAt: { gt: new Date(Math.min(...due.map((d) => d.b.startAt.getTime()))) } },
    select: { id: true, businessId: true, clientId: true, staffId: true, startAt: true, services: true },
  });
  const rebooked = (d: Due) =>
    later.some((x) => x.id !== d.b.id && x.businessId === d.b.businessId && x.clientId === d.b.clientId && x.startAt > d.b.startAt && (x.staffId === d.b.staffId || serviceIdsOf(x).includes(d.serviceId)));

  // Одно сообщение на клиента в день: созревшие в один день визиты объединяются
  const groups = new Map<string, Due[]>();
  for (const d of due) {
    if (rebooked(d)) continue;
    const day = utcToLocal(new Date(d.dueAt), refs.tz.get(d.b.locationId) ?? DEFAULT_TZ).slice(0, 10);
    const key = `${d.b.businessId}:${d.b.clientId}:${day}`;
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }
  for (const [key, group] of groups) {
    group.sort((a, b) => a.dueAt - b.dueAt);
    const first = group[0]!;
    const b = first.b;
    const type = await ctx.configs.get(b.businessId, 55);
    if (!type.enabled) continue;
    const biz = liveBusiness(refs, b.businessId);
    const client = liveClient(refs, b.clientId);
    if (!biz || !client) continue;
    const prefs = refs.prefs.get(client.id);
    if (prefs?.marketingOptOut) continue;
    const names = (lang: Locale) => [...new Set(group.map((g) => localText(refs.service.get(g.serviceId)?.name, lang)).filter(Boolean))].join(', ');
    tally(
      res,
      await sendClientAuto(ctx.db, ctx.messenger, {
        businessId: b.businessId,
        businessName: biz.brandName || biz.name,
        type,
        kind: 'repeat_invite',
        client,
        appUserId: refs.appUserOf(b.clientId, b.appUserId),
        prefs,
        vars: varsFor(refs, b.businessId, (lang) => ({ service: names(lang), visitServices: names(lang) }), b, b.clientId),
        dedupe: `55:${key.split(':').slice(1).join(':')}`,
        url: `/book?staff=${b.staffId}&service=${first.serviceId}`,
        inbox: { kind: 'repeat_invite', staffId: b.staffId, bookingId: b.id },
        staffId: b.staffId,
        bookingId: b.id,
        now: ctx.now,
      }),
    );
  }
  return res;
}

export async function notifyClientDaily(db: PrismaService, messenger: BusinessMessenger, now: Date = new Date()): Promise<ClientDailyResult> {
  if (inQuietHours(now)) return { quiet: true, birthday: {}, repeat: {} };
  const ctx: Ctx = { db, messenger, now, configs: new ClientTypeConfigs(db) };
  const run = async (name: string, fn: (c: Ctx) => Promise<ClientAutoTally>) => {
    try {
      return await fn(ctx);
    } catch (err) {
      logger.error({ err }, `notify.client-daily: ${name} упал`);
      return {};
    }
  };
  return { quiet: false, birthday: await run('3', birthdays), repeat: await run('55', repeatInvites) };
}

/** Что попало в лог воркера: только если что-то ушло или не доставлено */
export function clientAutoWorth(...tallies: ClientAutoTally[]): boolean {
  return tallies.some((t) => (t.push ?? 0) + (t.telegram ?? 0) + (t.sms ?? 0) + (t.whatsapp ?? 0) + (t.notDelivered ?? 0) > 0);
}

