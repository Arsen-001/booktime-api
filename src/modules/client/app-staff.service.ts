import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { ApiError } from '../../common/errors/api-error.js';
import { newId } from '../../common/ids/ids.js';
import { PrismaService } from '../../common/prisma.service.js';
import { utcToLocalDate } from '../../common/time/time.js';
import { staffView } from '../businesses/views.js';
import { BookingsService } from '../journal/bookings.service.js';
import { roundMoney } from '../payroll/payroll-engine.js';
import { ScheduleService } from '../schedule/schedule.service.js';
import { serviceView } from '../services/services.views.js';

/**
 * Раздел «Приложение» (F-14-116…129), стадия 21 (лейн client+online, попытка 2): своя таблица сотрудников
 * (доступ в приложении), Z-отчёт, «моя зарплата» — своя лёгкая форма, не второй раз реестр `payroll`/`reports`
 * (см. докстринг схемы у `EmployeeAppAccess`/`AppPayrollPayout`).
 */
export type StaffPushType = 'bookings' | 'calls' | 'reviews' | 'payroll' | 'news';
export type PayrollAppAccess = 'none' | 'self' | 'all';

export interface EmployeeAppAccess {
  onlyOwnBookings: boolean;
  hideClientContacts: boolean;
  analyticsAllowed: boolean;
  pushEnabledByOwner: boolean;
  pushTypesAllowed: StaffPushType[];
  pushTypesOn: StaffPushType[];
  hideClientDataInPush: boolean;
  payrollAccess: PayrollAppAccess;
  payrollCurrentDayOnly: boolean;
  twoStepLoginEnabled: boolean;
}

const DEFAULT_ACCESS: EmployeeAppAccess = {
  onlyOwnBookings: false,
  hideClientContacts: false,
  analyticsAllowed: true,
  pushEnabledByOwner: false,
  pushTypesAllowed: [],
  pushTypesOn: [],
  hideClientDataInPush: false,
  payrollAccess: 'self',
  payrollCurrentDayOnly: false,
  twoStepLoginEnabled: false,
};

const ARRIVED = 'arrived';
type Json = unknown;
const arr = <T = string>(v: Json): T[] => (Array.isArray(v) ? (v as T[]) : []);

