import dayjs from 'dayjs';
import '../../common/time/time.js';
import type { NotificationTypeOut, RichLocalizedText } from './notify-rich-types.service.js';
import type { NotifyChannel } from './notify-type-registry.js';

/**
 * Вывод журнала отправок из событий записей — порт `src/areas/notify/lib/liveLog.ts` фронта (этап 21, лейн
 * notify-log+mailings). Функция чистая, как на фронте: на вход — данные бизнеса за окно, на выход — строки журнала.
 * Время — местные строки 'YYYY-MM-DDTHH:mm' (пояс филиала), как у мока; сервис переводит их в UTC при записи.
 *
 * Отличия от мока (намеренные):
 *  - ссылка {link} ведёт на /b/<slug>/booking/<id> БЕЗ ?h=: хэш доступа сервер хранит только как sha256
 *    (Booking.accessHash, B19) и восстановить исходный не может;
 *  - короткие ссылки SMS: `shorten` отдаёт метку длиной с настоящий код (6 знаков), сервис после вывода заводит
 *    ShortLink на каждую метку и подменяет её — длина SMS (и цена) от этого не меняется.
 */

export type Lang = 'ru' | 'hy' | 'en';
export const LANGS: Lang[] = ['ru', 'hy', 'en'];
export type LogStatus = 'sent' | 'delivered' | 'notDelivered' | 'sending' | 'read' | 'rejected' | 'insufficientFunds' | 'rejectedByOperator' | 'rejectedByRateLimiter';

export interface LText {
  ru: string;
  hy?: string;
  en?: string;
}

export interface DBooking {
  id: string;
  locationId: string;
  staffId: string;
  clientId: string | null;
  /** местное */
  start: string;
  status: string;
  serviceIds: string[];
  total: number;
  source: string;
  visitorName: string | null;
  /** местное */
  createdAt: string;
  deleted: boolean;
  override: { sendOnSave?: boolean; smsEnabled?: boolean; emailEnabled?: boolean; pushEnabled?: boolean; smsTimingHours?: number; emailTimingHours?: number; pushTimingHours?: number } | null;
}

export interface DClient {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  appUserId: string | null;
  birthday: string | null;
}

export interface DEvent {
  id: string;
  bookingId: string;
  kind: string;
  fromStatus: string | null;
  toStatus: string | null;
  prevStart: string | null;
  byRef: string;
  /** местное */
  at: string;
}

export interface DStaff {
  id: string;
  name: string;
  phone: string;
  role: string;
  locationIds: string[];
}

export interface DClientPrefs {
  channels: { push: boolean; sms: boolean; email: boolean };
  disabledTypeCodes: number[];
}

export interface LogRow {
  /** ключ дубля — стабилен между проходами */
  key: string;
  createdAt: string;
  typeCode?: number;
  typeLabel: LText;
  channel: NotifyChannel;
  status: LogStatus;
  contact: string;
  text: LText;
  clientId?: string;
  staffId?: string;
  bookingId?: string;
  sentLanguage: Lang;
  costAmd: number;
  smsParts?: number;
  scheduled?: boolean;
  deferredFrom?: string;
}

export interface DeriveContext {
  business: { slug: string; name: string; phone: string; website: string };
  locations: Map<string, { address: LText; phone: string; mapsLink: string }>;
  defaultLocationId?: string;
  staff: DStaff[];
  services: Map<string, LText>;
  bookings: Map<string, DBooking>;
  clients: Map<string, DClient>;
  clientPrefs: Map<string, DClientPrefs>;
  types: NotificationTypeOut[];
  settings: { language: Lang; dateFormat: '24h' | '12h'; quietHours: { enabled: boolean; from: string; to: string } };
  /** местное «сейчас» */
  now: string;
  shorten?: (path: string) => string;
  /** Будущие записи клиентов (для «приглашение не уходит, если есть будущая запись», F-05-032) */
  clientsWithFutureBooking: Set<string>;
  /** «Клиент записался снова на ту же услугу позже» — ключ `${clientId}|${serviceId}|${start}` проверяет rebookedAfter */
  rebookedAfter: (clientId: string, bookingId: string, serviceIds: string[], start: string) => boolean;
}

// ─────────── цены (Ув11, Ув13): SMS — 25 ֏ за часть, WhatsApp — за сообщение ───────────

export const SMS_PART_PRICE_AMD = 25;
export const WHATSAPP_MESSAGE_PRICE_AMD = 17;
const GSM7_BASIC = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXTENDED = '^{}\\[~]|€\f';
const BASIC = new Set(Array.from(GSM7_BASIC));
const EXTENDED = new Set(Array.from(GSM7_EXTENDED));

