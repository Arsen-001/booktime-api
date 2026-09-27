var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service.js';
import { ApiError } from '../../common/errors/api-error.js';
import { newId } from '../../common/ids/ids.js';
import { moneyToJson } from '../../common/money/money.js';
import { PrismaService } from '../../common/prisma.service.js';
import { localToUtc } from '../../common/time/time.js';
import { FinanceCatalogService } from '../finance/finance-catalog.service.js';
import { FinOpsService } from '../finance/fin-ops.service.js';
import { StockCatalogService } from './stock-catalog.service.js';
function docView(r, lines) {
    return {
        id: r.id,
        businessId: r.businessId,
        locationId: r.locationId,
        number: r.number,
        type: r.type,
        date: r.date.toISOString(),
        warehouseId: r.warehouseId,
        toWarehouseId: r.toWarehouseId ?? undefined,
        counterpartyName: r.counterpartyName ?? undefined,
        clientId: r.clientId ?? undefined,
        staffId: r.staffId ?? undefined,
        serviceId: r.serviceId ?? undefined,
        bookingId: r.bookingId ?? undefined,
        paid: r.paid,
        paymentMethod: r.paymentMethod ?? undefined,
        extraLines: r.extraLines ?? undefined,
        autoWriteoff: r.autoWriteoff,
        cancelledAt: r.cancelledAt?.toISOString(),
        financeOperationId: r.financeOperationId ?? undefined,
        reason: r.reason ?? undefined,
        comment: r.comment ?? undefined,
        inventoryId: r.inventoryId ?? undefined,
        cancelledByDocId: r.cancelledByDocId ?? undefined,
        cancelsDocId: r.cancelsDocId ?? undefined,
        version: r.version,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt?.toISOString(),
        lines: lines.map((l) => ({ goodId: l.goodId, qtySale: l.qtySale, unitPrice: moneyToJson(l.unitPrice), discountPct: l.discountPct ?? undefined, costTotal: moneyToJson(l.costTotal) })),
    };
}
function lineTotal(l) {
    const discounted = l.discountPct ? Math.round(l.unitPrice * (1 - l.discountPct / 100)) : l.unitPrice;
    return BigInt(Math.round(discounted * l.qtySale));
}
/**
 * Складские операции (F-08-046…078, F-00-135/137/138, PLAN §6 №13): приход, списание, перемещение, продажа —
 * один документ = одна транзакция, кассу трогает только `FinOpsService` (приход «Оплачено» / продажа), как
 * `recordStockFinanceOperation` мока. Автосписание по норме техкарты — `StockTechCardsService`, отдельный
 * файл (нужен и `JournalModule`, лишний вес сюда не тащим).
 */