@Injectable()
export class AppStaffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bookings: BookingsService,
    private readonly schedule: ScheduleService,
  ) {}

  async listAppStaff(businessId: string, includeFired = true) {
    const [staffRows, accessRows] = await Promise.all([
      this.prisma.staff.findMany({ where: { businessId, ...(includeFired ? {} : { status: { not: 'fired' } }) }, include: { locations: { select: { locationId: true } } } }),
      this.prisma.employeeAppAccess.findMany({ where: { businessId } }),
    ]);
    const accessById = new Map(accessRows.map((r) => [r.staffId, r.data as unknown as EmployeeAppAccess]));
    const services = await this.prisma.service.findMany({ where: { businessId } });
    const serviceById = new Map(services.map((s) => [s.id, s]));
    const bookings = await this.prisma.booking.findMany({ where: { businessId, deletedAt: null }, select: { staffId: true, status: true, total: true } });
    return staffRows.map((staff) => {
      const svcRows = arr<string>(staff.serviceIds)
        .map((id) => serviceById.get(id))
        .filter((s): s is NonNullable<typeof s> => Boolean(s));
      const own = bookings.filter((b) => b.staffId === staff.id);
      const revenue = own.filter((b) => b.status === ARRIVED).reduce((s, b) => s + Number(b.total), 0);
      return {
        staff: staffView(staff),
        services: svcRows.map((service) => ({ service: serviceView(service), durationMin: service.durationMin })),
        bookingsCount: own.length,
        revenue,
        access: accessById.get(staff.id) ?? DEFAULT_ACCESS,
      };
    });
  }

  async setEmployeeAppAccess(ctx: { businessId: string; staffId: string }, patch: Partial<EmployeeAppAccess>, opts: { forbidOwner?: boolean } = {}) {
    const staff = await this.prisma.staff.findFirst({ where: { id: ctx.staffId, businessId: ctx.businessId } });
    if (!staff) throw new ApiError('not_found', 'Staff not found');
    if (opts.forbidOwner && staff.role === 'owner') throw new ApiError('forbidden', 'Owner access is managed in the web cabinet only');
    const existing = await this.prisma.employeeAppAccess.findUnique({ where: { staffId: ctx.staffId } });
    const current = (existing?.data as unknown as EmployeeAppAccess | undefined) ?? DEFAULT_ACCESS;
    const next: EmployeeAppAccess = { ...current, ...patch };
    await this.prisma.employeeAppAccess.upsert({
      where: { staffId: ctx.staffId },
      create: { staffId: ctx.staffId, businessId: ctx.businessId, data: next as unknown as Prisma.InputJsonValue },
      update: { data: next as unknown as Prisma.InputJsonValue },
    });
    return next;
  }

  /** Z-отчёт (закрытие смены), F-14-122: визиты «пришёл» дня + разбивка по способу оплаты (кабинет уже пишет
   *  оплату визита в BookingPayment — этап 12; методы группируем через PaymentMethod.kind, custom → cash). */
  async getDayZReport(businessId: string, date: string, staffId?: string) {
    const from = new Date(`${date}T00:00:00.000Z`);
    const to = new Date(from.getTime() + 86_400_000);
    const bookings = await this.prisma.booking.findMany({
      where: { businessId, status: ARRIVED, startAt: { gte: from, lt: to }, ...(staffId ? { staffId } : {}) },
    });
    const [clients, staffRows, methods, payments] = await Promise.all([
      this.prisma.client.findMany({ where: { businessId } }),
      this.prisma.staff.findMany({ where: { businessId } }),
      this.prisma.paymentMethod.findMany({ where: { businessId } }),
      this.prisma.bookingPayment.findMany({ where: { businessId, bookingId: { in: bookings.map((b) => b.id) }, cancelled: false } }),
    ]);
    const clientById = new Map(clients.map((c) => [c.id, c]));
    const staffById = new Map(staffRows.map((s) => [s.id, s]));
    const methodKind = new Map(methods.map((m) => [m.key, m.kind]));
    const paymentsByBooking = new Map<string, typeof payments>();
    for (const p of payments) paymentsByBooking.set(p.bookingId, [...(paymentsByBooking.get(p.bookingId) ?? []), p]);

    const rows = await Promise.all(
      bookings.map(async (booking) => {
        const client = clientById.get(booking.clientId ?? '');
        const staff = staffById.get(booking.staffId);
        const recorded = paymentsByBooking.get(booking.id) ?? [];
        const paidTotal = recorded.length ? recorded.reduce((s, p) => s + Number(p.amount) - Number(p.refundedAmount), 0) : Number(booking.total);
        const view = await this.bookings.view(this.prisma, booking);
        return { booking: view, clientName: client?.name ?? booking.visitorName ?? 'Гость', staffName: staff?.name ?? '—', total: Number(booking.total), paidTotal };
      }),
    );
    const byMethod: Record<'cash' | 'card' | 'loyalty', number> = { cash: 0, card: 0, loyalty: 0 };
    for (const booking of bookings) {
      const recorded = paymentsByBooking.get(booking.id) ?? [];
      if (recorded.length) {
        for (const p of recorded) {
          const net = Number(p.amount) - Number(p.refundedAmount);
          if (p.kind !== 'money') byMethod.loyalty += net;
          else byMethod[methodKind.get(p.methodKey) === 'card' ? 'card' : 'cash'] += net;
        }
      } else {
        byMethod.cash += Number(booking.total);
      }
    }
    return {
      rows,
      total: rows.reduce((s, r) => s + Number(r.total), 0),
      byMethod,
    };
  }

  /** F-14-127 «Calculation»: отработано, оказанные услуги, товары визита (BookingPayment.goods=true строки) */
  async getPayrollCalculation(businessId: string, staffId: string, from: string, to: string) {
    const fromAt = new Date(`${from}T00:00:00.000Z`);
    const toAt = new Date(`${to}T23:59:59.999Z`);
    const bookings = await this.prisma.booking.findMany({ where: { businessId, staffId, status: ARRIVED, startAt: { gte: fromAt, lte: toAt } }, select: { id: true, startAt: true, durationMin: true, total: true } });
    // «Отработано» — то же правило, что «Расчёт» и «Моя зарплата» в вебе: дни и часы графика за период (final-fix 01.10)
    // Только по сегодняшний день включительно; дни графика после сегодня — отдельной подписью (решение 01.10)
    const scheduled = await this.schedule.hours(businessId, staffId, from, to);
    const today = utcToLocalDate(new Date());
    let daysWorked = 0;
    let hoursWorked = 0;
    let scheduledAheadDays = 0;
    let scheduledAheadHours = 0;
    for (const d of scheduled.days) {
      const minutes = (d.hours as { from: string; to: string }[]).reduce((sum, r) => sum + Math.max(0, hhmm(r.to) - hhmm(r.from)), 0);
      const hours = roundMoney(minutes / 60);
      if (d.date > today) {
        if (hours > 0) scheduledAheadDays += 1;
        scheduledAheadHours = roundMoney(scheduledAheadHours + hours);
        continue;
      }
      if (hours > 0) daysWorked += 1;
      hoursWorked = roundMoney(hoursWorked + hours);
    }
    const servicesValue = bookings.reduce((s, b) => s + Number(b.total), 0);
    const goodsLines = bookings.length ? await this.prisma.bookingPayment.findMany({ where: { businessId, bookingId: { in: bookings.map((b) => b.id) }, goods: true, cancelled: false } }) : [];
    const productsValue = goodsLines.reduce((s, l) => s + Number(l.amount) - Number(l.refundedAmount), 0);
    return {
      daysWorked,
      hoursWorked,
      scheduledAheadDays,
      scheduledAheadHours,
      servicesCount: bookings.length,
      servicesValue,
      productsCount: goodsLines.length,
      productsValue,
      total: servicesValue + productsValue,
    };
  }

  /** F-14-127 «Payouts»: демо-копилка выплат — earned из calc(), paid из своего счётчика (не PayrollSettlementEntry,
   *  см. докстринг схемы AppPayrollPayout: эта форма не завязана на кассу/период, как настоящая выплата). */
  async getPayrollPayouts(businessId: string, staffId: string, from: string, to: string) {
    const [{ total }, row] = await Promise.all([this.getPayrollCalculation(businessId, staffId, from, to), this.prisma.appPayrollPayout.findUnique({ where: { staffId } })]);
    const earned = total;
    const paid = Math.min(row ? Number(row.paid) : 0, earned);
    return { earned, paid, remaining: Math.max(0, earned - paid) };
  }

  async recordPayrollPayout(businessId: string, staffId: string, amount: number): Promise<number> {
    if (amount <= 0) throw new ApiError('validation', 'Amount must be positive');
    const row = await this.prisma.appPayrollPayout.upsert({
      where: { staffId },
      create: { staffId, businessId, paid: BigInt(Math.round(amount)) },
      update: { paid: { increment: BigInt(Math.round(amount)) } },
    });
    return Number(row.paid);
  }

  /** F-14-074: «Отправить сообщение» из окна записи — свободный текст в ленту клиента. client-2-fix: kind 'direct' —
   *  личное сообщение, его не глушит «выключить новости» мастера/салона (в отличие от рассылки 'broadcast') */
  async sendOneOffPush(businessId: string, input: { appUserId: string; bookingId?: string; text: string }) {
    const text = input.text.trim();
    if (!text) throw new ApiError('validation', 'Text is required');
    const row = await this.prisma.inboxItem.create({
      data: { id: newId('inboxItem'), appUserId: input.appUserId, businessId, bookingId: input.bookingId, kind: 'direct', params: { text } as Prisma.InputJsonValue },
    });
    return { id: row.id, appUserId: row.appUserId, businessId: row.businessId, bookingId: row.bookingId ?? undefined, kind: row.kind, params: row.params as Record<string, unknown>, createdAt: row.createdAt.toISOString() };
  }
}

function hhmm(value: string): number {
  const [h, m] = value.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}
