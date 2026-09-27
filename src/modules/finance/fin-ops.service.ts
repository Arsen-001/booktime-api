import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { newId } from '../../common/ids/ids.js';
import { moneyToJson } from '../../common/money/money.js';
import { PrismaService } from '../../common/prisma.service.js';
import { localDayRangeUtc, localToUtc, nowLocal } from '../../common/time/time.js';
import { FinanceCatalogService } from './finance-catalog.service.js';
import type { FineBody, FinOpBody, FinOpPatchBody, RefundBody } from './finance.schemas.js';

type FinOpRow = {
  id: string;
  businessId: string;
  locationId: string;
  accountId: string;
  itemId: string;
  kind: string;
  amount: bigint;
  date: Date;
  method: string;
  partyType: string;
  partyId: string | null;
  partyName: string | null;
  comment: string | null;
  source: string;
  refId: string | null;
  docNumber: string | null;
  lineLabel: string | null;
  transferGroupId: string | null;
  feeOperationId: string | null;
  feeOfOperationId: string | null;
  refundOfId: string | null;
  refundedAmount: bigint;
  cancelled: boolean;
  cancelledAt: Date | null;
  history: unknown;
  createdBy: string | null;
  createdAt: Date;
};

function finOpView(r: FinOpRow) {
  return {
    id: r.id,
    businessId: r.businessId,
    locationId: r.locationId,
    accountId: r.accountId,
    itemId: r.itemId,
    kind: r.kind as 'income' | 'expense' | 'transfer_out' | 'transfer_in',
    amount: moneyToJson(r.amount),
    date: r.date.toISOString(),
    method: r.method as 'cash' | 'card' | 'transfer' | 'other',
    partyType: r.partyType as 'counterparty' | 'client' | 'staff' | 'none',
    partyId: r.partyId ?? undefined,
    partyName: r.partyName ?? undefined,
    comment: r.comment ?? undefined,
    source: r.source,
    refId: r.refId ?? undefined,
    docNumber: r.docNumber ?? undefined,
    lineLabel: r.lineLabel ?? undefined,
    transferGroupId: r.transferGroupId ?? undefined,
    feeOperationId: r.feeOperationId ?? undefined,
    feeOfOperationId: r.feeOfOperationId ?? undefined,
    refundOfId: r.refundOfId ?? undefined,
    refundedAmount: moneyToJson(r.refundedAmount),
    cancelled: r.cancelled,
    cancelledAt: r.cancelledAt?.toISOString(),
    createdBy: r.createdBy ?? 'system',
    createdAt: r.createdAt.toISOString(),
    history: r.history,
  };
}

export interface FinOpFilter {
  locationIds?: string[];
  accountId?: string;
  itemId?: string;
  kind?: string;
  method?: string;
  partyType?: string;
  partyId?: string;
  cancelled?: boolean;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
}

/**
 * Операции — движение по кассам (F-07-010…018, 02-api.md §12). Возвраты и штрафы (F-07-066…075) живут здесь же:
 * оба — частные случаи операции (расход-возврат / доход-штраф), не отдельная таблица.
 */
