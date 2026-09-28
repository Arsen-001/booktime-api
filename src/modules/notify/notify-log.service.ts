import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { BUSINESS_MESSENGER, MAIL_SENDER } from '../../adapters/adapters.js';
import type { MailSender } from '../../adapters/mail/mail.js';
import type { BusinessMessenger } from '../../adapters/business-sms/business-sms.js';
import { ApiError } from '../../common/errors/api-error.js';
import { newId } from '../../common/ids/ids.js';
import { PrismaService } from '../../common/prisma.service.js';
import { localToUtc, nowLocal, utcToLocal } from '../../common/time/time.js';
import { ShortLinksService } from '../shortlinks/shortlinks.service.js';
import { NotifyMoreService } from './notify-more.service.js';
import { NotifyRichTypesService } from './notify-rich-types.service.js';
import { enqueueClientNotification } from './outbox.js';
import { costOf, deriveLogRows, statusFor } from './notify-log-derive.js';
import type { DBooking, DClient, DClientPrefs, DeriveContext, DEvent, DStaff, LogRow, LText } from './notify-log-derive.js';

const J = (v: unknown) => v as Prisma.InputJsonValue;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ACTIVE = ['awaiting_confirmation', 'awaiting_prepayment', 'scheduled', 'client_confirmed'];
/** Первый проход журнала бизнеса — на столько дней назад (экран по умолчанию показывает прошлый месяц) */
const FIRST_SYNC_DAYS = 45;
/** Чаще не пересчитываем: экраны журнала/окна записи/карточки клиента зовут журнал одновременно */
const SYNC_THROTTLE_MS = 30_000;
/** Отступ окна событий: тихие часы переносят до суток, приглашение уходит через N часов после отмены */
const EVENT_MARGIN_MS = 4 * DAY;

/** Строка журнала для экрана — LogMessage фронта (src/domain/notify.ts) */
export interface LogMessageOut {
  id: string;
  businessId: string;
  createdAt: string;
  typeCode?: number;
  typeLabel: LText;
  channel: string;
  status: string;
  contact: string;
  text: LText;
  clientId?: string;
  staffId?: string;
  bookingId?: string;
  sentLanguage?: string;
  costAmd?: number;
  smsParts?: number;
  scheduled?: boolean;
  deferredFrom?: string;
}

export interface LogQuery {
  limit: number;
  cursor?: string;
  from?: Date;
  to?: Date;
  channel?: string;
  status?: string;
  typeCode?: number;
  clientId?: string;
  bookingId?: string;
}

/** Служебная строка журнала (рассылка, тест, разовое сообщение) — пишут этот сервис и NotifyMailingsService */
export interface ServiceLogRow {
  dedupeKey?: string;
  sentAt: Date;
  typeCode?: number;
  typeLabel: LText;
  channel: string;
  status: string;
  contact: string;
  text: LText;
  clientId?: string;
  staffId?: string;
  bookingId?: string;
  sentLanguage?: string;
  costAmd: number;
  smsParts?: number;
  source: 'mailing' | 'test' | 'oneOff' | 'service';
}

type EntryRow = Awaited<ReturnType<PrismaService['notifyLogEntry']['findMany']>>[number];

function toOut(r: EntryRow): LogMessageOut {
  return {
    id: r.id,
    businessId: r.businessId,
    createdAt: utcToLocal(r.sentAt),
    typeCode: r.typeCode ?? undefined,
    typeLabel: r.typeLabel as unknown as LText,
    channel: r.channel,
    status: r.status,
    contact: r.contact,
    text: r.text as unknown as LText,
    clientId: r.clientId ?? undefined,
    staffId: r.staffId ?? undefined,
    bookingId: r.bookingId ?? undefined,
    sentLanguage: r.sentLanguage ?? undefined,
    costAmd: r.costAmd,
    smsParts: r.smsParts ?? undefined,
    deferredFrom: r.deferredFrom ? utcToLocal(r.deferredFrom) : undefined,
  };
}

const ONE_OFF_TYPE_CODE = 15;

