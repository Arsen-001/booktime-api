import { Injectable, Optional } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { newId } from '../../common/ids/ids.js';
import { maskPhone } from '../../common/phone.js';
import { PrismaService } from '../../common/prisma.service.js';
import { logger } from '../../common/logging/logger.js';
import { DEFAULT_TZ, localDayRangeUtc, utcToLocal } from '../../common/time/time.js';
import { BookingsService, staffActor } from '../journal/bookings.service.js';
import { INTAKE_CLOSED_STATUSES, INTAKE_KIND, INTAKE_SERVICE_NAME, intakeSettingsView, isIntakeBooking, type IntakeSettingsView } from './order-rules.js';
import type { IntakeSettingsBody } from './orders.schemas.js';

type Db = Pick<Prisma.TransactionClient, 'service'>;
type AcceptDb = Pick<Prisma.TransactionClient, 'service' | 'booking' | 'order'>;
const arr = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);

export interface IntakeBookingView {
  bookingId: string;
  start: string;
  durationMin: number;
  status: string;
  staffId: string;
  clientId: string | null;
  clientName: string;
  clientPhone: string;
  description: string | null;
  orderId: string | null;
  orderNumber: number | null;
}

/** Услуга «Приём заказа» бизнеса (одна; старейшая, если вдруг две) */
export function findIntakeService(db: Db, businessId: string) {
  return db.service.findFirst({ where: { businessId, kind: INTAKE_KIND }, orderBy: { createdAt: 'asc' } });
}

/**
 * ⭐ Запись на сдачу по времени (05.10.2026): детейлинг, приём техники, ателье, химчистка. Настройка — это сама скрытая
 * услуга «Приём заказа» (kind = 'intake'): вкл/выкл = active + onlineBookable, длина окна = durationMin, кто принимает =
 * staffIds (в паре со Staff.serviceIds, как у обычных услуг). Окна, код по телефону, запись, напоминания и журнал —
 * общий движок онлайн-записи; здесь только настройка и список «кто сдаёт сегодня» для раздела «Заказы».
 */
