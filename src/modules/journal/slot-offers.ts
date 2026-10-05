import type { Prisma } from '../../generated/prisma/client.js';
import { env } from '../../common/config/env.js';
import { ApiError } from '../../common/errors/api-error.js';
import { isLocale, LOCALES, t, type Locale } from '../../common/i18n/i18n.js';
import { newId } from '../../common/ids/ids.js';
import { normalizePhone } from '../../common/phone.js';
import type { PrismaService } from '../../common/prisma.service.js';
import { DEFAULT_TZ, utcToLocal } from '../../common/time/time.js';
import { toMinutes } from '../availability/engine.js';
import { clientPrefsOf } from '../notify/client-auto.js';
import { enqueueClientNotification, enqueueOutbox } from '../notify/outbox.js';
import { tgLocale } from '../telegram/telegram-links.js';
import { waitlistOffer } from './waitlist-match.js';

/**
 * ⭐ «Найти окно → Предложить» на сервере (06.10.2026, F-01-156, F-00-103, F-00-101; охват ТЗ 06.10 п. 4 №10) — порт
 * мока `src/api/journal-offers.ts` фронта. Администратор выбирает окна в «Найти окно» и каналы:
 *  · «Лист ожидания» — единый лист бизнеса (заявки сотрудников, «Сообщить, когда освободится» из приложения и виджета):
 *    кому подходит окно — правило раздачи освободившегося окна (waitlist-match.ts: мастер, услуга помещается в окно, день и
 *    время желания). Вставшему из приложения — пуш «Освободилось окно» и строка ленты с кнопкой «Записаться» на это окно;
 *    без приложения — Telegram-бот на номере со ссылкой записи; иначе — «Не доставлено» в журнале. Заявке — отметка
 *    «Уведомлён» (видна на /biz/waitlist, в панели журнала и у клиента);
 *  · «Горящее окно» (только сегодня) — пуш подписчикам ❤ мастера и салона, не приглушившим новости (F-00-115), одним
 *    сообщением со списком сегодняшних окон (до пяти) и скидкой из «Продвижения» (client-promotion.hotSlotDiscountPercent).
 * Один человек — одно сообщение (про самое раннее подходящее окно), без повторов по телефону и аккаунту. Каждое
 * сообщение — строка журнала отправок с настоящим статусом (итог — из очереди, notify-log-outbox.ts); само предложение —
 * в business_settings 'journal-slot-offers' («уже предлагали в HH:MM» в «Найти окно»), последние 200.
 * Клиент выключил пуши (F-04-090) — пуша нет, остаётся Telegram.
 */

export type SlotOfferChannel = 'waitlist' | 'hot';

export interface SlotOfferTarget {
  staffId: string;
  serviceId: string;
  date: string;
  time: string;
  /** Длина свободного окна, мин; нет — окно подобрано под услугу */
  freeMin?: number;
}

export interface SlotOfferOut {
  id: string;
  businessId: string;
  staffId: string;
  serviceId: string;
  date: string;
  time: string;
  channels: SlotOfferChannel[];
  recipients: number;
  hotDiscountPercent?: number;
  createdAt: string;
}

export interface SlotOfferPreviewOut {
  counts: Record<SlotOfferChannel, number>;
  hotAvailable: boolean;
  hotDiscountPercent?: number;
  offeredAt?: string;
}

const OFFERS_AREA = 'journal-slot-offers';
const PROMOTION_AREA = 'client-promotion';
const MAX_OFFERS = 200;
const HOT_SLOTS_IN_TEXT = 5;
const arr = <T = string>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const byTime = (a: SlotOfferTarget, b: SlotOfferTarget) => (a.date + a.time).localeCompare(b.date + b.time);

interface Recipient {
  channel: SlotOfferChannel;
  target: SlotOfferTarget;
  name: string;
  phone?: string;
  appUserId?: string;
  clientId?: string;
  serviceId?: string;
  entryId?: string;
}

interface Ctx {
  db: PrismaService;
  businessId: string;
  tz: string;
  today: string;
  durations: Map<string, number>;
}

