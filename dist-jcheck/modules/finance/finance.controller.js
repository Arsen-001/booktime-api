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
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Biz, Ctx } from '../../common/http/guards.js';
import { ZodBody, ZodOk } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { FinanceCatalogService } from './finance-catalog.service.js';
import { FinOpsService } from './fin-ops.service.js';
import { cashRegisterBody, cashRegisterPatchBody, counterpartyBody, counterpartyPatchBody, documentPatchBody, fineBody, finOpBody, finOpPatchBody, importCounterpartiesBody, importFinOpsBody, paymentItemBody, paymentItemPatchBody, paymentMethodBody, paymentMethodPatchBody, refundBody, reorderBody, transferFundsBody, } from './finance.schemas.js';
function splitCsv(v) {
    return v ? v.split(',').filter(Boolean) : undefined;
}
/**
 * Финансы и касса (docs/backend/02-api.md §12, PLAN §6 №12). Владелец данных — сам бизнес. Сделки визита живут в
 * `BookingPaymentsController` (path `/bookings/:id/payments`) — доктему литеральнее, чем гнездиться здесь.
 */
let FinanceController = class FinanceController {
    constructor(catalog, ops) {
        this.catalog = catalog;
        this.ops = ops;
    }
    // ─────────────────────────── Кассы ───────────────────────────
    listCashRegisters(businessId, locationIds, withBalance) {
        return this.catalog.listCashRegisters(businessId, splitCsv(locationIds), withBalance === '1' || withBalance === 'true');
    }
    createCashRegister(ctx, body) {
        return this.catalog.createCashRegister(ctx, body);
    }
    updateCashRegister(ctx, id, body) {
        return this.catalog.updateCashRegister(ctx, id, body);
    }
    async removeCashRegister(ctx, id) {
        await this.catalog.removeCashRegister(ctx, id);
        return { ok: true };
    }
    async reorderCashRegisters(ctx, body) {
        await this.catalog.reorderCashRegisters(ctx, body.orderedIds);
        return { ok: true };
    }
    async transfer(ctx, body) {
        const { fromOperationId, toOperationId } = await this.catalog.transfer(ctx, body);
        return Promise.all([this.ops.get(ctx.member.businessId, fromOperationId), this.ops.get(ctx.member.businessId, toOperationId)]);
    }
    // ─────────────────────────── Статьи ───────────────────────────
    listItems(businessId) {
        return this.catalog.listItems(businessId);
    }
    createItem(ctx, body) {
        return this.catalog.createItem(ctx, body);
    }
    updateItem(ctx, id, body) {
        return this.catalog.updateItem(ctx, id, body);
    }
    async removeItem(ctx, id) {
        await this.catalog.removeItem(ctx.member.businessId, id);
        return { ok: true };
    }
    // ─────────────────────────── Методы оплаты (упрощённо) ───────────────────────────
    listMethods(businessId) {
        return this.catalog.listMethods(businessId);
    }
    createMethod(ctx, body) {
        return this.catalog.createMethod(ctx, body);
    }
    updateMethod(ctx, id, body) {
        return this.catalog.updateMethod(ctx, id, body);
    }
    async removeMethod(ctx, id) {
        await this.catalog.removeMethod(ctx.member.businessId, id);
        return { ok: true };
    }
    // ─────────────────────────── Контрагенты ───────────────────────────
    listCounterparties(businessId) {
        return this.catalog.listCounterparties(businessId);
    }
    createCounterparty(ctx, body) {
        return this.catalog.createCounterparty(ctx, body);
    }
    updateCounterparty(ctx, id, body) {
        return this.catalog.updateCounterparty(ctx, id, body);
    }
    async removeCounterparty(ctx, id) {
        await this.catalog.removeCounterparty(ctx.member.businessId, id);
        return { ok: true };
    }
    importCounterparties(ctx, body) {
        return this.catalog.importCounterparties(ctx, body.rows);
    }
    // ─────────────────────────── Документы ───────────────────────────
    listDocuments(businessId, q) {
        return this.catalog.listDocuments(businessId, { type: q.type, contentKind: q.contentKind, dateFrom: q.dateFrom, dateTo: q.dateTo, search: q.search });
    }
    getDocument(businessId, id) {
        return this.catalog.getDocument(businessId, id);
    }
    updateDocument(ctx, id, body) {
        return this.catalog.updateDocument(ctx, id, body.note);
    }
    // ─────────────────────────── Операции ───────────────────────────
    listOps(businessId, q) {
        const filter = {
            locationIds: splitCsv(q.locationIds),
            accountId: q.accountId,
            itemId: q.itemId,
            kind: q.kind,
            method: q.method,
            partyType: q.partyType,
            partyId: q.partyId,
            cancelled: q.cancelled === undefined ? undefined : q.cancelled === 'true',
            dateFrom: q.dateFrom,
            dateTo: q.dateTo,
            search: q.search,
        };
        return this.ops.list(businessId, filter);
    }
    getOp(businessId, id) {
        return this.ops.get(businessId, id);
    }
    createOp(ctx, body) {
        return this.ops.create(ctx, body);
    }
    updateOp(ctx, id, body) {
        return this.ops.update(ctx, id, body);
    }
    async cancelOp(ctx, id) {
        await this.ops.cancel(ctx, id);
        return { ok: true };
    }
    importOps(ctx, body) {
        return this.ops.importRows(ctx, body.rows);
    }
    // ─────────────────────────── Возвраты и штрафы (F-07-066…075) ───────────────────────────
    refund(ctx, body) {
        return this.ops.refund(ctx, body);
    }
    fine(ctx, body) {
        return this.ops.fine(ctx, body);
    }
    // ─────────────────────────── Отчёты (F-07-163…165) ───────────────────────────
    cashDay(businessId, date, locationIds) {
        return this.ops.cashDay(businessId, date, splitCsv(locationIds));
    }
    overview(businessId, from, to, locationIds) {
        return this.ops.overview(businessId, from, to, splitCsv(locationIds));
    }
    pnl(businessId, from, to, locationIds) {
        return this.ops.pnl(businessId, from, to, splitCsv(locationIds));
    }
};
__decorate([
    Get('cash-registers'),
    Biz('finance.view'),
    __param(0, Param('businessId')),
    __param(1, Query('locationIds')),
    __param(2, Query('withBalance')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String]),
    __metadata("design:returntype", void 0)
], FinanceController.prototype, "listCashRegisters", null);
__decorate([
    Post('cash-registers'),
    Biz('finance.edit'),
    ZodBody(cashRegisterBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(cashRegisterBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], FinanceController.prototype, "createCashRegister", null);
__decorate([
    Patch('cash-registers/:id'),
    Biz('finance.edit'),
    ZodBody(cashRegisterPatchBody),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body(new Zod(cashRegisterPatchBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], FinanceController.prototype, "updateCashRegister", null);
__decorate([
    Delete('cash-registers/:id'),
    Biz('finance.edit'),
    HttpCode(200),
    ZodOk(z.object({ ok: z.literal(true) })),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], FinanceController.prototype, "removeCashRegister", null);
__decorate([
    Post('cash-registers/reorder'),
    Biz('finance.edit'),
    HttpCode(200),
    ZodBody(reorderBody),
    ZodOk(z.object({ ok: z.literal(true) })),
    __param(0, Ctx()),
    __param(1, Body(new Zod(reorderBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], FinanceController.prototype, "reorderCashRegisters", null);
__decorate([
    Post('cash-registers/transfer'),
    Biz('finance.edit'),
    ZodBody(transferFundsBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(transferFundsBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], FinanceController.prototype, "transfer", null);
__decorate([
    Get('items'),
    Biz('finance.view'),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], FinanceController.prototype, "listItems", null);
__decorate([
    Post('items'),
    Biz('finance.edit'),
    ZodBody(paymentItemBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(paymentItemBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], FinanceController.prototype, "createItem", null);
__decorate([
    Patch('items/:id'),
    Biz('finance.edit'),
    ZodBody(paymentItemPatchBody),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body(new Zod(paymentItemPatchBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], FinanceController.prototype, "updateItem", null);
__decorate([
    Delete('items/:id'),
    Biz('finance.edit'),
    HttpCode(200),
    ZodOk(z.object({ ok: z.literal(true) })),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], FinanceController.prototype, "removeItem", null);
__decorate([
    Get('payment-methods'),
    Biz('finance.view'),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], FinanceController.prototype, "listMethods", null);
__decorate([
    Post('payment-methods'),
    Biz('finance.edit'),
    ZodBody(paymentMethodBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(paymentMethodBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], FinanceController.prototype, "createMethod", null);
__decorate([
    Patch('payment-methods/:id'),
    Biz('finance.edit'),
    ZodBody(paymentMethodPatchBody),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body(new Zod(paymentMethodPatchBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], FinanceController.prototype, "updateMethod", null);
__decorate([
    Delete('payment-methods/:id'),
    Biz('finance.edit'),
    HttpCode(200),
    ZodOk(z.object({ ok: z.literal(true) })),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], FinanceController.prototype, "removeMethod", null);
__decorate([
    Get('counterparties'),
    Biz('finance.view'),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], FinanceController.prototype, "listCounterparties", null);
__decorate([
    Post('counterparties'),
    Biz('finance.edit'),
    ZodBody(counterpartyBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(counterpartyBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], FinanceController.prototype, "createCounterparty", null);
__decorate([
    Patch('counterparties/:id'),
    Biz('finance.edit'),
    ZodBody(counterpartyPatchBody),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body(new Zod(counterpartyPatchBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], FinanceController.prototype, "updateCounterparty", null);
__decorate([
    Delete('counterparties/:id'),
    Biz('finance.edit'),
    HttpCode(200),
    ZodOk(z.object({ ok: z.literal(true) })),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], FinanceController.prototype, "removeCounterparty", null);
__decorate([
    Post('counterparties/import'),
    Biz('finance.edit'),
    ZodBody(importCounterpartiesBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(importCounterpartiesBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], FinanceController.prototype, "importCounterparties", null);
__decorate([
    Get('documents'),
    Biz('finance.view'),
    __param(0, Param('businessId')),
    __param(1, Query()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], FinanceController.prototype, "listDocuments", null);
__decorate([
    Get('documents/:id'),
    Biz('finance.view'),
    __param(0, Param('businessId')),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], FinanceController.prototype, "getDocument", null);
__decorate([
    Patch('documents/:id'),
    Biz('finance.edit'),
    ZodBody(documentPatchBody),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body(new Zod(documentPatchBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], FinanceController.prototype, "updateDocument", null);
__decorate([
    Get('fin-ops'),
    Biz('finance.view'),
    __param(0, Param('businessId')),
    __param(1, Query()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], FinanceController.prototype, "listOps", null);
__decorate([
    Get('fin-ops/:id'),
    Biz('finance.view'),
    __param(0, Param('businessId')),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], FinanceController.prototype, "getOp", null);
__decorate([
    Post('fin-ops'),
    Biz('finance.edit'),
    ZodBody(finOpBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(finOpBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], FinanceController.prototype, "createOp", null);
__decorate([
    Patch('fin-ops/:id'),
    Biz('finance.edit'),
    ZodBody(finOpPatchBody),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body(new Zod(finOpPatchBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], FinanceController.prototype, "updateOp", null);
__decorate([
    Post('fin-ops/:id/cancel'),
    Biz('finance.edit'),
    HttpCode(200),
    ZodOk(z.object({ ok: z.literal(true) })),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], FinanceController.prototype, "cancelOp", null);
__decorate([
    Post('fin-ops/import'),
    Biz('finance.edit'),
    ZodBody(importFinOpsBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(importFinOpsBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], FinanceController.prototype, "importOps", null);
__decorate([
    Post('refunds'),
    Biz('finance.edit'),
    ZodBody(refundBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(refundBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], FinanceController.prototype, "refund", null);
__decorate([
    Post('fines'),
    Biz('finance.edit'),
    ZodBody(fineBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(fineBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], FinanceController.prototype, "fine", null);
__decorate([
    Get('reports/cash-day'),
    Biz('finance.view'),
    __param(0, Param('businessId')),
    __param(1, Query('date')),
    __param(2, Query('locationIds')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String]),
    __metadata("design:returntype", void 0)
], FinanceController.prototype, "cashDay", null);
__decorate([
    Get('reports/finance'),
    Biz('finance.view'),
    __param(0, Param('businessId')),
    __param(1, Query('from')),
    __param(2, Query('to')),
    __param(3, Query('locationIds')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, String]),
    __metadata("design:returntype", void 0)
], FinanceController.prototype, "overview", null);
__decorate([
    Get('reports/pnl'),
    Biz('finance.view'),
    __param(0, Param('businessId')),
    __param(1, Query('from')),
    __param(2, Query('to')),
    __param(3, Query('locationIds')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, String]),
    __metadata("design:returntype", void 0)
], FinanceController.prototype, "pnl", null);
FinanceController = __decorate([
    ApiTags('finance'),
    Controller('v1/biz/:businessId/finance'),
    __metadata("design:paramtypes", [FinanceCatalogService,
        FinOpsService])
], FinanceController);
export { FinanceController };
//# sourceMappingURL=finance.controller.js.map