/** Части SMS по GSM 03.38 — порт `src/areas/notify/lib/sms.ts::countSms` */
export function smsParts(text: string): number {
  let gsm = true;
  for (const ch of text) if (!BASIC.has(ch) && !EXTENDED.has(ch)) gsm = false;
  let units = 0;
  if (gsm) for (const ch of text) units += EXTENDED.has(ch) ? 2 : 1;
  else units = text.length;
  if (units === 0) return 0;
  const single = gsm ? 160 : 70;
  const multi = gsm ? 153 : 67;
  return units <= single ? 1 : Math.ceil(units / multi);
}

export function costOf(channel: string, text: string): { costAmd: number; smsParts?: number } {
  if (channel === 'sms') {
    const parts = Math.max(1, smsParts(text));
    return { costAmd: parts * SMS_PART_PRICE_AMD, smsParts: parts };
  }
  if (channel === 'whatsapp') return { costAmd: WHATSAPP_MESSAGE_PRICE_AMD };
  return { costAmd: 0 };
}

// ─────────── статус доставки ───────────
// Настоящих отчётов о доставке у провайдера бизнеса нет (адаптер business-sms — заглушка, В-08), поэтому статус —
// тот же детерминированный цикл, что у мока (F-05-008: «Не доставлено» должно встречаться, иначе кнопку
// «Напомнить через WhatsApp» нельзя проверить). Уйдёт, когда появятся отчёты провайдера.
const FAILURE_PRONE: NotifyChannel[] = ['push', 'brandedApp', 'sms', 'whatsapp'];
export function statusFor(seed: string, channel?: string): LogStatus {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  const cycle: LogStatus[] = channel && FAILURE_PRONE.includes(channel as NotifyChannel) ? ['delivered', 'sent', 'read', 'notDelivered'] : ['delivered', 'sent', 'read'];
  return cycle[hash % cycle.length]!;
}

// ─────────── время ───────────

const FMT = 'YYYY-MM-DDTHH:mm';
const d = (s: string) => dayjs(s, FMT);

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** Тихие часы (Ув12): попал в окно — перенос на его конец */
export function quietShift(quiet: { enabled: boolean; from: string; to: string }, at: string): string {
  if (!quiet.enabled) return at;
  const t = d(at);
  const m = t.hour() * 60 + t.minute();
  const from = minutesOf(quiet.from);
  const to = minutesOf(quiet.to);
  if (from === to) return at;
  const inside = from > to ? m >= from || m < to : m >= from && m < to;
  if (!inside) return at;
  let end = t.hour(Math.floor(to / 60)).minute(to % 60).second(0);
  if (!end.isAfter(t)) end = end.add(1, 'day');
  return end.format(FMT);
}