async function context(db: PrismaService, businessId: string, targets: SlotOfferTarget[], now: Date): Promise<Ctx> {
  if (!targets.length) throw new ApiError('validation', 'Invalid input', { targets: 'empty' });
  const [location, staff, services] = await Promise.all([
    db.location.findFirst({ where: { businessId }, select: { tz: true }, orderBy: { id: 'asc' } }),
    db.staff.findMany({ where: { businessId, id: { in: [...new Set(targets.map((x) => x.staffId))] } }, select: { id: true } }),
    db.service.findMany({ where: { businessId }, select: { id: true, durationMin: true } }),
  ]);
  const staffIds = new Set(staff.map((s) => s.id));
  const durations = new Map(services.map((s) => [s.id, s.durationMin]));
  for (const x of targets) {
    if (!staffIds.has(x.staffId)) throw new ApiError('not_found', 'staff not found');
    if (!durations.has(x.serviceId)) throw new ApiError('not_found', 'service not found');
  }
  const tz = location?.tz || DEFAULT_TZ;
  return { db, businessId, tz, today: utcToLocal(now, tz).slice(0, 10), durations };
}

/** Кто получит предложения — без повторов; окна раньше первым (одно сообщение про самое раннее подходящее) */
async function collectRecipients(ctx: Ctx, targets: SlotOfferTarget[], wanted: ReadonlySet<SlotOfferChannel>): Promise<Recipient[]> {
  const seenPhones = new Set<string>();
  const seenUsers = new Set<string>();
  const out: Recipient[] = [];
  const takePhone = (phone: string | undefined) => {
    const key = (phone && (normalizePhone(phone) ?? phone)) || '';
    if (key && seenPhones.has(key)) return false;
    if (key) seenPhones.add(key);
    return true;
  };
  if (wanted.has('waitlist')) {
    const entries = await ctx.db.waitlistEntry.findMany({ where: { businessId: ctx.businessId, bookingId: null }, orderBy: { createdAt: 'asc' } });
    const taken = new Set<string>();
    for (const x of targets) {
      const duration = ctx.durations.get(x.serviceId) ?? 0;
      // Окно короче услуги — никому: записаться в него всё равно нельзя
      if (x.freeMin !== undefined && duration > x.freeMin) continue;
      const window = { staffId: x.staffId, serviceIds: [x.serviceId], durationMin: x.freeMin ?? duration, date: x.date, startMin: toMinutes(x.time) };
      for (const e of entries) {
        if (taken.has(e.id)) continue;
        // Желания только на прошлые дни — заявка истекла
        const wishes = arr<{ date?: string }>(e.wishes);
        if (wishes.length && wishes.every((w) => w.date && w.date < ctx.today)) continue;
        const service = waitlistOffer(e, window, ctx.durations);
        if (service === null) continue;
        if (e.appUserId && seenUsers.has(e.appUserId)) continue;
        if (!takePhone(e.clientPhone)) continue;
        taken.add(e.id);
        if (e.appUserId) seenUsers.add(e.appUserId);
        out.push({ channel: 'waitlist', target: x, name: e.clientName, phone: e.clientPhone, appUserId: e.appUserId ?? undefined, clientId: e.clientId ?? undefined, serviceId: service ?? x.serviceId, entryId: e.id });
      }
    }
  }
  const hot = targets.find((x) => x.date === ctx.today);
  if (wanted.has('hot') && hot) {
    const staff = await ctx.db.staff.findMany({ where: { businessId: ctx.businessId }, select: { id: true } });
    const favorites = await ctx.db.favorite.findMany({
      where: { newsMuted: false, OR: [{ targetType: 'business', targetId: ctx.businessId }, { targetType: 'staff', targetId: { in: staff.map((s) => s.id) } }] },
      select: { appUserId: true },
      orderBy: { createdAt: 'asc' },
    });
    for (const f of favorites) {
      if (seenUsers.has(f.appUserId)) continue;
      seenUsers.add(f.appUserId);
      out.push({ channel: 'hot', target: hot, name: '', appUserId: f.appUserId });
    }
  }
  return out;
}

