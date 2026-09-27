import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { newId } from '../../common/ids/ids.js';
import { LiveService } from '../../common/live/live.service.js';
import { moneyToJson, percentOf } from '../../common/money/money.js';
import { PrismaService } from '../../common/prisma.service.js';
import { nowLocal, utcToLocalDate } from '../../common/time/time.js';
import { extrasOf, type BookingExtras } from '../journal/rules.js';
import { FinanceCatalogService } from './finance-catalog.service.js';
import type { PayBookingBody } from './finance.schemas.js';

type Money = bigint;

/** Остаток к оплате по каждой строке визита (F-07-181), портировано 1:1 из domain/finance.ts фронта (bigint) */
function remainingByLine(lineTotals: Money[], payments: { serviceIndex?: number; amount: Money; cancelled?: boolean }[]): Money[] {
  const remaining = [...lineTotals];
  for (const p of payments) {
    if (p.cancelled || p.serviceIndex === undefined) continue;
    if (remaining[p.serviceIndex] !== undefined) remaining[p.serviceIndex] = remaining[p.serviceIndex]! - p.amount;
  }
  return remaining;
}

/** Разносит сумму по строкам визита по порядку — первая непогашенная строка первой (domain/finance.ts) */
function allocateAmountToLines(lineTotals: Money[], payments: { serviceIndex?: number; amount: Money; cancelled?: boolean }[], amount: Money): { serviceIndex: number; amount: Money }[] {
  const remaining = remainingByLine(lineTotals, payments);
  const result: { serviceIndex: number; amount: Money }[] = [];
  let left = amount;
  for (let i = 0; i < remaining.length && left > 0n; i++) {
    if (remaining[i]! <= 0n) continue;
    const take = remaining[i]! < left ? remaining[i]! : left;
    result.push({ serviceIndex: i, amount: take });
    left -= take;
  }
  return result;
}

type BookingRow = { id: string; businessId: string; locationId: string; staffId: string; clientId: string | null; status: string; services: unknown; total: bigint; paidAmount: bigint; extras: unknown; deletedAt: Date | null };

/**
 * Оплата визита (F-07-036…050/181/184, 02-api.md §12) — только денежная оплата (kind='money'); скидки/лояльность/
 * личный счёт пишутся разделом «Лояльность» (этап 11, POST …/loyalty/bookings/:id/apply) прямо в `extras.payments`.
 * «К оплате» здесь считается от booking.paidAmount (единый счётчик всех источников), а не только от строк этого
 * раздела — иначе клиент, уже закрывший визит предоплатой/бонусами, был бы посчитан неоплаченным (решено по ходу,
 * PROGRESS.md этапа 12: тот же класс ошибки, что стадия 11 поймала в ownerId).
 */