@Injectable()
export class FinOpsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly catalog: FinanceCatalogService,
  ) {}

  private whereOf(businessId: string, f?: FinOpFilter): Prisma.FinOpWhereInput {
    const where: Prisma.FinOpWhereInput = { businessId };
    if (f?.locationIds?.length) where.locationId = { in: f.locationIds };
    if (f?.accountId) where.accountId = f.accountId;
    if (f?.itemId) where.itemId = f.itemId;
    if (f?.kind) where.kind = f.kind;
    if (f?.method) where.method = f.method;
    if (f?.partyType) where.partyType = f.partyType;
    if (f?.partyId) where.partyId = f.partyId;
    if (f?.cancelled !== undefined) where.cancelled = f.cancelled;
    if (f?.dateFrom || f?.dateTo) where.date = { ...(f.dateFrom ? { gte: localToUtc(f.dateFrom) } : {}), ...(f.dateTo ? { lte: localToUtc(f.dateTo) } : {}) };
    if (f?.search) where.OR = [{ partyName: { contains: f.search } }, { comment: { contains: f.search } }];
    return where;
  }

  async list(businessId: string, filter?: FinOpFilter) {
    await this.catalog.ensureDefaults(businessId);
    const rows = await this.prisma.finOp.findMany({ where: this.whereOf(businessId, filter), orderBy: { date: 'desc' } });
    return rows.map(finOpView);
  }

  async get(businessId: string, id: string) {
    const row = await this.prisma.finOp.findFirst({ where: { id, businessId } });
    if (!row) throw new ApiError('not_found', 'Operation not found');
    return finOpView(row);
  }

  /** Ручная операция «Новый платёж» (F-07-012) — тот же путь, которым соседи (оплата визита, штраф) кладут запись */
  async create(ctx: RequestContext, body: FinOpBody, source: FinOpBody['source'] = 'manual') {
    const businessId = ctx.member!.businessId;
    const account = await this.prisma.cashRegister.findFirst({ where: { id: body.accountId, businessId } });
    if (!account) throw new ApiError('not_found', 'Cash register not found');
    const id = newId('finOp');
    const history = [{ at: new Date().toISOString(), by: ctx.member!.staffId, action: 'created' }] as Prisma.InputJsonValue;
    await this.prisma.$transaction(async (tx) => {
      await tx.finOp.create({
        data: {
          id,
          businessId,
          locationId: body.locationId,
          accountId: body.accountId,
          itemId: body.itemId,
          kind: body.kind,
          amount: BigInt(body.amount),
          date: localToUtc(body.date),
          method: body.method,
          partyType: body.partyType,
          partyId: body.partyId,
          partyName: body.partyName,
          comment: body.comment,
          source,
          refId: body.refId,
          docNumber: body.docNumber,
          lineLabel: body.lineLabel,
          history,
          createdBy: ctx.member!.staffId,
          updatedBy: ctx.member!.staffId,
        },
      });
      await this.audit.record(tx, ctx, { action: 'create', entityType: 'finOp', entityId: id, businessId, after: { amount: body.amount, kind: body.kind } });
    });
    return this.get(businessId, id);
  }

  async importRows(ctx: RequestContext, rows: FinOpBody[]) {
    const created: string[] = [];
    for (const row of rows) {
      const op = await this.create(ctx, row, 'import');
      created.push(op.id);
    }
    return this.prisma.finOp.findMany({ where: { id: { in: created } } }).then((r) => r.map(finOpView));
  }

  async update(ctx: RequestContext, id: string, patch: FinOpPatchBody) {
    const businessId = ctx.member!.businessId;
    const row = await this.prisma.finOp.findFirst({ where: { id, businessId } });
    if (!row) throw new ApiError('not_found', 'Operation not found');
    if (row.cancelled) throw new ApiError('already_cancelled', 'Operation is cancelled');
    const history = Array.isArray(row.history) ? [...(row.history as Record<string, unknown>[])] : [];
    const by = ctx.member!.staffId;
    const data: Record<string, unknown> = { updatedBy: by, version: { increment: 1 } };
    const fieldMap: [keyof FinOpPatchBody, keyof FinOpRow][] = [
      ['accountId', 'accountId'],
      ['itemId', 'itemId'],
      ['method', 'method'],
      ['partyType', 'partyType'],
      ['partyId', 'partyId'],
      ['partyName', 'partyName'],
      ['comment', 'comment'],
    ];
    for (const [key, field] of fieldMap) {
      const next = patch[key];
      if (next === undefined) continue;
      const prev = row[field];
      if (prev === next) continue;
      history.push({ at: new Date().toISOString(), by, action: 'edited', field, from: String(prev ?? ''), to: String(next ?? '') });
      data[field] = next;
    }
    if (patch.amount !== undefined && BigInt(patch.amount) !== row.amount) {
      history.push({ at: new Date().toISOString(), by, action: 'edited', field: 'amount', from: String(row.amount), to: String(patch.amount) });
      data.amount = BigInt(patch.amount);
    }
    if (patch.date !== undefined) {
      const next = localToUtc(patch.date);
      if (next.getTime() !== row.date.getTime()) {
        history.push({ at: new Date().toISOString(), by, action: 'edited', field: 'date', from: row.date.toISOString(), to: next.toISOString() });
        data.date = next;
      }
    }
    data.history = history as Prisma.InputJsonValue;
    await this.prisma.finOp.update({ where: { id }, data });
    return this.get(businessId, id);
  }

  /** Отмена (F-07-015) — удаления нет; тянет за собой комиссию и парную операцию перевода */
  async cancel(ctx: RequestContext, id: string) {
    const businessId = ctx.member!.businessId;
    const row = await this.prisma.finOp.findFirst({ where: { id, businessId } });
    if (!row) throw new ApiError('not_found', 'Operation not found');
    if (row.cancelled) return;
    const toCancel = [row.id];
    if (row.feeOperationId) toCancel.push(row.feeOperationId);
    if (row.transferGroupId) {
      const pair = await this.prisma.finOp.findMany({ where: { transferGroupId: row.transferGroupId, id: { not: row.id } }, select: { id: true } });
      toCancel.push(...pair.map((p) => p.id));
    }
    const by = ctx.member!.staffId;
    await this.prisma.$transaction(async (tx) => {
      for (const opId of toCancel) {
        const op = await tx.finOp.findUnique({ where: { id: opId } });
        if (!op || op.cancelled) continue;
        const history = Array.isArray(op.history) ? [...(op.history as Record<string, unknown>[])] : [];
        history.push({ at: new Date().toISOString(), by, action: 'cancelled' });
        await tx.finOp.update({ where: { id: opId }, data: { cancelled: true, cancelledAt: new Date(), cancelledBy: by, history: history as Prisma.InputJsonValue } });
      }
      await this.audit.record(tx, ctx, { action: 'cancel', entityType: 'finOp', entityId: row.id, businessId, before: { cancelled: false }, after: { cancelled: true } });
    });
  }

  // ─────────────────────────── Штраф (F-07-066…075) ───────────────────────────

  /** Штраф клиенту (например, неявка) — доходная операция статьёй «Штраф» (chargeClientPenalty мока) */
  async fine(ctx: RequestContext, body: FineBody) {
    const businessId = ctx.member!.businessId;
    const client = await this.prisma.client.findFirst({ where: { id: body.clientId, businessId } });
    if (!client) throw new ApiError('not_found', 'Client not found');
    const itemId = await this.catalog.systemItemId(businessId, 'penaltyCharge');
    const op = await this.create(
      ctx,
      { locationId: body.locationId, accountId: body.accountId, itemId, kind: 'income', amount: body.amount, date: nowLocal(), method: 'cash', partyType: 'client', partyId: body.clientId, partyName: nameOf(client), comment: body.comment, source: 'manual' },
      'manual',
    );
    return op;
  }

  // ─────────────────────────── Возврат (F-07-066…075) ───────────────────────────

  /** Возврат части/всей суммы операции без отмены исходной (F-07-072: касса дня продажи не искажается) */
  async refund(ctx: RequestContext, body: RefundBody) {
    const businessId = ctx.member!.businessId;
    const original = await this.prisma.finOp.findFirst({ where: { id: body.finOpId, businessId } });
    if (!original) throw new ApiError('not_found', 'Operation not found');
    if (original.cancelled) throw new ApiError('already_cancelled', 'Operation is cancelled');
    const available = original.amount - original.refundedAmount;
    if (BigInt(body.amount) > available) throw new ApiError('over_refund', 'Refund exceeds remaining amount');
    const itemId = await this.catalog.systemItemId(businessId, 'refund');
    const refundKind = original.kind === 'income' ? 'expense' : 'income';
    const id = newId('finOp');
    const history = [{ at: new Date().toISOString(), by: ctx.member!.staffId, action: 'created' }] as Prisma.InputJsonValue;
    await this.prisma.$transaction(async (tx) => {
      await tx.finOp.create({
        data: {
          id,
          businessId,
          locationId: original.locationId,
          accountId: original.accountId,
          itemId,
          kind: refundKind,
          amount: BigInt(body.amount),
          date: new Date(),
          method: original.method,
          partyType: original.partyType,
          partyId: original.partyId,
          partyName: original.partyName,
          comment: body.comment ?? 'Возврат',
          source: original.source,
          refId: original.refId,
          refundOfId: original.id,
          history,
          createdBy: ctx.member!.staffId,
          updatedBy: ctx.member!.staffId,
        },
      });
      await tx.finOp.update({ where: { id: original.id }, data: { refundedAmount: { increment: BigInt(body.amount) } } });
      await tx.financeDocument.create({ data: { id: newId('financeDocument'), businessId, number: this.catalog.docNumber(), date: new Date(), type: 'refund', amount: BigInt(body.amount), refOperationId: original.id, refBookingId: original.refId, note: body.comment, createdBy: ctx.member!.staffId, updatedBy: ctx.member!.staffId } });
      await this.audit.record(tx, ctx, { action: 'refund', entityType: 'finOp', entityId: original.id, businessId, before: { refundedAmount: moneyToJson(original.refundedAmount) }, after: { refundedAmount: moneyToJson(original.refundedAmount + BigInt(body.amount)) } });
    });
    return this.get(businessId, id);
  }

  // ─────────────────────────── Отчёты (F-07-163…165) ───────────────────────────

  /** Касса дня (F-01-011/F-07-165): приход/расход и разбивка наличные/карта за календарный день филиала(ей) */
  async cashDay(businessId: string, date: string, locationIds?: string[]) {
    const registers = await this.prisma.cashRegister.findMany({ where: { businessId, ...(locationIds?.length ? { locationId: { in: locationIds } } : {}) }, select: { id: true, locationId: true } });
    const location = registers[0] ? await this.prisma.location.findFirst({ where: { id: registers[0].locationId } }) : null;
    const range = localDayRangeUtc(date, location?.tz);
    const ops = await this.prisma.finOp.findMany({ where: { accountId: { in: registers.map((r) => r.id) }, cancelled: false, date: { gte: range.from, lt: range.to } } });
    const income = ops.filter((o) => o.kind === 'income').reduce((s, o) => s + o.amount, 0n);
    const expense = ops.filter((o) => o.kind === 'expense').reduce((s, o) => s + o.amount, 0n);
    const cash = ops.filter((o) => o.method === 'cash').reduce((s, o) => s + (o.kind === 'income' ? o.amount : -o.amount), 0n);
    const card = ops.filter((o) => o.method !== 'cash').reduce((s, o) => s + (o.kind === 'income' ? o.amount : -o.amount), 0n);
    return { income: moneyToJson(income), expense: moneyToJson(expense), cash: moneyToJson(cash), card: moneyToJson(card) };
  }

  /** Обзор «Финансы» (F-07-163) — приход/расход за период, разбивка по статьям */
  async overview(businessId: string, from: string, to: string, locationIds?: string[]) {
    const ops = await this.prisma.finOp.findMany({ where: { businessId, cancelled: false, ...(locationIds?.length ? { locationId: { in: locationIds } } : {}), date: { gte: localToUtc(from), lte: localToUtc(to) } } });
    const items = await this.prisma.paymentItem.findMany({ where: { businessId } });
    const nameOfItem = new Map(items.map((i) => [i.id, i.name]));
    const byItem = new Map<string, { itemId: string; name: string; income: bigint; expense: bigint }>();
    let income = 0n;
    let expense = 0n;
    for (const op of ops) {
      if (op.kind === 'income') income += op.amount;
      else if (op.kind === 'expense') expense += op.amount;
      else continue;
      const row = byItem.get(op.itemId) ?? { itemId: op.itemId, name: nameOfItem.get(op.itemId) ?? '—', income: 0n, expense: 0n };
      if (op.kind === 'income') row.income += op.amount;
      else row.expense += op.amount;
      byItem.set(op.itemId, row);
    }
    return {
      income: moneyToJson(income),
      expense: moneyToJson(expense),
      net: moneyToJson(income - expense),
      byItem: [...byItem.values()].map((r) => ({ itemId: r.itemId, name: r.name, income: moneyToJson(r.income), expense: moneyToJson(r.expense) })),
    };
  }

  /** P&L (F-07-164) — то же деление, что overview, но по знаку статьи (доход/расход системного каталога) */
  async pnl(businessId: string, from: string, to: string, locationIds?: string[]) {
    return this.overview(businessId, from, to, locationIds);
  }
}

function nameOf(client: { name: string; lastName: string | null }): string {
  return [client.name, client.lastName].filter(Boolean).join(' ').trim();
}