async function hotDiscountOf(db: PrismaService, businessId: string): Promise<number | undefined> {
  const row = await db.businessSetting.findUnique({ where: { businessId_area: { businessId, area: PROMOTION_AREA } } });
  const pct = (row?.data as { hotSlotDiscountPercent?: number } | null)?.hotSlotDiscountPercent;
  return typeof pct === 'number' && pct > 0 ? pct : undefined;
}

async function storedOffers(db: PrismaService, businessId: string): Promise<SlotOfferOut[]> {
  const row = await db.businessSetting.findUnique({ where: { businessId_area: { businessId, area: OFFERS_AREA } } });
  return arr<SlotOfferOut>((row?.data as { offers?: unknown } | null)?.offers);
}

/** Кому уйдёт предложение — для подтверждения «отправим N людям» */
export async function previewSlotOffer(db: PrismaService, businessId: string, targets: SlotOfferTarget[], now: Date = new Date()): Promise<SlotOfferPreviewOut> {
  const sorted = targets.slice().sort(byTime);
  const ctx = await context(db, businessId, sorted, now);
  const counts: Record<SlotOfferChannel, number> = { waitlist: 0, hot: 0 };
  for (const r of await collectRecipients(ctx, sorted, new Set(['waitlist', 'hot']))) counts[r.channel] += 1;
  const offeredAt = (await storedOffers(db, businessId)).find((o) => sorted.some((x) => o.staffId === x.staffId && o.date === x.date && o.time === x.time))?.createdAt;
  const hotDiscountPercent = await hotDiscountOf(db, businessId);
  return { counts, hotAvailable: sorted.some((x) => x.date === ctx.today), ...(hotDiscountPercent ? { hotDiscountPercent } : {}), ...(offeredAt ? { offeredAt } : {}) };
}

/** Когда предлагали окна дня: `${staffId}|${time}` → местное время последнего предложения */
export async function listSlotOffers(db: PrismaService, businessId: string, date: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const o of await storedOffers(db, businessId)) {
    if (o.date !== date) continue;
    const key = `${o.staffId}|${o.time}`;
    if (!out[key] || o.createdAt > out[key]) out[key] = o.createdAt;
  }
  return out;
}

type L10n = Record<Locale, string>;
const each = (fn: (l: Locale) => string): L10n => Object.fromEntries(LOCALES.map((l) => [l, fn(l)])) as L10n;

/**
 * Предложить окна выбранным каналам. Сообщения — в очередь отправки (пуш / Telegram) и в журнал отправок; отметки
 * «Уведомлён»; след каждого окна. Возвращает предложения и сколько человек их получили.
 */
