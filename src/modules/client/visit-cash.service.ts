import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { ApiError } from '../../common/errors/api-error.js';
import { type Locale, t } from '../../common/i18n/i18n.js';
import { newId } from '../../common/ids/ids.js';
import { PrismaService } from '../../common/prisma.service.js';
import { localDayRangeUtc, utcToLocal, utcToLocalDate } from '../../common/time/time.js';
import { BookingsService } from '../journal/bookings.service.js';
import { waLink } from '../notify/wa-link.js';

/**
 * «Визит-микрокасса» (F-14-092…098), стадия 21 (лейн client+online, попытка 4): `src/api/client.ts::
 * listVisitCandidates/getVisitDetail/addVisitSaleLine/removeVisitSaleLine/addVisitPayment/removeVisitPayment/
 * refundVisitPayment/listNoAppRemindersTomorrow/sendVisitReceipt/isVisitReceiptSent`. Своя лёгкая демо-касса
 * приложения (см. докстринг схемы у `VisitCashRecord`) — не витрина над разделом «Финансы».
 */
const ACTIVE_STATUSES = ['awaiting_confirmation', 'awaiting_prepayment', 'scheduled', 'client_confirmed'];
const VISIT_STATUSES = ['arrived', 'scheduled', 'client_confirmed', 'awaiting_confirmation'];

const CARD_COMMISSION_PERCENT: Record<'visa' | 'mastercard' | 'arca', number> = { visa: 2.5, mastercard: 2.5, arca: 1.5 };

export interface AddVisitSaleLineInput {
  kind: 'product' | 'membership' | 'certificate';
  title: string;
  price: number;
  discount?: number;
  sellerStaffId?: string;
  code?: string;
}

export interface AddVisitPaymentInput {
  method: 'cash' | 'card' | 'loyalty';
  amount: number;
  cashDeskId?: string;
  cardBrand?: 'visa' | 'mastercard' | 'arca';
}

