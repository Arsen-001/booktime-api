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
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../common/errors/api-error.js';
import { Biz, Ctx } from '../../common/http/guards.js';
import { ZodBody } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { isLocalDate } from '../../common/time/time.js';
import { JournalAccess, csv } from '../journal/access.js';
import { JournalMoreService } from './journal-more.service.js';
const date = (v, name) => {
    if (!isLocalDate(v))
        throw new ApiError('validation', 'Invalid input', { [name]: 'YYYY-MM-DD' });
    return v;
};
const id = z.string().min(1).max(40);
const localAt = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
const packageSlotsBody = z.object({
    locationId: id,
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    order: z.enum(['parallel', 'sequential_one', 'sequential_many']),
    steps: z
        .array(z.object({ serviceId: id, staffId: id, durationMin: z.number().int().min(1).max(24 * 60), bufferAfterMin: z.number().int().min(0).max(600).optional() }))
        .min(1)
        .max(20),
});
const prefsBody = z.object({
    pinnedFields: z.array(z.string().max(60)).max(60).optional(),
    clientCardPins: z.array(z.string().max(60)).max(60).optional(),
    // FavoriteSection фронта: без labelKey/href «Ещё» журнала падает (Link без href) — принимаем только полную форму
    favorites: z.array(z.object({ id: z.string().min(1).max(120), labelKey: z.string().min(1).max(160), href: z.string().regex(/^\/[^\s]*$/).max(300) }).strict()).max(100).optional(),
    waitlistPanelOpen: z.boolean().optional(),
});
const draftBody = z.object({ key: z.string().min(1).max(200), data: z.unknown().nullable() });
const saleBody = z.object({
    itemId: id,
    qty: z.number().positive().max(10_000),
    paymentMethod: z.enum(['cash', 'card']),
    code: z.string().max(60).optional(),
    clientId: id.optional(),
    clientName: z.string().max(160).optional(),
    locationId: id.optional(),
});
const ledgerBody = z.object({
    locationId: id,
    at: localAt,
    category: z.string().max(30),
    cashRegister: z.string().max(120).optional(),
    counterpartyType: z.enum(['contractor', 'client', 'staff']),
    counterpartyName: z.string().min(1).max(160),
    amount: z.number().int().positive(),
    comment: z.string().max(400).optional(),
    createdByStaffId: z.string().max(40).optional(),
});
/**
 * Этап 21, лейн «journal»: то, что экраны журнала считали у себя по моковой базе (src/api/journal.ts) —
 * часы сетки, загрузка дней, лаки, статистика клиента, частые услуги, сводка дня, окна пакета, личные
 * закрепления и избранное, черновик окна записи, продажа вне визита, «Новый платёж».
 */
