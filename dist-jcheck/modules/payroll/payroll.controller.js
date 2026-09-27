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
import { ApiError } from '../../common/errors/api-error.js';
import { Biz, Ctx } from '../../common/http/guards.js';
import { ZodBody, ZodOk } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { PayrollCatalogService } from './payroll-catalog.service.js';
import { PayrollComputeService } from './payroll-compute.service.js';
import { PayrollSettlementsService } from './payroll-settlements.service.js';
import { assignmentBody, bonusPenaltyTypeBody, bulkApplySchemeBody, chartBody, criterionBody, generalSettingsBody, payoutBody, ruleBody, schemeBlocksBody, settlementEntryBody, settlementSheetBody } from './payroll.schemas.js';
/** Своё ли это (право `payroll.manage` отсутствует) — В-10 «мастер видит свою выручку и зарплату всегда»,
 * без него calcAccess ограничен своим staffId (F-09-085…089: полная модель прав на сотрудника — честный гэп,
 * см. docs/PROGRESS.md «Этап 14»). Владелец/сеть/ИП управляют всем через payroll.manage как обычно. */
function ownOnlyStaffId(ctx) {
    return ctx.member.permissions.has('payroll.manage') ? undefined : ctx.member.staffId;
}
function requireLocationId(locationId) {
    if (!locationId)
        throw new ApiError('validation', 'locationId is required');
    return locationId;
}
/** Основные настройки, классическая модель, расчёты, справочник премий/штрафов, аналитика (F-09-004…101). */
let PayrollController = class PayrollController {
    constructor(catalog, compute, settlements) {
        this.catalog = catalog;
        this.compute = compute;
        this.settlements = settlements;
    }
    // ─────────────────────────── Основные настройки (F-09-004/005) ───────────────────────────
    getSettings(ctx, locationId) {
        return this.catalog.getSettings(ctx.member.businessId, requireLocationId(locationId));
    }
    saveSettings(ctx, locationId, body) {
        return this.catalog.saveSettings(ctx, requireLocationId(locationId), body);
    }
    // ─────────────────────────── Расчёт (F-09-058…065) ───────────────────────────
    day(ctx, locationId, date) {
        return this.compute.computeDay(ctx.member.businessId, requireLocationId(locationId), date, ownOnlyStaffId(ctx));
    }
    period(ctx, locationId, from, to, positionKey) {
        return this.compute.computePeriod(ctx.member.businessId, requireLocationId(locationId), from, to, positionKey, ownOnlyStaffId(ctx));
    }
    statement(ctx, locationId, staffId, from, to) {
        const own = ownOnlyStaffId(ctx);
        if (own && own !== staffId)
            throw new ApiError('forbidden', 'Own statement only');
        return this.compute.computeStatement(ctx.member.businessId, requireLocationId(locationId), staffId, from, to);
    }
    fundAnalytics(ctx, locationId, from, to) {
        return this.settlements.fundAnalytics(ctx.member.businessId, requireLocationId(locationId), from, to);
    }
    // ─────────────────────────── b04: быстрая настройка при подключении (F-09-104) ───────────────────────────
    setupTargets(ctx) {
        return this.catalog.listSetupTargets(ctx.member.businessId);
    }
    bulkApply(ctx, body) {
        return this.catalog.bulkApplyDefaultScheme(ctx, body.staffIds, body.defaultPercent).then((applied) => ({ applied }));
    }
    // ─────────────────────────── Классическая модель: правила (F-09-049/050) ───────────────────────────
    listRules(ctx) {
        return this.catalog.listRules(ctx.member.businessId);
    }
    getRule(ctx, id) {
        return this.catalog.getRule(ctx.member.businessId, id);
    }
    createRule(ctx, body) {
        return this.catalog.saveRule(ctx, undefined, body);
    }
    updateRule(ctx, id, body) {
        return this.catalog.saveRule(ctx, id, body);
    }
    async deleteRule(ctx, id) {
        await this.catalog.deleteRule(ctx, id);
        return { ok: true };
    }
    // ─────────────────────────── Классическая модель: критерии (F-09-052) ───────────────────────────
    listCriteria(ctx) {
        return this.catalog.listCriteria(ctx.member.businessId);
    }
    getCriterion(ctx, id) {
        return this.catalog.getCriterion(ctx.member.businessId, id);
    }
    createCriterion(ctx, body) {
        return this.catalog.saveCriterion(ctx, undefined, body);
    }
    updateCriterion(ctx, id, body) {
        return this.catalog.saveCriterion(ctx, id, body);
    }
    async deleteCriterion(ctx, id) {
        await this.catalog.deleteCriterion(ctx, id);
        return { ok: true };
    }
    // ─────────────────────────── Классическая модель: схемы расчёта — charts (F-09-054) ───────────────────────────
    listCharts(ctx) {
        return this.catalog.listCharts(ctx.member.businessId);
    }
    getChart(ctx, id) {
        return this.catalog.getChart(ctx.member.businessId, id);
    }
    createChart(ctx, body) {
        return this.catalog.saveChart(ctx, undefined, body);
    }
    updateChart(ctx, id, body) {
        return this.catalog.saveChart(ctx, id, body);
    }
    async deleteChart(ctx, id) {
        await this.catalog.deleteChart(ctx, id);
        return { ok: true };
    }
    // ─────────────────────────── Классическая модель: назначения (F-09-055) ───────────────────────────
    listAssignments(ctx, staffId) {
        return this.catalog.listAssignments(ctx.member.businessId, staffId);
    }
    createAssignment(ctx, body) {
        return this.catalog.createAssignment(ctx, body);
    }
    async deleteAssignment(ctx, id) {
        await this.catalog.deleteAssignment(ctx, id);
        return { ok: true };
    }
    // ─────────────────────────── Справочник «Премии и штрафы» (F-09-072) ───────────────────────────
    listBonusPenaltyTypes(ctx, kind) {
        return this.catalog.listBonusPenaltyTypes(ctx.member.businessId, kind);
    }
    createBonusPenaltyType(ctx, body) {
        return this.catalog.saveBonusPenaltyType(ctx, undefined, body);
    }
    updateBonusPenaltyType(ctx, id, body) {
        return this.catalog.saveBonusPenaltyType(ctx, id, body);
    }
    async deleteBonusPenaltyType(ctx, id) {
        await this.catalog.deleteBonusPenaltyType(ctx, id);
        return { ok: true };
    }
    // ─────────────────────────── Взаиморасчёты и выплата (F-07-159…162, F-09-066…080) ───────────────────────────
    createSheet(ctx, body) {
        return this.settlements.createSheet(ctx, body);
    }
    accrueSheet(ctx, id) {
        return this.settlements.accrueSheet(ctx, id);
    }
    createEntry(ctx, body) {
        return this.settlements.createEntry(ctx, body);
    }
    async deleteEntry(ctx, id) {
        await this.settlements.deleteEntry(ctx, id);
        return { ok: true };
    }
    payout(ctx, body) {
        return this.settlements.payout(ctx, body);
    }
    getApproval(ctx, sheetId) {
        return this.settlements.getApproval(ctx.member.businessId, sheetId);
    }
    advanceApproval(ctx, sheetId) {
        return this.settlements.advanceApproval(ctx, sheetId);
    }
    signApproval(ctx, sheetId) {
        return this.settlements.signApproval(ctx.member.businessId, sheetId, ctx.member.staffId);
    }
};
__decorate([
    Get('settings'),
    Biz('payroll.view'),
    __param(0, Ctx()),
    __param(1, Query('locationId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], PayrollController.prototype, "getSettings", null);
__decorate([
    Patch('settings'),
    Biz('payroll.manage'),
    ZodBody(generalSettingsBody),
    __param(0, Ctx()),
    __param(1, Query('locationId')),
    __param(2, Body(new Zod(generalSettingsBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object]),
    __metadata("design:returntype", void 0)
], PayrollController.prototype, "saveSettings", null);
__decorate([
    Get('day'),
    Biz('payroll.view'),
    __param(0, Ctx()),
    __param(1, Query('locationId')),
    __param(2, Query('date')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, String]),
    __metadata("design:returntype", void 0)
], PayrollController.prototype, "day", null);
__decorate([
    Get('period'),
    Biz('payroll.view'),
    __param(0, Ctx()),
    __param(1, Query('locationId')),
    __param(2, Query('from')),
    __param(3, Query('to')),
    __param(4, Query('positionKey')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, String, String, String]),
    __metadata("design:returntype", void 0)
], PayrollController.prototype, "period", null);
__decorate([
    Get('statement'),
    Biz('payroll.view'),
    __param(0, Ctx()),
    __param(1, Query('locationId')),
    __param(2, Query('staffId')),
    __param(3, Query('from')),
    __param(4, Query('to')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, String, String, String]),
    __metadata("design:returntype", void 0)
], PayrollController.prototype, "statement", null);
__decorate([
    Get('fund-analytics'),
    Biz('payroll.manage'),
    __param(0, Ctx()),
    __param(1, Query('locationId')),
    __param(2, Query('from')),
    __param(3, Query('to')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, String, String]),
    __metadata("design:returntype", void 0)
], PayrollController.prototype, "fundAnalytics", null);
__decorate([
    Get('setup-targets'),
    Biz('payroll.manage'),
    __param(0, Ctx()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], PayrollController.prototype, "setupTargets", null);
__decorate([
    Post('setup-targets/bulk-apply'),
    Biz('payroll.manage'),
    ZodBody(bulkApplySchemeBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(bulkApplySchemeBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], PayrollController.prototype, "bulkApply", null);
__decorate([
    Get('rules'),
    Biz('payroll.manage'),
    __param(0, Ctx()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], PayrollController.prototype, "listRules", null);
__decorate([
    Get('rules/:id'),
    Biz('payroll.manage'),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], PayrollController.prototype, "getRule", null);
__decorate([
    Post('rules'),
    Biz('payroll.manage'),
    ZodBody(ruleBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(ruleBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], PayrollController.prototype, "createRule", null);
__decorate([
    Patch('rules/:id'),
    Biz('payroll.manage'),
    ZodBody(ruleBody),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body(new Zod(ruleBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], PayrollController.prototype, "updateRule", null);
__decorate([
    Delete('rules/:id'),
    Biz('payroll.manage'),
    HttpCode(200),
    ZodOk(z.object({ ok: z.literal(true) })),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], PayrollController.prototype, "deleteRule", null);
__decorate([
    Get('criteria'),
    Biz('payroll.manage'),
    __param(0, Ctx()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], PayrollController.prototype, "listCriteria", null);
__decorate([
    Get('criteria/:id'),
    Biz('payroll.manage'),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], PayrollController.prototype, "getCriterion", null);
__decorate([
    Post('criteria'),
    Biz('payroll.manage'),
    ZodBody(criterionBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(criterionBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], PayrollController.prototype, "createCriterion", null);
__decorate([
    Patch('criteria/:id'),
    Biz('payroll.manage'),
    ZodBody(criterionBody),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body(new Zod(criterionBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], PayrollController.prototype, "updateCriterion", null);
__decorate([
    Delete('criteria/:id'),
    Biz('payroll.manage'),
    HttpCode(200),
    ZodOk(z.object({ ok: z.literal(true) })),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], PayrollController.prototype, "deleteCriterion", null);
__decorate([
    Get('charts'),
    Biz('payroll.manage'),
    __param(0, Ctx()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], PayrollController.prototype, "listCharts", null);
__decorate([
    Get('charts/:id'),
    Biz('payroll.manage'),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], PayrollController.prototype, "getChart", null);
__decorate([
    Post('charts'),
    Biz('payroll.manage'),
    ZodBody(chartBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(chartBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], PayrollController.prototype, "createChart", null);
__decorate([
    Patch('charts/:id'),
    Biz('payroll.manage'),
    ZodBody(chartBody),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body(new Zod(chartBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], PayrollController.prototype, "updateChart", null);
__decorate([
    Delete('charts/:id'),
    Biz('payroll.manage'),
    HttpCode(200),
    ZodOk(z.object({ ok: z.literal(true) })),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], PayrollController.prototype, "deleteChart", null);
__decorate([
    Get('assignments'),
    Biz('payroll.manage'),
    __param(0, Ctx()),
    __param(1, Query('staffId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], PayrollController.prototype, "listAssignments", null);
__decorate([
    Post('assignments'),
    Biz('payroll.manage'),
    ZodBody(assignmentBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(assignmentBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], PayrollController.prototype, "createAssignment", null);
__decorate([
    Delete('assignments/:id'),
    Biz('payroll.manage'),
    HttpCode(200),
    ZodOk(z.object({ ok: z.literal(true) })),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], PayrollController.prototype, "deleteAssignment", null);
__decorate([
    Get('bonus-penalty-types'),
    Biz('payroll.view'),
    __param(0, Ctx()),
    __param(1, Query('kind')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], PayrollController.prototype, "listBonusPenaltyTypes", null);
__decorate([
    Post('bonus-penalty-types'),
    Biz('payroll.manage'),
    ZodBody(bonusPenaltyTypeBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(bonusPenaltyTypeBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], PayrollController.prototype, "createBonusPenaltyType", null);
__decorate([
    Patch('bonus-penalty-types/:id'),
    Biz('payroll.manage'),
    ZodBody(bonusPenaltyTypeBody),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body(new Zod(bonusPenaltyTypeBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], PayrollController.prototype, "updateBonusPenaltyType", null);
__decorate([
    Delete('bonus-penalty-types/:id'),
    Biz('payroll.manage'),
    HttpCode(200),
    ZodOk(z.object({ ok: z.literal(true) })),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], PayrollController.prototype, "deleteBonusPenaltyType", null);
__decorate([
    Post('settlements/sheet'),
    Biz('payroll.manage'),
    ZodBody(settlementSheetBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(settlementSheetBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], PayrollController.prototype, "createSheet", null);
__decorate([
    Post('settlements/:id/accrue'),
    Biz('payroll.manage'),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], PayrollController.prototype, "accrueSheet", null);
__decorate([
    Post('settlements/entry'),
    Biz('payroll.manage'),
    ZodBody(settlementEntryBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(settlementEntryBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], PayrollController.prototype, "createEntry", null);
__decorate([
    Delete('settlements/:id'),
    Biz('payroll.manage'),
    HttpCode(200),
    ZodOk(z.object({ ok: z.literal(true) })),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], PayrollController.prototype, "deleteEntry", null);
__decorate([
    Post('payouts'),
    Biz('payroll.manage'),
    ZodBody(payoutBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(payoutBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], PayrollController.prototype, "payout", null);
__decorate([
    Get('statements/:sheetId/approval'),
    Biz('payroll.view'),
    __param(0, Ctx()),
    __param(1, Param('sheetId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], PayrollController.prototype, "getApproval", null);
__decorate([
    Post('statements/:sheetId/approval/advance'),
    Biz('payroll.manage'),
    __param(0, Ctx()),
    __param(1, Param('sheetId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], PayrollController.prototype, "advanceApproval", null);
__decorate([
    Post('statements/:sheetId/approval/sign'),
    Biz('payroll.view'),
    __param(0, Ctx()),
    __param(1, Param('sheetId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], PayrollController.prototype, "signApproval", null);
PayrollController = __decorate([
    ApiTags('payroll'),
    Controller('v1/biz/:businessId/payroll'),
    __metadata("design:paramtypes", [PayrollCatalogService,
        PayrollComputeService,
        PayrollSettlementsService])
], PayrollController);
export { PayrollController };
/** Схема сотрудника и его взаиморасчёты — гнездится под /staff/:staffId (F-09-010…048, F-07-159…162). */
let PayrollStaffController = class PayrollStaffController {
    constructor(catalog, settlements) {
        this.catalog = catalog;
        this.settlements = settlements;
    }
    assertOwnOrManage(ctx, staffId) {
        if (!ctx.member.permissions.has('payroll.manage') && ctx.member.staffId !== staffId)
            throw new ApiError('forbidden', 'Own scheme/settlements only');
    }
    getScheme(ctx, staffId) {
        this.assertOwnOrManage(ctx, staffId);
        return this.catalog.getScheme(ctx.member.businessId, staffId);
    }
    saveScheme(ctx, staffId, body) {
        return this.catalog.saveScheme(ctx, staffId, body);
    }
    copyScheme(ctx, staffId, otherStaffId) {
        return this.catalog.copyScheme(ctx, staffId, otherStaffId);
    }
    listSettlements(ctx, staffId, periodFrom, periodTo) {
        this.assertOwnOrManage(ctx, staffId);
        return this.settlements.list(ctx.member.businessId, staffId, periodFrom, periodTo);
    }
    balance(ctx, staffId) {
        this.assertOwnOrManage(ctx, staffId);
        return this.settlements.staffBalance(ctx.member.businessId, staffId);
    }
};
__decorate([
    Get('payroll-scheme'),
    Biz('payroll.view'),
    __param(0, Ctx()),
    __param(1, Param('staffId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], PayrollStaffController.prototype, "getScheme", null);
__decorate([
    Patch('payroll-scheme'),
    Biz('payroll.manage'),
    ZodBody(schemeBlocksBody),
    __param(0, Ctx()),
    __param(1, Param('staffId')),
    __param(2, Body(new Zod(schemeBlocksBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], PayrollStaffController.prototype, "saveScheme", null);
__decorate([
    Post('payroll-scheme/copy-from/:otherStaffId'),
    Biz('payroll.manage'),
    __param(0, Ctx()),
    __param(1, Param('staffId')),
    __param(2, Param('otherStaffId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String]),
    __metadata("design:returntype", void 0)
], PayrollStaffController.prototype, "copyScheme", null);
__decorate([
    Get('settlements'),
    Biz('payroll.view'),
    __param(0, Ctx()),
    __param(1, Param('staffId')),
    __param(2, Query('periodFrom')),
    __param(3, Query('periodTo')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, String]),
    __metadata("design:returntype", void 0)
], PayrollStaffController.prototype, "listSettlements", null);
__decorate([
    Get('settlements/balance'),
    Biz('payroll.view'),
    __param(0, Ctx()),
    __param(1, Param('staffId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], PayrollStaffController.prototype, "balance", null);
PayrollStaffController = __decorate([
    ApiTags('payroll'),
    Controller('v1/biz/:businessId/staff/:staffId'),
    __metadata("design:paramtypes", [PayrollCatalogService,
        PayrollSettlementsService])
], PayrollStaffController);
export { PayrollStaffController };
//# sourceMappingURL=payroll.controller.js.map