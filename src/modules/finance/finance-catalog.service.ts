import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { newId } from '../../common/ids/ids.js';
import { moneyToJson } from '../../common/money/money.js';
import { PrismaService } from '../../common/prisma.service.js';
import { localToUtc } from '../../common/time/time.js';
import type {
  CashRegisterBody,
  CounterpartyBody,
  PaymentItemBody,
  PaymentMethodBody,
} from './finance.schemas.js';

/** 15 системных статей (SYSTEM_ITEM_KEYS фронта, src/domain/finance.ts) — заведены сидом/при первом обращении,
 * не удаляются (только переименовываются). Ключ → {name, kind}. */
export const SYSTEM_ITEMS: Record<string, { name: string; kind: 'income' | 'expense' }> = {
  materialsPurchase: { name: 'Закупка материалов', kind: 'expense' },
  goodsPurchase: { name: 'Закупка товаров', kind: 'expense' },
  staffPayroll: { name: 'Зарплата персонала', kind: 'expense' },
  taxes: { name: 'Налоги', kind: 'expense' },
  servicePayment: { name: 'Оплата услуги', kind: 'income' },
  membershipSale: { name: 'Продажа абонемента', kind: 'income' },
  goodsSale: { name: 'Продажа товара', kind: 'income' },
  otherIncome: { name: 'Прочий доход', kind: 'income' },
  otherExpense: { name: 'Прочий расход', kind: 'expense' },
  accountTopUp: { name: 'Пополнение счёта', kind: 'income' },
  acquiringFee: { name: 'Комиссия эквайринга', kind: 'expense' },
  certificateSale: { name: 'Продажа сертификата', kind: 'income' },
  penaltyCharge: { name: 'Штраф', kind: 'income' },
  depositRetained: { name: 'Удержанный депозит', kind: 'income' },
  refund: { name: 'Возврат', kind: 'expense' },
};

function cashRegisterView(r: { id: string; businessId: string; locationId: string; name: string; kind: string; openingBalance: bigint; note: string | null; order: number; systemGenerated: boolean; version: number; createdAt: Date }, balance?: bigint) {
  return {
    id: r.id,
    businessId: r.businessId,
    createdAt: r.createdAt.toISOString(),
    locationId: r.locationId,
    name: r.name,
    kind: r.kind as 'cash' | 'card' | 'other',
    openingBalance: moneyToJson(r.openingBalance),
    note: r.note ?? undefined,
    order: r.order,
    systemGenerated: r.systemGenerated,
    version: r.version,
    ...(balance !== undefined ? { balance: moneyToJson(balance) } : {}),
  };
}

function itemView(r: { id: string; businessId: string; name: string; kind: string; comment: string | null; systemKey: string | null; version: number; createdAt: Date }) {
  return { id: r.id, businessId: r.businessId, name: r.name, kind: r.kind as 'income' | 'expense', comment: r.comment ?? undefined, system: r.systemKey !== null, version: r.version, createdAt: r.createdAt.toISOString() };
}

function methodView(r: { id: string; businessId: string; key: string; label: string; kind: string; feePercent: number; accountId: string | null; active: boolean; order: number; version: number }) {
  return { id: r.id, businessId: r.businessId, key: r.key, label: r.label, kind: r.kind as 'cash' | 'card' | 'custom', feePercent: r.feePercent, accountId: r.accountId ?? undefined, active: r.active, order: r.order, version: r.version };
}

function counterpartyView(r: { id: string; businessId: string; type: string; name: string; inn: string | null; phone: string | null; email: string | null; contact: string | null; note: string | null; version: number; createdAt: Date }) {
  return { id: r.id, businessId: r.businessId, type: r.type as 'supplier' | 'company' | 'person' | 'other', name: r.name, inn: r.inn ?? undefined, phone: r.phone ?? undefined, email: r.email ?? undefined, contact: r.contact ?? undefined, note: r.note ?? undefined, version: r.version, createdAt: r.createdAt.toISOString() };
}

function documentView(r: { id: string; businessId: string; number: string; date: Date; type: string; contentKind: string | null; amount: bigint; refOperationId: string | null; refBookingId: string | null; note: string | null; version: number; createdAt: Date }) {
  return { id: r.id, businessId: r.businessId, number: r.number, date: r.date.toISOString(), type: r.type, contentKind: r.contentKind ?? undefined, amount: moneyToJson(r.amount), refOperationId: r.refOperationId ?? undefined, refBookingId: r.refBookingId ?? undefined, note: r.note ?? undefined, version: r.version, createdAt: r.createdAt.toISOString() };
}