let JournalMoreController = class JournalMoreController {
    constructor(svc, access) {
        this.svc = svc;
        this.access = access;
    }
    async staffHours(ctx, staffIds, from, to, locationId, ids) {
        const f = date(from, 'from');
        return this.svc.staffHours(await this.access.businessIds(ctx, ids), csv(staffIds).slice(0, 200), f, to ? date(to, 'to') : f, locationId || undefined);
    }
    async rangeLoad(ctx, staffIds, from, to, ids) {
        return this.svc.rangeLoad(await this.access.businessIds(ctx, ids), csv(staffIds).slice(0, 200), date(from, 'from'), date(to, 'to'));
    }
    async lacquers(ctx, ids, day, bizIds) {
        return this.svc.lacquers(await this.access.businessIds(ctx, bizIds), { ids: csv(ids), date: day ? date(day, 'date') : undefined });
    }
    async clientVisitStats(ctx, clientId, ids) {
        if (!clientId)
            throw new ApiError('validation', 'Invalid input', { clientId: 'required' });
        return this.svc.clientVisitStats(await this.access.businessIds(ctx, ids), clientId);
    }
    frequentServices(p, staffId, limit) {
        if (!staffId)
            throw new ApiError('validation', 'Invalid input', { staffId: 'required' });
        return this.svc.frequentServices(p.businessId, staffId, Number(limit) || 6);
    }
    daySummary(p, day) {
        return this.svc.daySummary(p.businessId, date(day, 'date'));
    }
    packageSlots(p, body) {
        return this.svc.packageSlots(p.businessId, body.locationId, body.date, body.steps, body.order);
    }
    // ─────────── личное ───────────
    prefs(p, userKey) {
        return this.svc.prefs(p.businessId, userKey);
    }
    patchPrefs(ctx, p, userKey, body) {
        return this.svc.patchPrefs(ctx, p.businessId, userKey, body);
    }
    draft(p, key) {
        if (!key)
            throw new ApiError('validation', 'Invalid input', { key: 'required' });
        return this.svc.draft(p.businessId, key);
    }
    async setDraft(ctx, p, body) {
        await this.svc.setDraft(ctx, p.businessId, body.key, body.data ?? null);
    }
    // ─────────── продажа вне визита ───────────
    goodsCatalog(ctx, locationId) {
        return this.svc.goodsCatalog(ctx, locationId || undefined);
    }
    sell(ctx, body) {
        return this.svc.sell(ctx, body);
    }
    async cancelSale(ctx, saleId) {
        await this.svc.cancelSale(ctx, saleId);
    }
    // ─────────── «Новый платёж» ───────────
    ledger(p, locationId) {
        if (!locationId)
            throw new ApiError('validation', 'Invalid input', { locationId: 'required' });
        return this.svc.ledger(p.businessId, locationId);
    }
    createLedger(ctx, body) {
        return this.svc.createLedger(ctx, body);
    }
    async cancelLedger(ctx, opId) {
        await this.svc.cancelLedger(ctx, opId);
    }
};
__decorate([
    Get('staff-hours'),
    Biz('journal.view'),
    ApiOperation({ summary: 'Рабочие часы сотрудников по дням: {staffId: {date: DayHours}} (F-01-013/019/023)' }),
    __param(0, Ctx()),
    __param(1, Query('staffIds')),
    __param(2, Query('from')),
    __param(3, Query('to')),
    __param(4, Query('locationId')),
    __param(5, Query('businessIds')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, String, String, String]),
    __metadata("design:returntype", Promise)
], JournalMoreController.prototype, "staffHours", null);
__decorate([
    Get('range-load'),
    Biz('journal.view'),
    ApiOperation({ summary: 'Загрузка дней диапазона для мини-календаря (F-01-003/004)' }),
    __param(0, Ctx()),
    __param(1, Query('staffIds')),
    __param(2, Query('from')),
    __param(3, Query('to')),
    __param(4, Query('businessIds')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, String, String]),
    __metadata("design:returntype", Promise)
], JournalMoreController.prototype, "rangeLoad", null);
__decorate([
    Get('lacquers'),
    Biz('journal.view'),
    ApiOperation({ summary: 'Оттенок лака записей (F-00-094): ?ids= или ?date=' }),
    __param(0, Ctx()),
    __param(1, Query('ids')),
    __param(2, Query('date')),
    __param(3, Query('businessIds')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, String]),
    __metadata("design:returntype", Promise)
], JournalMoreController.prototype, "lacquers", null);
__decorate([
    Get('client-visit-stats'),
    Biz('journal.view'),
    ApiOperation({ summary: 'Статистика клиента в окне записи (F-01-071)' }),
    __param(0, Ctx()),
    __param(1, Query('clientId')),
    __param(2, Query('businessIds')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String]),
    __metadata("design:returntype", Promise)
], JournalMoreController.prototype, "clientVisitStats", null);
__decorate([
    Get('frequent-services'),
    Biz('journal.view'),
    ApiOperation({ summary: 'Id самых частых услуг мастера (F-01-056)' }),
    __param(0, Param()),
    __param(1, Query('staffId')),
    __param(2, Query('limit')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String]),
    __metadata("design:returntype", void 0)
], JournalMoreController.prototype, "frequentServices", null);
__decorate([
    Get('day-summary'),
    Biz('journal.view'),
    ApiOperation({ summary: 'Сводка дня: касса, записано, выполнено, товары, клиенты (F-01-011)' }),
    __param(0, Param()),
    __param(1, Query('date')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], JournalMoreController.prototype, "daySummary", null);
__decorate([
    Post('package-slots'),
    HttpCode(200),
    Biz('journal.view'),
    ApiOperation({ summary: 'Окна, где помещается весь пакет услуг (F-01-134, F-02-069)' }),
    ZodBody(packageSlotsBody),
    __param(0, Param()),
    __param(1, Body(new Zod(packageSlotsBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], JournalMoreController.prototype, "packageSlots", null);
__decorate([
    Get('prefs/:userKey'),
    Biz('journal.view'),
    ApiOperation({ summary: 'Личные закрепления журнала: поля окна, плитки карточки, избранное, панель ожидания' }),
    __param(0, Param()),
    __param(1, Param('userKey')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], JournalMoreController.prototype, "prefs", null);
__decorate([
    Patch('prefs/:userKey'),
    Biz('journal.view'),
    ZodBody(prefsBody),
    __param(0, Ctx()),
    __param(1, Param()),
    __param(2, Param('userKey')),
    __param(3, Body(new Zod(prefsBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, String, Object]),
    __metadata("design:returntype", void 0)
], JournalMoreController.prototype, "patchPrefs", null);
__decorate([
    Get('draft'),
    Biz('journal.view'),
    ApiOperation({ summary: 'Черновик окна записи (F-01-040)' }),
    __param(0, Param()),
    __param(1, Query('key')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], JournalMoreController.prototype, "draft", null);
__decorate([
    Put('draft'),
    HttpCode(204),
    Biz('journal.view'),
    ZodBody(draftBody),
    __param(0, Ctx()),
    __param(1, Param()),
    __param(2, Body(new Zod(draftBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object]),
    __metadata("design:returntype", Promise)
], JournalMoreController.prototype, "setDraft", null);
__decorate([
    Get('goods-catalog'),
    Biz('journal.view'),
    ApiOperation({ summary: 'Каталог «Продать»: товары склада, типы абонементов и сертификатов (F-01-010)' }),
    __param(0, Ctx()),
    __param(1, Query('locationId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], JournalMoreController.prototype, "goodsCatalog", null);
__decorate([
    Post('quick-sales'),
    Biz('journal.edit'),
    ApiOperation({ summary: 'Продажа вне визита (F-01-010, F-04-219): склад/лояльность + касса' }),
    ZodBody(saleBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(saleBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], JournalMoreController.prototype, "sell", null);
__decorate([
    Post('quick-sales/:id/cancel'),
    HttpCode(204),
    Biz('journal.edit'),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], JournalMoreController.prototype, "cancelSale", null);
__decorate([
    Get('ledger'),
    Biz('journal.view'),
    ApiOperation({ summary: 'Платежи без визита филиала — ручные операции кассы (F-01-151)' }),
    __param(0, Param()),
    __param(1, Query('locationId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], JournalMoreController.prototype, "ledger", null);
__decorate([
    Post('ledger'),
    Biz('journal.edit'),
    ZodBody(ledgerBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(ledgerBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], JournalMoreController.prototype, "createLedger", null);
__decorate([
    Post('ledger/:id/cancel'),
    HttpCode(204),
    Biz('journal.edit'),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], JournalMoreController.prototype, "cancelLedger", null);
JournalMoreController = __decorate([
    ApiTags('journal'),
    Controller('v1/biz/:businessId/journal'),
    __metadata("design:paramtypes", [JournalMoreService,
        JournalAccess])
], JournalMoreController);
export { JournalMoreController };
//# sourceMappingURL=journal-more.controller.js.map