var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Biz, Ctx } from '../../common/http/guards.js';
import { ZodBody, ZodOk } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { InventoriesService } from './inventories.service.js';
import { StockCatalogService } from './stock-catalog.service.js';
import { StockOpsService } from './stock-ops.service.js';
import { categoryBody, categoryPatchBody, equipmentBody, equipmentPatchBody, goodBody, goodPatchBody, idsBody, incomeBody, inventoryCreateBody, inventorySetLinesBody, moveBody, opDocPatchBody, quickUpdateGoodsBody, reminderBody, reorderBody, restoreGoodsBody, saleBody, stockSettingsPatchBody, techCardPutBody, warehouseBody, warehousePatchBody, writeoffBody, } from './stock.schemas.js';
import { TechCardsService } from './tech-cards.service.js';
/**
 * Склад (docs/backend/02-api.md §13, PLAN §6 №13). Владелец данных — сам бизнес (как финансы, этап 12),
 * не сеть — сетевое копирование товаров (F-08-130/135) не строим в этом проходе (см. PROGRESS.md «Не строил»).
 */
let StockController = class StockController {
    constructor(catalog, ops, techCards, inventories) {
        this.catalog = catalog;
        this.ops = ops;
        this.techCards = techCards;
        this.inventories = inventories;
    }
    // ─────────────────────────── Склады (F-08-004…009) ───────────────────────────
    listWarehouses(businessId, locationId) {
        return this.catalog.listWarehouses(businessId, locationId);
    }
    getWarehouse(businessId, id) {
        return this.catalog.getWarehouse(businessId, id);
    }
    createWarehouse(ctx, body) {
        return this.catalog.createWarehouse(ctx, body);
    }
    updateWarehouse(ctx, id, body) {
        return this.catalog.updateWarehouse(ctx, id, body);
    }
    async removeWarehouse(ctx, id) {
        await this.catalog.removeWarehouse(ctx.member.businessId, id);
        return { ok: true };
    }
    async reorderWarehouses(ctx, locationId, body) {
        await this.catalog.reorderWarehouses(ctx.member.businessId, locationId, body.orderedIds);
        return { ok: true };
    }
    // ─────────────────────────── Категории (F-08-010…014) ───────────────────────────
    listCategories(businessId, locationId, tree, includeArchived) {
        if (tree === '1' || tree === 'true')
            return this.catalog.listCategoryTree(businessId, locationId);
        return this.catalog.listCategoriesFlat(businessId, locationId, includeArchived === '1' || includeArchived === 'true');
    }
    createCategory(ctx, body) {
        return this.catalog.createCategory(ctx, body);
    }
    updateCategory(ctx, id, body) {
        return this.catalog.updateCategory(ctx, id, body);
    }
    async archiveCategory(ctx, id) {
        await this.catalog.archiveCategory(ctx, id);
        return { ok: true };
    }
    async restoreCategory(ctx, id) {
        await this.catalog.restoreCategory(ctx, id);
        return { ok: true };
    }
    restoreCategories(ctx, body) {
        return this.catalog.restoreCategories(ctx, body.ids);
    }
    async removeCategory(ctx, id) {
        await this.catalog.removeCategory(ctx.member.businessId, id);
        return { ok: true };
    }
    // ─────────────────────────── Товары (F-08-015…027) ───────────────────────────
    listGoods(businessId, q) {
        return this.catalog.listGoods(businessId, q.locationId, { categoryId: q.categoryId, search: q.search, includeArchived: q.includeArchived === '1' || q.includeArchived === 'true', page: q.page ? Number(q.page) : undefined, pageSize: q.pageSize ? Number(q.pageSize) : undefined });
    }
    searchGoods(businessId, locationId, query = '', limit) {
        return this.catalog.searchGoods(businessId, locationId, query, limit ? Number(limit) : undefined);
    }
    getGood(businessId, id) {
        return this.catalog.getGood(businessId, id);
    }
    getGoodHistory(businessId, id) {
        return this.catalog.listEntityHistory(businessId, 'stockGood', id);
    }
    createGood(ctx, body) {
        return this.catalog.createGood(ctx, body);
    }
    updateGood(ctx, id, body) {
        return this.catalog.updateGood(ctx, id, body);
    }
    async quickUpdateGoods(ctx, body) {
        await this.catalog.quickUpdateGoods(ctx, body.ids, body);
        return { ok: true };
    }
    async archiveGood(ctx, id) {
        await this.catalog.archiveGood(ctx, id);
        return { ok: true };
    }
    archiveGoods(ctx, body) {
        return this.catalog.archiveGoods(ctx, body.ids);
    }
    async restoreGood(ctx, id) {
        await this.catalog.restoreGood(ctx, id);
        return { ok: true };
    }
    restoreGoods(ctx, body) {
        return this.catalog.restoreGoods(ctx, body.ids, body.markRestored);
    }
    async removeGood(ctx, id) {
        await this.catalog.removeGood(ctx.member.businessId, id);
        return { ok: true };
    }
    // ─────────────────────────── Остатки и «заказать» (F-00-137) ───────────────────────────
    async balances(businessId, goodId) {
        return this.catalog.computeLevels(businessId, goodId);
    }
    toOrder(businessId, locationId) {
        return this.catalog.listOrderCandidates(businessId, locationId);
    }
    async toOrderWhatsApp(businessId, locationId, phone) {
        const items = await this.catalog.listOrderCandidates(businessId, locationId);
        return { url: this.catalog.buildOrderWhatsAppUrl(phone, items) };
    }
    // ─────────────────────────── Операции: приход/списание/перемещение/продажа (F-08-046…078) ───────────────────────────
    listOps(businessId, q) {
        return this.ops.listOps(businessId, { type: q.type, warehouseId: q.warehouseId, goodId: q.goodId, dateFrom: q.dateFrom, dateTo: q.dateTo, search: q.search, page: q.page ? Number(q.page) : undefined, pageSize: q.pageSize ? Number(q.pageSize) : undefined });
    }
    getOp(businessId, id) {
        return this.ops.getDoc(businessId, id);
    }
    getOpHistory(businessId, id) {
        return this.catalog.listEntityHistory(businessId, 'stockOperation', id);
    }
    createIncome(ctx, body) {
        return this.ops.createIncome(ctx, body.locationId, body);
    }
    createWriteoff(ctx, body) {
        return this.ops.createWriteoff(ctx, body.locationId, body);
    }
    createMove(ctx, body) {
        return this.ops.createMove(ctx, body.locationId, body);
    }
    cancelMove(ctx, id) {
        return this.ops.cancelMove(ctx, id);
    }
    /** F-07-051…054: продажа вне визита — закрывает «честную дыру» этапа 12 (см. PROGRESS.md §12 «Осталось») */
    createSale(ctx, body) {
        return this.ops.createSale(ctx, body.locationId, body);
    }
    async cancelSale(ctx, id) {
        await this.ops.cancelSale(ctx, id);
        return { ok: true };
    }
    updateOp(ctx, id, body) {
        return this.ops.updateDoc(ctx, id, body);
    }
    async deleteLine(ctx, id, goodId) {
        await this.ops.deleteLine(ctx, id, goodId);
        return { ok: true };
    }
    async deleteOp(ctx, id) {
        await this.ops.deleteDoc(ctx, id);
        return { ok: true };
    }
    // ─────────────────────────── Техкарты (F-08-036…045) ───────────────────────────
    listTechCards(businessId, locationId, serviceId, staffId) {
        return this.techCards.list(businessId, locationId, serviceId, staffId);
    }
    /** F-08-039: техкарты одной услуги по всем мастерам, без привязки к филиалу (карточка услуги) */
    listTechCardsForService(businessId, serviceId) {
        return this.techCards.listForService(businessId, serviceId);
    }
    upsertTechCard(ctx, staffId, serviceId, body) {
        return this.techCards.upsert(ctx, { ...body, staffId, serviceId });
    }
    getTechCard(businessId, staffId, serviceId) {
        return this.techCards.getForServiceStaff(businessId, serviceId, staffId);
    }
    async removeTechCard(ctx, id) {
        await this.techCards.remove(ctx.member.businessId, id);
        return { ok: true };
    }
    // ─────────────────────────── Инвентаризация (F-08-079…089) ───────────────────────────
    listInventories(businessId, locationId) {
        return this.inventories.list(businessId, locationId);
    }
    getInventory(businessId, id) {
        return this.inventories.get(businessId, id);
    }
    createInventory(ctx, body) {
        return this.inventories.create(ctx, body.locationId, body);
    }
    setInventoryLines(ctx, id, body) {
        return this.inventories.setLines(ctx, id, body.lines);
    }
    completeInventory(ctx, id) {
        return this.inventories.complete(ctx, id);
    }
    async removeInventory(ctx, id) {
        await this.inventories.remove(ctx.member.businessId, id);
        return { ok: true };
    }
    // ─────────────────────────── Оборудование (⭐ F-00-141) ───────────────────────────
    listEquipment(businessId, locationId, includeArchived) {
        return this.catalog.listEquipment(businessId, locationId, includeArchived === '1' || includeArchived === 'true');
    }
    getEquipment(businessId, id) {
        return this.catalog.getEquipment(businessId, id);
    }
    createEquipment(ctx, body) {
        return this.catalog.createEquipment(ctx, body);
    }
    updateEquipment(ctx, id, body) {
        return this.catalog.updateEquipment(ctx, id, body);
    }
    async archiveEquipment(ctx, id) {
        await this.catalog.archiveEquipment(ctx.member.businessId, id);
        return { ok: true };
    }
    async removeEquipment(ctx, id) {
        await this.catalog.removeEquipment(ctx.member.businessId, id);
        return { ok: true };
    }
    // ─────────────────────────── Напоминания (⭐ F-00-142) ───────────────────────────
    listReminders(businessId, locationId) {
        return this.catalog.listReminders(businessId, locationId);
    }
    createReminder(ctx, body) {
        return this.catalog.createReminder(ctx, body);
    }
    async toggleReminder(ctx, id, body) {
        await this.catalog.toggleReminder(ctx.member.businessId, id, body.done);
        return { ok: true };
    }
    async removeReminder(ctx, id) {
        await this.catalog.removeReminder(ctx.member.businessId, id);
        return { ok: true };
    }
    // ─────────────────────────── Настройки (F-08-096…100) ───────────────────────────
    getSettings(businessId) {
        return this.catalog.getSettings(businessId);
    }
    updateSettings(ctx, body) {
        return this.catalog.updateSettings(ctx, body);
    }
};
__decorate([
    Get('warehouses'),
    Biz('stock.view'),
    __param(0, Param('businessId')),
    __param(1, Query('locationId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], StockController.prototype, "listWarehouses", null);
__decorate([
    Get('warehouses/:id'),
    Biz('stock.view'),
    __param(0, Param('businessId')),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], StockController.prototype, "getWarehouse", null);
__decorate([
    Post('warehouses'),
    Biz('stock.edit'),
    ZodBody(warehouseBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(warehouseBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], StockController.prototype, "createWarehouse", null);
__decorate([
    Patch('warehouses/:id'),
    Biz('stock.edit'),
    ZodBody(warehousePatchBody),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body(new Zod(warehousePatchBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], StockController.prototype, "updateWarehouse", null);
__decorate([
    Delete('warehouses/:id'),
    Biz('stock.edit'),
    HttpCode(200),
    ZodOk(z.object({ ok: z.literal(true) })),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], StockController.prototype, "removeWarehouse", null);
__decorate([
    Post('warehouses/reorder'),
    Biz('stock.edit'),
    HttpCode(200),
    ZodBody(reorderBody),
    ZodOk(z.object({ ok: z.literal(true) })),
    __param(0, Ctx()),
    __param(1, Query('locationId')),
    __param(2, Body(new Zod(reorderBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", Promise)
], StockController.prototype, "reorderWarehouses", null);
__decorate([
    Get('product-categories'),
    Biz('stock.view'),
    __param(0, Param('businessId')),
    __param(1, Query('locationId')),
    __param(2, Query('tree')),
    __param(3, Query('includeArchived')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, String]),
    __metadata("design:returntype", void 0)
], StockController.prototype, "listCategories", null);
__decorate([
    Post('product-categories'),
    Biz('stock.edit'),
    ZodBody(categoryBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(categoryBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], StockController.prototype, "createCategory", null);
__decorate([
    Patch('product-categories/:id'),
    Biz('stock.edit'),
    ZodBody(categoryPatchBody),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body(new Zod(categoryPatchBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], StockController.prototype, "updateCategory", null);
__decorate([
    Post('product-categories/:id/archive'),
    Biz('stock.edit'),
    HttpCode(200),
    ZodOk(z.object({ ok: z.literal(true) })),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], StockController.prototype, "archiveCategory", null);
__decorate([
    Post('product-categories/:id/restore'),
    Biz('stock.edit'),
    HttpCode(200),
    ZodOk(z.object({ ok: z.literal(true) })),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], StockController.prototype, "restoreCategory", null);
__decorate([
    Post('product-categories/restore'),
    Biz('stock.edit'),
    ZodBody(idsBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(idsBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], StockController.prototype, "restoreCategories", null);
__decorate([
    Delete('product-categories/:id'),
    Biz('stock.edit'),
    HttpCode(200),
    ZodOk(z.object({ ok: z.literal(true) })),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], StockController.prototype, "removeCategory", null);
__decorate([
    Get('products'),
    Biz('stock.view'),
    __param(0, Param('businessId')),
    __param(1, Query()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], StockController.prototype, "listGoods", null);
__decorate([
    Get('products/search'),
    Biz('stock.view'),
    __param(0, Param('businessId')),
    __param(1, Query('locationId')),
    __param(2, Query('q')),
    __param(3, Query('limit')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object, String]),
    __metadata("design:returntype", void 0)
], StockController.prototype, "searchGoods", null);
__decorate([
    Get('products/:id'),
    Biz('stock.view'),
    __param(0, Param('businessId')),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], StockController.prototype, "getGood", null);
__decorate([
    Get('products/:id/history'),
    Biz('stock.view'),
    __param(0, Param('businessId')),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], StockController.prototype, "getGoodHistory", null);
__decorate([
    Post('products'),
    Biz('stock.edit'),
    ZodBody(goodBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(goodBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], StockController.prototype, "createGood", null);
__decorate([
    Patch('products/:id'),
    Biz('stock.edit'),
    ZodBody(goodPatchBody),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body(new Zod(goodPatchBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], StockController.prototype, "updateGood", null);
__decorate([
    Post('products/quick-update'),
    Biz('stock.edit'),
    HttpCode(200),
    ZodBody(quickUpdateGoodsBody),
    ZodOk(z.object({ ok: z.literal(true) })),
    __param(0, Ctx()),
    __param(1, Body(new Zod(quickUpdateGoodsBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], StockController.prototype, "quickUpdateGoods", null);
__decorate([
    Post('products/:id/archive'),
    Biz('stock.edit'),
    HttpCode(200),
    ZodOk(z.object({ ok: z.literal(true) })),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], StockController.prototype, "archiveGood", null);
__decorate([
    Post('products/archive'),
    Biz('stock.edit'),
    ZodBody(idsBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(idsBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], StockController.prototype, "archiveGoods", null);
__decorate([
    Post('products/:id/restore'),
    Biz('stock.edit'),
    HttpCode(200),
    ZodOk(z.object({ ok: z.literal(true) })),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], StockController.prototype, "restoreGood", null);
__decorate([
    Post('products/restore'),
    Biz('stock.edit'),
    ZodBody(restoreGoodsBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(restoreGoodsBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], StockController.prototype, "restoreGoods", null);
__decorate([
    Delete('products/:id'),
    Biz('stock.edit'),
    HttpCode(200),
    ZodOk(z.object({ ok: z.literal(true) })),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], StockController.prototype, "removeGood", null);
__decorate([
    Get('balances'),
    Biz('stock.view'),
    __param(0, Param('businessId')),
    __param(1, Query('goodId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], StockController.prototype, "balances", null);
__decorate([
    Get('to-order'),
    Biz('stock.view'),
    __param(0, Param('businessId')),
    __param(1, Query('locationId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], StockController.prototype, "toOrder", null);
__decorate([
    Get('to-order/whatsapp-text'),
    Biz('stock.view'),
    __param(0, Param('businessId')),
    __param(1, Query('locationId')),
    __param(2, Query('phone')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String]),
    __metadata("design:returntype", Promise)
], StockController.prototype, "toOrderWhatsApp", null);
__decorate([
    Get('stock-ops'),
    Biz('stock.view'),
    __param(0, Param('businessId')),
    __param(1, Query()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], StockController.prototype, "listOps", null);
__decorate([
    Get('stock-ops/:id'),
    Biz('stock.view'),
    __param(0, Param('businessId')),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], StockController.prototype, "getOp", null);
__decorate([
    Get('stock-ops/:id/history'),
    Biz('stock.view'),
    __param(0, Param('businessId')),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], StockController.prototype, "getOpHistory", null);
__decorate([
    Post('stock-ops/income'),
    Biz('stock.edit'),
    ZodBody(incomeBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(incomeBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], StockController.prototype, "createIncome", null);
__decorate([
    Post('stock-ops/writeoff'),
    Biz('stock.edit'),
    ZodBody(writeoffBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(writeoffBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], StockController.prototype, "createWriteoff", null);
__decorate([
    Post('stock-ops/move'),
    Biz('stock.edit'),
    ZodBody(moveBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(moveBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], StockController.prototype, "createMove", null);
__decorate([
    Post('stock-ops/:id/cancel-move'),
    Biz('stock.edit'),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], StockController.prototype, "cancelMove", null);
__decorate([
    Post('sales'),
    Biz('stock.edit'),
    ZodBody(saleBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(saleBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], StockController.prototype, "createSale", null);
__decorate([
    Post('sales/:id/cancel'),
    Biz('stock.edit'),
    HttpCode(200),
    ZodOk(z.object({ ok: z.literal(true) })),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], StockController.prototype, "cancelSale", null);
__decorate([
    Patch('stock-ops/:id'),
    Biz('stock.edit'),
    ZodBody(opDocPatchBody),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body(new Zod(opDocPatchBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], StockController.prototype, "updateOp", null);
__decorate([
    Delete('stock-ops/:id/lines/:goodId'),
    Biz('stock.edit'),
    HttpCode(200),
    ZodOk(z.object({ ok: z.literal(true) })),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Param('goodId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String]),
    __metadata("design:returntype", Promise)
], StockController.prototype, "deleteLine", null);
__decorate([
    Delete('stock-ops/:id'),
    Biz('stock.edit'),
    HttpCode(200),
    ZodOk(z.object({ ok: z.literal(true) })),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], StockController.prototype, "deleteOp", null);
__decorate([
    Get('tech-cards'),
    Biz('stock.view'),
    __param(0, Param('businessId')),
    __param(1, Query('locationId')),
    __param(2, Query('serviceId')),
    __param(3, Query('staffId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, String]),
    __metadata("design:returntype", void 0)
], StockController.prototype, "listTechCards", null);
__decorate([
    Get('tech-cards/by-service/:serviceId'),
    Biz('stock.view'),
    __param(0, Param('businessId')),
    __param(1, Param('serviceId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], StockController.prototype, "listTechCardsForService", null);
__decorate([
    Put('staff/:staffId/services/:serviceId/tech-card'),
    Biz('stock.edit'),
    ZodBody(techCardPutBody),
    __param(0, Ctx()),
    __param(1, Param('staffId')),
    __param(2, Param('serviceId')),
    __param(3, Body(new Zod(techCardPutBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object]),
    __metadata("design:returntype", void 0)
], StockController.prototype, "upsertTechCard", null);
__decorate([
    Get('staff/:staffId/services/:serviceId/tech-card'),
    Biz('stock.view'),
    __param(0, Param('businessId')),
    __param(1, Param('staffId')),
    __param(2, Param('serviceId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String]),
    __metadata("design:returntype", void 0)
], StockController.prototype, "getTechCard", null);
__decorate([
    Delete('tech-cards/:id'),
    Biz('stock.edit'),
    HttpCode(200),
    ZodOk(z.object({ ok: z.literal(true) })),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], StockController.prototype, "removeTechCard", null);
__decorate([
    Get('inventories'),
    Biz('stock.view'),
    __param(0, Param('businessId')),
    __param(1, Query('locationId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], StockController.prototype, "listInventories", null);
__decorate([
    Get('inventories/:id'),
    Biz('stock.view'),
    __param(0, Param('businessId')),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], StockController.prototype, "getInventory", null);
__decorate([
    Post('inventories'),
    Biz('stock.edit'),
    ZodBody(inventoryCreateBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(inventoryCreateBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], StockController.prototype, "createInventory", null);
__decorate([
    Patch('inventories/:id/lines'),
    Biz('stock.edit'),
    ZodBody(inventorySetLinesBody),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body(new Zod(inventorySetLinesBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], StockController.prototype, "setInventoryLines", null);
__decorate([
    Post('inventories/:id/complete'),
    Biz('stock.edit'),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], StockController.prototype, "completeInventory", null);
__decorate([
    Delete('inventories/:id'),
    Biz('stock.edit'),
    HttpCode(200),
    ZodOk(z.object({ ok: z.literal(true) })),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], StockController.prototype, "removeInventory", null);
__decorate([
    Get('equipment'),
    Biz('stock.view'),
    __param(0, Param('businessId')),
    __param(1, Query('locationId')),
    __param(2, Query('includeArchived')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String]),
    __metadata("design:returntype", void 0)
], StockController.prototype, "listEquipment", null);
__decorate([
    Get('equipment/:id'),
    Biz('stock.view'),
    __param(0, Param('businessId')),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], StockController.prototype, "getEquipment", null);
__decorate([
    Post('equipment'),
    Biz('stock.edit'),
    ZodBody(equipmentBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(equipmentBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], StockController.prototype, "createEquipment", null);
__decorate([
    Patch('equipment/:id'),
    Biz('stock.edit'),
    ZodBody(equipmentPatchBody),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body(new Zod(equipmentPatchBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], StockController.prototype, "updateEquipment", null);
__decorate([
    Post('equipment/:id/archive'),
    Biz('stock.edit'),
    HttpCode(200),
    ZodOk(z.object({ ok: z.literal(true) })),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], StockController.prototype, "archiveEquipment", null);
__decorate([
    Delete('equipment/:id'),
    Biz('stock.edit'),
    HttpCode(200),
    ZodOk(z.object({ ok: z.literal(true) })),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], StockController.prototype, "removeEquipment", null);
__decorate([
    Get('reminders'),
    Biz('stock.view'),
    __param(0, Param('businessId')),
    __param(1, Query('locationId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], StockController.prototype, "listReminders", null);
__decorate([
    Post('reminders'),
    Biz('stock.edit'),
    ZodBody(reminderBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(reminderBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], StockController.prototype, "createReminder", null);
__decorate([
    Post('reminders/:id/toggle'),
    Biz('stock.edit'),
    HttpCode(200),
    ZodBody(z.object({ done: z.boolean() })),
    ZodOk(z.object({ ok: z.literal(true) })),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body(new Zod(z.object({ done: z.boolean() })))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", Promise)
], StockController.prototype, "toggleReminder", null);
__decorate([
    Delete('reminders/:id'),
    Biz('stock.edit'),
    HttpCode(200),
    ZodOk(z.object({ ok: z.literal(true) })),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], StockController.prototype, "removeReminder", null);
__decorate([
    Get('settings'),
    Biz('stock.view'),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], StockController.prototype, "getSettings", null);
__decorate([
    Patch('settings'),
    Biz('stock.edit'),
    ZodBody(stockSettingsPatchBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(stockSettingsPatchBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], StockController.prototype, "updateSettings", null);
StockController = __decorate([
    ApiTags('stock'),
    Controller('v1/biz/:businessId/stock'),
    __metadata("design:paramtypes", [StockCatalogService,
        StockOpsService,
        TechCardsService,
        InventoriesService])
], StockController);
export { StockController };
//# sourceMappingURL=stock.controller.js.map