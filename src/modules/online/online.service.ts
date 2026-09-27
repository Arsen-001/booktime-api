import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { CodeChannel } from '../../adapters/code-sender/code-sender.js';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { updateVersioned } from '../../common/http/version.js';
import { newId } from '../../common/ids/ids.js';
import type { Locale } from '../../common/i18n/i18n.js';
import { normalizePhone } from '../../common/phone.js';
import { PrismaService } from '../../common/prisma.service.js';
import { DEFAULT_TZ, localDayRangeUtc, utcToLocal } from '../../common/time/time.js';
import type { Business, BookingLink } from '../../generated/prisma/client.js';
import { Prisma } from '../../generated/prisma/client.js';
import { AvailabilityService } from '../availability/availability.service.js';
import type { FreeSlot } from '../availability/engine.js';
import { businessView, locationView, staffView } from '../businesses/views.js';
import { OtpService } from '../auth/otp.service.js';
import { categoryView, serviceView } from '../services/services.views.js';
import { BookingsService, clientActor, coreClient } from '../journal/bookings.service.js';
import type { BusinessOnlineRulesBody, CreateLinkBody, StaffClientRulesBody, UpdateLinkBody } from './online.schemas.js';

const arr = <T = string>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const opt = <T>(v: T | null | undefined): T | undefined => (v === null || v === undefined ? undefined : v);

/** Prisma отказывается писать `undefined` внутри JSON-поля — вырезаем такие ключи перед записью */
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
  allowCancelPrepaid: false,
  keepPrepaymentOnLateCancel: true,
  allowAnyStaffAssignment: true,
  addClaimLinkToMessage: true,
} as const;

function hashOf(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** 'YYYY-MM-DD' → следующий календарный день, тем же форматом (UTC-арифметика, без часового пояса) */
function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Публичный подвид мастера (F-00-077, F-00-010): без точного домашнего адреса, логина и часов звонков */
function sanitizePublicStaff(row: Parameters<typeof staffView>[0]) {
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

    return {
      business: await this.businessOut(business),
      location: location ? locationView(location) : undefined,
      categories: categories.map(categoryView),
      services: services.map(serviceView),
      staff: visibleStaff.map(sanitizePublicStaff),
      link: linkOut,
      regularsCount: await this.countRegulars(business.id),
      serviceConfigs: {},
      staffServiceOnline: {},
      linkStaffGone,
      promoBlocks: [],
      businessStars: 0,
      networkBranches,
      packages: [],
      hourCycle,
      addressHidden,
    };
  }

  private async businessOut(b: Business) {
    const locationIds = (await this.prisma.location.findMany({ where: { businessId: b.id, deletedAt: null }, select: { id: true } })).map((l) => l.id);
    return businessView(b, locationIds);
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

  // ─────────────────────────── запись по хэшу без входа (B8, B19) ───────────────────────────

  private async findByHash(id: string, hash: string) {
    const row = await this.prisma.booking.findUnique({ where: { id } });
    if (!row || !row.accessHash || row.accessHash !== hashOf(hash)) throw new ApiError('not_found', 'Booking not found');
    if (row.accessHashExpiresAt && row.accessHashExpiresAt.getTime() < Date.now()) throw new ApiError('not_found', 'Booking not found');
    return row;
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
    return {
      booking: await this.bookings.view(this.prisma, row),
      business: await this.businessOut(business),
      location: location ? locationView(location) : undefined,
      staff: staff ? sanitizePublicStaff(staff) : undefined,
      services: services.map(serviceView),
      meta: { bookingId: row.id, ...((row.onlineMeta as Record<string, unknown> | null) ?? {}) },
      hourCycle,
    };
  }

  private async clientRulesOf(staffId: string): Promise<{ cancelWindowHours: number; rescheduleWindowHours: number }> {
    const staff = await this.prisma.staff.findUnique({ where: { id: staffId }, select: { bookingRules: true } });
    const raw = (staff?.bookingRules as Record<string, unknown> | null) ?? {};
    return { cancelWindowHours: hoursOf(raw, 'cancelWindowMin', 'cancelWindowHours'), rescheduleWindowHours: hoursOf(raw, 'rescheduleWindowMin', 'rescheduleWindowHours') };
  }

  async cancelWindow(id: string, hash: string) {
    const row = await this.findByHash(id, hash);
    const rules = await this.clientRulesOf(row.staffId);
    const left = (row.startAt.getTime() - Date.now()) / 3_600_000;
    return {
      canCancelFree: left >= rules.cancelWindowHours,
      // B8 (08-open-questions.md, принятое предложение): по ссылке без входа переноса нет вообще, не только
      // «поздно» — экран (`BookingConfirmedScreen`) уже прячет/гасит кнопку по этому полю, ничего не правили.
      canReschedule: false,
      cancelWindowHours: rules.cancelWindowHours,
      rescheduleWindowHours: rules.rescheduleWindowHours,
    };
  }

  async cancelByHash(id: string, hash: string) {
    const row = await this.findByHash(id, hash);
    const { booking } = await this.bookings.cancelByClient(clientActor(null, 'link_holder'), id, { booking: row });
    return booking;
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