function clock(hh: number, mm: number, format: '24h' | '12h'): string {
  if (format !== '12h') return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`;
}

const TODAY: Record<Lang, string> = { ru: 'сегодня', en: 'today', hy: 'այսօր' };
const TOMORROW: Record<Lang, string> = { ru: 'завтра', en: 'tomorrow', hy: 'վաղը' };

function dateVars(startLocal: string, at: string, format: '24h' | '12h', lang: Lang) {
  const start = d(startLocal);
  const diffDays = start.startOf('day').diff(d(at).startOf('day'), 'day');
  const time = clock(start.hour(), start.minute(), format);
  const date = diffDays === 0 ? TODAY[lang] : diffDays === 1 ? TOMORROW[lang] : start.format('DD.MM.YYYY');
  const dateTime = diffDays === 0 || diffDays === 1 ? `${date}, ${time}` : `${date} ${time}`;
  return { date, time, dateTime };
}

// ─────────── шаблоны ───────────

/** Подставить переменные шаблона и убрать «пустые» хвосты («мастер: » без имени, пустые скобки) — общий для журнала и отправки (тип 73) */
export function fillTemplate(text: string, vars: Record<string, string>): string {
  return text
    .replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? '')
    .replace(/[^.։:!?\n]*[:՝]\s*(?=[.։]|$)[.։]?/g, '')
    .replace(/\(\s*,?\s*\)/g, '')
    .replace(/\s+([,.։])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/^\s*[:․]\s*/, '')
    .trim();
}

type VarsByLang = Record<Lang, Record<string, string>>;

function localize(source: RichLocalizedText | undefined, vars: VarsByLang, fallback: LText): LText {
  const base = source ?? fallback;
  const pick = (lang: Lang) => (base as LText)[lang] || fallback[lang] || base.ru;
  return { ru: fillTemplate(pick('ru'), vars.ru), en: fillTemplate(pick('en'), vars.en), hy: fillTemplate(pick('hy'), vars.hy) };
}

const HOST = 'booktime.am';
const SMS_LINK_KEYS = ['link', 'reviewLink', 'bookingLink', 'paymentLink'] as const;

function ownPathOf(link: string): string | null {
  const m = /^(?:https?:\/\/)?booktime\.am(\/.*)$/.exec(link.trim());
  return m ? m[1]! : null;
}

function forChannel(ctx: DeriveContext, channel: NotifyChannel, vars: VarsByLang): VarsByLang {
  if (channel !== 'sms') return vars;
  const one = (v: Record<string, string>) => {
    const out = { ...v };
    for (const key of SMS_LINK_KEYS) {
      const path = out[key] ? ownPathOf(out[key]!) : null;
      if (path && ctx.shorten) out[key] = `${HOST}/s/${ctx.shorten(path)}`;
    }
    if (out.date) out.date = out.date.replace(/^(\d{2}\.\d{2})\.\d{4}$/, '$1');
    if (out.dateTime) out.dateTime = out.dateTime.replace(/^(\d{2}\.\d{2})\.\d{4}/, '$1');
    return out;
  };
  return { ru: one(vars.ru), en: one(vars.en), hy: one(vars.hy) };
}

// ─────────── каналы (F-05-007/008) — порт engine.ts::previewDelivery ───────────

const CHECK_ORDER: NotifyChannel[] = ['email', 'adminApp', 'push', 'brandedApp', 'sms'];
const APP_CHANNELS = new Set<NotifyChannel>(['push', 'brandedApp']);

function pickChannel(type: NotificationTypeOut | undefined, hasApp: boolean): NotifyChannel | undefined {
  if (!type || !type.enabled) return undefined;
  let failed = false;
  for (const channel of CHECK_ORDER) {
    if (!type.availableChannels.includes(channel)) continue;
    const scenario = type.channels.find((c) => c.channel === channel)?.scenario ?? 'off';
    if (scenario === 'off') continue;
    if (scenario === 'fallback') {
      if (failed) return channel;
      continue;
    }
    if (APP_CHANNELS.has(channel) && !hasApp) {
      failed = true;
      continue;
    }
    return channel;
  }
  return undefined;
}

// ─────────── переменные ───────────

function businessVars(ctx: DeriveContext, lang: Lang, locationId?: string): Record<string, string> {
  const loc = ctx.locations.get(locationId ?? ctx.defaultLocationId ?? '') ?? (ctx.defaultLocationId ? ctx.locations.get(ctx.defaultLocationId) : undefined);
  const slug = ctx.business.slug;
  return {
    companyName: ctx.business.name,
    bookingLink: slug ? `${HOST}/b/${slug}/book` : '',
    address: loc ? loc.address[lang] || loc.address.ru : '',
    companyPhone: loc?.phone || ctx.business.phone || '',
    website: ctx.business.website.replace(/^https?:\/\//, ''),
    mapsLink: loc?.mapsLink ?? '',
  };
}

function clientVars(client: DClient | undefined): Record<string, string> {
  const [first, ...rest] = (client?.name ?? '').trim().split(/\s+/);
  return { clientName: first ?? '', clientLastName: rest.join(' '), clientPhone: client?.phone ?? '' };
}

function bookingVarsFor(ctx: DeriveContext, booking: DBooking, client: DClient | undefined, lang: Lang, at: string): Record<string, string> {
  const staff = ctx.staff.find((s) => s.id === booking.staffId);
  const names = booking.serviceIds.map((id) => ctx.services.get(id)).filter((n): n is LText => !!n).map((n) => n[lang] || n.ru);
  const { date, time, dateTime } = dateVars(booking.start, at, ctx.settings.dateFormat, lang);
  const slug = ctx.business.slug;
  const minutesLeft = Math.max(0, d(booking.start).diff(d(at), 'minute'));
  const unitH: Record<Lang, string> = { ru: 'ч', en: 'h', hy: 'ժ' };
  const unitM: Record<Lang, string> = { ru: 'мин', en: 'min', hy: 'ր' };
  const base = slug ? `${HOST}/b/${slug}/booking/${booking.id}` : '';
  return {
    ...businessVars(ctx, lang, booking.locationId),
    ...clientVars(client),
    date,
    time,
    dateTime,
    timeLeft: minutesLeft >= 60 ? `${Math.round(minutesLeft / 60)} ${unitH[lang]}` : `${minutesLeft} ${unitM[lang]}`,
    staff: staff?.name ?? '',
    service: names[0] ?? '',
    visitServices: names.join(', '),
    link: base,
    reviewLink: base ? `${base}?review=1` : '',
    paymentLink: base ? `${base}?pay=1` : '',
    amount: String(booking.total ?? ''),
    discount: '',
    days: '',
    code: '',
  };
}

function bookingVars(ctx: DeriveContext, booking: DBooking, client: DClient | undefined, at: string): VarsByLang {
  return { ru: bookingVarsFor(ctx, booking, client, 'ru', at), en: bookingVarsFor(ctx, booking, client, 'en', at), hy: bookingVarsFor(ctx, booking, client, 'hy', at) };
}

function appendVisitorNote(text: LText, booking: DBooking | undefined, client: DClient | undefined, channel: NotifyChannel): LText {
  if (!booking?.visitorName || channel === 'sms') return text;
  if (client && booking.visitorName.trim().toLowerCase() === client.name.trim().toLowerCase()) return text;
  const v = booking.visitorName;
  return { ru: `${text.ru}\nПосетитель: ${v}`, en: text.en ? `${text.en}\nVisitor: ${v}` : undefined, hy: text.hy ? `${text.hy}\nԱյցելու՝ ${v}` : undefined };
}

function sendLanguage(ctx: DeriveContext): Lang {
  return LANGS.includes(ctx.settings.language) ? ctx.settings.language : 'ru';
}

function pushEntry(
  out: LogRow[],
  ctx: DeriveContext,
  o: { key: string; createdAt: string; type: NotificationTypeOut | undefined; channel: NotifyChannel; client: DClient | undefined; booking?: DBooking; text: LText; fallbackLabel: LText; scheduled?: boolean; deferredFrom?: string },
): void {
  const scheduled = o.scheduled ?? d(o.createdAt).isAfter(d(ctx.now));
  const text = appendVisitorNote(o.text, o.booking, o.client, o.channel);
  const lang = sendLanguage(ctx);
  out.push({
    key: `live:${o.key}`,
    createdAt: o.createdAt,
    typeCode: o.type?.code,
    typeLabel: o.type?.name ?? o.fallbackLabel,
    channel: o.channel,
    status: scheduled ? 'sending' : statusFor(o.key, o.channel),
    contact: o.channel === 'email' ? o.client?.email || o.client?.phone || '—' : (o.client?.phone ?? '—'),
    text,
    clientId: o.client?.id,
    staffId: o.booking?.staffId,
    bookingId: o.booking?.id,
    sentLanguage: lang,
    ...costOf(o.channel, text[lang] || text.ru),
    scheduled: scheduled || undefined,
    deferredFrom: o.deferredFrom && o.deferredFrom !== o.createdAt ? o.deferredFrom : undefined,
  });
}

const typeOf = (ctx: DeriveContext, code: number) => ctx.types.find((t) => t.code === code);
const VIA_WIDGET = new Set(['app', 'link', 'widget']);
const ACTIVE = new Set(['awaiting_confirmation', 'awaiting_prepayment', 'scheduled', 'client_confirmed']);

// ─────────── события записи (F-05-024…032) ───────────

function eventDriven(ctx: DeriveContext, events: DEvent[]): LogRow[] {
  const out: LogRow[] = [];
  const t2 = typeOf(ctx, 2);
  const t8 = typeOf(ctx, 8);
  const t9 = typeOf(ctx, 9);
  const t4 = typeOf(ctx, 4);
  const t74 = typeOf(ctx, 74);
  const t75 = typeOf(ctx, 75);
  for (const event of events) {
    const booking = ctx.bookings.get(event.bookingId);
    if (!booking) continue;
    const client = booking.clientId ? ctx.clients.get(booking.clientId) : undefined;
    if (!client?.phone) continue;
    const hasApp = !!client.appUserId;
    const sendAt = quietShift(ctx.settings.quietHours, event.at);
    const vars = bookingVars(ctx, booking, client, sendAt);
    const started = booking.start <= sendAt;
    const base = { key: `ev_${event.id}`, createdAt: sendAt, deferredFrom: event.at, client, booking };
    const emit = (type: NotificationTypeOut | undefined, channel: NotifyChannel, fallback: LText, label: LText) =>
      pushEntry(out, ctx, { ...base, type, channel, text: localize(type?.templates[channel], forChannel(ctx, channel, vars), fallback), fallbackLabel: label });

    if (event.kind === 'created') {
      if (started || booking.override?.sendOnSave === false) continue;
      const type = VIA_WIDGET.has(booking.source) ? t2 : t8;
      const channel = pickChannel(type, hasApp);
      if (!channel) continue;
      emit(type, channel, { ru: `Вы записаны: ${vars.ru.service} ${vars.ru.date} в ${vars.ru.time}.`, en: `You are booked: ${vars.en.service} on ${vars.en.date} at ${vars.en.time}.` }, { ru: 'Детали записи', en: 'Booking details' });
      continue;
    }
    if (event.kind === 'status') {
      if (event.toStatus === 'client_confirmed' || (event.fromStatus === 'awaiting_confirmation' && event.toStatus === 'scheduled')) {
        if (started) continue;
        // F-05-026 п.2: подтверждение уходит и при выключенном типе
        const channel = pickChannel(t9, hasApp) ?? (hasApp ? 'push' : undefined);
        if (!channel) continue;
        emit(t9, channel, { ru: `Ваша запись на ${vars.ru.date} в ${vars.ru.time} подтверждена.`, en: `Your booking on ${vars.en.date} at ${vars.en.time} is confirmed.` }, { ru: 'Подтверждение записи', en: 'Booking confirmed' });
        continue;
      }
      if (event.toStatus === 'cancelled_by_client' || event.toStatus === 'cancelled_by_master') {
        const channel = pickChannel(t4, hasApp);
        if (!channel) continue;
        emit(t4, channel, { ru: `Ваша запись на ${vars.ru.date} в ${vars.ru.time} отменена.`, en: `Your booking on ${vars.en.date} at ${vars.en.time} was cancelled.` }, { ru: 'Отмена записи', en: 'Booking cancelled' });
        continue;
      }
      if (event.toStatus === 'no_show') {
        if (event.at > booking.start) continue;
        const channel = pickChannel(t75, hasApp);
        if (!channel) continue;
        emit(t75, channel, { ru: `Вы не пришли на запись ${vars.ru.date} в ${vars.ru.time}.`, en: `You missed your booking on ${vars.en.date} at ${vars.en.time}.` }, { ru: 'Не пришёл', en: 'No-show' });
      }
      continue;
    }
    if (event.kind === 'moved') {
      if (!t74?.enabled || started) continue;
      const cond = t74.conditions;
      const threshold = cond?.rescheduleThresholdMinutes ?? -1;
      const diff = event.prevStart ? Math.abs(d(booking.start).diff(d(event.prevStart), 'minute')) : 0;
      if (threshold >= 0 && diff < threshold) continue;
      const src = cond?.rescheduleSource ?? 'all';
      const byClient = event.byRef === 'client';
      if ((src === 'client' && !byClient) || (src === 'staff' && byClient)) continue;
      const channel = pickChannel(t74, hasApp);
      if (!channel) continue;
      emit(t74, channel, { ru: `Запись изменена: теперь ${vars.ru.date} в ${vars.ru.time}.`, en: `Booking changed: now ${vars.en.date} at ${vars.en.time}.` }, { ru: 'Изменение записи', en: 'Booking changed' });
      continue;
    }
    if (event.kind === 'deleted') {
      const channel = pickChannel(t4, hasApp);
      if (!channel) continue;
      emit(t4, channel, { ru: `Ваша запись на ${vars.ru.date} в ${vars.ru.time} отменена.`, en: `Your booking on ${vars.en.date} at ${vars.en.time} was cancelled.` }, { ru: 'Отмена записи', en: 'Booking cancelled' });
    }
  }
  return out;
}

// ─────────── напоминание (тип 1) и запрос подтверждения (тип 73) ───────────

const SCHEDULED_HORIZON_DAYS = 7;

function timeBased(ctx: DeriveContext, serviceHours: Record<string, number>): LogRow[] {
  const out: LogRow[] = [];
  const t1 = typeOf(ctx, 1);
  const t73 = typeOf(ctx, 73);
  const now = d(ctx.now);
  for (const booking of ctx.bookings.values()) {
    if (booking.deleted || !ACTIVE.has(booking.status)) continue;
    const client = booking.clientId ? ctx.clients.get(booking.clientId) : undefined;
    if (!client?.phone) continue;
    const hasApp = !!client.appUserId;
    const ov = booking.override;
    const firstService = booking.serviceIds[0];
    const svcHours = firstService !== undefined ? (serviceHours[firstService] ?? t1?.conditions?.serviceTimingHours?.[firstService]) : undefined;
    const start = d(booking.start);
    if (t1?.enabled) {
      const channel = pickChannel(t1, hasApp);
      if (channel) {
        const typeHours = svcHours ?? t1.conditions?.timingHours ?? 1;
        const hours =
          channel === 'email'
            ? (ov?.emailTimingHours ?? svcHours ?? t1.conditions?.emailTimingHours ?? typeHours)
            : channel === 'push' || channel === 'brandedApp'
              ? (ov?.pushTimingHours ?? typeHours)
              : (ov?.smsTimingHours ?? typeHours);
        const off = (channel === 'sms' && ov?.smsEnabled === false) || (channel === 'email' && ov?.emailEnabled === false) || ((channel === 'push' || channel === 'brandedApp') && ov?.pushEnabled === false);
        const planned = start.subtract(hours, 'hour');
        const sendAt = d(quietShift(ctx.settings.quietHours, planned.format(FMT)));
        const scheduled = sendAt.isAfter(now);
        if (
          !off &&
          sendAt.isBefore(start) &&
          !d(booking.createdAt).isAfter(planned) &&
          (!scheduled || sendAt.isBefore(now.add(SCHEDULED_HORIZON_DAYS, 'day'))) &&
          sendAt.isAfter(start.subtract(48, 'hour'))
        ) {
          const vars = bookingVars(ctx, booking, client, sendAt.format(FMT));
          pushEntry(out, ctx, {
            key: `rm_${booking.id}`,
            createdAt: sendAt.format(FMT),
            deferredFrom: planned.format(FMT),
            type: t1,
            channel,
            client,
            booking,
            scheduled,
            text: localize(t1.templates[channel], forChannel(ctx, channel, vars), { ru: `Напоминаем: ${vars.ru.date} в ${vars.ru.time} у вас ${vars.ru.service}.`, en: `Reminder: ${vars.en.date} at ${vars.en.time} you have ${vars.en.service}.` }),
            fallbackLabel: { ru: 'Напоминание', en: 'Reminder' },
          });
        }
      }
    }
    // Тип 73 (F-05-028, 03.10.2026): «Ожидание клиента» Altegio = наш «Записан» (scheduled) — как отправка
    // (jobs/notify-confirm-requests.ts) и мок; «Ждёт подтверждения» ждёт мастера, клиенту подтверждать нечего
    if (t73?.enabled && booking.status === 'scheduled') {
      const channel = pickChannel(t73, hasApp);
      if (!channel) continue;
      if ((channel === 'push' || channel === 'brandedApp') && ov?.pushEnabled === false) continue;
      const c = t73.conditions;
      const planned =
        c?.useSpecificTime && c.specificTime
          ? start.subtract(1, 'day').hour(Number(c.specificTime.slice(0, 2))).minute(Number(c.specificTime.slice(3, 5)))
          : start.subtract(c?.timingHours ?? 24, 'hour');
      const sendAt = d(quietShift(ctx.settings.quietHours, planned.format(FMT)));
      const scheduled = sendAt.isAfter(now);
      if (
        !d(booking.createdAt).isAfter(planned) &&
        sendAt.isBefore(start) &&
        (!scheduled || sendAt.isBefore(now.add(SCHEDULED_HORIZON_DAYS, 'day'))) &&
        sendAt.isAfter(start.subtract(72, 'hour'))
      ) {
        const vars = bookingVars(ctx, booking, client, sendAt.format(FMT));
        pushEntry(out, ctx, {
          key: `cf_${booking.id}`,
          createdAt: sendAt.format(FMT),
          deferredFrom: planned.format(FMT),
          type: t73,
          channel,
          client,
          booking,
          scheduled,
          text: localize(t73.templates[channel], forChannel(ctx, channel, vars), { ru: `Подтвердите визит ${vars.ru.date} в ${vars.ru.time}.`, en: `Please confirm your visit on ${vars.en.date} at ${vars.en.time}.` }),
          fallbackLabel: { ru: 'Запрос подтверждения', en: 'Confirmation requested' },
        });
      }
    }
  }
  return out;
}

// ─────────── приглашение недошедшим (тип 72) ───────────

function invites(ctx: DeriveContext, events: DEvent[]): LogRow[] {
  const out: LogRow[] = [];
  const t72 = typeOf(ctx, 72);
  if (!t72?.enabled) return out;
  const filter = t72.conditions?.inviteStatusFilter ?? 'all';
  const afterHours = t72.conditions?.inviteAfterHours ?? 0;
  for (const event of events) {
    if (event.kind !== 'status' || !['cancelled_by_client', 'cancelled_by_master', 'no_show'].includes(event.toStatus ?? '')) continue;
    const noShow = event.toStatus === 'no_show';
    if ((filter === 'cancelled' && noShow) || (filter === 'noShow' && !noShow)) continue;
    const booking = ctx.bookings.get(event.bookingId);
    if (!booking?.clientId) continue;
    const client = ctx.clients.get(booking.clientId);
    if (!client?.phone) continue;
    const planned = d(event.at).add(afterHours, 'hour');
    const sendAt = d(quietShift(ctx.settings.quietHours, planned.format(FMT)));
    if (sendAt.isAfter(d(ctx.now))) continue;
    if (ctx.clientsWithFutureBooking.has(client.id)) continue;
    const channel = pickChannel(t72, !!client.appUserId);
    if (!channel) continue;
    pushEntry(out, ctx, {
      key: `inv_${event.id}`,
      createdAt: sendAt.format(FMT),
      deferredFrom: planned.format(FMT),
      type: t72,
      channel,
      client,
      booking,
      text: localize(t72.templates[channel], forChannel(ctx, channel, bookingVars(ctx, booking, client, sendAt.format(FMT))), { ru: 'Заметили, что вы не смогли прийти. Запишитесь снова.', en: 'We noticed you could not make it. Book again.' }),
      fallbackLabel: { ru: 'Приглашение', en: 'Invite' },
    });
  }
  return out;
}

// ─────────── повторный визит (тип 55): несколько «созревших» визитов в один день — одно сообщение ───────────

function winback(ctx: DeriveContext, arrived: DBooking[], windowFrom: string): LogRow[] {
  const out: LogRow[] = [];
  const t55 = typeOf(ctx, 55);
  if (!t55?.enabled) return out;
  const days = t55.conditions?.winbackAfterDays ?? 14;
  const now = d(ctx.now);
  const groups = new Map<string, { booking: DBooking; client: DClient; dueAt: dayjs.Dayjs; names: LText[] }[]>();
  for (const booking of arrived) {
    if (!booking.clientId) continue;
    const client = ctx.clients.get(booking.clientId);
    if (!client?.phone) continue;
    const dueAt = d(booking.start).add(days, 'day');
    if (dueAt.isAfter(now) || dueAt.isBefore(d(windowFrom))) continue;
    if (ctx.rebookedAfter(client.id, booking.id, booking.serviceIds, booking.start)) continue;
    const names = booking.serviceIds.map((id) => ctx.services.get(id)).filter((n): n is LText => !!n);
    const key = `${client.id}_${dueAt.format('YYYY-MM-DD')}`;
    const list = groups.get(key) ?? [];
    list.push({ booking, client, dueAt, names });
    groups.set(key, list);
  }
  for (const group of groups.values()) {
    const first = group[0]!;
    const client = first.client;
    const dueAt = group.reduce((min, g) => (g.dueAt.isBefore(min) ? g.dueAt : min), first.dueAt);
    const namesIn = (lang: Lang) => Array.from(new Set(group.flatMap((g) => g.names.map((n) => n[lang] || n.ru)))).join(', ');
    const channel = pickChannel(t55, !!client.appUserId);
    if (!channel) continue;
    const base = bookingVars(ctx, first.booking, client, dueAt.format(FMT));
    const vars: VarsByLang = { ru: { ...base.ru, service: namesIn('ru') || base.ru.service! }, en: { ...base.en, service: namesIn('en') || base.en.service! }, hy: { ...base.hy, service: namesIn('hy') || base.hy.service! } };
    const services = namesIn('ru');
    const text = localize(t55.templates[channel], forChannel(ctx, channel, vars), {
      ru: `Давно вас не было! Ждём снова${services ? ` на ${services}` : ''}.`,
      en: `It has been a while! Come back soon${services ? ` for ${services}` : ''}.`,
    });
    const lang = sendLanguage(ctx);
    const seed = `wb_${client.id}_${dueAt.format('YYYY-MM-DD')}`;
    out.push({
      key: `live:${seed}`,
      createdAt: quietShift(ctx.settings.quietHours, dueAt.format(FMT)),
      typeCode: t55.code,
      typeLabel: t55.name,
      channel,
      status: statusFor(seed, channel),
      contact: channel === 'email' ? client.email || client.phone : client.phone,
      text,
      clientId: client.id,
      bookingId: first.booking.id,
      sentLanguage: lang,
      ...costOf(channel, text[lang] || text.ru),
    });
  }
  return out;
}

// ─────────── день рождения (тип 3) ───────────

function birthdays(ctx: DeriveContext, clients: DClient[]): LogRow[] {
  const out: LogRow[] = [];
  const t3 = typeOf(ctx, 3);
  if (!t3?.enabled) return out;
  const c = t3.conditions;
  const daysBefore = c?.birthdayMode === 'daysBefore' ? (c.birthdayDaysBefore ?? 3) : 0;
  const [hh, mm] = (c?.birthdayTimeOfDay ?? '10:00').split(':').map(Number);
  const now = d(ctx.now);
  for (const client of clients) {
    if (!client.birthday || !/^\d{4}-\d{2}-\d{2}$/.test(client.birthday)) continue;
    const bday = dayjs(client.birthday, 'YYYY-MM-DD');
    const occurrence = bday.year(now.year()).subtract(daysBefore, 'day').hour(hh || 0).minute(mm || 0);
    const sendAt = occurrence.isAfter(now) ? occurrence.subtract(1, 'year') : occurrence;
    if (now.diff(sendAt, 'day') > 3) continue;
    const channel = pickChannel(t3, !!client.appUserId);
    if (!channel) continue;
    const varsOf = (lang: Lang) => ({ ...businessVars(ctx, lang), ...clientVars(client) });
    const text = localize(t3.templates[channel], forChannel(ctx, channel, { ru: varsOf('ru'), en: varsOf('en'), hy: varsOf('hy') }), { ru: `С днём рождения, ${client.name}!`, en: `Happy birthday, ${client.name}!` });
    const lang = sendLanguage(ctx);
    out.push({
      key: `live:bd_${client.id}_${sendAt.year()}`,
      createdAt: quietShift(ctx.settings.quietHours, sendAt.format(FMT)),
      typeCode: t3.code,
      typeLabel: t3.name,
      channel,
      status: statusFor(`bd_${client.id}`, channel),
      contact: channel === 'email' ? client.email || client.phone : client.phone,
      text,
      clientId: client.id,
      sentLanguage: lang,
      ...costOf(channel, text[lang] || text.ru),
    });
  }
  return out;
}

// ─────────── администратору и мастеру (типы 10/56/41/12, 11/57/42/13/76) ───────────

function adminStaff(ctx: DeriveContext, events: DEvent[]): LogRow[] {
  const out: LogRow[] = [];
  const lang = sendLanguage(ctx);
  for (const event of events) {
    const booking = ctx.bookings.get(event.bookingId);
    if (!booking) continue;
    const client = booking.clientId ? ctx.clients.get(booking.clientId) : undefined;
    const baseVars = bookingVars(ctx, booking, client, event.at);
    const viaWidget = VIA_WIDGET.has(booking.source);
    const byClient = event.byRef === 'client';
    const masterName = ctx.staff.find((s) => s.id === booking.staffId)?.name ?? '';
    const display = booking.visitorName ? `${client?.name ?? ''} → ${booking.visitorName}` : (client?.name ?? '');
    const contactLabel = client ? `${display} (${client.phone})` : masterName;
    const withClient = (v: Record<string, string>) => ({ ...v, clientName: display || '—' });
    const vars: VarsByLang = { ru: withClient(baseVars.ru), en: withClient(baseVars.en), hy: withClient(baseVars.hy) };
    const emit = (who: 'adm' | 'stf', code: number, fallback: LText, target: DStaff | undefined) => {
      if (!target) return;
      const type = typeOf(ctx, code);
      if (type && !type.enabled) return;
      const seed = `${who}_${code}_${event.id}`;
      out.push({
        key: `live:${seed}`,
        createdAt: event.at,
        typeCode: code,
        typeLabel: type?.name ?? fallback,
        channel: 'adminApp',
        status: statusFor(seed),
        contact: target.phone,
        text: localize(type?.templates.adminApp, vars, fallback),
        staffId: target.id,
        bookingId: booking.id,
        sentLanguage: lang,
        costAmd: 0,
      });
    };
    const admin = (exclude?: string) => ctx.staff.find((s) => s.locationIds.includes(booking.locationId) && (s.role === 'owner' || s.role === 'admin') && s.id !== exclude);
    const master = ctx.staff.find((s) => s.id === booking.staffId);
    const nb = { ru: `Новая запись: ${contactLabel}, ${vars.ru.service}, ${vars.ru.date} ${vars.ru.time}.`, en: `New booking: ${contactLabel}, ${vars.en.service}, ${vars.en.date} ${vars.en.time}.` };
    if (event.kind === 'created') {
      if (viaWidget) {
        emit('adm', 10, nb, admin());
        emit('stf', 11, nb, master);
      } else if (!byClient) {
        emit('adm', 56, nb, admin(event.byRef));
        if (booking.staffId !== event.byRef) emit('stf', 57, nb, master);
      }
      continue;
    }
    if (event.kind === 'moved') {
      const mv = { ru: `Запись перенесена: ${contactLabel}, ${vars.ru.date} ${vars.ru.time}.`, en: `Booking rescheduled: ${contactLabel}, ${vars.en.date} ${vars.en.time}.` };
      if (viaWidget) emit('adm', 41, mv, admin());
      emit('stf', 42, mv, master);
      continue;
    }
    if (event.kind === 'deleted' || (event.kind === 'status' && (event.toStatus === 'cancelled_by_client' || event.toStatus === 'cancelled_by_master'))) {
      if (byClient) emit('adm', 12, { ru: `Запись удалена клиентом: ${contactLabel}, ${vars.ru.date} ${vars.ru.time}.`, en: `Booking cancelled by client: ${contactLabel}, ${vars.en.date} ${vars.en.time}.` }, admin());
      emit('stf', 13, { ru: `Запись удалена: ${contactLabel}, ${vars.ru.date} ${vars.ru.time}.`, en: `Booking removed: ${contactLabel}, ${vars.en.date} ${vars.en.time}.` }, master);
      continue;
    }
    if (event.kind === 'status' && event.toStatus === 'no_show') {
      emit('stf', 76, { ru: `Клиент не пришёл — слот ${vars.ru.date} ${vars.ru.time} свободен.`, en: `Client no-show — the ${vars.en.date} ${vars.en.time} slot is free.` }, master);
    }
  }
  return out;
}

export interface DeriveInput {
  events: DEvent[];
  arrived: DBooking[];
  birthdayClients: DClient[];
  serviceReminderHours: Record<string, number>;
  /** нижняя граница окна для повторного визита (местное) */
  windowFrom: string;
}

/** Все выведенные строки журнала за окно — и ушедшие, и «Запланировано» (scheduled) */
export function deriveLogRows(ctx: DeriveContext, input: DeriveInput): LogRow[] {
  const rows = [
    ...eventDriven(ctx, input.events),
    ...timeBased(ctx, input.serviceReminderHours),
    ...invites(ctx, input.events),
    ...winback(ctx, input.arrived, input.windowFrom),
    ...birthdays(ctx, input.birthdayClients),
    ...adminStaff(ctx, input.events),
  ];
  // F-05-090: настройки клиента ко всем клиентским строкам разом
  return rows.filter((r) => {
    if (!r.clientId || r.typeCode === undefined) return true;
    const prefs = ctx.clientPrefs.get(r.clientId);
    if (!prefs) return true;
    if (prefs.disabledTypeCodes.includes(r.typeCode)) return false;
    if ((r.channel === 'push' || r.channel === 'brandedApp') && !prefs.channels.push) return false;
    if (r.channel === 'sms' && !prefs.channels.sms) return false;
    if (r.channel === 'email' && !prefs.channels.email) return false;
    return true;
  });
}