let StockOpsService = class StockOpsService {
    constructor(prisma, audit, catalog, financeCatalog, finOps) {
        this.prisma = prisma;
        this.audit = audit;
        this.catalog = catalog;
        this.financeCatalog = financeCatalog;
        this.finOps = finOps;
    }
    async nextNumber(businessId) {
        const max = await this.prisma.stockOp.aggregate({ where: { businessId }, _max: { number: true } });
        const n = Number(max._max.number ?? 100000);
        return String((Number.isFinite(n) ? n : 100000) + 1);
    }
    async linesOf(opId) {
        return this.prisma.stockOpLine.findMany({ where: { opId } });
    }
    async getDoc(businessId, id) {
        const doc = await this.prisma.stockOp.findFirst({ where: { id, businessId } });
        if (!doc)
            return undefined;
        const lines = await this.linesOf(id);
        const warehouse = await this.prisma.warehouse.findUnique({ where: { id: doc.warehouseId } });
        const toWarehouse = doc.toWarehouseId ? await this.prisma.warehouse.findUnique({ where: { id: doc.toWarehouseId } }) : undefined;
        const goods = await this.prisma.product.findMany({ where: { id: { in: lines.map((l) => l.goodId) } } });
        return {
            ...docView(doc, lines),
            warehouseName: warehouse?.name ?? '',
            toWarehouseName: toWarehouse?.name,
            lineDetails: lines.map((l) => {
                const g = goods.find((x) => x.id === l.goodId);
                return { goodId: l.goodId, qtySale: l.qtySale, unitPrice: moneyToJson(l.unitPrice), discountPct: l.discountPct ?? undefined, costTotal: moneyToJson(l.costTotal), goodName: g?.name ?? '', saleUnit: g?.saleUnit ?? 'pcs' };
            }),
        };
    }
    async listOps(businessId, filters) {
        const where = { businessId };
        if (filters.type)
            where.type = filters.type;
        if (filters.warehouseId)
            where.OR = [{ warehouseId: filters.warehouseId }, { toWarehouseId: filters.warehouseId }];
        if (filters.dateFrom || filters.dateTo)
            where.date = { ...(filters.dateFrom ? { gte: localToUtc(filters.dateFrom) } : {}), ...(filters.dateTo ? { lte: localToUtc(filters.dateTo) } : {}) };
        if (filters.search)
            where.OR = [...(where.OR ?? []), { number: { contains: filters.search } }, { counterpartyName: { contains: filters.search } }];
        let docs = await this.prisma.stockOp.findMany({ where, orderBy: { date: 'desc' } });
        if (filters.goodId) {
            const lineOpIds = new Set((await this.prisma.stockOpLine.findMany({ where: { businessId, goodId: filters.goodId }, select: { opId: true } })).map((l) => l.opId));
            docs = docs.filter((d) => lineOpIds.has(d.id));
        }
        const total = docs.length;
        const page = filters.page ?? 1;
        const pageSize = filters.pageSize ?? 25;
        const slice = docs.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize);
        const rows = await Promise.all(slice.map((d) => this.getDoc(businessId, d.id)));
        return { items: rows.filter((r) => !!r), total };
    }
    // ─────────────────────────── Приход (F-08-054…057) ───────────────────────────
    async createIncome(ctx, locationId, input) {
        const businessId = ctx.member.businessId;
        const number = await this.nextNumber(businessId);
        const id = newId('stockOp');
        const settings = await this.catalog.ensureSettings(businessId);
        await this.prisma.$transaction(async (tx) => {
            await tx.stockOp.create({
                data: { id, businessId, locationId, number, type: 'income', date: localToUtc(input.date), warehouseId: input.warehouseId, counterpartyName: input.counterpartyName, paid: input.paid, paymentMethod: input.paid ? input.paymentMethod : undefined, comment: input.comment, createdBy: ctx.member.staffId, updatedBy: ctx.member.staffId },
            });
            await tx.stockOpLine.createMany({ data: input.lines.map((l) => ({ id: newId('stockOpLine'), opId: id, businessId, goodId: l.goodId, qtySale: Math.abs(l.qtySale), unitPrice: BigInt(l.unitPrice), discountPct: l.discountPct, costTotal: lineTotal(l) })) });
            // F-08-054/097: приход обновляет себестоимость по настройке (последняя цена / средневзвешенная / не трогать)
            if (settings.costMethod !== 'fromGoodSettings') {
                for (const line of input.lines) {
                    const good = await tx.product.findUnique({ where: { id: line.goodId } });
                    if (!good)
                        continue;
                    let next = BigInt(line.unitPrice);
                    if (settings.costMethod === 'average') {
                        const priorQty = await this.catalog.totalStock(businessId, line.goodId);
                        const totalQty = priorQty + Math.abs(line.qtySale);
                        next = totalQty > 0 ? BigInt(Math.round((priorQty * Number(good.costPrice) + Math.abs(line.qtySale) * line.unitPrice) / totalQty)) : BigInt(line.unitPrice);
                    }
                    await tx.product.update({ where: { id: line.goodId }, data: { costPrice: next } });
                }
            }
            await this.audit.record(tx, ctx, { action: 'create', entityType: 'stockOperation', entityId: id, businessId, after: { type: 'income', number } });
        });
        if (input.paid) {
            const amount = input.lines.reduce((s, l) => s + Number(lineTotal(l)), 0);
            await this.bridgeToFinance(ctx, { locationId, docId: id, docNumber: number, kind: 'expense', itemKey: 'goodsPurchase', amount, method: input.paymentMethod, comment: input.counterpartyName, source: 'manual' });
        }
        return this.getDoc(businessId, id);
    }
    // ─────────────────────────── Списание (F-08-058) ───────────────────────────
    async assertShortage(businessId, warehouseId, lines) {
        const settings = await this.catalog.ensureSettings(businessId);
        if (!settings.forbidOnShortage)
            return;
        for (const l of lines) {
            const available = await this.catalog.goodStockAt(businessId, l.goodId, warehouseId);
            if (Math.abs(l.qtySale) > available) {
                const good = await this.prisma.product.findUnique({ where: { id: l.goodId } });
                throw new ApiError('insufficient_stock', JSON.stringify({ goodName: good?.name ?? '', available }));
            }
        }
    }
    async createWriteoff(ctx, locationId, input) {
        const businessId = ctx.member.businessId;
        await this.assertShortage(businessId, input.warehouseId, input.lines);
        const number = await this.nextNumber(businessId);
        const id = newId('stockOp');
        await this.prisma.$transaction(async (tx) => {
            await tx.stockOp.create({ data: { id, businessId, locationId, number, type: 'writeoffProduct', date: localToUtc(input.date), warehouseId: input.warehouseId, reason: input.reason, comment: input.comment, createdBy: ctx.member.staffId, updatedBy: ctx.member.staffId } });
            await tx.stockOpLine.createMany({ data: input.lines.map((l) => ({ id: newId('stockOpLine'), opId: id, businessId, goodId: l.goodId, qtySale: -Math.abs(l.qtySale), unitPrice: BigInt(l.unitPrice), discountPct: l.discountPct, costTotal: -lineTotal(l) })) });
            await this.audit.record(tx, ctx, { action: 'create', entityType: 'stockOperation', entityId: id, businessId, after: { type: 'writeoffProduct', number } });
        });
        return this.getDoc(businessId, id);
    }
    // ─────────────────────────── Перемещение (F-08-005/048/059/060) ───────────────────────────
    async createMove(ctx, locationId, input) {
        const businessId = ctx.member.businessId;
        if (input.fromWarehouseId === input.toWarehouseId)
            throw new ApiError('validation', 'Same warehouse');
        await this.assertShortage(businessId, input.fromWarehouseId, input.lines.map((l) => ({ goodId: l.goodId, qtySale: l.qty })));
        const number = await this.nextNumber(businessId);
        const id = newId('stockOp');
        await this.prisma.$transaction(async (tx) => {
            await tx.stockOp.create({ data: { id, businessId, locationId, number, type: 'move', date: localToUtc(input.date), warehouseId: input.fromWarehouseId, toWarehouseId: input.toWarehouseId, comment: input.comment, createdBy: ctx.member.staffId, updatedBy: ctx.member.staffId } });
            for (const l of input.lines) {
                const good = await tx.product.findUnique({ where: { id: l.goodId } });
                const cost = good?.costPrice ?? 0n;
                await tx.stockOpLine.create({ data: { id: newId('stockOpLine'), opId: id, businessId, goodId: l.goodId, qtySale: -l.qty, unitPrice: cost, costTotal: -BigInt(Math.round(l.qty)) * cost } });
            }
            await this.audit.record(tx, ctx, { action: 'create', entityType: 'stockOperation', entityId: id, businessId, after: { type: 'move', number } });
        });
        return this.getDoc(businessId, id);
    }
    /** F-08-060: перемещение не редактируется — только отмена: документ-разворот */
    async cancelMove(ctx, id) {
        const businessId = ctx.member.businessId;
        const doc = await this.prisma.stockOp.findFirst({ where: { id, businessId } });
        if (!doc)
            throw new ApiError('not_found', 'Operation not found');
        if (doc.type !== 'move' || !doc.toWarehouseId)
            throw new ApiError('validation', 'Not a move operation');
        if (doc.cancelledByDocId)
            throw new ApiError('already_cancelled', 'Already cancelled');
        const lines = await this.linesOf(id);
        const number = await this.nextNumber(businessId);
        const reverseId = newId('stockOp');
        await this.prisma.$transaction(async (tx) => {
            await tx.stockOp.create({ data: { id: reverseId, businessId, locationId: doc.locationId, number, type: 'move', date: new Date(), warehouseId: doc.toWarehouseId, toWarehouseId: doc.warehouseId, comment: `Отмена перемещения № ${doc.number}`, cancelsDocId: doc.id, createdBy: ctx.member.staffId, updatedBy: ctx.member.staffId } });
            await tx.stockOpLine.createMany({ data: lines.map((l) => ({ id: newId('stockOpLine'), opId: reverseId, businessId, goodId: l.goodId, qtySale: l.qtySale, unitPrice: l.unitPrice, costTotal: l.costTotal })) });
            await tx.stockOp.update({ where: { id }, data: { cancelledByDocId: reverseId, version: { increment: 1 } } });
            await this.audit.record(tx, ctx, { action: 'cancel', entityType: 'stockOperation', entityId: id, businessId, after: { reverseId } });
        });
        return this.getDoc(businessId, reverseId);
    }
    // ─────────────────────────── Продажа (F-08-062…077, F-08-092, F-00-138) ───────────────────────────
    /** F-07-051…054: продажа вне визита — «честная дыра» этапа 12 закрыта здесь: списывает склад и, если оплачена
     * деньгами (не 'loyalty'/'unpaid'), заводит доходную операцию кассы статьёй «Продажа товара» */
    async createSale(ctx, locationId, input) {
        const businessId = ctx.member.businessId;
        await this.assertShortage(businessId, input.warehouseId, input.lines);
        const number = await this.nextNumber(businessId);
        const id = newId('stockOp');
        await this.prisma.$transaction(async (tx) => {
            await tx.stockOp.create({
                data: { id, businessId, locationId, number, type: 'sale', date: new Date(), warehouseId: input.warehouseId, clientId: input.clientId, staffId: input.staffId, bookingId: input.bookingId, paid: input.paymentMethod !== 'unpaid', paymentMethod: input.paymentMethod, comment: input.comment, createdBy: ctx.member.staffId, updatedBy: ctx.member.staffId },
            });
            await tx.stockOpLine.createMany({ data: input.lines.map((l) => ({ id: newId('stockOpLine'), opId: id, businessId, goodId: l.goodId, qtySale: -Math.abs(l.qtySale), unitPrice: BigInt(l.unitPrice), discountPct: l.discountPct, costTotal: -lineTotal(l) })) });
            await this.audit.record(tx, ctx, { action: 'create', entityType: 'stockOperation', entityId: id, businessId, after: { type: 'sale', number } });
        });
        if (input.paymentMethod === 'cash' || input.paymentMethod === 'card') {
            const amount = input.lines.reduce((s, l) => s + Number(lineTotal(l)), 0);
            await this.bridgeToFinance(ctx, { locationId, docId: id, docNumber: number, kind: 'income', itemKey: 'goodsSale', amount, method: input.paymentMethod, clientId: input.clientId, source: 'sale' });
        }
        return this.getDoc(businessId, id);
    }
    /**
     * F-08-073: отмена/возврат продажи. Товар возвращается на склад тем же способом, что и отменённое
     * перемещение/автосписание — `cancelledAt` выключает документ из `computeLevels` (§ каталога), так что
     * лишний документ-разворот не нужен. Выручка в кассе снимается: связанный `FinOp` (если продажа была
     * оплачена деньгами) гасится через `FinOpsService.cancel`, а не остаётся висеть отдельно от товара.
     */
    async cancelSale(ctx, id) {
        const businessId = ctx.member.businessId;
        const doc = await this.prisma.stockOp.findFirst({ where: { id, businessId } });
        if (!doc)
            throw new ApiError('not_found', 'Operation not found');
        if (doc.type !== 'sale')
            throw new ApiError('validation', 'Not a sale');
        if (doc.cancelledAt)
            throw new ApiError('already_cancelled', 'Already cancelled');
        await this.prisma.$transaction(async (tx) => {
            await tx.stockOp.update({ where: { id }, data: { cancelledAt: new Date(), version: { increment: 1 } } });
            await this.audit.record(tx, ctx, { action: 'cancel', entityType: 'stockOperation', entityId: id, businessId, after: { cancelled: true } });
        });
        if (doc.financeOperationId) {
            await this.finOps.cancel(ctx, doc.financeOperationId).catch(() => undefined);
        }
    }
    // ─────────────────────────── Правка / удаление документа (F-08-050/051/146) ───────────────────────────
    async updateDoc(ctx, id, patch) {
        const businessId = ctx.member.businessId;
        const doc = await this.prisma.stockOp.findFirst({ where: { id, businessId } });
        if (!doc)
            throw new ApiError('not_found', 'Operation not found');
        if (doc.type === 'move' || doc.type === 'sale')
            throw new ApiError('not_editable', 'This operation type is not editable, only cancellable');
        const wasPaid = doc.paid;
        const prevFinanceOperationId = doc.financeOperationId;
        const sign = doc.type === 'income' ? 1 : -1;
        await this.prisma.$transaction(async (tx) => {
            const data = { updatedBy: ctx.member.staffId, version: { increment: 1 } };
            if (patch.date !== undefined)
                data.date = localToUtc(patch.date);
            if (patch.warehouseId !== undefined)
                data.warehouseId = patch.warehouseId;
            if (patch.counterpartyName !== undefined)
                data.counterpartyName = patch.counterpartyName;
            if (patch.paid !== undefined)
                data.paid = patch.paid;
            if (patch.reason !== undefined)
                data.reason = patch.reason;
            if (patch.comment !== undefined)
                data.comment = patch.comment;
            await tx.stockOp.update({ where: { id }, data });
            if (patch.lines) {
                await tx.stockOpLine.deleteMany({ where: { opId: id } });
                await tx.stockOpLine.createMany({ data: patch.lines.map((l) => ({ id: newId('stockOpLine'), opId: id, businessId, goodId: l.goodId, qtySale: sign * Math.abs(l.qtySale), unitPrice: BigInt(l.unitPrice), discountPct: l.discountPct, costTotal: BigInt(sign) * lineTotal(l) })) });
            }
            await this.audit.record(tx, ctx, { action: 'update', entityType: 'stockOperation', entityId: id, businessId, after: { number: doc.number } });
        });
        const updated = await this.prisma.stockOp.findUniqueOrThrow({ where: { id } });
        if (updated.type === 'income') {
            if (updated.paid && !wasPaid && !prevFinanceOperationId) {
                const lines = await this.linesOf(id);
                const amount = lines.reduce((s, l) => s + Math.abs(Number(l.costTotal)), 0);
                await this.bridgeToFinance(ctx, { locationId: updated.locationId, docId: id, docNumber: updated.number, kind: 'expense', itemKey: 'goodsPurchase', amount, method: 'cash', comment: updated.counterpartyName ?? undefined, source: 'manual' });
            }
            else if (!updated.paid && wasPaid && prevFinanceOperationId) {
                await this.finOps.cancel(ctx, prevFinanceOperationId);
                await this.prisma.stockOp.update({ where: { id }, data: { financeOperationId: null } });
            }
        }
        return this.getDoc(businessId, id);
    }
    async deleteLine(ctx, docId, goodId) {
        const businessId = ctx.member.businessId;
        const doc = await this.prisma.stockOp.findFirst({ where: { id: docId, businessId } });
        if (!doc)
            throw new ApiError('not_found', 'Operation not found');
        if (doc.type === 'move')
            throw new ApiError('not_editable', 'Move operation lines are not editable');
        await this.prisma.$transaction(async (tx) => {
            await tx.stockOpLine.deleteMany({ where: { opId: docId, goodId } });
            await tx.stockOp.update({ where: { id: docId }, data: { version: { increment: 1 } } });
            await this.audit.record(tx, ctx, { action: 'update', entityType: 'stockOperation', entityId: docId, businessId, after: { removedLine: goodId } });
        });
    }
    /** ⭐ наше добавление к 1:1 (как этап 8 у finance): удалить документ целиком, с журналом */
    async deleteDoc(ctx, id) {
        const businessId = ctx.member.businessId;
        const doc = await this.prisma.stockOp.findFirst({ where: { id, businessId } });
        if (!doc)
            throw new ApiError('not_found', 'Operation not found');
        await this.prisma.$transaction(async (tx) => {
            await tx.stockOpLine.deleteMany({ where: { opId: id } });
            await tx.stockOp.delete({ where: { id } });
            await this.audit.record(tx, ctx, { action: 'delete', entityType: 'stockOperation', entityId: id, businessId, before: { number: doc.number }, after: null });
        });
    }
    // ─────────────────────────── Мост к finance (F-00-138/F-08-057/070/073) ───────────────────────────
    async bridgeToFinance(ctx, p) {
        if (p.amount <= 0)
            return;
        const businessId = ctx.member.businessId;
        const itemId = await this.financeCatalog.systemItemId(businessId, p.itemKey);
        const accounts = await this.financeCatalog.listCashRegisters(businessId, [p.locationId]);
        const wantCard = p.method === 'card';
        const account = accounts.find((a) => a.kind === (wantCard ? 'card' : 'cash')) ?? accounts[0];
        if (!account)
            return;
        const op = await this.finOps.create(ctx, {
            locationId: p.locationId,
            accountId: account.id,
            itemId,
            kind: p.kind,
            amount: p.amount,
            date: new Date().toISOString().slice(0, 16),
            method: p.method === 'card' ? 'card' : 'cash',
            partyType: p.clientId ? 'client' : 'none',
            partyId: p.clientId,
            comment: p.comment,
            source: p.source,
            refId: p.docId,
            docNumber: p.docNumber,
            lineLabel: p.kind === 'income' ? `Продажа № ${p.docNumber}` : `Приход № ${p.docNumber}`,
        }, p.source);
        await this.prisma.stockOp.update({ where: { id: p.docId }, data: { financeOperationId: op.id } });
    }
};
StockOpsService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [PrismaService,
        AuditService,
        StockCatalogService,
        FinanceCatalogService,
        FinOpsService])
], StockOpsService);
export { StockOpsService };
//# sourceMappingURL=stock-ops.service.js.map