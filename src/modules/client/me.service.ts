import { Injectable } from '@nestjs/common';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { newId } from '../../common/ids/ids.js';
import { PrismaService } from '../../common/prisma.service.js';
import { isLocalDate, nowLocal } from '../../common/time/time.js';
import { Prisma, type Booking as BookingRow } from '../../generated/prisma/client.js';
import { businessView, locationView } from '../businesses/views.js';
import { BookingsService, clientActor, type PlaceInput } from '../journal/bookings.service.js';
import { canReschedule, clientCancelOutcome, effectiveBookingRules, isCancelled, type BookingRules } from '../journal/rules.js';
import { MeLoyaltyService } from '../loyalty/me-loyalty.service.js';
import { sanitizePublicStaff } from '../online/online.service.js';
import { serviceView } from '../services/services.views.js';

const arr = <T = string>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

export interface CreateMyBookingInput {
  staffId: string;
  serviceId: string;
  start: string;
  locationId?: string;
  workplace?: string;
  visitAddress?: string;
  forWhom?: string;
  visitorName?: string;
  seats?: number;
  groupEventId?: string;
  comment?: string;
}

/**
 * Раздел «client» — «мои записи» и остальное личное (docs/backend/02 §2.2, PLAN §6 №9): создание/список/детали
 * записи (окно и статус решает `BookingsService.place`, этапы 6–7 — источник 'app' идёт по тем же онлайн-правилам,
 * что виджет и ссылка), лист ожидания «от себя», избранное, звёздочка, дневник, «мои мастера», лента, сторис,
 * обращение к нам. `comment` (заметка администратора в CRM) клиенту не показываем нигде — F-00-130.
 */