@Injectable()
export class BookingPaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly live: LiveService,
    private readonly catalog: FinanceCatalogService,
  ) {}

  private async requireBooking(businessId: string, bookingId: string): Promise<BookingRow> {
    const b = await this.prisma.booking.findFirst({ where: { id: bookingId, businessId } });
    if (!b) throw new ApiError('not_found', 'Booking not found');
    return b;
  }

  private lineTotalsOf(b: BookingRow): Money[] {
    const services = Array.isArray(b.services) ? (b.services as { price: number; qty: number }[]) : [];
    return services.map((s) => BigInt(Math.round(s.price * s.qty)));
  }

  private async summaryOf(b: BookingRow) {
    const extras = extrasOf(b.extras) as BookingExtras;
    const lineTotals = this.lineTotalsOf(b);
    const due = b.total - b.paidAmount > 0n ? b.total - b.paidAmount : 0n;
    const status: 'unpaid' | 'partial' | 'paid' = due <= 0n && b.total > 0n ? 'paid' : b.paidAmount > 0n ? 'partial' : 'unpaid';
    const moneyLines = await this.prisma.bookingPayment.findMany({ where: { businessId: b.businessId, bookingId: b.id }, orderBy: { createdAt: 'asc' } });
    return {
      bookingId: b.id,
      total: moneyToJson(b.total),
      paidAmount: moneyToJson(b.paidAmount),
      due: moneyToJson(due),
      status,
      lineTotals: lineTotals.map(moneyToJson),
      payments: (extras.payments ?? []).map((p) => ({ id: p.id, method: p.method, amount: p.amount, label: p.label, at: p.at })),
      moneyLines: moneyLines.map((l) => ({ id: l.id, serviceIndex: l.serviceIndex ?? undefined, methodKey: l.methodKey, methodLabel: l.methodLabel, accountId: l.accountId ?? undefined, amount: moneyToJson(l.amount), operationId: l.finOpId ?? undefined, cancelled: l.cancelled, cancelledAt: l.cancelledAt?.toISOString(), createdAt: l.createdAt.toISOString(), createdBy: l.createdBy ?? 'system' })),
      note: (extras as BookingExtras & { paymentNote?: string }).paymentNote,
    };
  }

  async getSummary(businessId: string, bookingId: string) {
    const b = await this.requireBooking(businessId, bookingId);
    return this.summaryOf(b);
  }

  /** Método/tile → касса и % комиссии, из payment_methods реального бизнеса (В-33/§12, упрощённо — см. schemas) */
  private async resolveMethod(businessId: string, methodKey: string, accountIdOverride?: string) {
    await this.catalog.ensureDefaults(businessId);
    const method = await this.prisma.paymentMethod.findFirst({ where: { businessId, key: methodKey, active: true } });
    if (!method) throw new ApiError('not_found', 'Payment method not found');
    const accountId = accountIdOverride ?? method.accountId;
    if (!accountId) throw new ApiError('validation', 'Payment method has no cash register');
    return { label: method.label, accountId, feePercent: method.feePercent };
  }

  /** Пишет деньги: FinOp(и) на каждую оплаченную строку + BookingPayment + строка в extras.payments + paidAmount */
  private async applyMoney(ctx: RequestContext, b: BookingRow, amount: Money, methodKey: string, accountIdOverride: string | undefined) {
    if (amount <= 0n) throw new ApiError('invalid_amount', 'Amount must be positive');
    const businessId = b.businessId;
    const { label, accountId, feePercent } = await this.resolveMethod(businessId, methodKey, accountIdOverride);
    const lineTotals = this.lineTotalsOf(b);
    const existing = await this.prisma.bookingPayment.findMany({ where: { businessId, bookingId: b.id, kind: 'money', cancelled: false } });
    const allocations = allocateAmountToLines(
      lineTotals,
      existing.map((e) => ({ serviceIndex: e.serviceIndex ?? undefined, amount: e.amount })),
      amount,
    );
    if (allocations.length === 0) allocations.push({ serviceIndex: 0, amount });
    const itemId = await this.catalog.systemItemId(businessId, 'servicePayment');
    const docNumber = this.catalog.docNumber();
    const at = new Date();
    const localAt = nowLocal();
    const by = ctx.member!.staffId;
    const bookedServices = Array.isArray(b.services) ? (b.services as { serviceId: string }[]) : [];
    const catalogServices = await this.prisma.service.findMany({ where: { businessId } });
    const serviceNameOf = (idx: number): string => {
      const row = catalogServices.find((s) => s.id === bookedServices[idx]?.serviceId);
      return (row?.name as { ru?: string } | null)?.ru ?? 'Услуга';
    };

    const paymentIds: string[] = [];
    await this.prisma.$transaction(async (tx) => {
      for (const alloc of allocations) {
        const opId = newId('finOp');
        const history = [{ at: at.toISOString(), by, action: 'created' }] as Prisma.InputJsonValue;
        await tx.finOp.create({
          data: {
            id: opId,
            businessId,
            locationId: b.locationId,
            accountId,
            itemId,
            kind: 'income',
            amount: alloc.amount,
            date: at,
            method: methodKey === 'cash' ? 'cash' : methodKey === 'card' ? 'card' : 'other',
            partyType: b.clientId ? 'client' : 'none',
            partyId: b.clientId ?? undefined,
            source: 'booking',
            refId: b.id,
            docNumber,
            lineLabel: serviceNameOf(alloc.serviceIndex),
            history,
            createdBy: by,
            updatedBy: by,
          },
        });
        const paymentId = newId('payment');
        await tx.bookingPayment.create({
          data: { id: paymentId, businessId, bookingId: b.id, serviceIndex: alloc.serviceIndex, kind: 'money', methodKey, methodLabel: label, accountId, amount: alloc.amount, finOpId: opId, createdBy: by },
        });
        paymentIds.push(paymentId);
      }
      if (feePercent > 0) {
        const feeAmount = percentOf(amount, feePercent);
        if (feeAmount > 0n) {
          const feeItemId = await this.catalog.systemItemId(businessId, 'acquiringFee');
          await tx.finOp.create({
            data: {
              id: newId('finOp'),
              businessId,
              locationId: b.locationId,
              accountId,
              itemId: feeItemId,
              kind: 'expense',
              amount: feeAmount,
              date: at,
              method: 'other',
              partyType: 'none',
              source: 'booking',
              refId: b.id,
              comment: `Комиссия за эквайринг · ${label}`,
              history: [{ at: at.toISOString(), by: 'system', action: 'created' }] as Prisma.InputJsonValue,
              createdBy: 'system',
              updatedBy: 'system',
            },
          });
        }
      }
      await tx.financeDocument.create({ data: { id: newId('financeDocument'), businessId, number: docNumber, date: at, type: 'visit', amount, refBookingId: b.id, createdBy: by, updatedBy: by } });
      const extras = extrasOf(b.extras) as BookingExtras;
      const line = { id: paymentIds[0] ?? newId('payment'), method: methodKey, amount: Number(amount), label, at: localAt };
      const payments = [...(extras.payments ?? []), line];
      const nextExtras = { ...extras, payments, paidAmount: Number(b.paidAmount + amount) };
      await tx.booking.update({ where: { id: b.id }, data: { extras: nextExtras as unknown as Prisma.InputJsonValue, paidAmount: { increment: amount }, version: { increment: 1 } } });
      await this.audit.record(tx, ctx, { action: 'pay', entityType: 'booking', entityId: b.id, businessId, before: { paidAmount: moneyToJson(b.paidAmount) }, after: { paidAmount: moneyToJson(b.paidAmount + amount) } });
    });
    await this.live.publish(`biz:${businessId}:day:${utcToLocalDate(at)}`, { type: 'booking.changed', data: { bookingIds: [b.id] } });
  }

  async pay(ctx: RequestContext, businessId: string, bookingId: string, body: PayBookingBody) {
    const first = await this.requireBooking(businessId, bookingId);
    if (first.deletedAt) throw new ApiError('not_found', 'Booking not found');
    if (body.mode === 'quick') {
      const due = first.total - first.paidAmount;
      if (due <= 0n) throw new ApiError('invalid_amount', 'Already paid');
      await this.applyMoney(ctx, first, due, body.methodKey, body.accountId);
    } else {
      for (const part of body.parts) {
        const fresh = await this.requireBooking(businessId, bookingId);
        const due = fresh.total - fresh.paidAmount;
        if (due <= 0n) break;
        const amount = BigInt(part.amount) < due ? BigInt(part.amount) : due;
        if (amount <= 0n) continue;
        await this.applyMoney(ctx, fresh, amount, part.methodKey, part.accountId);
      }
    }
    return this.getSummary(businessId, bookingId);
  }

  /** DELETE …/payments/:id — отменяет одну строку денежной оплаты: снимает FinOp, откатывает paidAmount и
   * убирает соответствующую строку extras.payments (тот же id — payment-строка и BookingPayment делят id) */
  async cancelLine(ctx: RequestContext, businessId: string, paymentId: string) {
    const line = await this.prisma.bookingPayment.findFirst({ where: { id: paymentId, businessId } });
    if (!line) throw new ApiError('not_found', 'Payment not found');
    if (line.cancelled) return this.getSummary(businessId, line.bookingId);
    const b = await this.requireBooking(businessId, line.bookingId);
    await this.prisma.$transaction(async (tx) => {
      await tx.bookingPayment.update({ where: { id: line.id }, data: { cancelled: true, cancelledAt: new Date() } });
      if (line.finOpId) {
        const op = await tx.finOp.findUnique({ where: { id: line.finOpId } });
        if (op && !op.cancelled) {
          const history = Array.isArray(op.history) ? [...(op.history as Record<string, unknown>[])] : [];
          history.push({ at: new Date().toISOString(), by: ctx.member!.staffId, action: 'cancelled' });
          await tx.finOp.update({ where: { id: op.id }, data: { cancelled: true, cancelledAt: new Date(), cancelledBy: ctx.member!.staffId, history: history as Prisma.InputJsonValue } });
        }
      }
      const extras = extrasOf(b.extras) as BookingExtras;
      const payments = (extras.payments ?? []).filter((p) => p.id !== line.id);
      const nextExtras = { ...extras, payments, paidAmount: Math.max(0, Number(b.paidAmount) - Number(line.amount)) };
      await tx.booking.update({ where: { id: b.id }, data: { extras: nextExtras as unknown as Prisma.InputJsonValue, paidAmount: { decrement: line.amount }, version: { increment: 1 } } });
      await this.audit.record(tx, ctx, { action: 'cancel', entityType: 'bookingPayment', entityId: line.id, businessId, before: { amount: moneyToJson(line.amount) }, after: null });
    });
    return this.getSummary(businessId, line.bookingId);
  }

  async setNote(ctx: RequestContext, businessId: string, bookingId: string, note: string) {
    const b = await this.requireBooking(businessId, bookingId);
    const extras = extrasOf(b.extras) as BookingExtras & { paymentNote?: string };
    await this.prisma.booking.update({ where: { id: b.id }, data: { extras: { ...extras, paymentNote: note } as unknown as Prisma.InputJsonValue, updatedBy: ctx.member!.staffId, version: { increment: 1 } } });
  }

  /** Полный возврат (В-33-адаптация refundBookingFull мока) — отменяет все активные money-строки визита */
  async refundFull(ctx: RequestContext, businessId: string, bookingId: string, reason: string) {
    const lines = await this.prisma.bookingPayment.findMany({ where: { businessId, bookingId, kind: 'money', cancelled: false } });
    for (const line of lines) await this.cancelLine(ctx, businessId, line.id);
    await this.setNote(ctx, businessId, bookingId, reason);
    return this.getSummary(businessId, bookingId);
  }

  /** Нефискальный чек визита (В-33: «нефискальный чек в кассе») — снимок для печати/показа клиенту */
  async receipt(businessId: string, bookingId: string) {
    const b = await this.requireBooking(businessId, bookingId);
    const business = await this.prisma.business.findUnique({ where: { id: businessId } });
    const location = await this.prisma.location.findFirst({ where: { id: b.locationId } });
    const staff = await this.prisma.staff.findFirst({ where: { id: b.staffId } });
    const client = b.clientId ? await this.prisma.client.findFirst({ where: { id: b.clientId } }) : null;
    const services = Array.isArray(b.services) ? (b.services as { serviceId: string; price: number; qty: number }[]) : [];
    const svcRows = await this.prisma.service.findMany({ where: { businessId } });
    const extras = extrasOf(b.extras) as BookingExtras;
    return {
      bookingId: b.id,
      businessName: business?.name ?? businessId,
      locationName: (location?.name as { ru?: string } | null)?.ru ?? undefined,
      locationAddress: (location?.address as { ru?: string } | null)?.ru ?? undefined,
      staffName: staff?.name ?? undefined,
      clientName: client ? nameOfClient(client) : undefined,
      date: utcToLocalDate(new Date()),
      lines: services.map((s) => ({ name: (svcRows.find((r) => r.id === s.serviceId)?.name as { ru?: string } | null)?.ru ?? 'Услуга', price: s.price, qty: s.qty, total: Math.round(s.price * s.qty) })),
      total: moneyToJson(b.total),
      paidAmount: moneyToJson(b.paidAmount),
      payments: extras.payments ?? [],
    };
  }
}

function nameOfClient(client: { name: string; lastName: string | null }): string {
  return [client.name, client.lastName].filter(Boolean).join(' ').trim();
}
