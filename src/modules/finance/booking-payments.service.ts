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

/** Лимит ухода «личного счёта» клиента в минус (CLIENT_ACCOUNT_DEBT_LIMIT фронта, domain/finance.ts) */
export const CLIENT_ACCOUNT_DEBT_LIMIT = 5000n;

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

export interface PayTile {
  key: string;
  label: string;
  accountId: string;
  feePercent: number;
}

/**
 * Оплата визита (F-07-036…050/181/184, 02-api.md §12). Деньги (kind='money') — FinOp на каждую оплаченную строку
 * услуги; товары визита (этап 21, лейн finance+stock: extras.goodsLines, «К оплате» = услуги + товары, как в моке)
 * — строка `goods` без FinOp (выручку кладёт документ продажи склада, StockExtService.syncVisitGoodsSale); скидка
 * по акции (kind='discount') и личный счёт клиента (kind='account') — строками без денег в кассе.
 * «К оплате» считается от booking.paidAmount (единый счётчик всех источников — предоплата этапа 7, лояльность
 * этапа 11 пишут прямо туда), не от строк этого раздела.
 */
@Injectable()
export class BookingPaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly live: LiveService,
    private readonly catalog: FinanceCatalogService,
  ) {}

  async requireBooking(businessId: string, bookingId: string): Promise<BookingRow> {
    const b = await this.prisma.booking.findFirst({ where: { id: bookingId, businessId } });
    if (!b) throw new ApiError('not_found', 'Booking not found');
    return b;
  }

  /** Товары визита, которые продаёт склад (строки журнала extras.goodsLines на товары склада, qty > 0) */
  async goodsOf(b: BookingRow): Promise<{ name: string; qty: number; price: number; total: number }[]> {
    const lines = (extrasOf(b.extras) as BookingExtras).goodsLines ?? [];
    if (!lines.length) return [];
    const products = await this.prisma.product.findMany({ where: { businessId: b.businessId, id: { in: lines.map((l) => l.itemId) } }, select: { id: true, name: true } });
    const out: { name: string; qty: number; price: number; total: number }[] = [];
    for (const l of lines) {
      const p = products.find((x) => x.id === l.itemId);
      if (!p || !(l.qty > 0)) continue;
      out.push({ name: p.name, qty: l.qty, price: l.price, total: Math.round(l.price * l.qty * (1 - (l.discountPct ?? 0) / 100)) });
    }
    return out;
  }

  private serviceTotals(b: BookingRow): Money[] {
    const services = Array.isArray(b.services) ? (b.services as { price: number; qty: number }[]) : [];
    return services.map((s) => BigInt(Math.round(s.price * s.qty)));
  }

  /** Строки к оплате: услуги визита, за ними — его товары; и сумма к оплате = услуги (booking.total) + товары */
  async payableOf(b: BookingRow): Promise<{ lineTotals: Money[]; serviceCount: number; payable: Money; goods: { name: string; qty: number; price: number; total: number }[] }> {
    const goods = await this.goodsOf(b);
    const services = this.serviceTotals(b);
    const goodsTotal = goods.reduce((s, g) => s + BigInt(g.total), 0n);
    return { lineTotals: [...services, ...goods.map((g) => BigInt(g.total))], serviceCount: services.length, payable: b.total + goodsTotal, goods };
  }

  private async summaryOf(b: BookingRow) {
    const extras = extrasOf(b.extras) as BookingExtras;
    const { lineTotals, payable, goods } = await this.payableOf(b);
    const due = payable - b.paidAmount > 0n ? payable - b.paidAmount : 0n;
    const status: 'unpaid' | 'partial' | 'paid' = due <= 0n && payable > 0n ? 'paid' : b.paidAmount > 0n ? 'partial' : 'unpaid';
    const moneyLines = await this.prisma.bookingPayment.findMany({ where: { businessId: b.businessId, bookingId: b.id }, orderBy: { createdAt: 'asc' } });
    return {
      bookingId: b.id,
      total: moneyToJson(b.total),
      payableTotal: moneyToJson(payable),
      paidAmount: moneyToJson(b.paidAmount),
      due: moneyToJson(due),
      status,
      lineTotals: lineTotals.map(moneyToJson),
      goods,
      payments: (extras.payments ?? []).map((p) => ({ id: p.id, method: p.method, amount: p.amount, label: p.label, at: p.at })),
      moneyLines: moneyLines.map((l) => ({
        id: l.id,
        serviceIndex: l.serviceIndex ?? undefined,
        kind: l.kind as 'money' | 'discount' | 'account',
        methodKey: l.methodKey,
        methodLabel: l.methodLabel,
        accountId: l.accountId ?? undefined,
        amount: moneyToJson(l.amount),
        operationId: l.finOpId ?? undefined,
        refundedAmount: l.refundedAmount > 0n ? moneyToJson(l.refundedAmount) : undefined,
        goods: l.goods || undefined,
        debt: l.debt || undefined,
        loyaltyAccountId: l.loyaltyAccountId ?? undefined,
        groupId: l.groupId ?? undefined,
        cancelled: l.cancelled,
        cancelledAt: l.cancelledAt?.toISOString(),
        createdAt: l.createdAt.toISOString(),
        createdBy: l.createdBy ?? 'system',
      })),
      note: (extras as BookingExtras & { paymentNote?: string }).paymentNote,
    };
  }

  async getSummary(businessId: string, bookingId: string) {
    const b = await this.requireBooking(businessId, bookingId);
    return this.summaryOf(b);
  }

  /** Método/tile → касса и % комиссии, из payment_methods реального бизнеса (В-33/§12, упрощённо — см. schemas) */
  private async resolveMethod(businessId: string, methodKey: string, accountIdOverride?: string): Promise<PayTile> {
    await this.catalog.ensureDefaults(businessId);
    const method = await this.prisma.paymentMethod.findFirst({ where: { businessId, key: methodKey, active: true } });
    if (!method) throw new ApiError('not_found', 'Payment method not found');
    const accountId = accountIdOverride ?? method.accountId;
    if (!accountId) throw new ApiError('validation', 'Payment method has no cash register');
    return { key: methodKey, label: method.label, accountId, feePercent: method.feePercent };
  }

  private async activeLines(businessId: string, bookingId: string) {
    return this.prisma.bookingPayment.findMany({ where: { businessId, bookingId, cancelled: false } });
  }

  /** Пишет деньги: FinOp на каждую оплаченную строку услуги + строки BookingPayment (товары — без FinOp) +
   * строка в extras.payments + paidAmount. `tile` — явная плитка (ссылка на оплату онлайн, этап 21), иначе метод. */
  async applyMoney(ctx: RequestContext, b: BookingRow, amount: Money, methodKey: string, accountIdOverride: string | undefined, tile?: PayTile) {
    if (amount <= 0n) throw new ApiError('invalid_amount', 'Amount must be positive');
    const businessId = b.businessId;
    const { label, accountId, feePercent } = tile ?? (await this.resolveMethod(businessId, methodKey, accountIdOverride));
    const { lineTotals, serviceCount } = await this.payableOf(b);
    const existing = await this.activeLines(businessId, b.id);
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
    const client = b.clientId ? await this.prisma.client.findFirst({ where: { id: b.clientId }, select: { name: true } }) : null;
    const groupId = newId('payment');

    const paymentIds: string[] = [];
    let firstOpId: string | undefined;
    await this.prisma.$transaction(async (tx) => {
      for (const alloc of allocations) {
        const isGoods = alloc.serviceIndex >= serviceCount;
        let opId: string | undefined;
        if (!isGoods) {
          opId = newId('finOp');
          firstOpId ??= opId;
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
              partyName: client?.name ?? undefined,
              source: 'booking',
              refId: b.id,
              docNumber,
              lineLabel: serviceNameOf(alloc.serviceIndex),
              history,
              createdBy: by,
              updatedBy: by,
            },
          });
        }
        const paymentId = paymentIds.length === 0 ? groupId : newId('payment');
        await tx.bookingPayment.create({
          data: { id: paymentId, businessId, bookingId: b.id, serviceIndex: alloc.serviceIndex, kind: 'money', methodKey, methodLabel: label, accountId, amount: alloc.amount, finOpId: opId, goods: isGoods, groupId, createdBy: by },
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
              feeOfOperationId: firstOpId,
              history: [{ at: at.toISOString(), by: 'system', action: 'created' }] as Prisma.InputJsonValue,
              createdBy: 'system',
              updatedBy: 'system',
            },
          });
        }
      }
      await tx.financeDocument.create({ data: { id: newId('financeDocument'), businessId, number: docNumber, date: at, type: 'visit', amount, refBookingId: b.id, createdBy: by, updatedBy: by } });
      await this.pushExtrasLine(tx, b, { id: groupId, method: methodKey, amount: Number(amount), label, at: localAt }, amount);
      await this.audit.record(tx, ctx, { action: 'pay', entityType: 'booking', entityId: b.id, businessId, before: { paidAmount: moneyToJson(b.paidAmount) }, after: { paidAmount: moneyToJson(b.paidAmount + amount) } });
    });
    await this.live.publish(`biz:${businessId}:day:${utcToLocalDate(at)}`, { type: 'booking.changed', data: { bookingIds: [b.id] } });
    return firstOpId;
  }

  private async pushExtrasLine(tx: Prisma.TransactionClient, b: BookingRow, line: { id: string; method: string; amount: number; label: string; at: string }, amount: Money) {
    const fresh = await tx.booking.findUniqueOrThrow({ where: { id: b.id }, select: { extras: true, paidAmount: true } });
    const extras = extrasOf(fresh.extras) as BookingExtras;
    const payments = [...(extras.payments ?? []), line];
    const nextExtras = { ...extras, payments, paidAmount: Number(fresh.paidAmount + amount) };
    await tx.booking.update({ where: { id: b.id }, data: { extras: nextExtras as unknown as Prisma.InputJsonValue, paidAmount: { increment: amount }, version: { increment: 1 } } });
  }

  /** Строки без денег в кассе: скидка по акции (F-07-041) или личный счёт клиента (F-07-061/062) */
  private async applyNonMoney(ctx: RequestContext, b: BookingRow, amount: Money, kind: 'discount' | 'account', methodKey: string, label: string, extra: { debt?: boolean; loyaltyAccountId?: string }) {
    const { lineTotals } = await this.payableOf(b);
    const existing = await this.activeLines(b.businessId, b.id);
    const allocations = allocateAmountToLines(lineTotals, existing.map((e) => ({ serviceIndex: e.serviceIndex ?? undefined, amount: e.amount })), amount);
    if (allocations.length === 0) allocations.push({ serviceIndex: 0, amount });
    const groupId = newId('payment');
    const by = ctx.member!.staffId;
    await this.prisma.$transaction(async (tx) => {
      let first = true;
      for (const alloc of allocations) {
        await tx.bookingPayment.create({
          data: { id: first ? groupId : newId('payment'), businessId: b.businessId, bookingId: b.id, serviceIndex: alloc.serviceIndex, kind, methodKey, methodLabel: label.slice(0, 80), amount: alloc.amount, debt: Boolean(extra.debt), loyaltyAccountId: extra.loyaltyAccountId, groupId, createdBy: by },
        });
        first = false;
      }
      await this.pushExtrasLine(tx, b, { id: groupId, method: kind === 'discount' ? 'discount' : 'account', amount: Number(amount), label, at: nowLocal() }, amount);
      await this.audit.record(tx, ctx, { action: 'pay', entityType: 'booking', entityId: b.id, businessId: b.businessId, before: { paidAmount: moneyToJson(b.paidAmount) }, after: { paidAmount: moneyToJson(b.paidAmount + amount), kind } });
    });
    await this.live.publish(`biz:${b.businessId}:day:${utcToLocalDate(new Date())}`, { type: 'booking.changed', data: { bookingIds: [b.id] } });
  }

  private async dueOf(b: BookingRow): Promise<Money> {
    const { payable } = await this.payableOf(b);
    return payable - b.paidAmount;
  }

  /** Скидка по акции строкой оплаты (F-07-041); `exactLabel` — подпись как есть (лояльность: «Списание бонусов») */
  async applyDiscount(ctx: RequestContext, businessId: string, bookingId: string, label: string, amount: number, exactLabel?: boolean) {
    const b = await this.requireBooking(businessId, bookingId);
    const due = await this.dueOf(b);
    const applied = BigInt(amount) < due ? BigInt(amount) : due;
    if (applied <= 0n) throw new ApiError('invalid_amount', 'nothing_to_discount');
    await this.applyNonMoney(ctx, b, applied, 'discount', 'promo', exactLabel ? label : `Скидка по акции «${label}»`, {});
    return this.getSummary(businessId, bookingId);
  }

  /** Баланс «личного счёта» клиента (F-07-059…064, демо-минимум мока): пополнения − оплаты визитов счётом
   *  (кроме уже списанных «Лояльностью») − возвраты со счёта. Считается, а не хранится — нечему расходиться. */
  async clientAccountBalance(businessId: string, clientId: string): Promise<Money> {
    const [topUpItem, refundItem] = await Promise.all([this.catalog.systemItemId(businessId, 'accountTopUp'), this.catalog.systemItemId(businessId, 'refund')]);
    const ops = await this.prisma.finOp.findMany({ where: { businessId, partyType: 'client', partyId: clientId, source: 'account', cancelled: false, itemId: { in: [topUpItem, refundItem] } }, select: { itemId: true, amount: true, refId: true } });
    const topUps = ops.filter((o) => o.itemId === topUpItem).reduce((s, o) => s + o.amount, 0n);
    const refunds = ops.filter((o) => o.itemId === refundItem && !o.refId).reduce((s, o) => s + o.amount, 0n);
    const bookingIds = (await this.prisma.booking.findMany({ where: { businessId, clientId }, select: { id: true } })).map((x) => x.id);
    const spent = bookingIds.length
      ? (await this.prisma.bookingPayment.findMany({ where: { businessId, bookingId: { in: bookingIds }, kind: 'account', cancelled: false, loyaltyAccountId: null }, select: { amount: true, refundedAmount: true } })).reduce((s, p) => s + p.amount - p.refundedAmount, 0n)
      : 0n;
    return topUps - refunds - spent;
  }

  /** Оплата со счёта клиента, в том числе в долг до лимита (F-07-061/062); `loyalty` — деньги уже списаны «Лояльностью» */
  async applyAccount(ctx: RequestContext, businessId: string, bookingId: string, clientId: string, amount: number, loyalty?: { accountId: string; debt: boolean }) {
    const b = await this.requireBooking(businessId, bookingId);
    const due = await this.dueOf(b);
    const applied = BigInt(amount) < due ? BigInt(amount) : due;
    if (applied <= 0n) throw new ApiError('invalid_amount', 'nothing_to_pay');
    let debt = loyalty?.debt ?? false;
    if (!loyalty) {
      const next = (await this.clientAccountBalance(businessId, clientId)) - applied;
      if (next < -CLIENT_ACCOUNT_DEBT_LIMIT) throw new ApiError('insufficient_balance', 'debt_limit_exceeded');
      debt = next < 0n;
    }
    await this.applyNonMoney(ctx, b, applied, 'account', 'account', 'Личный счёт клиента', { debt, loyaltyAccountId: loyalty?.accountId });
    return this.getSummary(businessId, bookingId);
  }

  async pay(ctx: RequestContext, businessId: string, bookingId: string, body: PayBookingBody) {
    const first = await this.requireBooking(businessId, bookingId);
    if (first.deletedAt) throw new ApiError('not_found', 'Booking not found');
    if (body.mode === 'quick') {
      const due = await this.dueOf(first);
      if (due <= 0n) throw new ApiError('invalid_amount', 'Already paid');
      await this.applyMoney(ctx, first, due, body.methodKey, body.accountId);
    } else {
      // Сначала счёт клиента (лояльность и счета — первыми, F-07-040), потом деньги — как payBookingSplit мока
      const ordered = [...body.parts.filter((p) => p.methodKey === 'account'), ...body.parts.filter((p) => p.methodKey !== 'account')];
      for (const part of ordered) {
        const fresh = await this.requireBooking(businessId, bookingId);
        const due = await this.dueOf(fresh);
        if (due <= 0n) break;
        const amount = BigInt(part.amount) < due ? BigInt(part.amount) : due;
        if (amount <= 0n) continue;
        if (part.methodKey === 'account') {
          if (!fresh.clientId) throw new ApiError('validation', 'no_client');
          await this.applyAccount(ctx, businessId, bookingId, fresh.clientId, Number(amount), part.loyaltyAccountId ? { accountId: part.loyaltyAccountId, debt: Boolean(part.debt) } : undefined);
          continue;
        }
        await this.applyMoney(ctx, fresh, amount, part.methodKey, part.accountId);
      }
    }
    return this.getSummary(businessId, bookingId);
  }

  /** DELETE …/payments/:id — отменяет ВЕСЬ платёж (все строки его groupId, Ф11): снимает FinOp(и) с комиссией,
   * откатывает paidAmount и убирает строку extras.payments этого платежа */
  async cancelLine(ctx: RequestContext, businessId: string, paymentId: string) {
    const line = await this.prisma.bookingPayment.findFirst({ where: { id: paymentId, businessId } });
    if (!line) throw new ApiError('not_found', 'Payment not found');
    if (line.cancelled) return this.getSummary(businessId, line.bookingId);
    const b = await this.requireBooking(businessId, line.bookingId);
    const group = line.groupId ? await this.prisma.bookingPayment.findMany({ where: { businessId, bookingId: line.bookingId, groupId: line.groupId, cancelled: false } }) : [line];
    const total = group.reduce((s, l) => s + l.amount, 0n);
    await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      for (const l of group) {
        await tx.bookingPayment.update({ where: { id: l.id }, data: { cancelled: true, cancelledAt: now } });
        if (!l.finOpId) continue;
        const op = await tx.finOp.findUnique({ where: { id: l.finOpId } });
        if (op && !op.cancelled) {
          const history = Array.isArray(op.history) ? [...(op.history as Record<string, unknown>[])] : [];
          history.push({ at: now.toISOString(), by: ctx.member!.staffId, action: 'cancelled' });
          await tx.finOp.update({ where: { id: op.id }, data: { cancelled: true, cancelledAt: now, cancelledBy: ctx.member!.staffId, history: history as Prisma.InputJsonValue } });
          await tx.finOp.updateMany({ where: { businessId, feeOfOperationId: op.id, cancelled: false }, data: { cancelled: true, cancelledAt: now, cancelledBy: ctx.member!.staffId } });
        }
      }
      const fresh = await tx.booking.findUniqueOrThrow({ where: { id: b.id }, select: { extras: true, paidAmount: true } });
      const extras = extrasOf(fresh.extras) as BookingExtras;
      const ids = new Set([line.groupId, ...group.map((l) => l.id)].filter(Boolean));
      const payments = (extras.payments ?? []).filter((p) => !ids.has(p.id));
      const nextPaid = fresh.paidAmount - total > 0n ? fresh.paidAmount - total : 0n;
      const nextExtras = { ...extras, payments, paidAmount: Number(nextPaid) };
      await tx.booking.update({ where: { id: b.id }, data: { extras: nextExtras as unknown as Prisma.InputJsonValue, paidAmount: nextPaid, version: { increment: 1 } } });
      await this.audit.record(tx, ctx, { action: 'cancel', entityType: 'bookingPayment', entityId: line.id, businessId, before: { amount: moneyToJson(total) }, after: null });
    });
    return this.getSummary(businessId, line.bookingId);
  }

  async setNote(ctx: RequestContext, businessId: string, bookingId: string, note: string) {
    const b = await this.requireBooking(businessId, bookingId);
    const extras = extrasOf(b.extras) as BookingExtras & { paymentNote?: string };
    await this.prisma.booking.update({ where: { id: b.id }, data: { extras: { ...extras, paymentNote: note } as unknown as Prisma.InputJsonValue, updatedBy: ctx.member!.staffId, version: { increment: 1 } } });
  }

  /** Полный возврат (В-33-адаптация refundBookingFull мока) — отменяет все активные денежные платежи визита */
  async refundFull(ctx: RequestContext, businessId: string, bookingId: string, reason: string) {
    const lines = await this.prisma.bookingPayment.findMany({ where: { businessId, bookingId, kind: { in: ['money', 'account'] }, cancelled: false } });
    const done = new Set<string>();
    for (const line of lines) {
      const key = line.groupId ?? line.id;
      if (done.has(key)) continue;
      done.add(key);
      await this.cancelLine(ctx, businessId, line.id);
    }
    await this.setNote(ctx, businessId, bookingId, reason);
    return this.getSummary(businessId, bookingId);
  }

  /**
   * Частичный (или полный) возврат по одному платежу визита (fin-review Ф8, refundPaymentGroupSync мока) —
   * ОТДЕЛЬНОЙ расходной операцией «Возврат» с той же кассы тем же способом; исходная оплата остаётся (визит не
   * становится снова «К оплате», касса дня оплаты не меняется задним числом), у строк растёт refundedAmount.
   * Товары визита: денег в кассе finance у них нет (их кладёт продажа склада) — только отметка в строках.
   * Счёт клиента: деньги возвращаются на «личный счёт» — расходом «Возврат» с source='account' без кассы нет,
   * поэтому уменьшаем списание: строка account с refundedAmount не считается в clientAccountBalance (см. ниже).
   */
  async refundPayment(ctx: RequestContext, businessId: string, paymentId: string, amount: number, reason: string) {
    const line = await this.prisma.bookingPayment.findFirst({ where: { id: paymentId, businessId } });
    if (!line || line.cancelled) throw new ApiError('not_found', 'payment_not_found');
    if (line.kind === 'discount') throw new ApiError('discount_not_refundable', 'Discount is not money');
    const b = await this.requireBooking(businessId, line.bookingId);
    const group = line.groupId ? await this.prisma.bookingPayment.findMany({ where: { businessId, bookingId: b.id, groupId: line.groupId, cancelled: false }, orderBy: { createdAt: 'asc' } }) : [line];
    const net = group.reduce((s, l) => s + (l.amount - l.refundedAmount > 0n ? l.amount - l.refundedAmount : 0n), 0n);
    const want = BigInt(Math.round(Math.max(0, amount)));
    if (want <= 0n) throw new ApiError('invalid_amount', 'Amount must be positive');
    const take = want < net ? want : net;
    if (take <= 0n) throw new ApiError('invalid_amount', 'nothing_to_refund');
    const by = ctx.member!.staffId;
    const at = new Date();
    const goodsOnly = group.every((l) => l.goods);
    await this.prisma.$transaction(async (tx) => {
      if (line.kind === 'money' && !goodsOnly) {
        const src = group.find((l) => l.finOpId)?.finOpId;
        const source = src ? await tx.finOp.findUnique({ where: { id: src } }) : null;
        const accountId = line.accountId ?? source?.accountId;
        if (!accountId) throw new ApiError('payment_setup_incomplete', 'No cash register');
        const account = await tx.cashRegister.findUnique({ where: { id: accountId } });
        if (account?.kind === 'cash') {
          const ops = await tx.finOp.findMany({ where: { accountId, cancelled: false }, select: { kind: true, amount: true } });
          const balance = ops.reduce((s, o) => s + (o.kind === 'income' || o.kind === 'transfer_in' ? o.amount : -o.amount), account.openingBalance);
          if (balance < take) throw new ApiError('insufficient_cash', 'Not enough cash in the drawer');
        }
        const itemId = await this.catalog.systemItemId(businessId, 'refund');
        const client = b.clientId ? await tx.client.findFirst({ where: { id: b.clientId }, select: { name: true } }) : null;
        await tx.finOp.create({
          data: {
            id: newId('finOp'),
            businessId,
            locationId: b.locationId,
            accountId,
            itemId,
            kind: 'expense',
            amount: take,
            date: at,
            method: source?.method ?? (account?.kind === 'cash' ? 'cash' : 'card'),
            partyType: b.clientId ? 'client' : 'none',
            partyId: b.clientId ?? undefined,
            partyName: client?.name ?? undefined,
            comment: reason.trim() || undefined,
            source: 'booking',
            refId: b.id,
            refundOfId: source?.id,
            docNumber: source?.docNumber ?? undefined,
            lineLabel: source?.lineLabel ?? undefined,
            history: [{ at: at.toISOString(), by, action: 'created' }] as Prisma.InputJsonValue,
            createdBy: by,
            updatedBy: by,
          },
        });
        if (source) {
          const history = Array.isArray(source.history) ? [...(source.history as Record<string, unknown>[])] : [];
          history.push({ at: at.toISOString(), by, action: 'refunded' });
          await tx.finOp.update({ where: { id: source.id }, data: { refundedAmount: { increment: take }, history: history as Prisma.InputJsonValue } });
        }
      }
      // Разнос возврата по строкам — с последней к первой (как мок)
      let left = take;
      for (const l of [...group].reverse()) {
        if (left <= 0n) break;
        const lineNet = l.amount - l.refundedAmount;
        if (lineNet <= 0n) continue;
        const part = lineNet < left ? lineNet : left;
        await tx.bookingPayment.update({ where: { id: l.id }, data: { refundedAmount: { increment: part } } });
        left -= part;
      }
      await this.audit.record(tx, ctx, { action: 'refund', entityType: 'bookingPayment', entityId: line.id, businessId, before: { net: moneyToJson(net) }, after: { refunded: moneyToJson(take), reason } });
    });
    return this.getSummary(businessId, b.id);
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