/**
 * P1: «есть приложение» у клиента CRM — вычисляется на лету: пользователь приложения с тем же номером
 * (users.phone = clients.phone, есть профиль клиента), а clients.app_user_id — только «записался через приложение».
 */
export async function resolveAppUsers<T extends { phone: string; appUserId: string | null }>(prisma: PrismaService, clients: T[]): Promise<T[]> {
  const phones = [...new Set(clients.filter((c) => !c.appUserId && c.phone).map((c) => c.phone))];
  if (!phones.length) return clients;
  const users = await prisma.user.findMany({ where: { phone: { in: phones }, appProfile: { isNot: null } }, select: { id: true, phone: true } });
  const byPhone = new Map(users.map((u) => [u.phone!, u.id]));
  return clients.map((c) => (c.appUserId || !byPhone.has(c.phone) ? c : { ...c, appUserId: byPhone.get(c.phone)! }));
}

/**
 * Журнал отправок (F-05-107/108/130, Ув11/Ув12/Ув16) — этап 21, лейн notify-log+mailings. Строки выводятся из
 * booking_events/bookings/clients по каталогу типов «под экран» (NotifyRichTypesService, 29+2) — порт liveLog.ts
 * фронта (`notify-log-derive.ts`) — и материализуются в notify_log_entries окном от `notify_log_sync.synced_until`,
 * с ключом дубля: чтение журнала — одна выборка страницы по индексу (business_id, sent_at), а не пересчёт всей
 * истории. «Запланировано» (напоминания/подтверждения на неделю вперёд, отложенное тихими часами) не хранится —
 * выводится на лету из будущих записей, это будущее и оно меняется с каждой правкой записи.
 */