/**
 * Кассы, статьи, методы оплаты, контрагенты, документы — «Финансы и касса» (docs/backend/02-api.md §12, PLAN §6
 * №12). Владелец данных — сам бизнес (01 §12: «бизнес», не сеть, в отличие от лояльности этапа 11).
 */
@Injectable()
export class FinanceCatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Заводит 15 системных статей + кассу «Основная»/«Расчётный счёт» на каждый филиал без кассы + методы
   * оплаты cash/card, если бизнес ими ещё не пользовался (F-07-002, ensureDefaultAccounts мока). Идемпотентно —
   * зовётся лениво из чтений раздела, а не только один раз при регистрации бизнеса (PLAN §9: решение по ходу). */
  async ensureDefaults(businessId: string): Promise<void> {
    const itemCount = await this.prisma.paymentItem.count({ where: { businessId } });
    if (itemCount === 0) {
      await this.prisma.paymentItem.createMany({
        data: Object.entries(SYSTEM_ITEMS).map(([systemKey, v]) => ({ id: newId('paymentItem'), businessId, name: v.name, kind: v.kind, systemKey, createdBy: 'system', updatedBy: 'system' })),
      });
    }
    const locations = await this.prisma.location.findMany({ where: { businessId, deletedAt: null }, select: { id: true } });
    const withRegister = new Set((await this.prisma.cashRegister.findMany({ where: { businessId }, select: { locationId: true } })).map((r) => r.locationId));
    let order = await this.prisma.cashRegister.count({ where: { businessId } });
    for (const loc of locations) {
      if (withRegister.has(loc.id)) continue;
      const cashId = newId('cashRegister');
      const cardId = newId('cashRegister');
      await this.prisma.cashRegister.createMany({
        data: [
          { id: cashId, businessId, locationId: loc.id, name: 'Основная касса', kind: 'cash', order: order++, systemGenerated: true, createdBy: 'system', updatedBy: 'system' },
          { id: cardId, businessId, locationId: loc.id, name: 'Расчётный счёт', kind: 'card', order: order++, systemGenerated: true, createdBy: 'system', updatedBy: 'system' },
        ],
      });
    }
    const methodCount = await this.prisma.paymentMethod.count({ where: { businessId } });
    if (methodCount === 0) {
      const firstCash = await this.prisma.cashRegister.findFirst({ where: { businessId, kind: 'cash' }, orderBy: { order: 'asc' } });
      const firstCard = await this.prisma.cashRegister.findFirst({ where: { businessId, kind: 'card' }, orderBy: { order: 'asc' } });
      await this.prisma.paymentMethod.createMany({
        data: [
          { id: newId('paymentMethod'), businessId, key: 'cash', label: 'Наличные', kind: 'cash', accountId: firstCash?.id ?? null, order: 0, createdBy: 'system', updatedBy: 'system' },
          { id: newId('paymentMethod'), businessId, key: 'card', label: 'Банковская карта', kind: 'card', accountId: firstCard?.id ?? null, order: 1, createdBy: 'system', updatedBy: 'system' },
        ],
      });
    }
  }

  /** Ключ → id статьи этого бизнеса (для операций-соседей: оплата визита, комиссия, штраф…) */
  async systemItemId(businessId: string, key: keyof typeof SYSTEM_ITEMS): Promise<string> {
    await this.ensureDefaults(businessId);
    const row = await this.prisma.paymentItem.findFirst({ where: { businessId, systemKey: key } });
    if (!row) throw new ApiError('not_found', `System item ${key} missing`);
    return row.id;
  }

  // ─────────────────────────── Кассы ───────────────────────────

  async listCashRegisters(businessId: string, locationIds?: string[], withBalance = false) {
    await this.ensureDefaults(businessId);
    const rows = await this.prisma.cashRegister.findMany({
      where: { businessId, ...(locationIds?.length ? { locationId: { in: locationIds } } : {}) },
      orderBy: { order: 'asc' },
    });
    if (!withBalance) return rows.map((r) => cashRegisterView(r));
    const ids = rows.map((r) => r.id);
    const ops = await this.prisma.finOp.findMany({ where: { accountId: { in: ids }, cancelled: false }, select: { accountId: true, kind: true, amount: true } });
    const sumOf = (id: string) => ops.filter((o) => o.accountId === id).reduce((s, o) => s + (o.kind === 'income' || o.kind === 'transfer_in' ? o.amount : -o.amount), 0n);
    return rows.map((r) => cashRegisterView(r, r.openingBalance + sumOf(r.id)));
  }

  async createCashRegister(ctx: RequestContext, body: CashRegisterBody) {
    const businessId = ctx.member!.businessId;
    await this.ensureDefaults(businessId);
    const maxOrder = await this.prisma.cashRegister.aggregate({ where: { businessId }, _max: { order: true } });
    const id = newId('cashRegister');
    await this.prisma.$transaction(async (tx) => {
      await tx.cashRegister.create({ data: { id, businessId, locationId: body.locationId, name: body.name, kind: body.kind, openingBalance: BigInt(body.openingBalance), note: body.note, order: (maxOrder._max.order ?? -1) + 1, createdBy: ctx.member!.staffId, updatedBy: ctx.member!.staffId } });
      await this.audit.record(tx, ctx, { action: 'create', entityType: 'cashRegister', entityId: id, businessId, after: { name: body.name } });
    });
    return cashRegisterView(await this.prisma.cashRegister.findUniqueOrThrow({ where: { id } }));
  }

  async updateCashRegister(ctx: RequestContext, id: string, patch: Partial<CashRegisterBody>) {
    const businessId = ctx.member!.businessId;
    const row = await this.prisma.cashRegister.findFirst({ where: { id, businessId } });
    if (!row) throw new ApiError('not_found', 'Cash register not found');
    const data: Record<string, unknown> = { updatedBy: ctx.member!.staffId, version: { increment: 1 } };
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.kind !== undefined) data.kind = patch.kind;
    if (patch.locationId !== undefined) data.locationId = patch.locationId;
    if (patch.openingBalance !== undefined) data.openingBalance = BigInt(patch.openingBalance);
    if (patch.note !== undefined) data.note = patch.note;
    await this.prisma.$transaction(async (tx) => {
      await tx.cashRegister.update({ where: { id }, data });
      await this.audit.record(tx, ctx, { action: 'update', entityType: 'cashRegister', entityId: id, businessId, before: { name: row.name }, after: { name: patch.name ?? row.name } });
    });
    return cashRegisterView(await this.prisma.cashRegister.findUniqueOrThrow({ where: { id } }));
  }

  async removeCashRegister(ctx: RequestContext, id: string) {
    const businessId = ctx.member!.businessId;
    const row = await this.prisma.cashRegister.findFirst({ where: { id, businessId } });
    if (!row) throw new ApiError('not_found', 'Cash register not found');
    const used = await this.prisma.finOp.count({ where: { accountId: id } });
    if (used > 0) throw new ApiError('in_use', 'Cash register has operations; cannot delete');
    await this.prisma.$transaction(async (tx) => {
      await tx.cashRegister.delete({ where: { id } });
      await this.audit.record(tx, ctx, { action: 'delete', entityType: 'cashRegister', entityId: id, businessId, before: { name: row.name }, after: null });
    });
  }

  async reorderCashRegisters(ctx: RequestContext, orderedIds: string[]) {
    const businessId = ctx.member!.businessId;
    await this.prisma.$transaction(orderedIds.map((id, i) => this.prisma.cashRegister.updateMany({ where: { id, businessId }, data: { order: i } })));
  }

  /** Перевод между кассами (F-07-006) — пара операций transfer_out/transfer_in с общим transferGroupId */
  async transfer(ctx: RequestContext, body: import('./finance.schemas.js').TransferFundsBody) {
    const businessId = ctx.member!.businessId;
    if (body.fromAccountId === body.toAccountId) throw new ApiError('validation', 'Same account');
    const from = await this.prisma.cashRegister.findFirst({ where: { id: body.fromAccountId, businessId } });
    const to = await this.prisma.cashRegister.findFirst({ where: { id: body.toAccountId, businessId } });
    if (!from || !to) throw new ApiError('not_found', 'Cash register not found');
    const itemId = await this.systemItemId(businessId, 'otherExpense');
    const groupId = newId('finOp');
    const at = body.date ? localToUtc(body.date) : new Date();
    const outId = newId('finOp');
    const inId = newId('finOp');
    const history = [{ at: new Date().toISOString(), by: ctx.member!.staffId, action: 'created' }] as Prisma.InputJsonValue;
    await this.prisma.$transaction(async (tx) => {
      await tx.finOp.create({ data: { id: outId, businessId, locationId: from.locationId, accountId: from.id, itemId, kind: 'transfer_out', amount: BigInt(body.amount), date: at, method: 'transfer', partyType: 'none', comment: body.comment, source: 'transfer', transferGroupId: groupId, history, createdBy: ctx.member!.staffId, updatedBy: ctx.member!.staffId } });
      await tx.finOp.create({ data: { id: inId, businessId, locationId: to.locationId, accountId: to.id, itemId, kind: 'transfer_in', amount: BigInt(body.amount), date: at, method: 'transfer', partyType: 'none', comment: body.comment, source: 'transfer', transferGroupId: groupId, history, createdBy: ctx.member!.staffId, updatedBy: ctx.member!.staffId } });
      await this.audit.record(tx, ctx, { action: 'create', entityType: 'finOp', entityId: groupId, businessId, after: { amount: body.amount, from: from.id, to: to.id } });
    });
    return { fromOperationId: outId, toOperationId: inId };
  }

  // ─────────────────────────── Статьи ───────────────────────────

  async listItems(businessId: string) {
    await this.ensureDefaults(businessId);
    return (await this.prisma.paymentItem.findMany({ where: { businessId }, orderBy: { createdAt: 'asc' } })).map(itemView);
  }

  async createItem(ctx: RequestContext, body: PaymentItemBody) {
    const businessId = ctx.member!.businessId;
    const id = newId('paymentItem');
    await this.prisma.paymentItem.create({ data: { id, businessId, name: body.name, kind: body.kind, comment: body.comment, createdBy: ctx.member!.staffId, updatedBy: ctx.member!.staffId } });
    return itemView(await this.prisma.paymentItem.findUniqueOrThrow({ where: { id } }));
  }

  async updateItem(ctx: RequestContext, id: string, patch: Partial<PaymentItemBody>) {
    const businessId = ctx.member!.businessId;
    const row = await this.prisma.paymentItem.findFirst({ where: { id, businessId } });
    if (!row) throw new ApiError('not_found', 'Item not found');
    const data: Record<string, unknown> = { updatedBy: ctx.member!.staffId, version: { increment: 1 } };
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.comment !== undefined) data.comment = patch.comment;
    if (patch.kind !== undefined && !row.systemKey) data.kind = patch.kind;
    await this.prisma.paymentItem.update({ where: { id }, data });
    return itemView(await this.prisma.paymentItem.findUniqueOrThrow({ where: { id } }));
  }

  async removeItem(businessId: string, id: string) {
    const row = await this.prisma.paymentItem.findFirst({ where: { id, businessId } });
    if (!row) throw new ApiError('not_found', 'Item not found');
    if (row.systemKey) throw new ApiError('system_item', 'System item cannot be deleted');
    const used = await this.prisma.finOp.count({ where: { itemId: id } });
    if (used > 0) throw new ApiError('in_use', 'Item has operations; cannot delete');
    await this.prisma.paymentItem.delete({ where: { id } });
  }

  // ─────────────────────────── Методы оплаты (упрощённо) ───────────────────────────

  async listMethods(businessId: string) {
    await this.ensureDefaults(businessId);
    return (await this.prisma.paymentMethod.findMany({ where: { businessId }, orderBy: { order: 'asc' } })).map(methodView);
  }

  async createMethod(ctx: RequestContext, body: PaymentMethodBody) {
    const businessId = ctx.member!.businessId;
    await this.ensureDefaults(businessId);
    const maxOrder = await this.prisma.paymentMethod.aggregate({ where: { businessId }, _max: { order: true } });
    const id = newId('paymentMethod');
    await this.prisma.paymentMethod.create({ data: { id, businessId, key: id, label: body.label, kind: 'custom', feePercent: body.feePercent, accountId: body.accountId, order: (maxOrder._max.order ?? -1) + 1, createdBy: ctx.member!.staffId, updatedBy: ctx.member!.staffId } });
    return methodView(await this.prisma.paymentMethod.findUniqueOrThrow({ where: { id } }));
  }

  async updateMethod(ctx: RequestContext, id: string, patch: { label?: string; feePercent?: number; accountId?: string | null; active?: boolean }) {
    const businessId = ctx.member!.businessId;
    const row = await this.prisma.paymentMethod.findFirst({ where: { id, businessId } });
    if (!row) throw new ApiError('not_found', 'Method not found');
    const data: Record<string, unknown> = { updatedBy: ctx.member!.staffId, version: { increment: 1 } };
    if (patch.label !== undefined) data.label = patch.label;
    if (patch.feePercent !== undefined) data.feePercent = patch.feePercent;
    if (patch.accountId !== undefined) data.accountId = patch.accountId;
    if (patch.active !== undefined) data.active = patch.active;
    await this.prisma.paymentMethod.update({ where: { id }, data });
    return methodView(await this.prisma.paymentMethod.findUniqueOrThrow({ where: { id } }));
  }

  async removeMethod(businessId: string, id: string) {
    const row = await this.prisma.paymentMethod.findFirst({ where: { id, businessId } });
    if (!row) throw new ApiError('not_found', 'Method not found');
    if (row.kind !== 'custom') throw new ApiError('system_item', 'Built-in method cannot be deleted, archive it instead');
    await this.prisma.paymentMethod.delete({ where: { id } });
  }

  // ─────────────────────────── Контрагенты ───────────────────────────

  async listCounterparties(businessId: string) {
    return (await this.prisma.finCounterparty.findMany({ where: { businessId }, orderBy: { createdAt: 'desc' } })).map(counterpartyView);
  }

  async createCounterparty(ctx: RequestContext, body: CounterpartyBody) {
    const businessId = ctx.member!.businessId;
    const id = newId('finCounterparty');
    await this.prisma.finCounterparty.create({ data: { id, businessId, ...body, createdBy: ctx.member!.staffId, updatedBy: ctx.member!.staffId } });
    return counterpartyView(await this.prisma.finCounterparty.findUniqueOrThrow({ where: { id } }));
  }

  async updateCounterparty(ctx: RequestContext, id: string, patch: Partial<CounterpartyBody>) {
    const businessId = ctx.member!.businessId;
    const row = await this.prisma.finCounterparty.findFirst({ where: { id, businessId } });
    if (!row) throw new ApiError('not_found', 'Counterparty not found');
    await this.prisma.finCounterparty.update({ where: { id }, data: { ...patch, updatedBy: ctx.member!.staffId, version: { increment: 1 } } });
    return counterpartyView(await this.prisma.finCounterparty.findUniqueOrThrow({ where: { id } }));
  }

  async removeCounterparty(businessId: string, id: string) {
    const row = await this.prisma.finCounterparty.findFirst({ where: { id, businessId } });
    if (!row) throw new ApiError('not_found', 'Counterparty not found');
    await this.prisma.finCounterparty.delete({ where: { id } });
  }

  async importCounterparties(ctx: RequestContext, rows: CounterpartyBody[]) {
    const businessId = ctx.member!.businessId;
    const ids = rows.map(() => newId('finCounterparty'));
    await this.prisma.finCounterparty.createMany({ data: rows.map((r, i) => ({ id: ids[i]!, businessId, ...r, createdBy: ctx.member!.staffId, updatedBy: ctx.member!.staffId })) });
    return (await this.prisma.finCounterparty.findMany({ where: { id: { in: ids } } })).map(counterpartyView);
  }

  // ─────────────────────────── Документы ───────────────────────────

  async listDocuments(businessId: string, filter?: { type?: string; contentKind?: string; dateFrom?: string; dateTo?: string; search?: string }) {
    const where: Record<string, unknown> = { businessId };
    if (filter?.type) where.type = filter.type;
    if (filter?.contentKind) where.contentKind = filter.contentKind;
    if (filter?.dateFrom || filter?.dateTo) where.date = { ...(filter.dateFrom ? { gte: new Date(filter.dateFrom) } : {}), ...(filter.dateTo ? { lte: new Date(filter.dateTo) } : {}) };
    if (filter?.search) where.number = { contains: filter.search };
    const rows = await this.prisma.financeDocument.findMany({ where, orderBy: { date: 'desc' } });
    return rows.map(documentView);
  }

  async getDocument(businessId: string, id: string) {
    const row = await this.prisma.financeDocument.findFirst({ where: { id, businessId } });
    if (!row) throw new ApiError('not_found', 'Document not found');
    return documentView(row);
  }

  async updateDocument(ctx: RequestContext, id: string, note: string | undefined) {
    const businessId = ctx.member!.businessId;
    const row = await this.prisma.financeDocument.findFirst({ where: { id, businessId } });
    if (!row) throw new ApiError('not_found', 'Document not found');
    await this.prisma.financeDocument.update({ where: { id }, data: { note, updatedBy: ctx.member!.staffId, version: { increment: 1 } } });
    return documentView(await this.prisma.financeDocument.findUniqueOrThrow({ where: { id } }));
  }

  /** Номер документа — как в моке: случайное 9-значное число с префиксом 7 (F-07-181) */
  docNumber(): string {
    return String(700_000_000 + Math.floor(Math.random() * 99_999_999));
  }
}
