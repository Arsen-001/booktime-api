import { createHash, createHmac, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { CodeChannel } from '../../adapters/code-sender/code-sender.js';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { updateVersioned } from '../../common/http/version.js';
import { newId } from '../../common/ids/ids.js';
import type { Locale } from '../../common/i18n/i18n.js';
import { normalizePhone } from '../../common/phone.js';
import { PrismaService } from '../../common/prisma.service.js';
import { DEFAULT_TZ, localDayRangeUtc, localToUtc, utcToLocal } from '../../common/time/time.js';
import type { Business, BookingLink } from '../../generated/prisma/client.js';
import { Prisma } from '../../generated/prisma/client.js';
import { AvailabilityService } from '../availability/availability.service.js';
import type { FreeSlot } from '../availability/engine.js';
import { businessView, locationView, staffView } from '../businesses/views.js';
import { OtpService } from '../auth/otp.service.js';
import { ordersEnabledOf } from '../orders/order-rules.js';
import { categoryView, serviceView } from '../services/services.views.js';
import { BookingsService, clientActor, coreClient, staffActor } from '../journal/bookings.service.js';
import { ModerationService, photoModerationRefId } from '../platform/moderation.service.js';
import type { BusinessOnlineRulesBody, CreateLinkBody, StaffClientRulesBody, UpdateLinkBody } from './online.schemas.js';

const arr = <T = string>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const opt = <T>(v: T | null | undefined): T | undefined => (v === null || v === undefined ? undefined : v);

/** Prisma отказывается писать `undefined` внутри JSON-поля — вырезаем такие ключи перед записью */
/** 'YYYY-MM-DD' + n дней (календарная дата, без пояса) */
function addDaysLocal(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function pruneUndefined<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

/**
 * F-00-066: правила мастера по умолчанию, когда `staff.bookingRules` ещё пуст. Срок отмены/переноса — НЕ здесь:
 * в `staff.bookingRules` они лежат в минутах под ключами журнала (`cancelWindowMin`/`rescheduleWindowMin`, В-04,
 * `rules.ts` этапа 7) — единственный источник правды; сюда/обратно в часы для F-00-066 переводит `hoursOf()`.
 */
const DEFAULT_CLIENT_RULES = {
  allowReschedule: true,
  allowCancel: true,
  allowReschedulePrepaid: false,
  allowCancelPrepaid: true,
  keepPrepaymentOnLateCancel: true,
  allowAnyStaffAssignment: true,
  addClaimLinkToMessage: true,
} as const;

function hashOf(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * Токен ссылки записи, которая заменила заявку (О28), выводится из токена ссылки самой заявки: сырой токен новой записи
 * не хранится в данных отменённой заявки (final-fix 01.10) — его видел бы кабинет в onlineMeta. Клиент со старой
 * ссылкой получает новую ссылку при чтении (viewByHash), больше ни у кого исходного токена нет.
 */
function replacementToken(originalRaw: string, newBookingId: string): string {
  return createHmac('sha256', originalRaw).update(`replacedBy:${newBookingId}`).digest('hex').slice(0, 32);
}

/** 'YYYY-MM-DD' → следующий календарный день, тем же форматом (UTC-арифметика, без часового пояса) */
function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Публичный подвид мастера (F-00-077, F-00-010): без точного домашнего адреса, логина и часов звонков — тот же
 * подвид используют публичный каталог и карточки клиента (этап 9, `client` module) */
export function sanitizePublicStaff(row: Parameters<typeof staffView>[0]) {
  const { homeAddress: _h, login: _l, callHours: _c, ...rest } = staffView(row);
  return rest;
}

function filterByWorkplace(slots: FreeSlot[], workplace: string | undefined): FreeSlot[] {
  if (!workplace || workplace === 'visit') return slots;
  return slots.filter((s) => s.workplace === workplace);
}

/**
 * Раздел «online» (docs/backend/02 §3, PLAN §6 №8): публичная страница /b/<slug>, виджет, создание записи без
 * входа (с кодом, B2), «моя запись» по хэшу (B8, B19), ссылки (F-03-003…037), правила мастера/бизнеса (F-00-066,
 * F-03-079). Свободные окна и создание записи считает и держит тот же фундамент, что и журнал (этапы 6, 7):
 * `AvailabilityService`/`BookingsService.place()` уже несут В-22 (calendarVisibility) и «замок на мастера».
 */
@Injectable()
export class OnlineService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly availability: AvailabilityService,
    private readonly otp: OtpService,
    private readonly bookings: BookingsService,
    private readonly moderation: ModerationService,
  ) {}

  // ─────────────────────────── бизнес по slug ───────────────────────────

  async businessBySlug(slug: string) {
    const business = await this.prisma.business.findUnique({ where: { slug } });
    if (!business || business.status !== 'active') throw new ApiError('not_found', `Business "${slug}" not found`);
    return business;
  }

  private async travelTimeMin(staffId: string): Promise<number> {
    const staff = await this.prisma.staff.findUnique({ where: { id: staffId }, select: { bookingRules: true } });
    const rules = (staff?.bookingRules as Record<string, unknown> | null) ?? null;
    const v = rules?.travelTimeMin;
    return typeof v === 'number' && v > 0 ? v : 0;
  }

  /** F-00-080: буфер «время на дорогу» вокруг чужих выездов того же дня — считаем поверх готовых окон движка */
  private async filterByTravelBuffer(slots: FreeSlot[], staffId: string, date: string): Promise<FreeSlot[]> {
    const travelTimeMin = await this.travelTimeMin(staffId);
    if (!travelTimeMin || slots.length === 0) return slots;
    const day = localDayRangeUtc(date, DEFAULT_TZ);
    const visits = await this.prisma.booking.findMany({
      where: { staffId, deletedAt: null, workplace: 'visit', startAt: { gte: day.from, lt: day.to }, status: { notIn: ['cancelled_by_client', 'cancelled_by_master'] } },
      select: { startAt: true, durationMin: true },
    });
    if (!visits.length) return slots;
    const buffers = visits.map((b) => ({ from: new Date(b.startAt.getTime() - travelTimeMin * 60_000), to: new Date(b.startAt.getTime() + (b.durationMin + travelTimeMin) * 60_000) }));
    return slots.filter((s) => {
      const start = new Date(`${s.start}:00.000Z`);
      const end = new Date(`${s.end}:00.000Z`);
      return !buffers.some((b) => start < b.to && end > b.from);
    });
  }

  // ─────────────────────────── публичная страница (F-03-134, F-00-077, В-22) ───────────────────────────

  async publicBusinessData(slug: string, formId?: string) {
    const business = await this.businessBySlug(slug);
    const [locations, staffRows, services, categories, links] = await Promise.all([
      this.prisma.location.findMany({ where: { businessId: business.id, deletedAt: null }, orderBy: { sortOrder: 'asc' } }),
      this.prisma.staff.findMany({ where: { businessId: business.id, deletedAt: null }, include: { locations: { select: { locationId: true } } } }),
      this.prisma.service.findMany({ where: { businessId: business.id, active: true, onlineBookable: true } }),
      this.prisma.serviceCategory.findMany({ where: { businessId: business.id } }),
      this.prisma.bookingLink.findMany({ where: { businessId: business.id } }),
    ]);
    const location = locations[0];
    // F-00-077: мастер принимает только на дому — точный адрес виден клиенту лишь после подтверждённой записи.
    const ownerStaff = staffRows.find((s) => s.id === business.ownerStaffId);
    const ownerWorkplaces = arr<string>(ownerStaff?.workplaces);
    const addressHidden = Boolean(ownerStaff && ownerWorkplaces.includes('home') && !ownerWorkplaces.some((w) => w === 'salon' || w === 'gym'));

    const scheduledStaffIds = new Set((await this.prisma.workSchedule.findMany({ where: { businessId: business.id, staffId: { in: staffRows.map((s) => s.id) } }, select: { staffId: true } })).map((r) => r.staffId));
    const visibleStaff = staffRows.filter((s) => {
      if (s.status !== 'active' || s.onlineBookingEnabled === false) return false;
      if (!scheduledStaffIds.has(s.id)) return false;
      const own = arr<string>(s.serviceIds);
      return services.some((sv) => own.includes(sv.id));
    });

    let link = formId ? links.find((l) => l.formId === formId) : (links.find((l) => l.primary) ?? links[0]);
    if (formId && !link) throw new ApiError('not_found', `Form ${formId} not found`);
    let linkStaffGone = false;
    let linkOut: Record<string, unknown> | undefined = link ? linkView(link) : undefined;
    if (link) {
      const config = (link.config as Record<string, unknown>) ?? {};
      const preselected = config.preselectedStaffId !== 'any' ? (config.preselectedStaffId as string | undefined) : undefined;
      const stillVisible = (id: string | null | undefined) => !id || visibleStaff.some((s) => s.id === id);
      if (!stillVisible(link.staffId) || !stillVisible(preselected)) {
        linkStaffGone = true;
        linkOut = { ...linkOut, staffId: stillVisible(link.staffId) ? link.staffId : undefined, preselectedStaffId: stillVisible(preselected) ? preselected : undefined };
      }
    }
    let networkBranches: ReturnType<typeof businessView>[] | undefined;
    const config = link ? ((link.config as Record<string, unknown>) ?? {}) : {};
    if (link?.kind === 'network' && (link.networkId || config.networkId)) {
      const networkId = (link.networkId ?? (config.networkId as string))!;
      const branches = await this.prisma.business.findMany({ where: { networkId, status: 'active' } });
      networkBranches = await Promise.all(branches.map((b) => this.businessOut(b)));
    }
    const onlineArea = await this.prisma.businessSetting.findUnique({ where: { businessId_area: { businessId: business.id, area: 'online' } } });
    const hourCycle = ((onlineArea?.data as Record<string, unknown> | undefined)?.hourCycle as '24' | '12' | undefined) ?? '24';

    // F-00-168 (этап 21, лейн rest): один пакетный запрос вместо N+1 — бизнес + весь видимый персонал сразу.
    const allPhotoRefIds = [...arr<string>(business.photos), ...visibleStaff.flatMap((s) => arr<string>(s.photos))].map(photoModerationRefId);
    const hiddenPhotoRefIds = await this.moderation.hiddenRefIds(allPhotoRefIds);
    const staffOut = visibleStaff.map(sanitizePublicStaff).map((s) => {
      const photos = arr<string>(s.photos);
      if (!photos.length) return s;
      const visible = photos.filter((p) => !hiddenPhotoRefIds.has(photoModerationRefId(p)));
      return visible.length === photos.length ? s : { ...s, photos: visible };
    });

    return {
      business: await this.businessOut(business, hiddenPhotoRefIds),
      location: location ? locationView(location) : undefined,
      categories: categories.map(categoryView),
      services: services.map(serviceView),
      staff: staffOut,
      link: linkOut,
      regularsCount: await this.countRegulars(business.id),
      serviceConfigs: await this.serviceConfigsMap(business.id, services.map((s) => s.id)),
      staffServiceOnline: (onlineArea?.data as Record<string, unknown> | undefined)?.staffServiceOnline ?? {},
      linkStaffGone,
      // ⭐ промоблок ждёт очередь модерации (F-00-168) — не в этом заходе, см. docs/PROGRESS.md
      promoBlocks: [],
      businessStars: await this.starCount(business.id, 'business', business.id),
      networkBranches,
      packages: await this.publicPackages(business.id),
      hourCycle,
      addressHidden,
      // Мастерская «заказов» (ателье, ремонт, химчистка, детейлинг): без онлайн-услуг страница показывает не пустую
      // запись, а «принесите в часы работы, о готовности сообщат» и контакты (05.10.2026)
      ordersEnabled: ordersEnabledOf(business.ordersEnabled, business.sphereIds),
    };
  }

  /**
   * `hiddenBusinessPhotoRefIds` — набор, уже посчитанный вызывающей стороной, если она знает его заранее
   * (`publicBusinessData` считает один пакетный запрос сразу на бизнес+весь персонал, чтобы не бить N+1);
   * без параметра метод посчитает свой пакет сам (второй вызывающий, `viewByHash`, — один бизнес без персонала).
   */
  private async businessOut(b: Business, hiddenBusinessPhotoRefIds?: ReadonlySet<string>) {
    const locationIds = (await this.prisma.location.findMany({ where: { businessId: b.id, deletedAt: null }, select: { id: true } })).map((l) => l.id);
    const view = businessView(b, locationIds);
    const photos = arr<string>(view.photos);
    if (!photos.length) return view;
    const hidden = hiddenBusinessPhotoRefIds ?? (await this.moderation.hiddenRefIds(photos.map(photoModerationRefId)));
    if (!hidden.size) return view;
    const visiblePhotos = photos.filter((p) => !hidden.has(photoModerationRefId(p)));
    return visiblePhotos.length === photos.length ? view : { ...view, photos: visiblePhotos };
  }

  /** F-00-117: постоянные клиенты (3+ визита за 12 мес, В-38) — то же правило, что карточка мастера приложения */
  private async countRegulars(businessId: string): Promise<number> {
    const rows = await this.prisma.booking.groupBy({
      by: ['clientId'],
      where: { businessId, deletedAt: null, clientId: { not: null }, status: { notIn: ['cancelled_by_client', 'cancelled_by_master'] } },
      _count: { _all: true },
    });
    return rows.filter((r) => r._count._all >= 3).length;
  }

  // ─────────────────────────── окна виджета (F-03-065, F-03-084, F-03-085) ───────────────────────────
  // Форма запроса — как у фронта (`getWidgetFreeSlots`/`WidgetSlotQuery`, `src/api/online.ts`): длительность и id
  // услуги приходят от вызывающего (виджет уже посчитал их из выбранных строк), а не пересчитываются здесь —
  // ровно тот же вход, что уйдёт в `BookingsService.place()` при самой записи (её предпроверка окна, docs `04`).

  async widgetSlots(slug: string, q: { staffId: string; date: string; durationMin: number; durationMax?: number; serviceId?: string; locationId?: string; workplace?: string }): Promise<FreeSlot[]> {
    const business = await this.businessBySlug(slug);
    const slots = await this.availability.freeSlots(business.id, { staffId: q.staffId, date: q.date, durationMin: q.durationMin, durationMax: q.durationMax, locationId: q.locationId, serviceId: q.serviceId });
    return filterByWorkplace(await this.filterByTravelBuffer(slots, q.staffId, q.date), q.workplace);
  }

  async nearestDate(slug: string, q: { staffId: string; durationMin: number; durationMax?: number; serviceId?: string; from: string; locationId?: string; workplace?: string; maxDays?: number }): Promise<string | undefined> {
    let cursor = q.from;
    for (let i = 0; i < (q.maxDays ?? 60); i++) {
      const slots = await this.widgetSlots(slug, { ...q, date: cursor });
      if (slots.length > 0) return cursor;
      cursor = nextDay(cursor);
    }
    return undefined;
  }

  async monthAvailability(slug: string, q: { staffId: string; durationMin: number; durationMax?: number; serviceId?: string; month: string; locationId?: string; workplace?: string }): Promise<Record<string, boolean>> {
    const parts = q.month.split('-').map(Number);
    const y = parts[0];
    const m = parts[1];
    if (y === undefined || m === undefined) throw new ApiError('validation', 'month must be YYYY-MM');
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const out: Record<string, boolean> = {};
    for (let d = 1; d <= daysInMonth; d++) {
      const date = `${q.month}-${String(d).padStart(2, '0')}`;
      const slots = await this.widgetSlots(slug, { ...q, date });
      out[date] = slots.length > 0;
    }
    return out;
  }

  // ─────────────────────────── код перед записью (F-00-007, B2) ───────────────────────────

  async sendCode(ctx: RequestContext, input: { phone: string; channel: CodeChannel; locale?: Locale }) {
    const phone = normalizePhone(input.phone);
    if (!phone) throw new ApiError('invalid_phone', 'Phone must be +374XXXXXXXX');
    return this.otp.send({ phone, purpose: 'booking', channel: input.channel, ip: ctx.ip, locale: input.locale ?? 'ru' });
  }

  // ─────────────────────────── создание записи (F-03-091…098, F-03-123, F-03-139) ───────────────────────────

  async createBooking(
    slug: string,
    body: {
      staffId: string;
      start: string;
      services: { serviceId: string }[];
      clientName: string;
      clientPhone: string;
      code: string;
      comment?: string;
      forWhom?: string;
      linkId?: string;
      formId?: string;
      source: 'link' | 'widget';
      device: 'mobile' | 'desktop';
      workplace?: string;
      visitAddress?: string;
      reminderMinutesBefore?: number;
      anySpecialist?: boolean;
      email?: string;
      lastName?: string;
      patronymic?: string;
      customFieldValues?: Record<string, string>;
      locationId: string;
      payInFull?: boolean;
      addOns?: { serviceIds?: string[]; productIds?: string[] };
      /** «Пригласи подругу»: код из личной ссылки салона */
      referralCode?: string;
    },
  ) {
    const business = await this.businessBySlug(slug);
    const phone = normalizePhone(body.clientPhone);
    if (!phone) throw new ApiError('invalid_phone', 'Проверьте номер телефона');
    // B2: подтверждаем номер кодом СЕРВЕРОМ перед созданием записи — не доверяем самоотчёту клиента.
    await this.otp.verify({ phone, purpose: 'booking' }, body.code);

    const result = await this.bookings.place(clientActor(null, body.source === 'link' ? 'link_holder' : 'client'), {
      source: body.source,
      businessId: business.id,
      staffId: body.staffId,
      start: body.start,
      services: body.services.map((s) => ({ serviceId: s.serviceId })),
      locationId: body.locationId,
      workplace: body.workplace,
      client: { phone, name: body.clientName },
      forWhom: body.forWhom,
      comment: body.comment,
      staffAssignment: body.anySpecialist ? 'any' : undefined,
      payInFull: body.payInFull,
      addOns: body.addOns,
      referralCode: body.referralCode,
    });

    const raw = randomBytes(16).toString('hex');
    const row = await this.prisma.booking.findUniqueOrThrow({ where: { id: result.booking.id } });
    // B8: ссылка «моя запись без входа» живёт до конца визита + 7 дней
    const expiresAt = new Date(row.endAt.getTime() + 7 * 86_400_000);
    const meta = {
      linkId: body.linkId,
      formId: body.formId,
      widgetGen: 'new' as const,
      device: body.device,
      reminderMinutesBefore: body.reminderMinutesBefore,
      phoneVerified: true,
      visitAddress: body.workplace === 'visit' ? body.visitAddress : undefined,
      anySpecialist: body.anySpecialist,
      email: body.email,
      lastName: body.lastName,
      patronymic: body.patronymic,
      customFieldValues: body.customFieldValues,
      submittedAt: utcToLocal(new Date()),
    };
    await this.prisma.booking.update({ where: { id: row.id }, data: { accessHash: hashOf(raw), accessHashExpiresAt: expiresAt, onlineMeta: pruneUndefined(meta) as Prisma.InputJsonValue } });

    let client = result.client as Record<string, unknown> | undefined;
    if (!client && row.clientId) {
      const c = await this.prisma.client.findUnique({ where: { id: row.clientId } });
      if (c) client = coreClient(c);
    }
    if (body.email && client && !client.email) await this.prisma.client.update({ where: { id: row.clientId! }, data: { email: body.email } }).catch(() => undefined);

    return { booking: result.booking, client, accessHash: raw };
  }

  /**
   * ⭐ О28 «Другое время» / «мастер не ответил» (bookAlternativeTime мока, qa/full-test-0930 online.md): клиент по ссылке
   * берёт одно из окон, которые предложили вместо его записи, — одним вызовом, без формы и кода (хэш ссылки уже
   * подтверждает, что это он): тот же мастер, те же услуги, то же имя и телефон. Окно, которое предложил сам мастер
   * (исходная заявка ещё «ждёт подтверждения»), не ждёт второго подтверждения — сразу «Записан» (или «ждёт предоплату»),
   * а исходная заявка снимается как «перенесена» (cancelReason 'rescheduled', без неявки); старая ссылка ведёт на новую
   * запись (onlineMeta.replacedBy). Снятую по сроку заявку (мастер не ответил) новая запись не трогает.
   */
  async bookAlternativeTime(id: string, hash: string, start: string) {
    const orig = await this.findByHash(id, hash);
    const meta = ((orig.onlineMeta as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
    const offered = Array.isArray(meta.offeredStarts) ? (meta.offeredStarts as string[]) : [];
    if (!['awaiting_confirmation', 'cancelled_by_master'].includes(orig.status) || !offered.includes(start)) throw new ApiError('slot_taken', 'Это время уже недоступно');
    const client = orig.clientId ? await this.prisma.client.findUnique({ where: { id: orig.clientId } }) : null;
    if (!client) throw new ApiError('client_required', 'Нет имени и телефона');
    const acceptsOffer = orig.status === 'awaiting_confirmation';
    const source = orig.source === 'link' ? 'link' : 'widget';
    const lines = (Array.isArray(orig.services) ? orig.services : []) as { serviceId: string }[];
    const result = await this.bookings.place(clientActor(null, source === 'link' ? 'link_holder' : 'client'), {
      source,
      businessId: orig.businessId,
      staffId: orig.staffId,
      start,
      services: lines.map((l) => ({ serviceId: l.serviceId })),
      locationId: orig.locationId,
      workplace: orig.workplace,
      client: { phone: client.phone, name: orig.visitorName ?? client.name },
      forWhom: orig.forWhom,
      acceptsOffer,
    });
    const { offeredStarts: _o, replacedBy: _r, rescheduledTo: _t, ...keep } = meta;
    const raw = acceptsOffer ? replacementToken(hash, result.booking.id) : randomBytes(16).toString('hex');
    const row = await this.prisma.booking.findUniqueOrThrow({ where: { id: result.booking.id } });
    await this.prisma.booking.update({
      where: { id: row.id },
      data: { accessHash: hashOf(raw), accessHashExpiresAt: new Date(row.endAt.getTime() + 7 * 86_400_000), onlineMeta: pruneUndefined({ ...keep, submittedAt: utcToLocal(new Date()) }) as Prisma.InputJsonValue },
    });
    if (acceptsOffer) {
      await this.bookings.changeStatus(clientActor(null, 'link_holder'), [orig.businessId], orig.id, 'cancelled_by_client', 'client', { reason: 'rescheduled' });
      await this.prisma.booking.update({
        where: { id: orig.id },
        data: { cancelledBy: 'client', cancelledLate: false, onlineMeta: pruneUndefined({ ...keep, replacedBy: { bookingId: row.id, start: result.booking.start }, rescheduledTo: result.booking.start }) as Prisma.InputJsonValue, version: { increment: 1 } },
      });
    }
    return { booking: await this.bookings.view(this.prisma, await this.prisma.booking.findUniqueOrThrow({ where: { id: row.id } })), client: coreClient(client), accessHash: raw };
  }

  // ─────────────────────────── запись по хэшу без входа (B8, B19) ───────────────────────────

  private async findByHash(id: string, hash: string) {
    const row = await this.prisma.booking.findUnique({ where: { id } });
    if (!hash || !row || !row.accessHash || row.accessHash !== hashOf(hash)) throw new ApiError('not_found', 'Booking not found');
    if (row.accessHashExpiresAt && row.accessHashExpiresAt.getTime() < Date.now()) throw new ApiError('not_found', 'Booking not found');
    return row;
  }

  /** Строка записи по ссылке без входа — та же проверка хэша, что у остальных маршрутов (Telegram-бот, 30.09) */
  async bookingByHash(id: string, hash: string) {
    return this.findByHash(id, hash);
  }

  async viewByHash(id: string, hash: string) {
    const row = await this.findByHash(id, hash);
    const [business, location, staff, onlineArea] = await Promise.all([
      this.prisma.business.findUnique({ where: { id: row.businessId } }),
      this.prisma.location.findUnique({ where: { id: row.locationId } }),
      this.prisma.staff.findFirst({ where: { id: row.staffId }, include: { locations: { select: { locationId: true } } } }),
      this.prisma.businessSetting.findUnique({ where: { businessId_area: { businessId: row.businessId, area: 'online' } } }),
    ]);
    if (!business) throw new ApiError('not_found', 'Business not found');
    const serviceIds = arr<{ serviceId: string }>(row.services).map((l) => l.serviceId);
    const services = await this.prisma.service.findMany({ where: { id: { in: serviceIds } } });
    const hourCycle = ((onlineArea?.data as Record<string, unknown> | undefined)?.hourCycle as '24' | '12' | undefined) ?? '24';
    // ⭐ Допродажа: товары визита (к оплате на месте) — клиенту название для клиента, цена, количество
    const goodsLines = arr<{ itemId: string; qty: number; price: number }>((row.extras as { goodsLines?: unknown } | null)?.goodsLines);
    const products = goodsLines.length ? await this.prisma.product.findMany({ where: { id: { in: goodsLines.map((g) => g.itemId) }, businessId: row.businessId } }) : [];
    const goods = goodsLines.flatMap((g) => {
      const p = products.find((x) => x.id === g.itemId);
      if (!p) return [];
      const clientName = p.clientName && typeof p.clientName === 'object' ? (p.clientName as Record<string, string>) : undefined;
      return [{ name: clientName?.ru ? clientName : { ru: p.name }, price: g.price, qty: Math.max(1, g.qty || 1) }];
    });
    return {
      booking: await this.bookings.view(this.prisma, row),
      business: await this.businessOut(business),
      location: location ? locationView(location) : undefined,
      staff: staff ? sanitizePublicStaff(staff) : undefined,
      services: services.map(serviceView),
      meta: { bookingId: row.id, ...publicMeta(row.onlineMeta, hash) },
      hourCycle,
      ...(goods.length ? { goods } : {}),
    };
  }

  /**
   * Окно отмены по ссылке — те же действующие правила (бизнес + мастер) и тот же `clientCancelOutcome`, что у самой
   * отмены (`cancelByClient`): раньше окно читало только правила мастера и не видело «отмена запрещена»/бизнес.
   */
  async cancelWindow(id: string, hash: string) {
    const row = await this.findByHash(id, hash);
    const { outcome, rules, prepaidAmount } = await this.bookings.clientCancelPreview(row);
    return {
      canCancelFree: outcome.allowed && !outcome.late,
      // B8 (08-open-questions.md, принятое предложение): по ссылке без входа переноса нет вообще, не только
      // «поздно» — экран (`BookingConfirmedScreen`) уже прячет/гасит кнопку по этому полю, ничего не правили.
      canReschedule: false,
      cancelWindowHours: rules.cancelWindowMin / 60,
      rescheduleWindowHours: rules.rescheduleWindowMin / 60,
      // Окно отмены честно говорит про деньги: сколько уже заплачено и останется ли это у мастера при поздней отмене
      prepaidAmount,
      keepPrepaymentOnLateCancel: rules.keepPrepaymentOnLateCancel,
      // Мастер разрешает клиенту отменять оплаченную запись? Нет — окно сразу говорит «только через мастера» (как мок)
      allowCancelPrepaid: rules.allowCancelPrepaid,
      canCancel: outcome.allowed,
    };
  }

  async cancelByHash(id: string, hash: string) {
    const row = await this.findByHash(id, hash);
    const { booking } = await this.bookings.cancelByClient(clientActor(null, 'link_holder'), id, { booking: row });
    return booking;
  }

  /**
   * «Я оплатил» по ссылке без входа (B8) — тот же переход, что `BookingsService.markPaidByClient` у клиента со
   * своим аккаунтом (этап 9), но по hash, не по appUserId: таймер снятия заявки останавливается, дальше решает
   * мастер (В-05). Срок снимается с записи и с занятости (`BookingsService.stopPrepaymentHold`): воркер снимает
   * заявки «ждёт предоплату» по `holdUntil`, так что без этого оплаченная запись отменялась бы через timeoutMin.
   */
  async markPrepaymentPaid(id: string, hash: string) {
    const row = await this.findByHash(id, hash);
    if (row.status !== 'awaiting_prepayment') throw new ApiError('not_awaiting_prepayment', 'Эта запись не ждёт предоплату');
    const p = (row.prepayment as Record<string, unknown> | null) ?? {};
    const holdUntil = p.holdUntil as string | undefined;
    if (holdUntil && holdUntil < utcToLocal(new Date()) && !p.clientMarkedPaidAt) {
      throw new ApiError('prepayment_expired', 'Время на оплату истекло — окно уже освободилось');
    }
    let updated = row;
    if (!p.clientMarkedPaidAt) {
      // Таймер стоп, как «Я оплатил» в приложении: без этого воркер снимал запись по holdUntil, хотя клиент заплатил
      updated = await this.bookings.stopPrepaymentHold(row);
      await this.prisma.bookingEvent.create({ data: { id: newId('bookingEvent'), bookingId: id, businessId: row.businessId, staffId: row.staffId, clientId: row.clientId, appUserId: row.appUserId, kind: 'status', toStatus: 'prepayment_reported', byRef: 'client', startLocal: utcToLocal(row.startAt) } });
    }
    return this.bookings.view(this.prisma, updated);
  }

  // ─────────────────────────── ссылки (F-03-003…037) ───────────────────────────

  async listLinks(businessId: string) {
    const rows = await this.prisma.bookingLink.findMany({ where: { businessId }, orderBy: { createdAt: 'asc' } });
    return rows.map(linkView);
  }

  async getLink(businessId: string, id: string) {
    const row = await this.prisma.bookingLink.findFirst({ where: { id, businessId } });
    if (!row) throw new ApiError('not_found', 'Link not found');
    return linkView(row);
  }

  async createLink(ctx: RequestContext, businessId: string, body: CreateLinkBody) {
    // F-03-008: сетевая ссылка берёт сеть у самого бизнеса — у филиала одна сеть (Business.networkId)
    const business = await this.prisma.business.findUnique({ where: { id: businessId }, select: { networkId: true } });
    if (body.kind === 'network' && !business?.networkId) throw new ApiError('validation', 'This business is not part of a network', { kind: 'no_network' });
    const id = newId('bookingLink');
    const formId = String(1_500_000 + Math.floor(Math.random() * 899_999));
    const row = await this.prisma.bookingLink.create({
      data: {
        id,
        businessId,
        locationId: body.locationId,
        networkId: body.kind === 'network' ? business!.networkId : undefined,
        name: body.name,
        description: body.description,
        kind: body.kind,
        bookingType: body.bookingType,
        defaultLocale: body.defaultLocale,
        staffId: body.staffId,
        formId,
        config: { bookingFlow: 'menu', stepOrder: ['service', 'staff', 'time'], stepHidden: {}, stepLabels: {}, staffDisplayField: 'specialty', categoryDisplay: 'tags', theme: 'light', widgetButtonColor: '#4f46e5', websiteButton: { show: true, position: 'br', widgetSide: 'right', color: '#4f46e5', animation: true } },
        createdBy: ctx.member!.staffId,
        updatedBy: ctx.member!.staffId,
      },
    });
    if (body.primary) await this.setPrimaryLink(ctx, businessId, id);
    return this.getLink(businessId, id);
  }

  async updateLink(ctx: RequestContext, businessId: string, id: string, body: UpdateLinkBody, version: number | undefined) {
    const before = await this.prisma.bookingLink.findFirst({ where: { id, businessId } });
    if (!before) throw new ApiError('not_found', 'Link not found');
    const { locationId, name, description, defaultLocale, staffId, ...configPatch } = body;
    const data: Record<string, unknown> = { updatedBy: ctx.member!.staffId, config: { ...(before.config as Record<string, unknown>), ...configPatch } };
    if (locationId !== undefined) data.locationId = locationId;
    if (name !== undefined) data.name = name;
    if (description !== undefined) data.description = description;
    if (defaultLocale !== undefined) data.defaultLocale = defaultLocale;
    if (staffId !== undefined) data.staffId = staffId;
    await updateVersioned(this.prisma.bookingLink, { id, businessId }, version, data);
    return this.getLink(businessId, id);
  }

  /** F-03-010: основную ссылку нельзя удалить — сначала «Сделать основной» другую */
  async deleteLink(businessId: string, id: string) {
    const row = await this.prisma.bookingLink.findFirst({ where: { id, businessId } });
    if (!row) throw new ApiError('not_found', 'Link not found');
    if (row.primary) throw new ApiError('conflict', 'Primary link cannot be deleted');
    await this.prisma.bookingLink.delete({ where: { id } });
  }

  async setPrimaryLink(ctx: RequestContext, businessId: string, id: string) {
    const row = await this.prisma.bookingLink.findFirst({ where: { id, businessId } });
    if (!row) throw new ApiError('not_found', 'Link not found');
    await this.prisma.$transaction([
      this.prisma.bookingLink.updateMany({ where: { businessId }, data: { primary: false } }),
      this.prisma.bookingLink.update({ where: { id }, data: { primary: true, updatedBy: ctx.member!.staffId } }),
    ]);
    return this.getLink(businessId, id);
  }

  // ─────────────────────────── правила мастера для клиента (F-00-066) ───────────────────────────

  async staffClientRules(businessId: string, staffId: string) {
    const staff = await this.prisma.staff.findFirst({ where: { id: staffId, businessId } });
    if (!staff) throw new ApiError('not_found', 'Staff not found');
    const rules = { ...DEFAULT_CLIENT_RULES, ...((staff.bookingRules as Record<string, unknown> | null) ?? {}) };
    return { staffId, ...rules, cancelWindowHours: hoursOf(rules, 'cancelWindowMin', 'cancelWindowHours'), rescheduleWindowHours: hoursOf(rules, 'rescheduleWindowMin', 'rescheduleWindowHours') };
  }

  async updateStaffClientRules(ctx: RequestContext, businessId: string, staffId: string, patch: StaffClientRulesBody) {
    const staff = await this.prisma.staff.findFirst({ where: { id: staffId, businessId } });
    if (!staff) throw new ApiError('not_found', 'Staff not found');
    const current = (staff.bookingRules as Record<string, unknown> | null) ?? {};
    const next: Record<string, unknown> = { ...current };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      // Общие с журналом поля (В-04) хранятся в минутах — здесь их отдают/принимают в часах (F-00-066)
      if (k === 'cancelWindowHours') next.cancelWindowMin = Math.round(Number(v) * 60);
      else if (k === 'rescheduleWindowHours') next.rescheduleWindowMin = Math.round(Number(v) * 60);
      else next[k] = v;
    }
    await this.prisma.staff.update({ where: { id: staffId }, data: { bookingRules: next as Prisma.InputJsonValue, updatedBy: ctx.member!.staffId, version: { increment: 1 } } });
    return this.staffClientRules(businessId, staffId);
  }

  // ─────────────────────────── правила бизнеса (F-03-079, F-03-116, В-24) ───────────────────────────

  async businessOnlineRules(businessId: string) {
    const row = await this.prisma.businessSetting.findUnique({ where: { businessId_area: { businessId, area: 'online' } } });
    const data = (row?.data as Record<string, unknown> | undefined) ?? {};
    return { businessId, consentText: data.consentText ?? DEFAULT_CONSENT_TEXT, pauseUntil: opt(data.pauseUntil as string | undefined), allowAnyStaffForAllLinks: opt(data.allowAnyStaffForAllLinks as boolean | undefined), hourCycle: (data.hourCycle as '24' | '12' | undefined) ?? '24', reviewMode: (data.reviewMode as 'star' | 'text' | undefined) ?? 'star' };
  }

  async updateBusinessOnlineRules(businessId: string, patch: BusinessOnlineRulesBody) {
    await this.prisma.businessSetting.upsert({
      where: { businessId_area: { businessId, area: 'online' } },
      create: { businessId, area: 'online', data: patch as Prisma.InputJsonValue },
      update: { data: { ...(await this.rawOnlineArea(businessId)), ...patch } as Prisma.InputJsonValue, version: { increment: 1 } },
    });
    return this.businessOnlineRules(businessId);
  }

  private async rawOnlineArea(businessId: string): Promise<Record<string, unknown>> {
    const row = await this.prisma.businessSetting.findUnique({ where: { businessId_area: { businessId, area: 'online' } } });
    return (row?.data as Record<string, unknown> | undefined) ?? {};
  }

  // ─────────────────────────── источник записи для кабинета (F-03-123) ───────────────────────────

  async onlineMeta(businessId: string, bookingId: string) {
    const row = await this.prisma.booking.findFirst({ where: { id: bookingId, businessId } });
    if (!row) throw new ApiError('not_found', 'Booking not found');
    return { bookingId: row.id, source: row.source, device: (row.onlineMeta as Record<string, unknown> | null)?.device, ...((row.onlineMeta as Record<string, unknown> | null) ?? {}) };
  }

  // ═══════════════════════════ стадия 21 (лейн client+online) ═══════════════════════════

  // ── персональный домен (F-03-037) ──

  /** Глобально: подсайт `<subdomain>.booktime.am` уникален по всей платформе, не только у одного бизнеса */
  async isSubdomainAvailable(subdomain: string, excludeLinkId?: string): Promise<boolean> {
    const clean = subdomain.trim().toLowerCase();
    if (!clean) return false;
    // Глобальная проверка (F-03-037): подсайт `<subdomain>.booktime.am` уникален по ВСЕЙ платформе, не одному
    // бизнесу — ссылок мало (одна форма на бизнес обычно), фильтруем JSON-поле в JS, а не JSON-path в MySQL.
    const rows = await this.prisma.bookingLink.findMany({ select: { id: true, config: true } });
    return !rows.some((r) => r.id !== excludeLinkId && String((r.config as Record<string, unknown>).subdomain ?? '').toLowerCase() === clean);
  }

  // ── места работы и выезд (F-00-073…081) ──

  async placesData(businessId: string, staffId: string, locationId?: string) {
    const staff = await this.prisma.staff.findFirst({ where: { id: staffId, businessId }, include: { locations: { select: { locationId: true } } } });
    if (!staff) throw new ApiError('not_found', 'Staff not found');
    const locId = locationId ?? staff.locations[0]?.locationId;
    const location = locId ? await this.prisma.location.findUnique({ where: { id: locId } }) : null;
    return { staff: sanitizePublicStaff(staff), location: location ? locationView(location) : undefined, rules: await this.staffClientRules(businessId, staffId) };
  }

  // ── «Экран данных клиента» (F-03-071…075, F-03-104) ──

  private static readonly DEFAULT_CLIENT_FIELDS = { commentHidden: false, commentRequired: false, commentLabel: 'Комментарий к записи', emailHidden: false, emailRequired: false, lastNameEnabled: false, lastNameRequired: false, patronymicEnabled: false, patronymicRequired: false, widgetText: { ru: '', en: '', hy: '' }, partnerBrands: [] as string[] };

  private clientFieldsView(businessId: string, row: Awaited<ReturnType<typeof this.prisma.onlineClientFieldsConfig.findUnique>>) {
    const d = OnlineService.DEFAULT_CLIENT_FIELDS;
    return {
      businessId,
      commentHidden: row?.commentHidden ?? d.commentHidden,
      commentRequired: row?.commentRequired ?? d.commentRequired,
      commentLabel: row?.commentLabel ?? d.commentLabel,
      emailHidden: row?.emailHidden ?? d.emailHidden,
      emailRequired: row?.emailRequired ?? d.emailRequired,
      lastNameEnabled: row?.lastNameEnabled ?? d.lastNameEnabled,
      lastNameRequired: row?.lastNameRequired ?? d.lastNameRequired,
      patronymicEnabled: row?.patronymicEnabled ?? d.patronymicEnabled,
      patronymicRequired: row?.patronymicRequired ?? d.patronymicRequired,
      customFields: arr<Record<string, unknown>>(row?.customFields),
      widgetText: row?.widgetText ?? d.widgetText,
      partnerBrands: arr<string>(row?.partnerBrands),
    };
  }

  async clientFieldsConfig(businessId: string) {
    const row = await this.prisma.onlineClientFieldsConfig.findUnique({ where: { businessId } });
    return this.clientFieldsView(businessId, row);
  }

  async updateClientFieldsConfig(ctx: RequestContext, businessId: string, patch: Record<string, unknown>) {
    const current = await this.clientFieldsConfig(businessId);
    const next = { ...current, ...patch };
    await this.prisma.onlineClientFieldsConfig.upsert({
      where: { businessId },
      create: { businessId, commentHidden: next.commentHidden, commentRequired: next.commentRequired, commentLabel: next.commentLabel, emailHidden: next.emailHidden, emailRequired: next.emailRequired, lastNameEnabled: next.lastNameEnabled, lastNameRequired: next.lastNameRequired, patronymicEnabled: next.patronymicEnabled, patronymicRequired: next.patronymicRequired, customFields: next.customFields as Prisma.InputJsonValue, widgetText: next.widgetText as Prisma.InputJsonValue, partnerBrands: next.partnerBrands as Prisma.InputJsonValue, updatedBy: ctx.member!.staffId },
      update: { commentHidden: next.commentHidden, commentRequired: next.commentRequired, commentLabel: next.commentLabel, emailHidden: next.emailHidden, emailRequired: next.emailRequired, lastNameEnabled: next.lastNameEnabled, lastNameRequired: next.lastNameRequired, patronymicEnabled: next.patronymicEnabled, patronymicRequired: next.patronymicRequired, customFields: next.customFields as Prisma.InputJsonValue, widgetText: next.widgetText as Prisma.InputJsonValue, partnerBrands: next.partnerBrands as Prisma.InputJsonValue, updatedBy: ctx.member!.staffId },
    });
    return this.clientFieldsConfig(businessId);
  }

  async addCustomClientField(ctx: RequestContext, businessId: string, field: Record<string, unknown>) {
    const current = await this.clientFieldsConfig(businessId);
    const next = { ...field, id: newId('customField'), order: current.customFields.length };
    return this.updateClientFieldsConfig(ctx, businessId, { customFields: [...current.customFields, next] });
  }

  async removeCustomClientField(ctx: RequestContext, businessId: string, fieldId: string) {
    const current = await this.clientFieldsConfig(businessId);
    return this.updateClientFieldsConfig(ctx, businessId, { customFields: current.customFields.filter((f) => f.id !== fieldId) });
  }

  async moveCustomClientField(ctx: RequestContext, businessId: string, fieldId: string, direction: -1 | 1) {
    const current = await this.clientFieldsConfig(businessId);
    const list = [...current.customFields].sort((a, b) => (a.order as number) - (b.order as number));
    const i = list.findIndex((f) => f.id === fieldId);
    const j = i + direction;
    if (i < 0 || j < 0 || j >= list.length) return current;
    [list[i], list[j]] = [list[j]!, list[i]!];
    return this.updateClientFieldsConfig(ctx, businessId, { customFields: list.map((f, idx) => ({ ...f, order: idx })) });
  }

  /**
   * Ответы клиента на свои поля с «Сохранять в карточку: Карточка клиента» (F-03-073) — последнее заполненное
   * значение по каждому такому полю среди записей клиента В ЭТОМ бизнесе (В МОКЕ — «по всем бизнесам»; Client
   * здесь — карточка одного бизнеса, у неё нет межбизнесовой идентичности, поэтому шире одного businessId
   * читать нечего — решение лейна client+online, docs/PROGRESS.md).
   */
  async clientCustomFieldAnswers(businessId: string, clientId: string): Promise<{ label: string; value: string }[]> {
    const config = await this.clientFieldsConfig(businessId);
    const fields = config.customFields.filter((f) => f.target === 'client');
    if (!fields.length) return [];
    const bookings = await this.prisma.booking.findMany({ where: { businessId, clientId, onlineMeta: { not: Prisma.JsonNull } }, orderBy: { startAt: 'desc' }, select: { onlineMeta: true } });
    const byField = new Map<string, string>();
    for (const b of bookings) {
      const values = (b.onlineMeta as Record<string, unknown> | null)?.customFieldValues as Record<string, string> | undefined;
      if (!values) continue;
      for (const f of fields) {
        const v = values[f.id as string];
        if (v && !byField.has(f.label as string)) byField.set(f.label as string, v);
      }
    }
    return [...byField.entries()].map(([label, value]) => ({ label, value }));
  }

  // ── пустые профили в каталоге (F-00-072) ──

  async businessListability(businessId: string) {
    const [staffRows, services, schedules] = await Promise.all([
      this.prisma.staff.findMany({ where: { businessId, status: 'active' }, include: { locations: { select: { locationId: true } } } }),
      this.prisma.service.findMany({ where: { businessId } }),
      this.prisma.workSchedule.findMany({ where: { businessId }, select: { staffId: true } }),
    ]);
    const scheduledStaff = new Set(schedules.map((s) => s.staffId));
    return staffRows.map((s) => {
      const serviceIds = arr<string>(s.serviceIds);
      const own = services.filter((sv) => serviceIds.includes(sv.id) && sv.active && sv.onlineBookable);
      const missing: ('services' | 'photo' | 'schedule')[] = [];
      if (own.length === 0) missing.push('services');
      if (!s.avatarUrl && arr(s.photos).length === 0) missing.push('photo');
      if (!scheduledStaff.has(s.id)) missing.push('schedule');
      return { staff: sanitizePublicStaff(s), check: { listable: missing.length === 0, missing } };
    });
  }

  // ── очередь заявок (F-00-067, F-00-071, F-03-127) ──

  private isOnlineRequestWhere(businessId: string, staffId?: string) {
    return {
      businessId,
      deletedAt: null,
      // В-05: запись из приложения — только «Я оплатил» на сверке (её заявки на подтверждение — в журнале), как мок
      source: { in: ['link', 'widget', 'app'] },
      ...(staffId ? { staffId } : {}),
      OR: [{ status: 'awaiting_confirmation' }, { status: 'awaiting_prepayment' }],
    } satisfies Prisma.BookingWhereInput;
  }

  async listOnlineRequests(businessId: string, staffId?: string) {
    const rows = await this.prisma.booking.findMany({ where: this.isOnlineRequestWhere(businessId, staffId), orderBy: { startAt: 'asc' } });
    const filtered = rows.filter((b) => {
      if (b.status === 'awaiting_confirmation') return b.source !== 'app';
      const p = (b.prepayment as Record<string, unknown> | null) ?? {};
      return Boolean(p.clientMarkedPaidAt) && !p.paid;
    });
    if (!filtered.length) return [];
    const clientIds = [...new Set(filtered.map((b) => b.clientId).filter((x): x is string => Boolean(x)))];
    const [clients, locations, services] = await Promise.all([
      this.prisma.client.findMany({ where: { id: { in: clientIds } } }),
      this.prisma.location.findMany({ where: { businessId } }),
      this.prisma.service.findMany({ where: { businessId } }),
    ]);
    const clientById = new Map(clients.map((c) => [c.id, c]));
    const locById = new Map(locations.map((l) => [l.id, l]));
    const serviceById = new Map(services.map((s) => [s.id, s]));
    const arrivedCounts = new Map<string, number>();
    if (clientIds.length) {
      const arrived = await this.prisma.booking.findMany({ where: { businessId, deletedAt: null, status: 'arrived', clientId: { in: clientIds } }, select: { clientId: true } });
      for (const a of arrived) if (a.clientId) arrivedCounts.set(a.clientId, (arrivedCounts.get(a.clientId) ?? 0) + 1);
    }
    return filtered
      .map((b) => {
        const client = b.clientId ? clientById.get(b.clientId) : undefined;
        const meta = (b.onlineMeta as Record<string, unknown> | null) ?? {};
        const p = (b.prepayment as Record<string, unknown> | null) ?? {};
        return {
          bookingId: b.id,
          staffId: b.staffId,
          clientId: b.clientId ?? undefined,
          clientName: client?.name ?? '—',
          clientPhone: client?.phone ?? '',
          clientNoShowCount: client?.noShowCount ?? 0,
          clientBlocked: client?.blocked ?? false,
          start: utcToLocal(b.startAt),
          durationMin: b.durationMin,
          serviceNames: arr<{ serviceId: string }>(b.services).map((l) => serviceById.get(l.serviceId)?.name).filter((n): n is Record<string, string> => Boolean(n)).map((n) => n.ru),
          workplace: b.workplace,
          district: b.workplace === 'visit' ? locById.get(b.locationId)?.district ?? undefined : undefined,
          address: undefined,
          submittedAt: opt(meta.submittedAt as string | undefined),
          clientVisits: b.clientId ? (arrivedCounts.get(b.clientId) ?? 0) : 0,
          comment: opt(b.comment ?? undefined),
          // ⭐ Предоплата «за то, что не приходил» (владелец, 01.10.2026) — салон видит причину в заявке
          prepaymentNoShows:
            b.status === 'awaiting_prepayment' && p.reason === 'no_shows' ? { noShows: Number(p.noShows ?? 0), months: Number(p.months ?? 12) } : undefined,
          prepaymentReported: p.clientMarkedPaidAt ? { amount: (p as { amount?: number }).amount ?? 0, at: p.clientMarkedPaidAt as string } : undefined,
          offeredStarts: arr<string>(meta.offeredStarts),
        };
      })
      .sort((a, b) => (a.submittedAt ?? a.start).localeCompare(b.submittedAt ?? b.start));
  }

  async countPendingRequests(businessId: string, staffId?: string): Promise<number> {
    return (await this.listOnlineRequests(businessId, staffId)).length;
  }

  /** История смены статуса (F-00-068) — читаем готовый BookingEvent (kind: created | status) журнала (этап 7) */
  async bookingStatusLog(businessId: string, bookingId: string): Promise<{ status: string; at: string; by: 'client' | 'staff' }[]> {
    const booking = await this.prisma.booking.findFirst({ where: { id: bookingId, businessId }, select: { id: true } });
    if (!booking) throw new ApiError('not_found', 'Booking not found');
    const events = await this.prisma.bookingEvent.findMany({ where: { bookingId, kind: { in: ['created', 'status'] } }, orderBy: { at: 'asc' } });
    return events.map((e) => ({ status: e.toStatus ?? 'created', at: utcToLocal(e.at), by: e.byRef === 'client' ? 'client' : 'staff' }));
  }

  async respondToRequest(ctx: RequestContext, businessId: string, bookingId: string, action: 'confirm' | 'decline') {
    if (action !== 'confirm' && action !== 'decline') throw new ApiError('validation', 'action must be confirm or decline');
    const actor = staffActor(ctx);
    return action === 'confirm' ? this.bookings.confirm(actor, [businessId], bookingId) : this.bookings.decline(actor, [businessId], bookingId);
  }

  /** О28 «Другое время»: ближайшие свободные окна того же мастера, до `limit`, максимум 2 в один день */
  async suggestOtherTimes(businessId: string, bookingId: string, limit = 6): Promise<string[]> {
    const b = await this.prisma.booking.findFirst({ where: { id: bookingId, businessId } });
    if (!b) throw new ApiError('not_found', 'Booking not found');
    const services = arr<{ serviceId: string }>(b.services);
    const startLocal = utcToLocal(b.startAt);
    const today0 = utcToLocal(new Date()).slice(0, 10);
    const out: string[] = [];
    let cursor = today0 > startLocal.slice(0, 10) ? today0 : startLocal.slice(0, 10);
    const nowIso = utcToLocal(new Date());
    for (let i = 0; i < 14 && out.length < limit; i++) {
      const slots = await this.availability.freeSlots(businessId, { staffId: b.staffId, date: cursor, durationMin: b.durationMin, locationId: b.locationId, serviceId: services[0]?.serviceId });
      let addedToday = 0;
      for (const sl of slots) {
        if (addedToday >= 2 || out.length >= limit) break;
        if (sl.start === startLocal || sl.start < nowIso) continue;
        out.push(sl.start);
        addedToday++;
      }
      cursor = nextDay(cursor);
    }
    return out;
  }

  /** О28: сохраняем предложенные окна у записи (это не смена Booking.status — только пометка кабинета) */
  async offerOtherTimes(ctx: RequestContext, businessId: string, bookingId: string, starts: string[]): Promise<string[]> {
    if (!starts.length) throw new ApiError('validation', 'Выберите хотя бы одно окно');
    const b = await this.prisma.booking.findFirst({ where: { id: bookingId, businessId } });
    if (!b) throw new ApiError('not_found', 'Booking not found');
    const offered = starts.slice(0, 3);
    // Предлагать можно только свободное окно в графике мастера (final-fix 01.10): раньше сервер принимал любое
    // время, а клиент, нажав его, получал «Это время уже заняли». Та же проверка, что у suggestOtherTimes.
    const services = arr<{ serviceId: string }>(b.services);
    const nowIso = utcToLocal(new Date());
    for (const start of offered) {
      const at = start.slice(0, 16);
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(at) || at < nowIso.slice(0, 16)) throw new ApiError('slot_taken', 'Это время занято или вне графика мастера');
      const slots = await this.availability.freeSlots(businessId, { staffId: b.staffId, date: at.slice(0, 10), durationMin: b.durationMin, locationId: b.locationId, serviceId: services[0]?.serviceId });
      if (!slots.some((sl) => sl.start.slice(0, 16) === at)) throw new ApiError('slot_taken', 'Это время занято или вне графика мастера');
    }
    const meta = { ...((b.onlineMeta as Record<string, unknown> | null) ?? {}), offeredStarts: offered };
    await this.prisma.$transaction([
      this.prisma.booking.update({ where: { id: bookingId }, data: { onlineMeta: meta as Prisma.InputJsonValue } }),
      this.prisma.bookingEvent.create({ data: { id: newId('bookingEvent'), bookingId, businessId, staffId: b.staffId, clientId: b.clientId, appUserId: b.appUserId, kind: 'status', toStatus: 'time_offered', byRef: ctx.member!.staffId, startLocal: utcToLocal(b.startAt) } }),
    ]);
    return offered;
  }

  // ═══════════════════════════ стадия 21 (лейн client+online), попытка 2 ═══════════════════════════
  // Остаток `online.ts` (docs/PROGRESS.md, попытка 1): 6 маленьких сущностей (промоблок, пакет, звёздочка,
  // событие виджета, приглашение в окно, лист ожидания виджета) — одной общей таблицей `OnlineRecord`, тем же
  // приёмом, что и `FinRecord` у лейна finance+stock (см. схему) — вместо шести отдельных таблиц. Настройки
  // «мастер×услуга», интеграции, мобильные ссылки, API-ключ — в уже существующем JSON бизнеса (area 'online'),
  // рядом с hourCycle/consentText. Правила групповой записи — в уже существующем BookingLink.config, рядом с
  // остальными настройками ссылки (тот же приём, что staffDisplayField/theme у createLink).

  private orView(r: { id: string; businessId: string; createdAt: Date; data: unknown }) {
    return { id: r.id, businessId: r.businessId, createdAt: utcToLocal(r.createdAt), ...((r.data as Record<string, unknown>) ?? {}) };
  }

  // ── настройка онлайн-записи услуги (F-03-129) ──

  private async serviceConfigRow(businessId: string, serviceId: string) {
    return this.prisma.onlineRecord.findFirst({ where: { businessId, kind: 'serviceConfig', refId: serviceId } });
  }

  async serviceOnlineConfig(businessId: string, serviceId: string) {
    const svc = await this.prisma.service.findFirst({ where: { id: serviceId, businessId } });
    if (!svc) throw new ApiError('not_found', 'Service not found');
    const row = await this.serviceConfigRow(businessId, serviceId);
    return { serviceId, ...((row?.data as Record<string, unknown> | undefined) ?? {}) };
  }

  async updateServiceOnlineConfig(businessId: string, serviceId: string, patch: Record<string, unknown>) {
    const svc = await this.prisma.service.findFirst({ where: { id: serviceId, businessId } });
    if (!svc) throw new ApiError('not_found', 'Service not found');
    const row = await this.serviceConfigRow(businessId, serviceId);
    const next = pruneUndefined({ ...((row?.data as Record<string, unknown>) ?? {}), ...patch });
    if (row) await this.prisma.onlineRecord.update({ where: { id: row.id }, data: { data: next as Prisma.InputJsonValue } });
    else await this.prisma.onlineRecord.create({ data: { id: newId('onlineRecord'), businessId, kind: 'serviceConfig', refId: serviceId, data: next as Prisma.InputJsonValue } });
    return this.serviceOnlineConfig(businessId, serviceId);
  }

  /** Карта serviceId → конфиг, для публичной страницы (F-03-129) */
  private async serviceConfigsMap(businessId: string, serviceIds: string[]): Promise<Record<string, unknown>> {
    if (!serviceIds.length) return {};
    const rows = await this.prisma.onlineRecord.findMany({ where: { businessId, kind: 'serviceConfig', refId: { in: serviceIds } } });
    return Object.fromEntries(rows.map((r) => [r.refId as string, { serviceId: r.refId, ...(r.data as Record<string, unknown>) }]));
  }

  /** Карта пакетов, включённых онлайн, для публичной страницы (F-03-130) */
  private async publicPackages(businessId: string) {
    const rows = await this.prisma.onlineRecord.findMany({ where: { businessId, kind: 'package' } });
    return rows.filter((r) => (r.data as Record<string, unknown>).online === true).map((r) => this.orView(r));
  }

  // ── пара «мастер×услуга» (F-03-133) ──

  async staffServiceOnlineFlags(businessId: string): Promise<Record<string, boolean>> {
    const data = await this.rawOnlineArea(businessId);
    return (data.staffServiceOnline as Record<string, boolean> | undefined) ?? {};
  }

  async setStaffServiceOnline(businessId: string, staffId: string, serviceId: string, online: boolean): Promise<Record<string, boolean>> {
    const data = await this.rawOnlineArea(businessId);
    const flags = { ...((data.staffServiceOnline as Record<string, boolean> | undefined) ?? {}) };
    const key = `${staffId}:${serviceId}`;
    if (online) delete flags[key];
    else flags[key] = false;
    await this.upsertOnlineArea(businessId, data, { staffServiceOnline: flags });
    return flags;
  }

  /** Merge-и-запись в BusinessSetting(area:'online') одним местом — используют все настройки ниже */
  private async upsertOnlineArea(businessId: string, current: Record<string, unknown>, patch: Record<string, unknown>): Promise<void> {
    const data = { ...current, ...patch };
    await this.prisma.businessSetting.upsert({
      where: { businessId_area: { businessId, area: 'online' } },
      create: { businessId, area: 'online', data: data as Prisma.InputJsonValue },
      update: { data: data as Prisma.InputJsonValue, version: { increment: 1 } },
    });
  }

  // ── мобильные приложения (F-03-048) ──

  async mobileAppLinks(businessId: string) {
    const data = await this.rawOnlineArea(businessId);
    const m = (data.mobileApp as Record<string, unknown> | undefined) ?? {};
    return { businessId, iosUrl: opt(m.iosUrl as string | undefined), androidUrl: opt(m.androidUrl as string | undefined), consultRequestedAt: opt(m.consultRequestedAt as string | undefined) };
  }

  async updateMobileAppLinks(businessId: string, patch: Record<string, unknown>) {
    const data = await this.rawOnlineArea(businessId);
    const next = pruneUndefined({ ...((data.mobileApp as Record<string, unknown>) ?? {}), ...patch });
    await this.upsertOnlineArea(businessId, data, { mobileApp: next });
    return this.mobileAppLinks(businessId);
  }

  // ── другие каналы записи, демо-подключение (F-03-036…046) ──

  private static readonly INTEGRATION_IDS = ['ownApi', 'metaBookNow', 'googleReserve', 'yandexMaps', 'twoGis', 'earlyone', 'doqKz', 'thirdPartyBots'] as const;
  private static readonly UNAVAILABLE_IN_ARMENIA = new Set(['googleReserve', 'twoGis', 'doqKz']);

  async listIntegrations(businessId: string) {
    const data = await this.rawOnlineArea(businessId);
    const stored = (data.integrations as Record<string, { connected: boolean; connectedAt?: string }> | undefined) ?? {};
    return OnlineService.INTEGRATION_IDS.map((id) => (stored[id] ? { id, ...stored[id] } : { id, connected: false }));
  }

  async setIntegrationConnected(businessId: string, id: string, connected: boolean) {
    if (!(OnlineService.INTEGRATION_IDS as readonly string[]).includes(id)) throw new ApiError('not_found', 'Unknown integration');
    if (connected && OnlineService.UNAVAILABLE_IN_ARMENIA.has(id)) throw new ApiError('integration_unavailable', 'Пока недоступно в Армении по справке партнёра');
    const data = await this.rawOnlineArea(businessId);
    const stored = { ...((data.integrations as Record<string, unknown> | undefined) ?? {}) };
    const entry = { id, connected, connectedAt: connected ? utcToLocal(new Date()) : undefined };
    stored[id] = entry;
    await this.upsertOnlineArea(businessId, data, { integrations: stored });
    return entry;
  }

  /** Демо-ключ своего API (F-03-036) — только отображение, реальной проверки Bearer этим ключом ещё нет (Р19) */
  async apiCredentials(businessId: string) {
    const data = await this.rawOnlineArea(businessId);
    const c = (data.apiCredentials as { apiKey?: string; createdAt?: string } | undefined) ?? {};
    return { businessId, apiKey: opt(c.apiKey), createdAt: opt(c.createdAt) };
  }

  async generateApiKey(businessId: string) {
    const key = `bp_live_${randomBytes(16).toString('hex')}`;
    const data = await this.rawOnlineArea(businessId);
    const creds = { apiKey: key, createdAt: utcToLocal(new Date()) };
    await this.upsertOnlineArea(businessId, data, { apiCredentials: creds });
    return { businessId, ...creds };
  }

  async revokeApiKey(businessId: string): Promise<void> {
    const data = await this.rawOnlineArea(businessId);
    await this.upsertOnlineArea(businessId, data, { apiCredentials: {} });
  }

  // ── пакеты услуг / комплексы (F-03-130) ──

  async listOnlinePackages(businessId: string) {
    const rows = await this.prisma.onlineRecord.findMany({ where: { businessId, kind: 'package' }, orderBy: { createdAt: 'asc' } });
    return rows.map((r) => this.orView(r));
  }

  async createOnlinePackage(businessId: string, input: { name: string; serviceIds: string[]; mode: string }) {
    const data = { name: { ru: input.name, en: input.name, hy: input.name }, serviceIds: input.serviceIds, mode: input.mode, online: false };
    const row = await this.prisma.onlineRecord.create({ data: { id: newId('onlineRecord'), businessId, kind: 'package', data: data as Prisma.InputJsonValue } });
    return this.orView(row);
  }

  async updateOnlinePackage(businessId: string, id: string, patch: Record<string, unknown>) {
    const row = await this.prisma.onlineRecord.findFirst({ where: { id, businessId, kind: 'package' } });
    if (!row) throw new ApiError('not_found', 'Пакет не найден');
    const next = pruneUndefined({ ...(row.data as Record<string, unknown>), ...patch });
    const updated = await this.prisma.onlineRecord.update({ where: { id }, data: { data: next as Prisma.InputJsonValue } });
    return this.orView(updated);
  }

  async deleteOnlinePackage(businessId: string, id: string): Promise<void> {
    await this.prisma.onlineRecord.deleteMany({ where: { id, businessId, kind: 'package' } });
  }

  // ── промоблок в виджете (F-03-106) ──

  async listPromoBlocks(businessId: string) {
    const rows = await this.prisma.onlineRecord.findMany({ where: { businessId, kind: 'promoBlock' }, orderBy: { createdAt: 'asc' } });
    return rows.map((r) => this.orView(r));
  }

  /** F-00-168/F-03-106: новые тексты и картинки видны клиентам только после нашей проверки — как у heroImageUrl
   * ссылки. Очереди «наша панель → модерация» на промоблоки пока нет (ModerationKind платформы их не знает) —
   * «На проверке» держится своим статусом здесь; approve/reject у наc пока не строит ничего (не в этом заходе,
   * см. docs/PROGRESS.md — публичная сторона тоже пока не отдаёт промоблоки в getPublicBusinessData). */
  async createPromoBlock(businessId: string, input: Record<string, unknown>) {
    const data = { ...input, status: 'pending', enabled: true };
    const row = await this.prisma.onlineRecord.create({ data: { id: newId('onlineRecord'), businessId, kind: 'promoBlock', data: data as Prisma.InputJsonValue } });
    return this.orView(row);
  }

  async updatePromoBlock(businessId: string, id: string, patch: Record<string, unknown>) {
    const row = await this.prisma.onlineRecord.findFirst({ where: { id, businessId, kind: 'promoBlock' } });
    if (!row) throw new ApiError('not_found', 'Промоблок не найден');
    const next = pruneUndefined({ ...(row.data as Record<string, unknown>), ...patch });
    const updated = await this.prisma.onlineRecord.update({ where: { id }, data: { data: next as Prisma.InputJsonValue } });
    return this.orView(updated);
  }

  async deletePromoBlock(businessId: string, id: string): Promise<void> {
    await this.prisma.onlineRecord.deleteMany({ where: { id, businessId, kind: 'promoBlock' } });
  }

  // ── звёздочка вместо отзывов (F-00-116/117, F-03-105) ──

  async starCount(businessId: string, target: string, targetId: string): Promise<number> {
    const rows = await this.prisma.onlineRecord.findMany({ where: { businessId, kind: 'review' }, select: { data: true } });
    return rows.filter((r) => {
      const d = r.data as Record<string, unknown>;
      return d.target === target && d.targetId === targetId;
    }).length;
  }

  async hasReviewed(bookingId: string, target: string): Promise<boolean> {
    const rows = await this.prisma.onlineRecord.findMany({ where: { refId: bookingId, kind: 'review' }, select: { data: true } });
    return rows.some((r) => (r.data as Record<string, unknown>).target === target);
  }

  /** «Уже ли поставлена звёздочка» по ссылке без входа — только с хэшем ссылки (?h=), как остальные маршруты записи */
  async hasReviewedByHash(bookingId: string, hash: string, target: string): Promise<boolean> {
    await this.findByHash(bookingId, hash);
    return this.hasReviewed(bookingId, target);
  }

  /** Клиент ставит звёздочку по своей записи (F-00-116) — без входа, но только с хэшем ссылки «Вы записаны» (?h=):
   * раньше хэш не требовался, и по id любой записи можно было поставить звезду (qa/full-test-0930 backend.md, вопрос 3). */
  async addReviewByBooking(bookingId: string, hash: string, input: { target: string; targetId: string; clientId: string }) {
    const booking = await this.findByHash(bookingId, hash);
    // Звезда — только тому, у кого была эта запись: иначе по id любой записи можно было ставить звёзды любому мастеру/месту
    const expected = input.target === 'business' ? booking.businessId : booking.staffId;
    if (input.targetId !== expected) throw new ApiError('validation', 'Review target does not match the booking', { targetId: 'mismatch' });
    if (await this.hasReviewed(bookingId, input.target)) throw new ApiError('already_rated', 'Вы уже поставили звёздочку за эту запись');
    const data = { target: input.target, targetId: input.targetId, bookingId, clientId: input.clientId };
    const row = await this.prisma.onlineRecord.create({ data: { id: newId('onlineRecord'), businessId: booking.businessId, kind: 'review', refId: bookingId, data: data as Prisma.InputJsonValue } });
    return this.orView(row);
  }

  // ── события виджета для аналитики (F-03-117…122) ──

  private static readonly MAX_WIDGET_EVENTS = 200;

  async trackWidgetEvent(businessId: string, linkId: string | undefined, type: string): Promise<void> {
    if (!linkId) return;
    await this.prisma.onlineRecord.create({ data: { id: newId('onlineRecord'), businessId, kind: 'widgetEvent', linkId, data: { type } as Prisma.InputJsonValue } });
    const count = await this.prisma.onlineRecord.count({ where: { linkId, kind: 'widgetEvent' } });
    const cap = OnlineService.MAX_WIDGET_EVENTS * 4;
    if (count > cap) {
      const excess = await this.prisma.onlineRecord.findMany({ where: { linkId, kind: 'widgetEvent' }, orderBy: { createdAt: 'asc' }, take: count - cap, select: { id: true } });
      await this.prisma.onlineRecord.deleteMany({ where: { id: { in: excess.map((e) => e.id) } } });
    }
  }

  async listWidgetEvents(linkId: string) {
    const rows = await this.prisma.onlineRecord.findMany({ where: { linkId, kind: 'widgetEvent' }, orderBy: { createdAt: 'desc' }, take: OnlineService.MAX_WIDGET_EVENTS });
    return rows.map((r) => ({ id: r.id, linkId: r.linkId!, businessId: r.businessId, type: (r.data as Record<string, unknown>).type as string, at: utcToLocal(r.createdAt) }));
  }

  // ── групповая запись: настройка ссылки (F-03-076, F-03-102) ──

  private static readonly DEFAULT_GROUP_RULES = { allowExtraSeats: false, maxSeatsPerBooking: 1, allowMultiEvent: false, maxEventsPerBooking: 3 };

  async groupBookingRules(linkId: string) {
    const link = await this.prisma.bookingLink.findUnique({ where: { id: linkId } });
    if (!link) throw new ApiError('not_found', 'Link not found');
    const cfg = (link.config as Record<string, unknown>).groupBookingRules as Record<string, unknown> | undefined;
    return { linkId, ...OnlineService.DEFAULT_GROUP_RULES, ...cfg };
  }

  async updateGroupBookingRules(businessId: string, linkId: string, patch: Record<string, unknown>) {
    const link = await this.prisma.bookingLink.findFirst({ where: { id: linkId, businessId } });
    if (!link) throw new ApiError('not_found', 'Link not found');
    const current = await this.groupBookingRules(linkId);
    const { linkId: _l, ...rest } = current;
    void _l;
    const next = { ...rest, ...patch };
    await this.prisma.bookingLink.update({ where: { id: linkId }, data: { config: { ...(link.config as Record<string, unknown>), groupBookingRules: next } as Prisma.InputJsonValue } });
    return this.groupBookingRules(linkId);
  }

  // ── лист ожидания виджета (F-03-086, ⭐ F-00-101/102) ──
  // С 01.10.2026 — в ОДИН лист ожидания бизнеса (waitlist_entries, source 'widget'): его видят /biz/waitlist и панель
  // журнала, раздача окна (В-18) и «Найти окно». Старые online_records kind='waitlist' перенесены миграцией
  // 20261001233000_waitlist_all_sources. Ответ — прежний вид для виджета (waitlistRequestOut).

  async joinOnlineWaitlist(input: { businessId: string; locationId?: string; staffId: string; serviceId: string; date: string; clientName: string; clientPhone: string; comment?: string }) {
    const phone = normalizePhone(input.clientPhone);
    if (!phone) throw new ApiError('invalid_phone', 'Проверьте номер телефона');
    if (!input.clientName.trim()) throw new ApiError('invalid_input', 'Укажите имя');
    const day = /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : undefined;
    const view = (e: { id: string; businessId: string; locationId: string | null; clientName: string; clientPhone: string; comment: string; bookingId: string | null; createdAt: Date }) => ({
      id: e.id,
      businessId: e.businessId,
      ...(e.locationId ? { locationId: e.locationId } : {}),
      staffId: input.staffId,
      serviceId: input.serviceId,
      date: input.date,
      clientName: e.clientName,
      clientPhone: e.clientPhone,
      ...(e.comment ? { comment: e.comment } : {}),
      status: e.bookingId ? ('booked' as const) : ('pending' as const),
      createdAt: utcToLocal(e.createdAt),
    });
    // Тот же номер уже ждёт эту услугу у этого мастера в этот день — вторую заявку не заводим
    const open = await this.prisma.waitlistEntry.findMany({ where: { businessId: input.businessId, clientPhone: phone, bookingId: null } });
    const same = open.find((e) => {
      const wishes = (Array.isArray(e.wishes) ? e.wishes : []) as { date?: string }[];
      const services = (Array.isArray(e.serviceIds) ? e.serviceIds : []) as string[];
      const staff = (Array.isArray(e.staffIds) ? e.staffIds : []) as string[];
      return services.includes(input.serviceId) && (staff.length === 0 || staff.includes(input.staffId)) && (wishes.length === 0 || wishes.some((w) => !w.date || w.date === day));
    });
    if (same) return view(same);
    const client = await this.prisma.client.findFirst({ where: { businessId: input.businessId, phone, deletedAt: null }, select: { id: true } });
    const row = await this.prisma.waitlistEntry.create({
      data: {
        id: newId('waitlistEntry'),
        businessId: input.businessId,
        locationId: input.locationId ?? null,
        clientName: input.clientName.trim().slice(0, 160),
        clientPhone: phone,
        clientId: client?.id ?? null,
        source: 'widget',
        serviceIds: [input.serviceId],
        staffIds: [input.staffId],
        wishes: (day ? [{ date: day }] : []) as Prisma.InputJsonValue,
        comment: input.comment?.trim().slice(0, 2000) ?? '',
        tags: [],
      },
    });
    return view(row);
  }

  // ── «Кого позвать» (F-03-052) ──

  /**
   * «Кого позвать» (F-03-052) — порт slotCandidatesOf мока (qa/full-test-0930 online.md №8):
   * - «Обычно ходит» — визит «Пришёл» к этому мастеру за 90 дней примерно в тот же час; отмены и неявки не в счёт;
   * - «Пора снова» — правило dueAtOf (как «Пора записать» в «Клиентах»): последний визит «Пришёл» + самый короткий
   *   интервал повтора его услуг; у услуги нет интервала — срока нет; есть будущая активная запись в салоне — не звать;
   *   самые просроченные — первыми;
   * - один клиент — одно окно; дни — по Еревану.
   */
  private async slotCandidatesOf(businessId: string, staffId: string, days: number) {
    type Candidate = { slotStart: string; staffId: string; clientId: string; clientName: string; clientPhone: string; reason: 'regular' | 'dueAgain'; serviceId?: string };
    const staff = await this.prisma.staff.findFirst({ where: { id: staffId, businessId } });
    if (!staff) return [] as Candidate[];
    const bookings = await this.prisma.booking.findMany({ where: { businessId, staffId, deletedAt: null } });
    // `Client.blocked` — `Boolean?`: NULL значит «не заблокирован»; только явный OR ловит оба случая (см. историю правки)
    const clients = await this.prisma.client.findMany({ where: { businessId, deletedAt: null, OR: [{ blocked: null }, { blocked: false }] } });
    const clientsById = new Map(clients.map((c) => [c.id, c] as const));
    const out: Candidate[] = [];
    const todayLocal = utcToLocal(new Date()).slice(0, 10);
    const since90 = localToUtc(`${addDaysLocal(todayLocal, -90)}T00:00`);
    const arrived = bookings.filter((b) => b.status === 'arrived' && b.clientId);
    let cursor = todayLocal;
    for (let d = 0; d < days && out.length < 8; d++) {
      const slots = await this.availability.freeSlots(businessId, { staffId, date: cursor, durationMin: 30 });
      for (const slot of slots) {
        if (out.length >= 8) break;
        const hour = Number(slot.start.slice(11, 13));
        const regular = arrived.find((b) => {
          if (b.startAt < since90 || !clientsById.has(b.clientId!) || out.some((o) => o.clientId === b.clientId)) return false;
          return Math.abs(Number(utcToLocal(b.startAt).slice(11, 13)) - hour) <= 1;
        });
        const c = regular ? clientsById.get(regular.clientId!) : undefined;
        if (regular && c) out.push({ slotStart: slot.start, staffId, clientId: c.id, clientName: c.name, clientPhone: c.phone, reason: 'regular', serviceId: arr<{ serviceId: string }>(regular.services)[0]?.serviceId });
      }
      cursor = nextDay(cursor);
    }
    if (out.length < 8) {
      const now = new Date();
      const future = await this.prisma.booking.findMany({
        where: { businessId, deletedAt: null, clientId: { not: null }, startAt: { gt: now }, status: { in: ['scheduled', 'client_confirmed', 'awaiting_confirmation', 'awaiting_prepayment'] } },
        select: { clientId: true },
      });
      const hasFuture = new Set(future.map((b) => b.clientId!));
      const lastVisit = new Map<string, (typeof bookings)[number]>();
      for (const b of arrived) {
        const prev = lastVisit.get(b.clientId!);
        if (!prev || b.startAt > prev.startAt) lastVisit.set(b.clientId!, b);
      }
      const intervals = new Map(
        (await this.prisma.service.findMany({ where: { businessId, repeatIntervalDays: { gt: 0 } }, select: { id: true, repeatIntervalDays: true } })).map((sv) => [sv.id, sv.repeatIntervalDays!] as const),
      );
      const dueAtOf = (b: (typeof bookings)[number]): string | undefined => {
        const ds = arr<{ serviceId: string }>(b.services).map((l) => intervals.get(l.serviceId)).filter((n): n is number => Boolean(n && n > 0));
        return ds.length ? addDaysLocal(utcToLocal(b.startAt).slice(0, 10), Math.min(...ds)) : undefined;
      };
      const dueAgain = [...lastVisit.entries()]
        .filter(([id]) => clientsById.has(id) && !hasFuture.has(id) && !out.some((o) => o.clientId === id))
        .map(([id, last]) => ({ id, dueAt: dueAtOf(last) }))
        .filter((x): x is { id: string; dueAt: string } => Boolean(x.dueAt && x.dueAt <= todayLocal))
        .sort((a, b) => a.dueAt.localeCompare(b.dueAt))
        .map((x) => clientsById.get(x.id)!);
      const used = new Set(out.map((o) => o.slotStart));
      let cursor2 = todayLocal;
      outer: for (let d = 0; d < days; d++) {
        const slots = await this.availability.freeSlots(businessId, { staffId, date: cursor2, durationMin: 30 });
        for (const slot of slots) {
          if (out.length >= 8) break outer;
          if (used.has(slot.start)) continue;
          const c = dueAgain.shift();
          if (!c) break outer;
          out.push({ slotStart: slot.start, staffId, clientId: c.id, clientName: c.name, clientPhone: c.phone, reason: 'dueAgain' });
          used.add(slot.start);
        }
        cursor2 = nextDay(cursor2);
      }
    }
    return out;
  }

  async slotCandidates(businessId: string, staffId: string, days = 3) {
    return this.slotCandidatesOf(businessId, staffId, days);
  }

  async firstStaffWithCandidates(businessId: string, staffIds: string[]): Promise<string | undefined> {
    for (const id of staffIds) if ((await this.slotCandidatesOf(businessId, id, 3)).length > 0) return id;
    return staffIds[0];
  }

  async inviteToSlot(businessId: string, candidate: { slotStart: string; staffId: string; clientId: string; clientName: string; clientPhone: string; serviceId?: string }, message: string) {
    const data = { staffId: candidate.staffId, clientId: candidate.clientId, clientName: candidate.clientName, slotStart: candidate.slotStart, serviceId: candidate.serviceId, message };
    const row = await this.prisma.onlineRecord.create({ data: { id: newId('onlineRecord'), businessId, kind: 'slotInvite', refId: candidate.staffId, data: pruneUndefined(data) as Prisma.InputJsonValue } });
    return { id: row.id, businessId, sentAt: utcToLocal(row.createdAt), ...(row.data as Record<string, unknown>) };
  }

  async listSlotInvites(businessId: string) {
    const rows = await this.prisma.onlineRecord.findMany({ where: { businessId, kind: 'slotInvite' }, orderBy: { createdAt: 'desc' } });
    return rows.map((r) => ({ id: r.id, businessId, sentAt: utcToLocal(r.createdAt), ...(r.data as Record<string, unknown>) }));
  }

  // ── групповые события в виджете (F-03-101) и запись на них (F-03-076, F-03-101) ──

  private groupEventView(e: { id: string; businessId: string; locationId: string; serviceId: string; staffId: string; startAt: Date; durationMin: number; capacity: number; resourceIds: unknown; onlineUrl: string | null; seriesId: string | null; status: string; createdAt: Date }) {
    return {
      id: e.id,
      businessId: e.businessId,
      locationId: e.locationId,
      serviceId: e.serviceId,
      staffId: e.staffId,
      start: utcToLocal(e.startAt),
      durationMin: e.durationMin,
      capacity: e.capacity,
      resourceIds: arr<string>(e.resourceIds),
      onlineUrl: opt(e.onlineUrl ?? undefined),
      seriesId: opt(e.seriesId ?? undefined),
      status: e.status as 'scheduled' | 'cancelled',
      createdAt: utcToLocal(e.createdAt),
    };
  }

  private static readonly GROUP_ACTIVE_STATUSES = ['scheduled', 'awaiting_confirmation', 'client_confirmed', 'arrived'] as const;

  async listPublicGroupEvents(businessId: string, serviceId?: string) {
    const events = await this.prisma.groupEvent.findMany({ where: { businessId, status: 'scheduled', startAt: { gte: new Date() }, ...(serviceId ? { serviceId } : {}) }, orderBy: { startAt: 'asc' } });
    if (!events.length) return [];
    const serviceIds = [...new Set(events.map((e) => e.serviceId))];
    const staffIds = [...new Set(events.map((e) => e.staffId))];
    const [services, staffRows] = await Promise.all([
      this.prisma.service.findMany({ where: { id: { in: serviceIds } } }),
      this.prisma.staff.findMany({ where: { id: { in: staffIds } } }),
    ]);
    const svcById = new Map(services.map((s) => [s.id, s]));
    const staffById = new Map(staffRows.map((s) => [s.id, s]));
    const out: { event: ReturnType<OnlineService['groupEventView']>; service?: ReturnType<typeof serviceView>; staff?: ReturnType<typeof sanitizePublicStaff>; seatsTaken: number; seatsLeft: number }[] = [];
    for (const e of events) {
      const svc = svcById.get(e.serviceId);
      if (!svc || !svc.active || !svc.onlineBookable) continue;
      const seatsTaken = await this.prisma.booking.count({ where: { groupEventId: e.id, deletedAt: null, status: { in: [...OnlineService.GROUP_ACTIVE_STATUSES] } } });
      const staff = staffById.get(e.staffId);
      out.push({ event: this.groupEventView(e), service: serviceView(svc), staff: staff ? sanitizePublicStaff(staff) : undefined, seatsTaken, seatsLeft: Math.max(0, e.capacity - seatsTaken) });
    }
    return out;
  }

  /**
   * Запись на групповое событие с местами (F-03-076, F-03-101) — тот же путь, что `addParticipant` раздела
   * resources (`this.bookings.place()` с `groupEventId`, замок не мешает нескольким одновременным местам того же
   * события), но без сессии сотрудника: клиентский актёр, свой accessHash (как у `createBooking` выше). Проверку
   * кода сервером здесь НЕ делаем — виджет группового мастера сам генерирует демо-код и сверяет его локально
   * (`GroupBookingFlow.tsx`, `src/areas/**`, не наш файл трогать нельзя) и передаёт `phoneVerified: true` — тот же
   * уровень доверия, что был у мока; решение лейна client+online, docs/PROGRESS.md.
   */
  async createGroupOnlineBooking(businessId: string, input: { locationId: string; groupEventId: string; seats: number; clientName: string; clientPhone: string; comment?: string; linkId?: string; formId?: string; source: string; device: string; phoneVerified: boolean; payByMembership?: boolean }) {
    if (!input.phoneVerified) throw new ApiError('phone_not_verified', 'Подтвердите номер телефона кодом');
    const phone = normalizePhone(input.clientPhone);
    if (!phone) throw new ApiError('invalid_phone', 'Проверьте номер телефона');
    const event = await this.prisma.groupEvent.findFirst({ where: { id: input.groupEventId, businessId, status: 'scheduled' } });
    if (!event) throw new ApiError('not_found', 'Событие не найдено');
    const seatsTaken = await this.prisma.booking.count({ where: { groupEventId: event.id, deletedAt: null, status: { in: [...OnlineService.GROUP_ACTIVE_STATUSES] } } });
    if (seatsTaken + input.seats > event.capacity) throw new ApiError('slot_taken', 'Свободных мест не осталось');

    const result = await this.bookings.place(clientActor(null, 'client'), {
      source: input.source,
      businessId,
      locationId: input.locationId,
      staffId: event.staffId,
      start: utcToLocal(event.startAt),
      services: [{ serviceId: event.serviceId, qty: Math.max(1, input.seats), unitPrice: input.payByMembership ? 0 : undefined }],
      groupEventId: event.id,
      client: { phone, name: input.clientName },
      comment: input.comment,
    });

    const raw = randomBytes(16).toString('hex');
    const row = await this.prisma.booking.findUniqueOrThrow({ where: { id: result.booking.id } });
    const expiresAt = new Date(row.endAt.getTime() + 7 * 86_400_000);
    const meta = { linkId: input.linkId, formId: input.formId, widgetGen: 'new' as const, device: input.device, phoneVerified: true, paidByMembership: input.payByMembership };
    await this.prisma.booking.update({ where: { id: row.id }, data: { accessHash: hashOf(raw), accessHashExpiresAt: expiresAt, onlineMeta: pruneUndefined(meta) as Prisma.InputJsonValue } });

    let client = result.client as Record<string, unknown> | undefined;
    if (!client && row.clientId) {
      const c = await this.prisma.client.findUnique({ where: { id: row.clientId } });
      if (c) client = coreClient(c);
    }
    return { booking: result.booking, client, accessHash: raw };
  }

  // ── личный кабинет клиента в виджете (F-03-109…112) ──

  /**
   * Вход по номеру и коду (демо — F-03-077, тот же уровень доверия, что у виджета: код сверяется в `CabinetScreen.tsx`,
   * не здесь). «Раздача ссылки „управлять записью“» (accessHashes) — `accessHash` в базе хранится ХЕШЕМ (никогда не
   * восстановить сырой токен), поэтому новый токен выдаём только записям, у которых своего ещё не было (созданным
   * сотрудником вручную) — у записей из онлайн-потока уже есть свой рабочий токен с момента создания, его не трогаем.
   * Лояльность (сертификаты/абонементы клиента) — заглушка `[]`: своего клиентского обзора у карт/абонементов ещё
   * нет (см. docs/PROGRESS.md, лейн client — тот же блокер, что у `listMemberships`/`listCertificates`).
   */
  async cabinetData(businessId: string, phone: string) {
    const normalized = normalizePhone(phone);
    if (!normalized) throw new ApiError('invalid_phone', 'Проверьте номер телефона');
    const client = await this.prisma.client.findFirst({ where: { businessId, phone: normalized } });
    if (!client) throw new ApiError('not_found', 'С этим номером ещё нет записей');
    const now = new Date();
    const all = await this.prisma.booking.findMany({ where: { businessId, clientId: client.id, deletedAt: null }, orderBy: { startAt: 'desc' } });
    const upcoming = all.filter((b) => b.startAt >= now && b.status !== 'cancelled_by_client' && b.status !== 'cancelled_by_master').sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
    const past = all.filter((b) => b.startAt < now || b.status === 'arrived' || b.status === 'no_show');
    const serviceIds = new Set<string>();
    const staffIds = new Set<string>();
    for (const b of all) {
      for (const l of arr<{ serviceId: string }>(b.services)) serviceIds.add(l.serviceId);
      staffIds.add(b.staffId);
    }
    const [services, staffRows] = await Promise.all([
      this.prisma.service.findMany({ where: { id: { in: [...serviceIds] } } }),
      this.prisma.staff.findMany({ where: { id: { in: [...staffIds] } } }),
    ]);
    const servicesMap = Object.fromEntries(services.map((s) => [s.id, serviceView(s)]));
    const staffNames = Object.fromEntries(staffRows.map((s) => [s.id, s.name]));
    const missing = all.filter((b) => !b.accessHash);
    const accessHashes: Record<string, string> = {};
    for (const b of missing) {
      const raw = randomBytes(16).toString('hex');
      const expiresAt = new Date(b.endAt.getTime() + 7 * 86_400_000);
      await this.prisma.booking.update({ where: { id: b.id }, data: { accessHash: hashOf(raw), accessHashExpiresAt: expiresAt } });
      accessHashes[b.id] = raw;
    }
    const viewOf = (b: (typeof all)[number]) => this.bookings.view(this.prisma, b);
    return {
      client: coreClient(client),
      upcoming: await Promise.all(upcoming.map(viewOf)),
      past: await Promise.all(past.map(viewOf)),
      services: servicesMap,
      staffNames,
      loyalty: { certificates: [] as unknown[], subscriptions: [] as unknown[] },
      accessHashes,
    };
  }
}

/** Минуты (ключ журнала, В-04, единственный источник правды) побеждают, если заданы; часовой ключ — только запасной */
function hoursOf(rules: Record<string, unknown>, minKey: string, hourKey: string): number {
  if (typeof rules[minKey] === 'number') return Math.round((rules[minKey] as number) / 60);
  if (typeof rules[hourKey] === 'number') return rules[hourKey] as number;
  return 3;
}

function linkView(row: BookingLink) {
  return {
    id: row.id,
    businessId: row.businessId,
    locationId: opt(row.locationId ?? undefined),
    networkId: opt(row.networkId ?? undefined),
    name: row.name,
    kind: row.kind,
    bookingType: row.bookingType,
    defaultLocale: row.defaultLocale,
    staffId: opt(row.staffId ?? undefined),
    primary: row.primary,
    formId: row.formId,
    createdAt: utcToLocal(row.createdAt),
    version: row.version,
    ...((row.config as Record<string, unknown>) ?? {}),
  };
}

const DEFAULT_CONSENT_TEXT = {
  ru: 'Записываясь, вы соглашаетесь на обработку персональных данных (имя, телефон) для организации записи на услугу.',
  en: 'By booking, you agree to the processing of your personal data (name, phone) to arrange the appointment.',
  hy: 'Ամրագրելով՝ դուք համաձայն եք անձնական տվյալների (անուն, հեռախոս) մշակմանը՝ ծառայության գրանցումը կազմակերպելու համար։',
};

/** onlineMeta для клиента по ссылке: ссылка к записи-замене собирается из его же токена (не хранится) */
function publicMeta(onlineMeta: unknown, hash: string): Record<string, unknown> {
  const meta = { ...((onlineMeta as Record<string, unknown> | null) ?? {}) };
  const replaced = meta.replacedBy as { bookingId?: string; start?: string; hash?: string } | undefined;
  // `hash` в данных — только у заявок, перенесённых до 01.10 (тогда токен хранили); новые его не пишут
  if (replaced?.bookingId) meta.replacedBy = { bookingId: replaced.bookingId, start: replaced.start, hash: replaced.hash ?? replacementToken(hash, replaced.bookingId) };
  return meta;
}
