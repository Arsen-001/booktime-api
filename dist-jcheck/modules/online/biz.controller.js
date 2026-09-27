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
import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../common/errors/api-error.js';
import { Biz, Ctx } from '../../common/http/guards.js';
import { ZodBody, ZodOk } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { ifMatch } from '../../common/http/version.js';
import { bookingLinkOut, businessOnlineRulesBody, businessOnlineRulesOut, createLinkBody, onlineMetaOut, staffClientRulesBody, staffClientRulesOut, updateLinkBody, } from './online.schemas.js';
import { OnlineService } from './online.service.js';
/**
 * Кабинет: ссылки на запись (F-03-003…037), правила мастера для клиента (F-00-066), правила бизнеса онлайн-
 * записи (F-03-079, F-03-116, В-24), источник записи в журнале (F-03-123). docs/backend/02 §3, PLAN §6 №8.
 */
let BizOnlineController = class BizOnlineController {
    constructor(svc) {
        this.svc = svc;
    }
    // ── ссылки ──
    list(businessId) {
        return this.svc.listLinks(businessId);
    }
    get(businessId, id) {
        return this.svc.getLink(businessId, id);
    }
    create(ctx, businessId, body) {
        return this.svc.createLink(ctx, businessId, body);
    }
    update(ctx, req, businessId, id, body) {
        return this.svc.updateLink(ctx, businessId, id, body, ifMatch(req));
    }
    async remove(businessId, id) {
        await this.svc.deleteLink(businessId, id);
        return { ok: true };
    }
    setPrimary(ctx, businessId, id) {
        return this.svc.setPrimaryLink(ctx, businessId, id);
    }
    // ── правила мастера для клиента (F-00-066) ──
    clientRules(businessId, staffId) {
        return this.svc.staffClientRules(businessId, staffId);
    }
    setClientRules(ctx, businessId, staffId, body) {
        this.assertClientRulesEdit(ctx, staffId);
        return this.svc.updateStaffClientRules(ctx, businessId, staffId, body);
    }
    assertClientRulesEdit(ctx, staffId) {
        const m = ctx.member;
        if (m.permissions.has('online.manage'))
            return;
        if (staffId === m.staffId && m.permissions.has('online.own'))
            return;
        throw new ApiError('forbidden', 'Missing permission: online.manage');
    }
    // ── правила бизнеса (F-03-079, F-03-116, В-24) ──
    businessRules(businessId) {
        return this.svc.businessOnlineRules(businessId);
    }
    setBusinessRules(businessId, body) {
        return this.svc.updateBusinessOnlineRules(businessId, body);
    }
    // ── источник записи (F-03-123) ──
    onlineMeta(businessId, id) {
        return this.svc.onlineMeta(businessId, id);
    }
};
__decorate([
    Get('links'),
    Biz(),
    ZodOk(z.array(bookingLinkOut)),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], BizOnlineController.prototype, "list", null);
__decorate([
    Get('links/:id'),
    Biz(),
    ZodOk(bookingLinkOut),
    __param(0, Param('businessId')),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], BizOnlineController.prototype, "get", null);
__decorate([
    Post('links'),
    Biz('online.manage'),
    ApiOperation({ summary: '«Новая ссылка» (F-03-005, F-03-006)' }),
    ZodBody(createLinkBody),
    ZodOk(bookingLinkOut),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(createLinkBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], BizOnlineController.prototype, "create", null);
__decorate([
    Patch('links/:id'),
    Biz('online.manage'),
    ZodBody(updateLinkBody),
    ZodOk(bookingLinkOut),
    __param(0, Ctx()),
    __param(1, Req()),
    __param(2, Param('businessId')),
    __param(3, Param('id')),
    __param(4, Body(new Zod(updateLinkBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, String, String, Object]),
    __metadata("design:returntype", void 0)
], BizOnlineController.prototype, "update", null);
__decorate([
    Delete('links/:id'),
    Biz('online.manage'),
    __param(0, Param('businessId')),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], BizOnlineController.prototype, "remove", null);
__decorate([
    Post('links/:id/primary'),
    Biz('online.manage'),
    ZodOk(bookingLinkOut),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String]),
    __metadata("design:returntype", void 0)
], BizOnlineController.prototype, "setPrimary", null);
__decorate([
    Get('staff/:staffId/client-rules'),
    Biz(),
    ZodOk(staffClientRulesOut),
    __param(0, Param('businessId')),
    __param(1, Param('staffId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], BizOnlineController.prototype, "clientRules", null);
__decorate([
    Put('staff/:staffId/client-rules'),
    Biz(),
    ApiOperation({ summary: 'Владелец/администратор — всем; сам мастер — только себе (online.own, как в 03 §2)' }),
    ZodBody(staffClientRulesBody),
    ZodOk(staffClientRulesOut),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('staffId')),
    __param(3, Body(new Zod(staffClientRulesBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object]),
    __metadata("design:returntype", void 0)
], BizOnlineController.prototype, "setClientRules", null);
__decorate([
    Get('online/rules'),
    Biz(),
    ZodOk(businessOnlineRulesOut),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], BizOnlineController.prototype, "businessRules", null);
__decorate([
    Put('online/rules'),
    Biz('online.manage'),
    ZodBody(businessOnlineRulesBody),
    ZodOk(businessOnlineRulesOut),
    __param(0, Param('businessId')),
    __param(1, Body(new Zod(businessOnlineRulesBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], BizOnlineController.prototype, "setBusinessRules", null);
__decorate([
    Get('bookings/:id/online-meta'),
    Biz('journal.view'),
    ZodOk(onlineMetaOut),
    __param(0, Param('businessId')),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], BizOnlineController.prototype, "onlineMeta", null);
BizOnlineController = __decorate([
    ApiTags('online'),
    Controller('v1/biz/:businessId'),
    __metadata("design:paramtypes", [OnlineService])
], BizOnlineController);
export { BizOnlineController };
//# sourceMappingURL=biz.controller.js.map