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
import { ApiError } from '../../common/errors/api-error.js';
import { newId } from '../../common/ids/ids.js';
import { PrismaService } from '../../common/prisma.service.js';
import { StockCatalogService } from './stock-catalog.service.js';
import { StockOpsService } from './stock-ops.service.js';
const linesToJson = (lines) => lines;
const jsonToLines = (json) => (json ?? []);
function inventoryView(r) {
    return {
        id: r.id,
        businessId: r.businessId,
        locationId: r.locationId,
        number: r.number,
        warehouseId: r.warehouseId,
        categoryId: r.categoryId ?? undefined,
        date: r.date.toISOString(),
        comment: r.comment ?? undefined,
        status: r.status,
        lines: r.lines ?? [],
        writeoffDocId: r.writeoffDocId ?? undefined,
        incomeDocId: r.incomeDocId ?? undefined,
        version: r.version,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt?.toISOString(),
    };
}
/** Расхождение факт − расчёт; отрицательное — к списанию, положительное — в приход (F-08-082) */
export function inventoryDiff(line) {
    return (line.actualQty ?? line.calcQty) - line.calcQty;
}
/**
 * Инвентаризация (F-08-079…089, F-00-135): снимок расчётного остатка на момент создания, факт вводится
 * (вручную/сканером) в черновике, «Провести» пишет расхождения одним списанием и/или одним приходом и
 * запирает документ — как F-08-084.
 */
let InventoriesService = class InventoriesService {
    constructor(prisma, catalog, ops) {
        this.prisma = prisma;
        this.catalog = catalog;
        this.ops = ops;
    }
    async list(businessId, locationId) {
        return (await this.prisma.inventory.findMany({ where: { businessId, locationId }, orderBy: { date: 'desc' } })).map(inventoryView);
    }
    async get(businessId, id) {
        const row = await this.prisma.inventory.findFirst({ where: { id, businessId } });
        return row ? inventoryView(row) : undefined;
    }
    /** F-08-080: снимок остатков склада (всех товаров или одной категории) на момент создания */
    async create(ctx, locationId, body) {
        const businessId = ctx.member.businessId;
        const goods = await this.prisma.product.findMany({ where: { businessId, locationId, archived: false, ...(body.categoryId ? { categoryId: body.categoryId } : {}) } });
        const lines = [];
        for (const g of goods) {
            const qty = await this.catalog.goodStockAt(businessId, g.id, body.warehouseId);
            if (qty !== 0)
                lines.push({ goodId: g.id, calcQty: qty });
        }
        const number = await this.nextNumber(businessId);
        const id = newId('inventory');
        await this.prisma.inventory.create({ data: { id, businessId, locationId, number, warehouseId: body.warehouseId, categoryId: body.categoryId, date: new Date(), comment: body.comment, lines: linesToJson(lines), createdBy: ctx.member.staffId, updatedBy: ctx.member.staffId } });
        return this.get(businessId, id);
    }
    async nextNumber(businessId) {
        const max = await this.prisma.inventory.aggregate({ where: { businessId }, _max: { number: true } });
        const n = Number(max._max.number ?? 100000);
        return String((Number.isFinite(n) ? n : 100000) + 1);
    }
    /** F-08-082: ввод фактического остатка построчно (сканер/руками) — только в черновике */
    async setLines(ctx, id, lines) {
        const businessId = ctx.member.businessId;
        const row = await this.prisma.inventory.findFirst({ where: { id, businessId } });
        if (!row)
            throw new ApiError('not_found', 'Inventory not found');
        if (row.status !== 'draft')
            throw new ApiError('already_completed', 'Inventory already completed');
        const existing = jsonToLines(row.lines);
        const merged = existing.map((l) => {
            const patch = lines.find((p) => p.goodId === l.goodId);
            return patch ? { ...l, actualQty: patch.actualQty } : l;
        });
        await this.prisma.inventory.update({ where: { id }, data: { lines: linesToJson(merged), version: { increment: 1 }, updatedBy: ctx.member.staffId } });
        return this.get(businessId, id);
    }
    /**
     * F-08-084: «Провести» — расхождения одним списанием (отрицательные) и/или одним приходом (положительные),
     * запирает документ. Строки без введённого факта не участвуют (actualQty undefined ⇒ diff 0).
     */
    async complete(ctx, id) {
        const businessId = ctx.member.businessId;
        const row = await this.prisma.inventory.findFirst({ where: { id, businessId } });
        if (!row)
            throw new ApiError('not_found', 'Inventory not found');
        if (row.status !== 'draft')
            throw new ApiError('already_completed', 'Inventory already completed');
        const lines = jsonToLines(row.lines);
        const shortages = lines.filter((l) => inventoryDiff(l) < 0);
        const surpluses = lines.filter((l) => inventoryDiff(l) > 0);
        let writeoffDocId;
        let incomeDocId;
        if (shortages.length) {
            const goods = await this.prisma.product.findMany({ where: { id: { in: shortages.map((l) => l.goodId) } } });
            const doc = await this.ops.createWriteoff(ctx, row.locationId, {
                locationId: row.locationId,
                date: new Date().toISOString().slice(0, 16),
                warehouseId: row.warehouseId,
                reason: 'manual',
                comment: `Инвентаризация № ${row.number}: недостача`,
                lines: shortages.map((l) => ({ goodId: l.goodId, qtySale: Math.abs(inventoryDiff(l)), unitPrice: Number(goods.find((g) => g.id === l.goodId)?.costPrice ?? 0n) })),
            });
            writeoffDocId = doc?.id;
        }
        if (surpluses.length) {
            const goods = await this.prisma.product.findMany({ where: { id: { in: surpluses.map((l) => l.goodId) } } });
            const doc = await this.ops.createIncome(ctx, row.locationId, {
                locationId: row.locationId,
                date: new Date().toISOString().slice(0, 16),
                warehouseId: row.warehouseId,
                paid: false,
                paymentMethod: 'cash',
                comment: `Инвентаризация № ${row.number}: излишек`,
                lines: surpluses.map((l) => ({ goodId: l.goodId, qtySale: inventoryDiff(l), unitPrice: Number(goods.find((g) => g.id === l.goodId)?.costPrice ?? 0n) })),
            });
            incomeDocId = doc?.id;
        }
        await this.prisma.inventory.update({ where: { id }, data: { status: 'done', writeoffDocId, incomeDocId, version: { increment: 1 }, updatedBy: ctx.member.staffId } });
        return this.get(businessId, id);
    }
    async remove(businessId, id) {
        const row = await this.prisma.inventory.findFirst({ where: { id, businessId } });
        if (!row)
            throw new ApiError('not_found', 'Inventory not found');
        if (row.status !== 'draft')
            throw new ApiError('already_completed', 'Cannot delete a completed inventory');
        await this.prisma.inventory.delete({ where: { id } });
    }
};
InventoriesService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [PrismaService,
        StockCatalogService,
        StockOpsService])
], InventoriesService);
export { InventoriesService };
//# sourceMappingURL=inventories.service.js.map