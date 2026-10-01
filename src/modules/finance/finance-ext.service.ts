import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { newId } from '../../common/ids/ids.js';
import { moneyToJson } from '../../common/money/money.js';
import { PrismaService } from '../../common/prisma.service.js';
import { localDayRangeUtc, utcToLocal } from '../../common/time/time.js';
import { BookingPaymentsService } from './booking-payments.service.js';
import { isPrepaymentRegister } from './prepayment-ops.js';
import { FinanceCatalogService } from './finance-catalog.service.js';

/**
 * Этап 21, лейн «finance+stock»: остаток раздела «Финансы», который фасад `src/api/finance.ts` в режиме api ещё
 * считал в браузере. Настройки раздела — `business_settings` по ключам `finance.<key>` (JSON по разделам, F4 этапа
 * 18); демо-состояние онлайн-платежей без провайдера (Р14) — `fin_records`; деньги — FinOp/BookingPayment.
 */
export const FINANCE_SETTING_KEYS = [
  'paymentMethods',
  'receipt',
  'rights',
  'onlinePayment',
  'onlineLink',
  'prepayment',
  'staffPrepayment',
  'servicePrepayment',
  'fiscal',
  'policy',
  'policyServiceOverrides',
  'adyen',
  'paymentNotifications',
  'accountTypes',
] as const;
export type FinanceSettingKey = (typeof FINANCE_SETTING_KEYS)[number];

export const FIN_RECORD_KINDS = ['paymentLink', 'policySnapshot', 'policyEntry', 'adyenTxn', 'manualOrder'] as const;
export type FinRecordKind = (typeof FIN_RECORD_KINDS)[number];

type RecordRow = { id: string; kind: string; refId: string | null; clientId: string | null; data: unknown; createdAt: Date };
const recordView = (r: RecordRow) => ({ ...((r.data as Record<string, unknown>) ?? {}), id: r.id });