@Injectable()
export class NotifyLogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly richTypes: NotifyRichTypesService,
    private readonly more: NotifyMoreService,
    private readonly shortLinks: ShortLinksService,
    @Inject(BUSINESS_MESSENGER) private readonly messenger: BusinessMessenger,
    @Inject(MAIL_SENDER) private readonly mail: MailSender,
  ) {}

  // ─────────── чтение ───────────

  async list(businessId: string, q: LogQuery): Promise<{ items: LogMessageOut[]; nextCursor: string | null }> {
    await this.sync(businessId);
    const where: Prisma.NotifyLogEntryWhereInput = { businessId };
    if (q.channel) where.channel = q.channel;
    if (q.status) where.status = q.status;
    if (q.typeCode !== undefined) where.typeCode = q.typeCode;
    if (q.clientId) where.clientId = q.clientId;
    if (q.bookingId) where.bookingId = q.bookingId;
    const sentAt: Prisma.DateTimeFilter = {};
    if (q.from) sentAt.gte = q.from;
    if (q.to) sentAt.lt = q.to;
    if (q.from || q.to) where.sentAt = sentAt;
    if (q.cursor) {
      const [iso, id] = q.cursor.split('_').length > 1 ? [q.cursor.slice(0, q.cursor.indexOf('_')), q.cursor.slice(q.cursor.indexOf('_') + 1)] : [q.cursor, ''];
      const at = new Date(iso ?? '');
      if (Number.isNaN(at.getTime())) throw new ApiError('invalid_field', 'bad cursor');
      where.AND = [{ OR: [{ sentAt: { lt: at } }, { sentAt: at, id: { lt: id } }] }];
    }
    const rows = await this.prisma.notifyLogEntry.findMany({ where, orderBy: [{ sentAt: 'desc' }, { id: 'desc' }], take: q.limit + 1 });
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return { items: page.map(toOut), nextCursor: rows.length > q.limit && last ? `${last.sentAt.toISOString()}_${last.id}` : null };
  }

  /** Ув11 «Запланировано»: что уйдёт в ближайшую неделю — раньше первым (рассылки по расписанию добавляет контроллер) */
  async listScheduled(businessId: string): Promise<LogMessageOut[]> {
    const now = new Date();
    const derived = await this.derive(businessId, {
      eventsFrom: new Date(now.getTime() - 2 * DAY),
      eventsTo: now,
      bookingsFrom: now,
      bookingsTo: new Date(now.getTime() + 10 * DAY),
      winback: false,
    });
    const rows = await this.materializeLinks(businessId, derived.rows.filter((r) => r.scheduled), derived.paths);
    return rows.map((r) => this.rowOut(businessId, r, true)).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  // ─────────── синхронизация окна ───────────

  async sync(businessId: string, force = false): Promise<number> {
    const now = new Date();
    const state = await this.prisma.notifyLogSync.findUnique({ where: { businessId } });
    if (!force && state && now.getTime() - state.syncedUntil.getTime() < SYNC_THROTTLE_MS) return 0;
    const from = state?.syncedUntil ?? new Date(now.getTime() - FIRST_SYNC_DAYS * DAY);
    const derived = await this.derive(businessId, {
      eventsFrom: new Date(from.getTime() - EVENT_MARGIN_MS),
      eventsTo: now,
      bookingsFrom: new Date(from.getTime() - 2 * HOUR),
      bookingsTo: new Date(now.getTime() + 49 * HOUR),
      winback: true,
      winbackFrom: new Date(from.getTime() - DAY),
    });
    const nowL = utcToLocal(now);
    const due = derived.rows.filter((r) => !r.scheduled && r.createdAt <= nowL);
    let created = 0;
    if (due.length) {
      // ключи, что уже есть, не трогаем: короткие ссылки заводим только новым строкам
      const known = new Set(
        (await this.prisma.notifyLogEntry.findMany({ where: { dedupeKey: { in: due.map((r) => r.key) } }, select: { dedupeKey: true } })).map((r) => r.dedupeKey),
      );
      const fresh = await this.materializeLinks(businessId, due.filter((r) => !known.has(r.key)), derived.paths);
      if (fresh.length) {
        const res = await this.prisma.notifyLogEntry.createMany({
          skipDuplicates: true,
          data: fresh.map((r) => ({
            id: newId('notifyLogEntry'),
            businessId,
            dedupeKey: r.key,
            sentAt: localToUtc(r.createdAt),
            typeCode: r.typeCode ?? null,
            typeLabel: J(r.typeLabel),
            channel: r.channel,
            status: r.status,
            contact: r.contact.slice(0, 160),
            text: J(r.text),
            clientId: r.clientId ?? null,
            staffId: r.staffId ?? null,
            bookingId: r.bookingId ?? null,
            sentLanguage: r.sentLanguage,
            costAmd: r.costAmd,
            smsParts: r.smsParts ?? null,
            deferredFrom: r.deferredFrom ? localToUtc(r.deferredFrom) : null,
            source: 'live',
          })),
        });
        created = res.count;
      }
    }
    await this.prisma.notifyLogSync.upsert({ where: { businessId }, create: { businessId, syncedUntil: now }, update: { syncedUntil: now } });
    return created;
  }

  /** Служебная строка (рассылка/тест/разовое сообщение) — сразу в журнал */
  async write(businessId: string, row: ServiceLogRow): Promise<void> {
    await this.prisma.notifyLogEntry.createMany({
      skipDuplicates: true,
      data: [
        {
          id: newId('notifyLogEntry'),
          businessId,
          dedupeKey: row.dedupeKey ?? `${row.source}:${newId('notifyLogEntry')}`,
          sentAt: row.sentAt,
          typeCode: row.typeCode ?? null,
          typeLabel: J(row.typeLabel),
          channel: row.channel,
          status: row.status,
          contact: row.contact.slice(0, 160),
          text: J(row.text),
          clientId: row.clientId ?? null,
          staffId: row.staffId ?? null,
          bookingId: row.bookingId ?? null,
          sentLanguage: row.sentLanguage ?? null,
          costAmd: row.costAmd,
          smsParts: row.smsParts ?? null,
          source: row.source,
        },
      ],
    });
  }

  // ─────────── разовое сообщение (F-05-084/109) и ссылка на оплату (F-05-089) ───────────

  async sendOneOff(
    businessId: string,
    input: { clientId: string; text: string; channels: string[]; source: 'clientCard' | 'bookingWindow'; staffId?: string; bookingId?: string },
  ): Promise<{ sentChannels: string[] }> {
    const text = input.text.trim();
    if (!text) throw new ApiError('empty_text', 'Text is empty');
    const found = await this.prisma.client.findFirst({ where: { id: input.clientId, businessId, deletedAt: null } });
    if (!found) throw new ApiError('not_found', 'client not found');
    const client = (await resolveAppUsers(this.prisma, [found]))[0] ?? found;
    const pref = await this.prisma.clientNotifyPref.findUnique({ where: { clientId: client.id } });
    const ch = { push: true, sms: true, email: true, ...((pref?.channels as Partial<Record<'push' | 'sms' | 'email', boolean>> | null) ?? {}) };
    // F-05-084 п.1: только разрешённые клиенту каналы (F-05-090)
    const allowed = input.channels.filter((c) => {
      if (c === 'push' || c === 'brandedApp') return ch.push;
      if (c === 'sms') return ch.sms;
      if (c === 'email') return ch.email;
      return true;
    });
    if (allowed.length === 0) throw new ApiError('no_allowed_channel', 'no allowed channel');
    const sms = await this.prisma.businessSetting.findUnique({ where: { businessId_area: { businessId, area: 'notify-sms' } } });
    const smsConn = sms?.data as { connected?: boolean; channel?: 'sms' | 'whatsapp' } | undefined;
    const now = new Date();
    const label: LText =
      input.source === 'bookingWindow'
        ? { ru: 'Сообщение из окна записи', en: 'Message from the booking window', hy: 'Հաղորդագրություն գրանցման պատուհանից' }
        : { ru: 'Сообщение из карточки клиента', en: 'Message from the client card', hy: 'Հաղորդագրություն հաճախորդի քարտից' };
    for (const channel of allowed) {
      let delivered = false;
      if ((channel === 'push' || channel === 'brandedApp') && client.appUserId) {
        delivered = await enqueueClientNotification(this.prisma, {
          appUserId: client.appUserId,
          businessId,
          kind: 'oneOff',
          title: 'BookTime',
          body: text,
          dedupeKey: `oneOff:${newId('notifyLogEntry')}`,
        });
      } else if ((channel === 'sms' || channel === 'whatsapp') && smsConn?.connected) {
        delivered = (await this.messenger.send({ businessId, to: client.phone, text, channel: channel === 'whatsapp' ? 'whatsapp' : 'sms' })).delivered;
      } else if (channel === 'email' && client.email) {
        await this.mail.send({ to: client.email, subject: label.ru, text });
        delivered = true;
      }
      const cost = costOf(channel, text);
      await this.write(businessId, {
        sentAt: now,
        typeCode: ONE_OFF_TYPE_CODE,
        typeLabel: label,
        channel,
        // Нет приложения / не подключён провайдер бизнеса (В-08) — сообщение не ушло, так и пишем
        status: delivered ? 'sent' : 'notDelivered',
        contact: channel === 'email' ? client.email || client.phone : client.phone,
        text: { ru: text },
        clientId: client.id,
        staffId: input.staffId,
        bookingId: input.bookingId,
        costAmd: delivered ? cost.costAmd : 0,
        smsParts: cost.smsParts,
        source: 'oneOff',
      });
    }
    return { sentChannels: allowed };
  }

  /**
   * F-05-089: ссылка на оплату визита. Онлайн-оплаты нет (предоплата по реквизитам, F-00-097) — ссылка ведёт на
   * страницу записи с ?pay=1, короткая (ShortLink), одна и та же на каждое открытие.
   */
  async getPaymentLink(businessId: string, bookingId: string): Promise<{ bookingId: string; url: string; createdAt: string }> {
    const booking = await this.prisma.booking.findFirst({ where: { id: bookingId, businessId }, select: { id: true } });
    if (!booking) throw new ApiError('not_found', 'Booking not found');
    const biz = await this.prisma.business.findUnique({ where: { id: businessId }, select: { slug: true } });
    const link = await this.shortLinks.create(businessId, `/b/${biz?.slug ?? businessId}/booking/${bookingId}?pay=1`);
    const row = await this.prisma.shortLink.findUnique({ where: { code: link.code }, select: { createdAt: true } });
    return { bookingId, url: link.url, createdAt: utcToLocal(row?.createdAt ?? new Date()) };
  }

  async sendPaymentLink(businessId: string, input: { bookingId: string; clientId: string; channels: string[]; staffId?: string }): Promise<{ sentChannels: string[] }> {
    const link = await this.getPaymentLink(businessId, input.bookingId);
    const wa = await this.more.getAltegioWhatsApp(businessId);
    const channels = input.channels.filter((c) => c !== 'whatsapp' || wa.mode !== 'none');
    if (channels.length === 0) throw new ApiError('no_allowed_channel', 'no allowed channel');
    return this.sendOneOff(businessId, { clientId: input.clientId, text: `Оплатите визит по ссылке: ${link.url}`, channels, source: 'bookingWindow', staffId: input.staffId, bookingId: input.bookingId });
  }

  // ─────────── вывод ───────────

  private rowOut(businessId: string, r: LogRow, scheduled: boolean): LogMessageOut {
    return {
      id: `lg_${r.key.replace(/[^A-Za-z0-9_]/g, '_')}`,
      businessId,
      createdAt: r.createdAt,
      typeCode: r.typeCode,
      typeLabel: r.typeLabel,
      channel: r.channel,
      status: r.status,
      contact: r.contact,
      text: r.text,
      clientId: r.clientId,
      staffId: r.staffId,
      bookingId: r.bookingId,
      sentLanguage: r.sentLanguage,
      costAmd: r.costAmd,
      smsParts: r.smsParts,
      scheduled: scheduled || undefined,
      deferredFrom: r.deferredFrom,
    };
  }

  /** Метки коротких ссылок (Q00000…) → настоящие коды ShortLink; длина та же, цена SMS не меняется */
  private async materializeLinks(businessId: string, rows: LogRow[], paths: Map<string, string>): Promise<LogRow[]> {
    const used = new Map<string, string>();
    for (const r of rows) {
      for (const lang of ['ru', 'en', 'hy'] as const) {
        const t = r.text[lang];
        if (!t) continue;
        for (const m of t.matchAll(/booktime\.am\/s\/(Q\d{5})/g)) {
          const path = paths.get(m[1]!);
          if (path) used.set(m[1]!, path);
        }
      }
    }
    if (!used.size) return rows;
    const codes = new Map<string, string>();
    for (const [ph, path] of used) codes.set(ph, (await this.shortLinks.create(businessId, path)).code);
    const swap = (t: string | undefined) => (t ? t.replace(/booktime\.am\/s\/(Q\d{5})/g, (all, ph: string) => (codes.has(ph) ? `booktime.am/s/${codes.get(ph)}` : all)) : t);
    return rows.map((r) => ({ ...r, text: { ru: swap(r.text.ru) ?? '', en: swap(r.text.en), hy: swap(r.text.hy) } }));
  }

  private async derive(
    businessId: string,
    w: { eventsFrom: Date; eventsTo: Date; bookingsFrom: Date; bookingsTo: Date; winback: boolean; winbackFrom?: Date },
  ): Promise<{ rows: LogRow[]; paths: Map<string, string> }> {
    const business = await this.prisma.business.findUnique({ where: { id: businessId }, select: { slug: true, name: true, brandName: true, phone: true, socials: true } });
    if (!business) throw new ApiError('not_found', 'Business not found');
    const [types, settings, locations, staffRows, services, reminderRow, eventRows] = await Promise.all([
      this.richTypes.list(businessId),
      this.more.getSettings(businessId),
      this.prisma.location.findMany({ where: { businessId }, select: { id: true, address: true, phone: true, yandexMapsUrl: true }, orderBy: { id: 'asc' } }),
      this.prisma.staff.findMany({ where: { businessId }, select: { id: true, name: true, phone: true, role: true, locations: { select: { locationId: true } } } }),
      this.prisma.service.findMany({ where: { businessId }, select: { id: true, name: true } }),
      this.prisma.businessSetting.findUnique({ where: { businessId_area: { businessId, area: 'notify-service-reminder-hours' } } }),
      this.prisma.bookingEvent.findMany({ where: { businessId, at: { gte: w.eventsFrom, lte: w.eventsTo } }, orderBy: { at: 'asc' }, take: 5000 }),
    ]);
    const t55 = types.find((t) => t.code === 55);
    const winbackDays = t55?.conditions?.winbackAfterDays ?? 14;
    const eventBookingIds = [...new Set(eventRows.map((e) => e.bookingId))];
    const bookingSelect = { id: true, locationId: true, staffId: true, clientId: true, startAt: true, status: true, services: true, total: true, source: true, visitorName: true, createdAt: true, deletedAt: true, notifyOverride: true } as const;
    const [eventBookings, activeBookings, arrivedRows] = await Promise.all([
      eventBookingIds.length ? this.prisma.booking.findMany({ where: { id: { in: eventBookingIds }, businessId }, select: bookingSelect }) : Promise.resolve([]),
      this.prisma.booking.findMany({ where: { businessId, deletedAt: null, status: { in: ACTIVE }, startAt: { gte: w.bookingsFrom, lte: w.bookingsTo } }, select: bookingSelect, take: 5000 }),
      w.winback && t55?.enabled
        ? this.prisma.booking.findMany({
            where: { businessId, deletedAt: null, status: 'arrived', clientId: { not: null }, startAt: { gte: new Date((w.winbackFrom ?? w.eventsFrom).getTime() - winbackDays * DAY), lte: new Date(w.eventsTo.getTime() - winbackDays * DAY) } },
            select: bookingSelect,
            take: 5000,
          })
        : Promise.resolve([]),
    ]);
    const toB = (b: (typeof activeBookings)[number]): DBooking => ({
      id: b.id,
      locationId: b.locationId,
      staffId: b.staffId,
      clientId: b.clientId,
      start: utcToLocal(b.startAt),
      status: b.status,
      serviceIds: Array.isArray(b.services) ? (b.services as { serviceId?: string }[]).map((l) => l.serviceId).filter((x): x is string => !!x) : [],
      total: Number(b.total),
      source: b.source,
      visitorName: b.visitorName,
      createdAt: utcToLocal(b.createdAt),
      deleted: !!b.deletedAt,
      override: (b.notifyOverride as DBooking['override']) ?? null,
    });
    const bookings = new Map<string, DBooking>();
    for (const b of [...eventBookings, ...activeBookings]) bookings.set(b.id, toB(b));
    const arrived = arrivedRows.map(toB);

    // Приглашение (72): у клиента есть будущая запись — не зовём; повторный визит (55): записался снова на ту же услугу
    const cancelClientIds = [...new Set(eventRows.filter((e) => e.kind === 'status' && e.clientId).map((e) => e.clientId!))];
    const arrivedClientIds = [...new Set(arrived.map((b) => b.clientId!).filter(Boolean))];
    const [futureRows, laterRows] = await Promise.all([
      cancelClientIds.length
        ? this.prisma.booking.findMany({ where: { businessId, clientId: { in: cancelClientIds }, deletedAt: null, status: { in: ACTIVE }, startAt: { gt: new Date() } }, select: { clientId: true } })
        : Promise.resolve([]),
      arrivedClientIds.length
        ? this.prisma.booking.findMany({ where: { clientId: { in: arrivedClientIds }, deletedAt: null, startAt: { gte: new Date(Math.min(...arrived.map((b) => localToUtc(b.start).getTime()))) } }, select: { id: true, clientId: true, startAt: true, services: true } })
        : Promise.resolve([]),
    ]);
    const clientsWithFutureBooking = new Set(futureRows.map((r) => r.clientId!).filter(Boolean));
    const later = laterRows.map((r) => ({
      id: r.id,
      clientId: r.clientId!,
      start: utcToLocal(r.startAt),
      serviceIds: Array.isArray(r.services) ? (r.services as { serviceId?: string }[]).map((l) => l.serviceId ?? '') : [],
    }));

    const clientIds = new Set<string>();
    for (const b of [...bookings.values(), ...arrived]) if (b.clientId) clientIds.add(b.clientId);
    const [clientRows, birthdayRows] = await Promise.all([
      clientIds.size ? this.prisma.client.findMany({ where: { id: { in: [...clientIds] } }, select: { id: true, name: true, phone: true, email: true, appUserId: true, birthday: true } }) : Promise.resolve([]),
      w.winback ? this.prisma.client.findMany({ where: { businessId, deletedAt: null, purgedAt: null, birthday: { not: null } }, select: { id: true, name: true, phone: true, email: true, appUserId: true, birthday: true } }) : Promise.resolve([]),
    ]);
    const clients = new Map<string, DClient>();
    for (const c of await resolveAppUsers(this.prisma, [...clientRows, ...birthdayRows])) clients.set(c.id, c);
    const prefRows = clients.size ? await this.prisma.clientNotifyPref.findMany({ where: { clientId: { in: [...clients.keys()] } } }) : [];
    const clientPrefs = new Map<string, DClientPrefs>(
      prefRows.map((p) => [
        p.clientId,
        { channels: { push: true, sms: true, email: true, ...((p.channels as Partial<DClientPrefs['channels']>) ?? {}) }, disabledTypeCodes: Array.isArray(p.disabledTypeCodes) ? (p.disabledTypeCodes as number[]) : [] },
      ]),
    );

    const events: DEvent[] = eventRows.map((e) => ({ id: e.id, bookingId: e.bookingId, kind: e.kind, fromStatus: e.fromStatus, toStatus: e.toStatus, prevStart: e.prevStart, byRef: e.byRef, at: utcToLocal(e.at) }));
    const socials = (business.socials as { website?: string } | null) ?? {};
    let n = 0;
    const byPath = new Map<string, string>();
    const paths = new Map<string, string>();
    const ctx: DeriveContext = {
      business: { slug: business.slug, name: business.brandName || business.name, phone: business.phone, website: socials.website ?? '' },
      locations: new Map(locations.map((l) => [l.id, { address: (l.address as unknown as LText) ?? { ru: '' }, phone: l.phone ?? '', mapsLink: l.yandexMapsUrl ?? '' }])),
      defaultLocationId: locations[0]?.id,
      staff: staffRows.map<DStaff>((s) => ({ id: s.id, name: s.name, phone: s.phone, role: s.role, locationIds: s.locations.map((l) => l.locationId) })),
      services: new Map(services.map((s) => [s.id, s.name as unknown as LText])),
      bookings,
      clients,
      clientPrefs,
      types,
      settings: { language: settings.language, dateFormat: settings.dateFormat, quietHours: settings.quietHours },
      now: nowLocal(),
      shorten: (path) => {
        let ph = byPath.get(path);
        if (!ph) {
          ph = `Q${String(n++).padStart(5, '0')}`;
          byPath.set(path, ph);
          paths.set(ph, path);
        }
        return ph;
      },
      clientsWithFutureBooking,
      rebookedAfter: (clientId, bookingId, serviceIds, start) =>
        later.some((b) => b.clientId === clientId && b.id !== bookingId && b.start > start && b.serviceIds.some((s) => serviceIds.includes(s))),
    };
    const rows = deriveLogRows(ctx, {
      events,
      arrived,
      birthdayClients: birthdayRows.map((c) => clients.get(c.id) ?? c),
      serviceReminderHours: (reminderRow?.data as Record<string, number> | undefined) ?? {},
      windowFrom: utcToLocal(w.winbackFrom ?? w.eventsFrom),
    });
    return { rows, paths };
  }
}

export { statusFor };