@Injectable()
export class MeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bookings: BookingsService,
    private readonly loyalty: MeLoyaltyService,
  ) {}

  // ─────────────────────────── лояльность (F-06-156…163, В-17, этап 11) ───────────────────────────

  myLoyalty(userId: string, businessId: string) {
    return this.loyalty.getMine(userId, businessId);
  }

  myLoyaltyBuyable(businessId: string) {
    return this.loyalty.listBuyable(businessId);
  }

  requestCertificate(userId: string, businessId: string, typeId: string) {
    return this.loyalty.requestCertificate(userId, businessId, typeId);
  }

  requestMembership(userId: string, businessId: string, typeId: string) {
    return this.loyalty.requestMembership(userId, businessId, typeId);
  }

  // ─────────────────────────── запись из приложения (F-00-031, F-00-092/093/097) ───────────────────────────

  async createBooking(ctx: RequestContext, input: CreateMyBookingInput) {
    const staff = await this.prisma.staff.findUnique({ where: { id: input.staffId }, select: { businessId: true } });
    if (!staff) throw new ApiError('not_found', 'Staff not found');
    const place: PlaceInput = {
      source: 'app',
      businessId: staff.businessId,
      staffId: input.staffId,
      start: input.start,
      services: [{ serviceId: input.serviceId, qty: input.seats }],
      locationId: input.locationId,
      workplace: input.workplace,
      client: { appUserId: ctx.session!.userId },
      forWhom: input.forWhom,
      visitorName: input.visitorName,
      comment: input.comment,
      groupEventId: input.groupEventId,
      staffAssignment: 'specific',
    };
    const result = await this.bookings.place(clientActor(ctx), place);
    if (result.booking.workplace === 'visit' && input.visitAddress?.trim()) {
      await this.prisma.booking.update({ where: { id: result.booking.id }, data: { onlineMeta: { visitAddress: input.visitAddress.trim() } as Prisma.InputJsonValue } });
    }
    const { comment: _c, ...safe } = result.booking;
    return { booking: safe, client: result.client };
  }

  // ─────────────────────────── список/детали (F-14-011…026) ───────────────────────────

  private async enrich(row: BookingRow) {
    const [staff, business] = await Promise.all([
      this.prisma.staff.findUnique({ where: { id: row.staffId }, include: { locations: { select: { locationId: true } } } }),
      this.prisma.business.findUnique({ where: { id: row.businessId } }),
    ]);
    if (!staff || !business) return undefined;
    const serviceIds = arr<{ serviceId: string }>(row.services).map((l) => l.serviceId);
    const [service, location] = await Promise.all([
      serviceIds[0] ? this.prisma.service.findUnique({ where: { id: serviceIds[0] } }) : null,
      row.locationId ? this.prisma.location.findUnique({ where: { id: row.locationId } }) : null,
    ]);
    const view = await this.bookings.view(this.prisma, row);
    const { comment: _c, ...safe } = view;
    return {
      ...safe,
      staff: sanitizePublicStaff(staff),
      business: businessView(business, staff.locations.map((l) => l.locationId)),
      service: service ? serviceView(service) : undefined,
      location: location ? locationView(location) : undefined,
      // Абонементы/сертификаты клиента — этап 11 (loyalty); честно false, пока их нет
      byMembership: false,
    };
  }

  async listMine(appUserId: string, businessId?: string) {
    const rows = await this.prisma.booking.findMany({ where: { appUserId, deletedAt: null, ...(businessId ? { businessId } : {}) }, orderBy: { startAt: 'desc' } });
    const now = Date.now();
    const upcoming = [];
    const past = [];
    const cancelled = [];
    for (const r of rows) {
      const enriched = await this.enrich(r);
      if (!enriched) continue;
      if (isCancelled(r.status)) cancelled.push(enriched);
      else if (r.endAt.getTime() > now) upcoming.push(enriched);
      else past.push(enriched);
    }
    upcoming.reverse();
    return { upcoming, past, cancelled };
  }

  async getOne(appUserId: string, id: string) {
    const row = await this.prisma.booking.findFirst({ where: { id, appUserId, deletedAt: null } });
    if (!row) throw new ApiError('not_found', 'Booking not found');
    const enriched = await this.enrich(row);
    if (!enriched) throw new ApiError('not_found', 'Booking not found');
    const [biz, staff] = await Promise.all([
      this.prisma.business.findUnique({ where: { id: row.businessId }, select: { bookingRules: true } }),
      this.prisma.staff.findUnique({ where: { id: row.staffId }, select: { bookingRules: true, prepayment: true } }),
    ]);
    const rules = effectiveBookingRules(biz?.bookingRules as BookingRules | null, staff?.bookingRules as BookingRules | null);
    const now = nowLocal();
    const policyBooking = { start: enriched.start, status: row.status, deletedAt: row.deletedAt, prepayment: row.prepayment as { paid?: boolean } | null };
    const cancelOutcome = clientCancelOutcome(policyBooking, rules, now);
    const rescheduleOutcome = canReschedule(policyBooking, rules, now);
    const prepayment = row.prepayment as { amount: number; paid: boolean; holdUntil?: string } | null;
    const meta = (row.onlineMeta as Record<string, unknown> | null) ?? {};
    return {
      booking: enriched,
      staff: enriched.staff,
      business: enriched.business,
      service: enriched.service,
      location: enriched.location,
      prepaymentDeadline: prepayment?.holdUntil,
      prepaymentRequisites: prepayment && !prepayment.paid ? ((staff?.prepayment as Record<string, unknown> | null)?.requisites as string | undefined) : undefined,
      freeCancelUntil: cancelOutcome.allowed ? cancelOutcome.freeUntil : enriched.start,
      canCancelFree: cancelOutcome.allowed && !cancelOutcome.late,
      canReschedule: rescheduleOutcome.allowed,
      byMembership: false,
      visitAddress: meta.visitAddress as string | undefined,
      // Абонемент/сертификат/кэшбэк/товары визита — этапы 11/13; честно пусто, пока их нет
      payment: { total: enriched.total, paid: Number(row.paidAmount), lines: [] as unknown[], cashbackEarned: 0, products: [] as unknown[], paidByMembership: false },
    };
  }

  async markPaid(appUserId: string, id: string) {
    return this.bookings.markPaidByClient(appUserId, id);
  }

  // ─────────────────────────── лист ожидания «от себя» (F-00-101, F-00-102) ───────────────────────────

  async addWaitlist(appUserId: string, input: { staffId: string; serviceId: string; date: string }) {
    const staff = await this.prisma.staff.findUnique({ where: { id: input.staffId }, select: { businessId: true, name: true, phone: true } });
    if (!staff) throw new ApiError('not_found', 'Staff not found');
    const user = await this.prisma.user.findUnique({ where: { id: appUserId }, select: { name: true, phone: true } });
    const slots: { date?: string; anyTime: boolean }[] = input.date === 'any' || !isLocalDate(input.date) ? [] : [{ date: input.date, anyTime: true }];
    const row = await this.prisma.waitlistEntry.create({
      data: {
        id: newId('waitlistEntry'),
        businessId: staff.businessId,
        clientName: user?.name ?? '',
        clientPhone: user?.phone ?? '',
        appUserId,
        serviceIds: [input.serviceId],
        staffIds: [input.staffId],
        slots: slots as Prisma.InputJsonValue,
        createdBy: appUserId,
      },
    });
    return this.waitlistView(row);
  }

  private waitlistView(e: { id: string; appUserId: string | null; staffIds: unknown; serviceIds: unknown; createdAt: Date; notifiedAt: Date | null }) {
    return {
      id: e.id,
      appUserId: e.appUserId,
      staffId: arr(e.staffIds)[0],
      serviceId: arr(e.serviceIds)[0],
      date: 'any',
      createdAt: e.createdAt.toISOString(),
      notifiedAt: e.notifiedAt?.toISOString(),
    };
  }

  async listMyWaitlist(appUserId: string) {
    const rows = await this.prisma.waitlistEntry.findMany({ where: { appUserId }, orderBy: { createdAt: 'desc' } });
    const out = [];
    for (const e of rows) {
      const staffId = arr<string>(e.staffIds)[0];
      const serviceId = arr<string>(e.serviceIds)[0];
      const [staff, service] = await Promise.all([staffId ? this.prisma.staff.findUnique({ where: { id: staffId }, include: { locations: { select: { locationId: true } } } }) : null, serviceId ? this.prisma.service.findUnique({ where: { id: serviceId } }) : null]);
      if (!staff) continue;
      out.push({ ...this.waitlistView(e), staff: sanitizePublicStaff(staff), service: service ? serviceView(service) : undefined });
    }
    return out;
  }

  async removeWaitlist(appUserId: string, id: string) {
    await this.prisma.waitlistEntry.deleteMany({ where: { id, appUserId } });
  }

  // ─────────────────────────── «Мои мастера» (F-00-118) ───────────────────────────

  async listMyMasters(appUserId: string, limit = 6) {
    const rows = await this.prisma.booking.findMany({ where: { appUserId, deletedAt: null, source: { in: ['app', 'link', 'widget'] } }, select: { staffId: true }, distinct: ['staffId'], take: limit });
    const staff = await this.prisma.staff.findMany({ where: { id: { in: rows.map((r) => r.staffId) } }, include: { locations: { select: { locationId: true } } } });
    return staff.map(sanitizePublicStaff);
  }

  // ─────────────────────────── ❤ избранное (F-00-113, F-00-115) ───────────────────────────

  async toggleFavorite(appUserId: string, targetType: string, targetId: string): Promise<boolean> {
    const existing = await this.prisma.favorite.findUnique({ where: { appUserId_targetType_targetId: { appUserId, targetType, targetId } } });
    if (existing) {
      await this.prisma.favorite.delete({ where: { id: existing.id } });
      return false;
    }
    await this.prisma.favorite.create({ data: { id: newId('favorite'), appUserId, targetType, targetId } });
    return true;
  }

  async isFavorited(appUserId: string, targetType: string, targetId: string): Promise<boolean> {
    return Boolean(await this.prisma.favorite.findUnique({ where: { appUserId_targetType_targetId: { appUserId, targetType, targetId } } }));
  }

  async setFavoriteNewsMuted(appUserId: string, id: string, muted: boolean): Promise<void> {
    await this.prisma.favorite.updateMany({ where: { id, appUserId }, data: { newsMuted: muted } });
  }

  async listFavorites(appUserId: string) {
    const rows = await this.prisma.favorite.findMany({ where: { appUserId }, orderBy: { createdAt: 'desc' } });
    const out = [];
    for (const f of rows) {
      if (f.targetType === 'staff') {
        const staff = await this.prisma.staff.findUnique({ where: { id: f.targetId }, include: { locations: { select: { locationId: true } } } });
        const business = staff ? await this.prisma.business.findUnique({ where: { id: staff.businessId } }) : null;
        if (staff && business) out.push({ favorite: f, staff: sanitizePublicStaff(staff), business: businessView(business, staff.locations.map((l) => l.locationId)) });
      } else {
        const business = await this.prisma.business.findUnique({ where: { id: f.targetId } });
        if (business) out.push({ favorite: f, business: businessView(business, []) });
      }
    }
    return out;
  }

  // ─────────────────────────── ★ звёздочка (F-00-116) ───────────────────────────

  async getMyStar(appUserId: string, staffId: string) {
    return this.prisma.starRating.findUnique({ where: { appUserId_staffId: { appUserId, staffId } } });
  }

  async rateStaff(appUserId: string, staffId: string, bookingId: string): Promise<void> {
    const booking = await this.prisma.booking.findFirst({ where: { id: bookingId, appUserId, status: 'arrived' } });
    if (!booking) throw new ApiError('not_allowed', 'Оценить можно только визит со статусом «пришёл»');
    const existing = await this.prisma.starRating.findUnique({ where: { appUserId_staffId: { appUserId, staffId } } });
    if (existing) return;
    await this.prisma.starRating.create({ data: { id: newId('starRating'), appUserId, staffId, bookingId } });
  }

  async unrateStaff(appUserId: string, staffId: string): Promise<void> {
    await this.prisma.starRating.deleteMany({ where: { appUserId, staffId } });
  }

  // ─────────────────────────── дневник (F-00-122) ───────────────────────────

  async listDiary(appUserId: string) {
    const [bookings, manual] = await Promise.all([
      this.prisma.booking.findMany({ where: { appUserId, status: 'arrived', deletedAt: null } }),
      this.prisma.diaryEntry.findMany({ where: { appUserId }, orderBy: { date: 'desc' } }),
    ]);
    const fromBookings = [];
    for (const b of bookings) {
      const staff = await this.prisma.staff.findUnique({ where: { id: b.staffId } });
      const serviceId = arr<{ serviceId: string }>(b.services)[0]?.serviceId;
      const service = serviceId ? await this.prisma.service.findUnique({ where: { id: serviceId } }) : null;
      fromBookings.push({ id: b.id, source: 'app' as const, date: b.startAt.toISOString().slice(0, 10), amount: Number(b.total), removable: false, staff: staff ? sanitizePublicStaff({ ...staff, locations: [] }) : undefined, service: service ? serviceView(service) : undefined });
    }
    const manualRows = manual.map((e) => ({ id: e.id, source: 'manual' as const, date: e.date, amount: Number(e.amount), removable: true, serviceName: e.serviceName, masterName: e.masterName }));
    return [...fromBookings, ...manualRows].sort((a, b) => b.date.localeCompare(a.date));
  }

  async addDiary(appUserId: string, input: { serviceName: string; masterName: string; date: string; amount: number }) {
    const row = await this.prisma.diaryEntry.create({ data: { id: newId('diaryEntry'), appUserId, serviceName: input.serviceName.slice(0, 200), masterName: input.masterName.slice(0, 160), date: input.date, amount: Math.max(0, Math.round(input.amount)) } });
    return { id: row.id, appUserId, serviceName: row.serviceName, masterName: row.masterName, date: row.date, amount: Number(row.amount), createdAt: row.createdAt.toISOString() };
  }

  async removeDiary(appUserId: string, id: string): Promise<void> {
    await this.prisma.diaryEntry.deleteMany({ where: { id, appUserId } });
  }

  // ─────────────────────────── лента (F-14-055) ───────────────────────────

  async listInbox(appUserId: string) {
    const rows = await this.prisma.inboxItem.findMany({ where: { appUserId }, orderBy: { createdAt: 'desc' }, take: 100 });
    const out = [];
    for (const n of rows) {
      const [business, staff, booking] = await Promise.all([
        n.businessId ? this.prisma.business.findUnique({ where: { id: n.businessId } }) : null,
        n.staffId ? this.prisma.staff.findUnique({ where: { id: n.staffId } }) : null,
        n.bookingId ? this.prisma.booking.findUnique({ where: { id: n.bookingId } }) : null,
      ]);
      if (!business) continue;
      const serviceId = booking ? arr<{ serviceId: string }>(booking.services)[0]?.serviceId : undefined;
      const service = serviceId ? await this.prisma.service.findUnique({ where: { id: serviceId } }) : null;
      const bookingSafe = booking ? (({ comment: _c, ...rest }) => rest)(await this.bookings.view(this.prisma, booking)) : undefined;
      out.push({
        id: n.id,
        appUserId,
        kind: n.kind,
        businessId: n.businessId,
        staffId: n.staffId ?? undefined,
        bookingId: n.bookingId ?? undefined,
        params: (n.params as Record<string, unknown> | null) ?? undefined,
        createdAt: n.createdAt.toISOString(),
        readAt: n.readAt?.toISOString(),
        business: businessView(business, []),
        staff: staff ? sanitizePublicStaff({ ...staff, locations: [] }) : undefined,
        booking: bookingSafe,
        service: service ? serviceView(service) : undefined,
      });
    }
    return out;
  }

  async markInboxRead(appUserId: string, id: string): Promise<void> {
    await this.prisma.inboxItem.updateMany({ where: { id, appUserId, readAt: null }, data: { readAt: new Date() } });
  }

  async markAllInboxRead(appUserId: string): Promise<void> {
    await this.prisma.inboxItem.updateMany({ where: { appUserId, readAt: null }, data: { readAt: new Date() } });
  }

  // ─────────────────────────── сторис (просмотр) — этап 19 их заводит, здесь честно пусто ───────────────────────────

  async listStories(): Promise<unknown[]> {
    return [];
  }

  // ─────────────────────────── обращение к нам (F-00-182) ───────────────────────────

  async submitSupport(input: { appUserId?: string; phone?: string; subject: string; message: string }): Promise<void> {
    await this.prisma.supportTicket.create({ data: { id: newId('supportTicket'), appUserId: input.appUserId, phone: input.phone, subject: input.subject.slice(0, 200), message: input.message.slice(0, 4000) } });
  }
}