@Injectable()
export class FinanceExtService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly catalog: FinanceCatalogService,
    private readonly payments: BookingPaymentsService,
  ) {}

  // ─────────────────────────── Настройки раздела (JSON по ключам) ───────────────────────────

  async getSetting(businessId: string, key: FinanceSettingKey) {
    const row = await this.prisma.businessSetting.findUnique({ where: { businessId_area: { businessId, area: `finance.${key}` } } });
    return { stored: row?.data ?? null };
  }

  async putSetting(ctx: RequestContext, key: FinanceSettingKey, value: unknown) {
    const businessId = ctx.member!.businessId;
    const area = `finance.${key}`;
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.businessSetting.findUnique({ where: { businessId_area: { businessId, area } } });
      await tx.businessSetting.upsert({
        where: { businessId_area: { businessId, area } },
        create: { businessId, area, data: value as Prisma.InputJsonValue, updatedBy: ctx.member!.staffId },
        update: { data: value as Prisma.InputJsonValue, updatedBy: ctx.member!.staffId, version: { increment: 1 } },
      });
      await this.audit.record(tx, ctx, { action: 'update', entityType: 'financeSettings', entityId: key, businessId, before: { value: before?.data ?? null }, after: { value } });
    });
    if (key === 'paymentMethods') await this.syncPaymentMethods(ctx, value as PaymentMethodsSettingsJson);
    return value;
  }

  /** Настройки методов оплаты (F-07-025…030) → плитки окна оплаты (`payment_methods` этапа 12): касса наличных,
   *  касса и % комиссии карты, свои способы — одна правда для окна оплаты и экрана настроек */
  private async syncPaymentMethods(ctx: RequestContext, s: PaymentMethodsSettingsJson) {
    const businessId = ctx.member!.businessId;
    await this.catalog.ensureDefaults(businessId);
    const by = ctx.member!.staffId;
    if (s.cash?.accountId !== undefined) await this.prisma.paymentMethod.updateMany({ where: { businessId, key: 'cash' }, data: { accountId: s.cash.accountId, updatedBy: by } });
    if (s.card) await this.prisma.paymentMethod.updateMany({ where: { businessId, key: 'card' }, data: { accountId: s.card.accountId ?? undefined, feePercent: Math.round(s.card.feePct ?? 0), updatedBy: by } });
    let order = 10;
    for (const c of s.custom ?? []) {
      await this.prisma.paymentMethod.upsert({
        where: { businessId_key: { businessId, key: c.id } },
        create: { id: newId('paymentMethod'), businessId, key: c.id, label: c.name.slice(0, 80), kind: 'custom', feePercent: Math.round(c.feePct ?? 0), accountId: c.accountId ?? null, active: c.active !== false, order: order++, createdBy: by, updatedBy: by },
        update: { label: c.name.slice(0, 80), feePercent: Math.round(c.feePct ?? 0), accountId: c.accountId ?? null, active: c.active !== false, updatedBy: by, version: { increment: 1 } },
      });
    }
  }

  // ─────────────────────────── Демо-документы онлайн-платежей (fin_records) ───────────────────────────

  async listRecords(businessId: string, kind: FinRecordKind, refId?: string, clientId?: string) {
    const rows = await this.prisma.finRecord.findMany({ where: { businessId, kind, ...(refId ? { refId } : {}), ...(clientId ? { clientId } : {}) }, orderBy: { createdAt: 'desc' } });
    return rows.map(recordView);
  }

  async createRecord(ctx: RequestContext, kind: FinRecordKind, data: Record<string, unknown>, refId?: string, clientId?: string) {
    const businessId = ctx.member!.businessId;
    const id = typeof data.id === 'string' && data.id ? data.id : newId('finRecord');
    const row = await this.prisma.finRecord.create({ data: { id, businessId, kind, refId: refId ?? null, clientId: clientId ?? null, data: { ...data, id, businessId } as Prisma.InputJsonValue } });
    return recordView(row);
  }

  async patchRecord(ctx: RequestContext, id: string, patch: Record<string, unknown>, refId?: string) {
    const businessId = ctx.member!.businessId;
    const row = await this.prisma.finRecord.findFirst({ where: { id, businessId } });
    if (!row) throw new ApiError('not_found', 'Record not found');
    const next = { ...((row.data as Record<string, unknown>) ?? {}), ...patch, id, businessId };
    const saved = await this.prisma.finRecord.update({ where: { id }, data: { data: next as Prisma.InputJsonValue, ...(refId ? { refId } : {}) } });
    return recordView(saved);
  }

  // ─────────────────────────── Ссылка на оплату (F-07-078…083, 156, 183) ───────────────────────────

  async paymentLinkForBooking(businessId: string, bookingId: string) {
    const rows = await this.listRecords(businessId, 'paymentLink', bookingId);
    return { link: rows[0] ?? null };
  }

  async createPaymentLink(ctx: RequestContext, input: { targetKind: 'booking' | 'sale'; bookingId?: string; saleLabel?: string; amount: number; remainingBefore: number }) {
    if (!(input.amount > 0)) throw new ApiError('invalid_amount', 'amount_must_be_positive');
    if (input.amount > input.remainingBefore) throw new ApiError('invalid_amount', 'amount_exceeds_due');
    const businessId = ctx.member!.businessId;
    const settings = ((await this.getSetting(businessId, 'onlineLink')).stored as { waitMinutes?: number; requisitesText?: string } | null) ?? {};
    const now = new Date();
    const link = {
      businessId,
      targetKind: input.targetKind,
      bookingId: input.bookingId,
      saleLabel: input.saleLabel,
      amount: Math.round(input.amount),
      remainingBefore: input.remainingBefore,
      status: 'pending',
      createdAt: utcToLocal(now),
      createdBy: ctx.member!.staffId,
      expiresAt: new Date(now.getTime() + (settings.waitMinutes ?? 30) * 60_000).toISOString(),
      requisitesText: settings.requisitesText ?? '',
    };
    return this.createRecord(ctx, 'paymentLink', link, input.bookingId);
  }

  /** Касса онлайн-денег (F-07-183): системная безналичная касса, иначе любая безналичная, но не наличный ящик */
  private async onlineAccountId(businessId: string, locationId?: string): Promise<string> {
    await this.catalog.ensureDefaults(businessId);
    // Касса «Предоплата на реквизиты» — деньги у мастера, не онлайн-платежи салона (как `!a.systemKey` мока)
    const regs = (await this.prisma.cashRegister.findMany({ where: { businessId }, orderBy: { order: 'asc' } })).filter((r) => !isPrepaymentRegister(r.id));
    const pick =
      regs.find((r) => r.kind === 'card' && r.systemGenerated && (!locationId || r.locationId === locationId)) ??
      regs.find((r) => r.kind === 'card') ??
      regs.find((r) => r.kind !== 'cash') ??
      regs[0];
    if (!pick) throw new ApiError('validation', 'online_account_missing');
    return pick.id;
  }

  /** Клиент «оплатил» по ссылке — деньги на кассу онлайн-платежей; ссылка визита — платёж по строкам (F-07-081) */
  async markPaymentLinkPaid(ctx: RequestContext, id: string) {
    const businessId = ctx.member!.businessId;
    const row = await this.prisma.finRecord.findFirst({ where: { id, businessId, kind: 'paymentLink' } });
    if (!row) throw new ApiError('not_found', 'link_not_found');
    const link = row.data as { status: string; expiresAt: string; amount: number; targetKind: string; bookingId?: string; saleLabel?: string };
    if (link.status !== 'pending' || Date.parse(link.expiresAt) <= Date.now()) throw new ApiError('validation', 'link_not_live');
    let operationId: string | undefined;
    let onlineCategory: 'onlineFull' | 'onlinePartial' | undefined;
    if (link.targetKind === 'booking' && link.bookingId) {
      const b = await this.payments.requireBooking(businessId, link.bookingId);
      const { payable } = await this.payments.payableOf(b);
      const due = payable - b.paidAmount;
      const amount = BigInt(link.amount) < due ? BigInt(link.amount) : due;
      if (amount > 0n) {
        const accountId = await this.onlineAccountId(businessId, b.locationId);
        operationId = await this.payments.applyMoney(ctx, b, amount, 'onlineLink', undefined, { key: 'onlineLink', label: 'Оплата по ссылке', accountId, feePercent: 0 });
      }
      onlineCategory = amount >= payable ? 'onlineFull' : 'onlinePartial';
    } else {
      const accountId = await this.onlineAccountId(businessId);
      const reg = await this.prisma.cashRegister.findUniqueOrThrow({ where: { id: accountId } });
      const itemId = await this.catalog.systemItemId(businessId, 'otherIncome');
      operationId = newId('finOp');
      await this.prisma.finOp.create({
        data: { id: operationId, businessId, locationId: reg.locationId, accountId, itemId, kind: 'income', amount: BigInt(link.amount), date: new Date(), method: 'other', partyType: 'none', comment: link.saleLabel, source: 'sale', history: [{ at: new Date().toISOString(), by: ctx.member!.staffId, action: 'created' }] as Prisma.InputJsonValue, createdBy: ctx.member!.staffId, updatedBy: ctx.member!.staffId },
      });
    }
    return this.patchRecord(ctx, id, { status: 'paid', paidAt: utcToLocal(new Date()), operationId, onlineCategory });
  }

  async cancelPaymentLink(ctx: RequestContext, id: string) {
    const row = await this.prisma.finRecord.findFirst({ where: { id, businessId: ctx.member!.businessId, kind: 'paymentLink' } });
    if (!row) return;
    if ((row.data as { status?: string }).status !== 'pending') return;
    await this.patchRecord(ctx, id, { status: 'cancelled', cancelledAt: utcToLocal(new Date()) });
  }

  // ─────────────────────────── Личный счёт клиента (F-07-059…064, 070) ───────────────────────────

  async clientAccount(businessId: string, clientId: string) {
    const topUpItem = await this.catalog.systemItemId(businessId, 'accountTopUp');
    const ops = await this.prisma.finOp.findMany({ where: { businessId, itemId: topUpItem, partyType: 'client', partyId: clientId, source: 'account', refId: null }, orderBy: { date: 'desc' } });
    const topUps = ops.map((o) => ({ id: o.id, businessId, clientId, amount: moneyToJson(o.amount), operationId: o.id, cancelled: o.cancelled || undefined, cancelledAt: o.cancelledAt ? utcToLocal(o.cancelledAt) : undefined, createdAt: utcToLocal(o.date), createdBy: o.createdBy ?? 'system' }));
    return { balance: moneyToJson(await this.payments.clientAccountBalance(businessId, clientId)), topUps };
  }

  async topUpClientAccount(ctx: RequestContext, clientId: string, body: { accountId: string; amount: number; method: 'cash' | 'card' | 'other'; clientName?: string }) {
    const businessId = ctx.member!.businessId;
    if (!(body.amount > 0)) throw new ApiError('invalid_amount', 'Amount must be positive');
    const account = await this.prisma.cashRegister.findFirst({ where: { id: body.accountId, businessId } });
    if (!account) throw new ApiError('not_found', 'Cash register not found');
    const itemId = await this.catalog.systemItemId(businessId, 'accountTopUp');
    const id = newId('finOp');
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.finOp.create({
        data: { id, businessId, locationId: account.locationId, accountId: account.id, itemId, kind: 'income', amount: BigInt(Math.round(body.amount)), date: now, method: body.method, partyType: 'client', partyId: clientId, partyName: body.clientName, source: 'account', history: [{ at: now.toISOString(), by: ctx.member!.staffId, action: 'created' }] as Prisma.InputJsonValue, createdBy: ctx.member!.staffId, updatedBy: ctx.member!.staffId },
      });
      await this.audit.record(tx, ctx, { action: 'topup', entityType: 'clientAccount', entityId: clientId, businessId, before: null, after: { amount: Math.round(body.amount) } });
    });
    const topUp = { id, businessId, clientId, amount: Math.round(body.amount), operationId: id, createdAt: utcToLocal(now), createdBy: ctx.member!.staffId };
    return { topUp, balance: moneyToJson(await this.payments.clientAccountBalance(businessId, clientId)) };
  }

  async cancelTopUp(ctx: RequestContext, opId: string) {
    const businessId = ctx.member!.businessId;
    const op = await this.prisma.finOp.findFirst({ where: { id: opId, businessId, source: 'account' } });
    if (!op || op.cancelled) return;
    const history = Array.isArray(op.history) ? [...(op.history as Record<string, unknown>[])] : [];
    history.push({ at: new Date().toISOString(), by: ctx.member!.staffId, action: 'cancelled' });
    await this.prisma.finOp.update({ where: { id: op.id }, data: { cancelled: true, cancelledAt: new Date(), cancelledBy: ctx.member!.staffId, history: history as Prisma.InputJsonValue } });
  }

  /** F-07-070: частичный возврат со счёта клиента — расход «Возврат» уменьшает и счёт, и кассу */
  async refundClientAccount(ctx: RequestContext, clientId: string, body: { accountId: string; amount: number; comment?: string }) {
    const businessId = ctx.member!.businessId;
    const balance = await this.payments.clientAccountBalance(businessId, clientId);
    const want = BigInt(Math.round(body.amount));
    const applied = want < balance ? want : balance;
    if (applied <= 0n) throw new ApiError('invalid_amount', 'nothing_to_refund');
    const account = await this.prisma.cashRegister.findFirst({ where: { id: body.accountId, businessId } });
    if (!account) throw new ApiError('not_found', 'account_not_found');
    const itemId = await this.catalog.systemItemId(businessId, 'refund');
    const now = new Date();
    await this.prisma.finOp.create({
      data: { id: newId('finOp'), businessId, locationId: account.locationId, accountId: account.id, itemId, kind: 'expense', amount: applied, date: now, method: 'other', partyType: 'client', partyId: clientId, comment: body.comment?.trim() || undefined, source: 'account', history: [{ at: now.toISOString(), by: ctx.member!.staffId, action: 'created' }] as Prisma.InputJsonValue, createdBy: ctx.member!.staffId, updatedBy: ctx.member!.staffId },
    });
    return { balance: moneyToJson(balance - applied) };
  }

  /** Есть ли у клиентов бизнеса ненулевой «личный счёт» — removeAccountType мока не даёт потерять деньги/долг */
  async anyNonZeroAccount(businessId: string) {
    const topUpItem = await this.catalog.systemItemId(businessId, 'accountTopUp');
    const refundItem = await this.catalog.systemItemId(businessId, 'refund');
    const fromOps = await this.prisma.finOp.findMany({ where: { businessId, source: 'account', partyType: 'client', itemId: { in: [topUpItem, refundItem] } }, select: { partyId: true }, distinct: ['partyId'] });
    const accountLines = await this.prisma.bookingPayment.findMany({ where: { businessId, kind: 'account', loyaltyAccountId: null }, select: { bookingId: true }, distinct: ['bookingId'] });
    const bookingClients = accountLines.length ? await this.prisma.booking.findMany({ where: { id: { in: accountLines.map((l) => l.bookingId) } }, select: { clientId: true } }) : [];
    const clientIds = new Set([...fromOps.map((o) => o.partyId), ...bookingClients.map((b) => b.clientId)].filter((x): x is string => !!x));
    for (const clientId of clientIds) if ((await this.payments.clientAccountBalance(businessId, clientId)) !== 0n) return { inUse: true };
    return { inUse: false };
  }

  // ─────────────────────────── Клиент: продано/оплачено, визиты с долгом (F-07-055/057) ───────────────────────────

  private async serviceNames(businessId: string) {
    const rows = await this.prisma.service.findMany({ where: { businessId }, select: { id: true, name: true } });
    return new Map(rows.map((r) => [r.id, (r.name as { ru?: string } | null)?.ru ?? '']));
  }

  async clientMoneyInputs(businessId: string, clientId: string) {
    const bookings = await this.prisma.booking.findMany({ where: { businessId, clientId, status: 'arrived', deletedAt: null } });
    const totals: number[] = [];
    for (const b of bookings) totals.push(moneyToJson((await this.payments.payableOf(b)).payable));
    const lines = bookings.length ? await this.prisma.bookingPayment.findMany({ where: { businessId, bookingId: { in: bookings.map((b) => b.id) }, cancelled: false, kind: { not: 'discount' } }, select: { amount: true } }) : [];
    const paidFromBookings = moneyToJson(lines.reduce((s, l) => s + l.amount, 0n));
    const manual = await this.prisma.finOp.findMany({ where: { businessId, partyType: 'client', partyId: clientId, source: 'manual', refId: null }, select: { kind: true, amount: true, cancelled: true } });
    return { totals, paidFromBookings, manualOps: manual.map((o) => ({ kind: o.kind, amount: moneyToJson(o.amount), cancelled: o.cancelled })) };
  }

  async clientDebtVisits(businessId: string, clientId: string) {
    const bookings = await this.prisma.booking.findMany({ where: { businessId, clientId, deletedAt: null, status: { in: ['arrived', 'no_show'] } }, orderBy: { startAt: 'asc' } });
    const names = await this.serviceNames(businessId);
    const rows = [];
    for (const b of bookings) {
      const lines = await this.prisma.bookingPayment.findMany({ where: { businessId, bookingId: b.id, cancelled: false }, orderBy: { createdAt: 'asc' } });
      const paid = lines.reduce((s, p) => s + p.amount, 0n);
      const total = (await this.payments.payableOf(b)).payable;
      const due = total - paid > 0n ? total - paid : 0n;
      const serviceLabel = ((b.services as { serviceId: string }[]) ?? []).map((l) => names.get(l.serviceId)).filter((n): n is string => !!n).join(', ');
      rows.push({ bookingId: b.id, start: utcToLocal(b.startAt), staffId: b.staffId, serviceLabel: serviceLabel || '—', total: moneyToJson(total), paid: moneyToJson(paid), due: moneyToJson(due), method: lines[0]?.methodLabel ?? '—', debt: lines.some((l) => l.debt) });
    }
    return rows;
  }

  /**
   * «Пришли, но не оплатили» (fin-review Ф20, listUnpaidVisits мока): визиты «Клиент пришёл» за последние `days`
   * дней, по которым получено меньше суммы визита (услуги + товары). Новые сверху.
   */
  async unpaidVisits(businessId: string, locationIds: string[] | undefined, days: number) {
    const now = new Date();
    const from = new Date(now.getTime() - Math.max(1, Math.min(days, 366)) * 86_400_000);
    const bookings = await this.prisma.booking.findMany({
      where: { businessId, status: 'arrived', deletedAt: null, startAt: { gte: from, lte: now }, ...(locationIds?.length ? { locationId: { in: locationIds } } : {}) },
      orderBy: { startAt: 'desc' },
    });
    if (!bookings.length) return [];
    const names = await this.serviceNames(businessId);
    const clientIds = [...new Set(bookings.map((b) => b.clientId).filter((x): x is string => !!x))];
    const clients = clientIds.length ? await this.prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, name: true, lastName: true } }) : [];
    const rows = [];
    for (const b of bookings) {
      const total = (await this.payments.payableOf(b)).payable;
      if (total <= 0n) continue;
      const due = total - b.paidAmount;
      if (due <= 0n) continue;
      const c = clients.find((x) => x.id === b.clientId);
      const serviceLabel = ((b.services as { serviceId: string }[]) ?? []).map((l) => names.get(l.serviceId)).filter((n): n is string => !!n).join(', ');
      rows.push({
        bookingId: b.id,
        start: utcToLocal(b.startAt),
        clientName: c ? [c.name, c.lastName].filter(Boolean).join(' ').trim() : undefined,
        serviceLabel: serviceLabel || '—',
        total: moneyToJson(total),
        paid: moneyToJson(total - due),
        due: moneyToJson(due),
      });
    }
    return rows;
  }

  // ─────────────────────────── Сводка денег дня в журнале (F-07-046) ───────────────────────────

  async dayMoneySummary(businessId: string, date: string, locationIds?: string[]) {
    const locs = locationIds?.length ? locationIds : (await this.prisma.location.findMany({ where: { businessId, deletedAt: null }, select: { id: true } })).map((l) => l.id);
    const location = locs[0] ? await this.prisma.location.findFirst({ where: { id: locs[0] } }) : null;
    const range = localDayRangeUtc(date, location?.tz ?? undefined);
    const regs = await this.prisma.cashRegister.findMany({ where: { businessId, locationId: { in: locs } }, select: { id: true } });
    const ops = await this.prisma.finOp.findMany({ where: { businessId, accountId: { in: regs.map((r) => r.id) }, cancelled: false, date: { gte: range.from, lt: range.to } } });
    const sum = (xs: { amount: bigint }[]) => moneyToJson(xs.reduce((s, o) => s + o.amount, 0n));
    const cashIn = sum(ops.filter((o) => o.method === 'cash' && o.kind === 'income'));
    const cardIn = sum(ops.filter((o) => o.method !== 'cash' && o.kind === 'income'));
    const goodsItem = await this.prisma.paymentItem.findFirst({ where: { businessId, systemKey: 'goodsSale' }, select: { id: true } });
    const goodsTotal = goodsItem ? sum(ops.filter((o) => o.kind === 'income' && o.itemId === goodsItem.id)) : 0;
    const bookings = await this.prisma.booking.findMany({ where: { businessId, locationId: { in: locs }, deletedAt: null, startAt: { gte: range.from, lt: range.to } }, select: { id: true, total: true, status: true, clientId: true } });
    const recordsTotal = moneyToJson(bookings.reduce((s, b) => s + b.total, 0n));
    const doneTotal = moneyToJson(bookings.filter((b) => b.status === 'arrived').reduce((s, b) => s + b.total, 0n));
    const loyalty = bookings.length ? await this.prisma.bookingPayment.findMany({ where: { businessId, bookingId: { in: bookings.map((b) => b.id) }, cancelled: false, kind: { in: ['account', 'discount'] } }, select: { amount: true } }) : [];
    const clientsCount = new Set(bookings.map((b) => b.clientId).filter(Boolean)).size;
    return { clientsCount, cashIn, cardIn, totalIn: cashIn + cardIn, doneTotal, recordsTotal, loyaltyTotal: sum(loyalty), goodsTotal };
  }

  // ─────────────────────────── Нефискальный чек визита (F-07-147/148/158) ───────────────────────────

  async bookingReceiptData(businessId: string, bookingId: string) {
    const b = await this.prisma.booking.findFirst({ where: { id: bookingId, businessId } });
    if (!b) throw new ApiError('not_found', 'booking_not_found');
    const [business, client, names, settings] = await Promise.all([
      this.prisma.business.findUnique({ where: { id: businessId }, select: { name: true } }),
      b.clientId ? this.prisma.client.findFirst({ where: { id: b.clientId }, select: { name: true, phone: true, email: true } }) : Promise.resolve(null),
      this.serviceNames(businessId),
      this.getSetting(businessId, 'receipt'),
    ]);
    const lines = await this.prisma.bookingPayment.findMany({ where: { businessId, bookingId, cancelled: false }, orderBy: { createdAt: 'asc' } });
    const firstOp = lines.find((l) => l.finOpId)?.finOpId;
    const docNumber = firstOp ? (await this.prisma.finOp.findUnique({ where: { id: firstOp }, select: { docNumber: true } }))?.docNumber ?? undefined : undefined;
    const groups = new Map<string, { label: string; amount: bigint; kind: string }>();
    for (const l of lines) {
      const key = l.groupId ?? l.id;
      const g = groups.get(key) ?? { label: l.methodLabel, amount: 0n, kind: l.kind };
      g.amount += l.amount;
      groups.set(key, g);
    }
    const { payable, goods } = await this.payments.payableOf(b);
    const extras = (b.extras as { paymentNote?: string } | null) ?? {};
    return {
      settings: settings.stored,
      businessName: business?.name ?? '—',
      client: client ?? undefined,
      docNumber,
      date: utcToLocal(b.startAt),
      serviceLines: ((b.services as { serviceId: string; price: number; qty: number }[]) ?? []).map((l) => ({ label: names.get(l.serviceId) || '—', amount: Math.round(l.price * l.qty) })),
      goodsLines: goods.map((g) => ({ label: g.qty > 1 ? `${g.name} × ${g.qty}` : g.name, amount: g.total })),
      paymentLines: [...groups.values()].map((g) => ({ label: g.label, amount: moneyToJson(g.amount), kind: g.kind as 'money' | 'discount' | 'account' })),
      total: moneyToJson(payable),
      note: extras.paymentNote,
    };
  }

  // ─────────────────────────── Отмена выплаты зарплаты (F-07-160) ───────────────────────────

  async cancelSalaryPayout(ctx: RequestContext, entryId: string) {
    const businessId = ctx.member!.businessId;
    const entry = await this.prisma.payrollSettlementEntry.findFirst({ where: { id: entryId, businessId, kind: 'payout' } });
    if (!entry) return;
    await this.prisma.$transaction(async (tx) => {
      if (entry.operationId) {
        const op = await tx.finOp.findUnique({ where: { id: entry.operationId } });
        if (op && !op.cancelled) {
          const history = Array.isArray(op.history) ? [...(op.history as Record<string, unknown>[])] : [];
          history.push({ at: new Date().toISOString(), by: ctx.member!.staffId, action: 'cancelled' });
          await tx.finOp.update({ where: { id: op.id }, data: { cancelled: true, cancelledAt: new Date(), cancelledBy: ctx.member!.staffId, history: history as Prisma.InputJsonValue } });
        }
      }
      await tx.payrollSettlementEntry.delete({ where: { id: entry.id } });
      await this.audit.record(tx, ctx, { action: 'delete', entityType: 'payrollSettlementEntry', entityId: entry.id, businessId, before: { staffId: entry.staffId, kind: entry.kind, amount: moneyToJson(entry.amount) }, after: null });
    });
  }
}

interface PaymentMethodsSettingsJson {
  cash?: { accountId: string | null };
  card?: { feePct?: number; accountId?: string | null };
  custom?: { id: string; name: string; feePct?: number; accountId?: string; active?: boolean }[];
}