export async function offerSlots(
  db: PrismaService,
  businessId: string,
  targets: SlotOfferTarget[],
  channels: SlotOfferChannel[],
  now: Date = new Date(),
): Promise<{ offers: SlotOfferOut[]; sent: number }> {
  const sorted = targets.slice().sort(byTime);
  const ctx = await context(db, businessId, sorted, now);
  const wanted = new Set(channels);
  const recipients = await collectRecipients(ctx, sorted, wanted);
  const nowL = utcToLocal(now, ctx.tz);
  const batch = newId('slotOffer');
  const [business, staffRows, serviceRows, discount] = await Promise.all([
    db.business.findUnique({ where: { id: businessId }, select: { name: true, brandName: true, slug: true } }),
    db.staff.findMany({ where: { businessId }, select: { id: true, name: true } }),
    db.service.findMany({ where: { businessId, id: { in: [...new Set([...sorted.map((x) => x.serviceId), ...recipients.map((r) => r.serviceId ?? '')])].filter(Boolean) } }, select: { id: true, name: true } }),
    wanted.has('hot') ? hotDiscountOf(db, businessId) : Promise.resolve(undefined),
  ]);
  const place = business?.brandName || business?.name || 'BookTime';
  const link = business?.slug ? `${env.PUBLIC_SITE_URL}/b/${business.slug}/book` : env.PUBLIC_SITE_URL;
  const staffName = (id: string) => staffRows.find((s) => s.id === id)?.name ?? '';
  const serviceName = (id: string, l: Locale) => {
    const n = (serviceRows.find((s) => s.id === id)?.name as Partial<Record<Locale, string>> | null) ?? {};
    return n[l] || n.ru || '';
  };
  const when = (x: SlotOfferTarget) => `${x.date.slice(8, 10)}.${x.date.slice(5, 7)} ${x.time}`;
  const label = { ru: 'Предложение окна', en: 'Slot offer', hy: 'Ազատ ժամի առաջարկ' };
  const hotLabel = { ru: 'Горящее окно', en: 'Hot slot', hy: 'Այսօրվա ազատ ժամ' };

  const personal = recipients.filter((r) => r.channel === 'waitlist');
  const prefs = await clientPrefsOf(db, personal.map((r) => r.clientId).filter((v): v is string => Boolean(v)));
  const userIds = personal.map((r) => r.appUserId).filter((v): v is string => Boolean(v));
  const [users, tokens] = await Promise.all([
    userIds.length ? db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, locale: true } }) : [],
    userIds.length ? db.pushToken.findMany({ where: { userId: { in: userIds }, app: 'client', invalidAt: null }, select: { userId: true } }) : [],
  ]);
  const localeOf = new Map(users.map((u) => [u.id, isLocale(u.locale) ? u.locale : ('ru' as Locale)]));
  const withToken = new Set(tokens.map((x) => x.userId));
  const log: Prisma.NotifyLogEntryCreateManyInput[] = [];
  const logRow = (key: string, o: { channel: string; status: string; contact: string; text: L10n; lang: Locale; clientId?: string; staffId?: string; typeLabel: typeof label }) =>
    log.push({
      id: newId('notifyLogEntry'),
      businessId,
      dedupeKey: key,
      sentAt: now,
      typeCode: null,
      typeLabel: o.typeLabel,
      channel: o.channel,
      status: o.status,
      contact: o.contact.slice(0, 160),
      text: o.text,
      clientId: o.clientId ?? null,
      staffId: o.staffId ?? null,
      bookingId: null,
      sentLanguage: o.lang,
      costAmd: 0,
      smsParts: null,
      source: 'service',
    });

  for (const r of personal) {
    const x = r.target;
    const serviceId = r.serviceId ?? x.serviceId;
    const key = `slotOffer:${batch}:${r.entryId}`;
    const params = (l: Locale) => ({ staff: staffName(x.staffId), when: when(x), service: serviceName(serviceId, l), place, link });
    const pushOk = r.appUserId && withToken.has(r.appUserId) && (!r.clientId || prefs.get(r.clientId)?.push !== false);
    if (pushOk) {
      const lang = localeOf.get(r.appUserId!) ?? 'ru';
      const text = each((l) => t(l, 'waitlist.slotAvailableAt', params(l)));
      await enqueueClientNotification(db, {
        businessId,
        kind: 'waitlist_available',
        appUserId: r.appUserId!,
        title: staffName(x.staffId) || place,
        body: text[lang],
        url: `/book?staff=${encodeURIComponent(x.staffId)}&slot=${encodeURIComponent(`${x.date}T${x.time}`)}&service=${encodeURIComponent(serviceId)}`,
        dedupeKey: `${key}:push`,
        meta: { clientId: r.clientId, staffId: x.staffId },
        inbox: { kind: 'waitlist_slot', businessId, staffId: x.staffId, params: { date: x.date, time: x.time, serviceId } },
      });
      logRow(key, { channel: 'push', status: 'sending', contact: r.phone ?? '', text, lang, clientId: r.clientId, staffId: x.staffId, typeLabel: label });
      continue;
    }
    const phone = r.phone ? (normalizePhone(r.phone) ?? r.phone) : '';
    const chats = phone ? await db.telegramLink.findMany({ where: { phone, blockedAt: null }, select: { chatId: true, languageCode: true } }) : [];
    const text = each((l) => t(l, 'slotOffer.telegram', params(l)));
    if (chats.length) {
      for (const c of chats) {
        await enqueueOutbox(db, {
          businessId,
          app: 'telegram',
          kind: 'waitlist_available',
          recipientUserId: c.chatId,
          title: place,
          body: text[tgLocale(c.languageCode)],
          url: link,
          dedupeKey: `${key}:tg:${c.chatId}`,
          meta: { clientId: r.clientId, staffId: x.staffId },
        });
      }
      logRow(key, { channel: 'telegram', status: 'sending', contact: phone, text, lang: tgLocale(chats[0]!.languageCode), clientId: r.clientId, staffId: x.staffId, typeLabel: label });
      continue;
    }
    // Ни приложения, ни Telegram: SMS провайдера бизнеса не подключены (В-08) — так и пишем, а не «отправлено»
    logRow(key, { channel: 'push', status: 'notDelivered', contact: phone || '—', text, lang: 'ru', clientId: r.clientId, staffId: x.staffId, typeLabel: label });
  }

  const subscribers = recipients.filter((r) => r.channel === 'hot' && r.appUserId);
  const hotSlots = sorted.filter((x) => x.date === ctx.today).slice(0, HOT_SLOTS_IN_TEXT);
  if (subscribers.length && hotSlots.length) {
    const key = `hotSlot:${batch}`;
    const text = each((l) =>
      t(l, 'slotOffer.hot', {
        place,
        link,
        slots: hotSlots.map((x) => `${x.time} ${serviceName(x.serviceId, l)} · ${staffName(x.staffId)}`).join('; '),
        discount: discount ? t(l, 'slotOffer.hotDiscount', { percent: discount }) : '',
      }),
    );
    const subUsers = await db.user.findMany({ where: { id: { in: subscribers.map((r) => r.appUserId!) } }, select: { id: true, locale: true } });
    const subLocale = new Map(subUsers.map((u) => [u.id, isLocale(u.locale) ? u.locale : ('ru' as Locale)]));
    for (const r of subscribers) {
      await enqueueClientNotification(db, {
        businessId,
        kind: 'news',
        appUserId: r.appUserId!,
        title: place,
        body: text[subLocale.get(r.appUserId!) ?? 'ru'],
        url: `/places/${businessId}`,
        dedupeKey: `${key}:${r.appUserId}`,
        inbox: { kind: 'broadcast', businessId, params: { text: text[subLocale.get(r.appUserId!) ?? 'ru'] } },
      });
    }
    // Одна строка на пуш подписчикам — как рассылка: получатель — число людей
    logRow(key, { channel: 'push', status: 'sending', contact: String(subscribers.length), text, lang: 'ru', typeLabel: hotLabel });
  }

  if (log.length) await db.notifyLogEntry.createMany({ data: log, skipDuplicates: true });

  // Отметка «Уведомлён» — одна на заявку
  const at = now.toISOString();
  for (const r of personal) {
    const e = await db.waitlistEntry.findUnique({ where: { id: r.entryId! }, select: { notifiedTimes: true } });
    await db.waitlistEntry.update({ where: { id: r.entryId! }, data: { notifiedAt: now, notifiedTimes: [...arr<string>(e?.notifiedTimes), at] as Prisma.InputJsonValue } });
  }

  const offers: SlotOfferOut[] = sorted.map((x) => ({
    id: newId('slotOffer'),
    businessId,
    staffId: x.staffId,
    serviceId: x.serviceId,
    date: x.date,
    time: x.time,
    channels,
    recipients: recipients.filter((r) => r.target === x || (r.channel === 'hot' && x.date === ctx.today)).length,
    ...(discount ? { hotDiscountPercent: discount } : {}),
    createdAt: nowL,
  }));
  const kept = [...offers, ...(await storedOffers(db, businessId))].slice(0, MAX_OFFERS);
  await db.businessSetting.upsert({
    where: { businessId_area: { businessId, area: OFFERS_AREA } },
    create: { businessId, area: OFFERS_AREA, data: { offers: kept } as unknown as Prisma.InputJsonValue },
    update: { data: { offers: kept } as unknown as Prisma.InputJsonValue },
  });
  return { offers, sent: recipients.length };
}