@Injectable()
export class VisitCashService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bookings: BookingsService,
  ) {}

  /** Визиты бизнеса сегодня, доступные для открытия в приложении (F-14-093/094) */
  async listVisitCandidates(businessId: string, viewerStaffId?: string) {
    const tz = await this.bookings.tzOfBusiness(this.prisma, businessId);
    const today = utcToLocalDate(new Date(), tz);
    const { from, to } = localDayRangeUtc(today, tz);
    const access = viewerStaffId ? await this.prisma.employeeAppAccess.findUnique({ where: { staffId: viewerStaffId } }) : null;
    const onlyOwn = Boolean((access?.data as { onlyOwnBookings?: boolean } | undefined)?.onlyOwnBookings);
    const bookings = await this.prisma.booking.findMany({
      where: { businessId, deletedAt: null, startAt: { gte: from, lt: to }, status: { in: VISIT_STATUSES }, ...(onlyOwn && viewerStaffId ? { staffId: viewerStaffId } : {}) },
      orderBy: { startAt: 'asc' },
    });
    const clients = await this.prisma.client.findMany({ where: { businessId, id: { in: bookings.map((b) => b.clientId).filter((id): id is string => Boolean(id)) } } });
    const clientById = new Map(clients.map((c) => [c.id, c]));
    return Promise.all(
      bookings.map(async (booking) => ({
        booking: await this.bookings.view(this.prisma, booking),
        clientName: booking.visitorName ?? clientById.get(booking.clientId ?? '')?.name ?? 'Гость',
      })),
    );
  }

  /** Визит в разрезе продаж/оплат (F-14-092…098) */
  async getVisitDetail(businessId: string, bookingId: string) {
    const booking = await this.bookings.find(this.prisma, [businessId], bookingId);
    const [client, business, records] = await Promise.all([
      booking.clientId ? this.prisma.client.findUnique({ where: { id: booking.clientId } }) : Promise.resolve(null),
      this.prisma.business.findUnique({ where: { id: businessId }, select: { name: true } }),
      this.prisma.visitCashRecord.findMany({ where: { bookingId } }),
    ]);
    const saleLines = records
      .filter((r) => r.kind === 'saleLine')
      .map((r) => ({ id: r.id, bookingId: r.bookingId, ...(r.data as object) }) as unknown as VisitSaleLineView);
    const payments = records
      .filter((r) => r.kind === 'payment' && !r.refundedAt)
      .map((r) => ({ id: r.id, bookingId: r.bookingId, createdAt: r.createdAt.toISOString(), ...(r.data as object) }) as unknown as VisitPaymentLineView);
    const salesTotal = saleLines.reduce((sum, l) => sum + Math.max(0, l.price - l.discount), 0);
    const dueTotal = Number(booking.total) + salesTotal;
    const paidTotal = payments.reduce((sum, p) => sum + p.amount, 0);
    return {
      booking: await this.bookings.view(this.prisma, booking),
      clientName: booking.visitorName ?? client?.name ?? 'Гость',
      businessName: business?.name,
      saleLines,
      payments,
      salesTotal,
      dueTotal,
      paidTotal,
      remaining: Math.max(0, dueTotal - paidTotal),
    };
  }

  /** «Завтра N клиентов без приложения» + готовый текст в WhatsApp мастера (F-00-121) */
  async listNoAppRemindersTomorrow(businessId: string, locale: Locale) {
    const tz = await this.bookings.tzOfBusiness(this.prisma, businessId);
    const tomorrow = utcToLocalDate(new Date(Date.now() + 86_400_000), tz);
    const { from, to } = localDayRangeUtc(tomorrow, tz);
    const [bookings, business] = await Promise.all([
      this.prisma.booking.findMany({ where: { businessId, deletedAt: null, startAt: { gte: from, lt: to }, status: { in: ACTIVE_STATUSES } }, orderBy: { startAt: 'asc' } }),
      this.prisma.business.findUnique({ where: { id: businessId }, select: { name: true } }),
    ]);
    const clientIds = bookings.map((b) => b.clientId).filter((id): id is string => Boolean(id));
    const clients = clientIds.length ? await this.prisma.client.findMany({ where: { id: { in: clientIds } } }) : [];
    const clientById = new Map(clients.map((c) => [c.id, c]));
    const serviceIds = bookings.flatMap((b) => (b.services as { serviceId?: string }[] | null)?.[0]?.serviceId ?? []);
    const services = serviceIds.length ? await this.prisma.service.findMany({ where: { id: { in: serviceIds } } }) : [];
    const serviceById = new Map(services.map((s) => [s.id, s]));
    const rows: Array<{ bookingId: string; clientName: string; phone: string; serviceName: string; time: string; whatsappUrl: string }> = [];
    for (const b of bookings) {
      const client = b.clientId ? clientById.get(b.clientId) : undefined;
      if (!client || client.appUserId) continue; // с приложением — напоминаем пушем (F-00-120), не сюда
      const serviceId = (b.services as { serviceId?: string }[] | null)?.[0]?.serviceId;
      const service = serviceId ? serviceById.get(serviceId) : undefined;
      const serviceName = (service?.name as Record<string, string> | undefined)?.ru ?? '';
      const time = utcToLocal(b.startAt, tz);
      const text = t(locale, 'booking.remindTemplate', { name: client.name, time: time.slice(11, 16), service: serviceName, business: business?.name ?? 'BookTime' });
      rows.push({ bookingId: b.id, clientName: client.name, phone: client.phone, serviceName, time, whatsappUrl: waLink(client.phone, text) });
    }
    return rows;
  }

  /** «+ Add sale»: продажа товара, абонемента или сертификата в визите (F-14-092) */
  async addVisitSaleLine(businessId: string, bookingId: string, input: AddVisitSaleLineInput) {
    await this.bookings.find(this.prisma, [businessId], bookingId);
    const data = { kind: input.kind, title: input.title, price: input.price, discount: input.discount ?? 0, sellerStaffId: input.sellerStaffId, code: input.code };
    const row = await this.prisma.visitCashRecord.create({
      data: { id: newId('visitSaleLine'), businessId, bookingId, kind: 'saleLine', data: data as unknown as Prisma.InputJsonValue },
    });
    return { id: row.id, bookingId, ...data };
  }

  /** Корзина у товара в «Products and memberships» — удаляет продажу (F-14-092) */
  async removeVisitSaleLine(businessId: string, id: string) {
    const row = await this.prisma.visitCashRecord.findFirst({ where: { id, businessId, kind: 'saleLine' } });
    if (!row) throw new ApiError('not_found', 'Sale line not found');
    await this.prisma.visitCashRecord.delete({ where: { id } });
  }

  /** Способ оплаты визита: наличные/карта/лояльность, доступна частями («Split», F-14-094/097) */
  async addVisitPayment(businessId: string, bookingId: string, input: AddVisitPaymentInput) {
    if (input.amount <= 0) throw new ApiError('validation', 'Amount must be positive');
    await this.bookings.find(this.prisma, [businessId], bookingId);
    const commissionPercent = input.method === 'card' && input.cardBrand ? CARD_COMMISSION_PERCENT[input.cardBrand] : undefined;
    const data = {
      method: input.method,
      amount: input.amount,
      cashDeskId: input.method === 'cash' ? input.cashDeskId : undefined,
      cardBrand: input.method === 'card' ? input.cardBrand : undefined,
      commissionPercent,
    };
    const row = await this.prisma.visitCashRecord.create({
      data: { id: newId('visitPayment'), businessId, bookingId, kind: 'payment', data: data as unknown as Prisma.InputJsonValue },
    });
    return { id: row.id, bookingId, createdAt: row.createdAt.toISOString(), ...data };
  }

  /** Корзина рядом с суммой — удаляет проведённую оплату (F-14-097) */
  async removeVisitPayment(businessId: string, id: string) {
    const row = await this.prisma.visitCashRecord.findFirst({ where: { id, businessId, kind: 'payment' } });
    if (!row) throw new ApiError('not_found', 'Payment not found');
    await this.prisma.visitCashRecord.delete({ where: { id } });
  }

  /** «Make a refund» — не стирает оплату, помечает возвращённой, чек остаётся в истории (F-14-095) */
  async refundVisitPayment(businessId: string, id: string) {
    const row = await this.prisma.visitCashRecord.findFirst({ where: { id, businessId, kind: 'payment' } });
    if (!row) throw new ApiError('not_found', 'Payment not found');
    await this.prisma.visitCashRecord.update({ where: { id }, data: { refundedAt: new Date() } });
  }

  /** Отправить клиенту квитанцию об оплате визита — пушем в ленту (F-14-095) */
  async sendVisitReceipt(businessId: string, bookingId: string, input: { appUserId: string; total: number }) {
    const row = await this.prisma.inboxItem.create({
      data: { id: newId('inboxItem'), appUserId: input.appUserId, businessId, bookingId, kind: 'receipt', params: { amount: input.total } as Prisma.InputJsonValue },
    });
    return { id: row.id, appUserId: row.appUserId, businessId: row.businessId, bookingId: row.bookingId ?? undefined, kind: row.kind, params: row.params as Record<string, unknown>, createdAt: row.createdAt.toISOString() };
  }

  async isVisitReceiptSent(businessId: string, bookingId: string): Promise<boolean> {
    const row = await this.prisma.inboxItem.findFirst({ where: { businessId, bookingId, kind: 'receipt' } });
    return Boolean(row);
  }
}

interface VisitSaleLineView {
  id: string;
  bookingId: string;
  kind: 'product' | 'membership' | 'certificate';
  title: string;
  price: number;
  discount: number;
  sellerStaffId?: string;
  code?: string;
}

interface VisitPaymentLineView {
  id: string;
  bookingId: string;
  createdAt: string;
  method: 'cash' | 'card' | 'loyalty';
  amount: number;
  cashDeskId?: string;
  cardBrand?: 'visa' | 'mastercard' | 'arca';
  commissionPercent?: number;
}