@Injectable()
export class OrderIntakeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Optional() private readonly bookings?: BookingsService,
  ) {}

  /**
   * После «Принять заказ» по записи: клиент пришёл — запись на сдачу становится «Пришёл» тем же переходом, что в журнале
   * (события, лента, «визит не закрыт» не висит). Best-effort, как пересчёт лояльности в журнале: заказ уже создан,
   * а запись могли отметить раньше или её переход не разрешён — тогда просто оставляем как есть.
   */
  async markArrived(ctx: RequestContext, businessId: string, bookingId: string): Promise<void> {
    const row = await this.prisma.booking.findFirst({ where: { id: bookingId, businessId, deletedAt: null }, select: { status: true } });
    if (!row || row.status === 'arrived' || INTAKE_CLOSED_STATUSES.includes(row.status) || !this.bookings || !ctx.member) return;
    await this.bookings.changeStatus(staffActor(ctx), [businessId], bookingId, 'arrived').catch((err: unknown) => {
      logger.warn({ err, bookingId }, 'orders: запись на сдачу не отмечена «Пришёл» после приёма заказа');
    });
  }

  async settings(businessId: string): Promise<IntakeSettingsView> {
    return intakeSettingsView(await findIntakeService(this.prisma, businessId));
  }

  async setSettings(ctx: RequestContext, businessId: string, body: IntakeSettingsBody): Promise<IntakeSettingsView> {
    const business = await this.prisma.business.findUnique({ where: { id: businessId }, select: { id: true, sphereIds: true } });
    if (!business) throw new ApiError('not_found', 'Business not found');
    const staff = await this.prisma.staff.findMany({ where: { businessId, deletedAt: null }, select: { id: true, status: true, serviceIds: true } });
    const active = staff.filter((s) => s.status === 'active').map((s) => s.id);
    // Кто принимает: выбранные (только активные сотрудники бизнеса), не выбрано — все активные
    const staffIds = body.staffIds?.length ? body.staffIds.filter((id) => active.includes(id)) : active;
    if (body.staffIds?.length && !staffIds.length) throw new ApiError('validation', 'Unknown staff', { staffIds: 'No active staff selected' });
    if (body.enabled && !staffIds.length) throw new ApiError('intake_no_staff', 'No active staff to accept orders');
    const by = ctx.member?.staffId ?? null;

    await this.prisma.$transaction(async (tx) => {
      const existing = await findIntakeService(tx, businessId);
      const id = existing?.id ?? newId('service');
      if (existing) {
        await tx.service.update({
          where: { id },
          data: { durationMin: body.slotMin, staffIds: staffIds, active: body.enabled, onlineBookable: body.enabled, updatedBy: by, version: { increment: 1 } },
        });
      } else {
        await tx.service.create({
          data: {
            id,
            businessId,
            categoryId: null,
            sphereId: arr(business.sphereIds)[0] ?? 'general',
            name: { ...INTAKE_SERVICE_NAME },
            kind: INTAKE_KIND,
            durationMin: body.slotMin,
            priceMin: 0n,
            bufferAfterMin: 0,
            photos: [],
            materials: [],
            staffIds,
            workplaces: ['salon'],
            onlineBookable: body.enabled,
            active: body.enabled,
            order: 0,
            createdBy: by,
            updatedBy: by,
          },
        });
      }
      // Пара Service.staffIds ↔ Staff.serviceIds (её читают окна и проверка записи)
      for (const s of staff) {
        const own = arr(s.serviceIds);
        const should = staffIds.includes(s.id);
        if (should === own.includes(id)) continue;
        await tx.staff.update({ where: { id: s.id }, data: { serviceIds: should ? [...own, id] : own.filter((x) => x !== id) } });
      }
      await this.audit.record(tx, ctx, {
        action: existing ? 'update' : 'create',
        entityType: 'order_intake',
        entityId: id,
        businessId,
        before: existing ? intakeSettingsView(existing) : null,
        after: { enabled: body.enabled, slotMin: body.slotMin, staffIds },
      });
    });
    return this.settings(businessId);
  }

  /** Записи на сдачу за день (время Еревана): кто придёт, что сдаёт и принят ли уже заказ */
  async bookingsOn(ctx: RequestContext, businessId: string, date: string): Promise<IntakeBookingView[]> {
    const svc = await findIntakeService(this.prisma, businessId);
    if (!svc) return [];
    const { from, to } = localDayRangeUtc(date, DEFAULT_TZ);
    const rows = (
      await this.prisma.booking.findMany({
        where: { businessId, deletedAt: null, startAt: { gte: from, lt: to }, status: { notIn: [...INTAKE_CLOSED_STATUSES] } },
        orderBy: { startAt: 'asc' },
        take: 500,
      })
    )
      .filter((b) => isIntakeBooking(b.services, svc.id))
      .sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
    if (!rows.length) return [];
    const clientIds = [...new Set(rows.map((b) => b.clientId).filter((x): x is string => Boolean(x)))];
    const [clients, orders] = await Promise.all([
      clientIds.length ? this.prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, name: true, phone: true } }) : Promise.resolve([]),
      this.prisma.order.findMany({ where: { businessId, bookingId: { in: rows.map((b) => b.id) } }, select: { id: true, number: true, bookingId: true } }),
    ]);
    const canPhones = ctx.member?.permissions.has('clients.phones') ?? false;
    return rows.map((b) => {
      const client = clients.find((c) => c.id === b.clientId);
      const order = orders.find((o) => o.bookingId === b.id);
      const phone = client?.phone ?? '';
      return {
        bookingId: b.id,
        start: utcToLocal(b.startAt, DEFAULT_TZ),
        durationMin: b.durationMin,
        status: b.status,
        staffId: b.staffId,
        clientId: b.clientId,
        clientName: b.visitorName ?? client?.name ?? '',
        clientPhone: canPhones ? phone : maskPhone(phone),
        description: b.comment ?? null,
        orderId: order?.id ?? null,
        orderNumber: order?.number ?? null,
      };
    });
  }
}

/**
 * Проверка записи перед «Принять заказ»: запись на сдачу этого бизнеса, не удалена и не отменена. Заказ по ней уже
 * есть — 409 intake_already_accepted (уникальный orders.booking_id ловит и гонку двух нажатий).
 */
export async function assertIntakeAcceptable(db: AcceptDb, businessId: string, bookingId: string): Promise<{ staffId: string; locationId: string }> {
  const [booking, svc, taken] = await Promise.all([
    db.booking.findFirst({ where: { id: bookingId, businessId }, select: { id: true, services: true, status: true, deletedAt: true, staffId: true, locationId: true } }),
    findIntakeService(db, businessId),
    db.order.findFirst({ where: { bookingId }, select: { id: true } }),
  ]);
  if (!booking || booking.deletedAt) throw new ApiError('not_found', 'Booking not found');
  if (!isIntakeBooking(booking.services, svc?.id)) throw new ApiError('not_intake_booking', 'Booking is not a drop-off booking');
  if (INTAKE_CLOSED_STATUSES.includes(booking.status)) throw new ApiError('booking_cancelled', 'Booking is cancelled');
  if (taken) throw new ApiError('intake_already_accepted', 'Order for this booking already exists');
  return { staffId: booking.staffId, locationId: booking.locationId };
}
