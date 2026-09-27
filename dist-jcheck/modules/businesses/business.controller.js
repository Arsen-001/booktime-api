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
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../common/errors/api-error.js';
import { Authed, Biz, Ctx } from '../../common/http/guards.js';
import { ZodBody, ZodOk } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { ifMatch } from '../../common/http/version.js';
import { Idempotent } from '../../common/idempotency/idempotency.js';
import { PrismaService } from '../../common/prisma.service.js';
import { RateLimit } from '../../common/rate-limit/rate-limit.js';
import { businessOut, coreOut, hereBody, locationBody, locationOut, patchBusinessBody, patchLocationBody, registerBusinessBody, registerOut, securityBody, securityOut, settingBody, settingOut, } from './business.schemas.js';
import { BusinessService } from './business.service.js';
const AREA_RE = /^[a-z][a-zA-Z0-9_.-]{1,39}$/;
/** Бизнес, филиалы, настройки разделов — /v1/biz (docs/backend/02 §18, §7) */
let BusinessController = class BusinessController {
    constructor(biz, prisma) {
        this.biz = biz;
        this.prisma = prisma;
    }
    register(ctx, body) {
        return this.biz.register(ctx, body);
    }
    get(businessId) {
        return this.biz.get(businessId);
    }
    async core(ctx, businessId) {
        const m = ctx.member;
        let ids = [businessId];
        if (m.role === 'network' && m.networkId) {
            ids = (await this.prisma.business.findMany({ where: { networkId: m.networkId, leftAt: null }, select: { id: true } })).map((b) => b.id);
        }
        return this.biz.core(businessId, ids);
    }
    patch(ctx, req, businessId, body) {
        return this.biz.patch(ctx, businessId, body, ifMatch(req));
    }
    // ─────────── филиалы ───────────
    locations(businessId) {
        return this.biz.locations(businessId);
    }
    addLocation(ctx, businessId, body) {
        return this.biz.addLocation(ctx, businessId, body);
    }
    patchLocation(ctx, req, businessId, locationId, body) {
        return this.biz.patchLocation(ctx, businessId, locationId, body, ifMatch(req));
    }
    here(ctx, businessId, locationId, body) {
        return this.biz.markHere(ctx, businessId, locationId, body);
    }
    // ─────────── безопасность бизнеса (F-00-047) и настройки разделов ───────────
    async security(businessId) {
        const b = await this.biz.get(businessId);
        return { blockHomeVisitDuringShift: b.forbidHomeBookingsDuringShift };
    }
    async setSecurity(ctx, businessId, body) {
        const b = await this.biz.patch(ctx, businessId, { forbidHomeBookingsDuringShift: body.blockHomeVisitDuringShift }, undefined);
        return { blockHomeVisitDuringShift: b.forbidHomeBookingsDuringShift };
    }
    getSetting(businessId, area) {
        if (!AREA_RE.test(area))
            throw new ApiError('validation', 'Bad area');
        return this.biz.getSetting(businessId, area);
    }
    putSetting(ctx, req, businessId, area, body) {
        if (!AREA_RE.test(area))
            throw new ApiError('validation', 'Bad area');
        const raw = req.header('if-match');
        return this.biz.putSetting(ctx, businessId, area, body.data, raw === '0' ? 0 : ifMatch(req));
    }
};
__decorate([
    Post(),
    Authed(),
    Idempotent(),
    RateLimit({ bucket: 'biz-register', limit: 10, windowSec: 86_400, by: 'session' }),
    ApiOperation({ summary: 'Регистрация бизнеса (F-00-035): бизнес + филиал + владелец; сессия переходит в «Мой бизнес»' }),
    ZodBody(registerBusinessBody),
    ZodOk(registerOut),
    __param(0, Ctx()),
    __param(1, Body(new Zod(registerBusinessBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], BusinessController.prototype, "register", null);
__decorate([
    Get(':businessId'),
    Biz(),
    ApiOperation({ summary: 'Бизнес (вид «свой бизнес»)' }),
    ZodOk(businessOut),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], BusinessController.prototype, "get", null);
__decorate([
    Get(':businessId/core'),
    Biz(),
    ApiOperation({ summary: 'Бизнес(ы), филиалы, сотрудники, сеть одним ответом (владельцу сети — все филиалы)' }),
    ZodOk(coreOut),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], BusinessController.prototype, "core", null);
__decorate([
    Patch(':businessId'),
    Biz('settings.manage'),
    ApiOperation({ summary: 'Название, описание, логотип, контакты, соцсети (F-15-097…120). If-Match: version' }),
    ZodBody(patchBusinessBody),
    ZodOk(businessOut),
    __param(0, Ctx()),
    __param(1, Req()),
    __param(2, Param('businessId')),
    __param(3, Body(new Zod(patchBusinessBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, String, Object]),
    __metadata("design:returntype", void 0)
], BusinessController.prototype, "patch", null);
__decorate([
    Get(':businessId/locations'),
    Biz(),
    ApiOperation({ summary: 'Филиалы (места) бизнеса' }),
    ZodOk(z.array(locationOut)),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], BusinessController.prototype, "locations", null);
__decorate([
    Post(':businessId/locations'),
    Biz('settings.manage'),
    ApiOperation({ summary: 'Добавить место/филиал (F-15-104)' }),
    ZodBody(locationBody),
    ZodOk(locationOut),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(locationBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], BusinessController.prototype, "addLocation", null);
__decorate([
    Patch(':businessId/locations/:locationId'),
    Biz('settings.manage'),
    ApiOperation({ summary: 'Адрес, телефоны, часы, пояс филиала. If-Match: version' }),
    ZodBody(patchLocationBody),
    ZodOk(locationOut),
    __param(0, Ctx()),
    __param(1, Req()),
    __param(2, Param('businessId')),
    __param(3, Param('locationId')),
    __param(4, Body(new Zod(patchLocationBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, String, String, Object]),
    __metadata("design:returntype", void 0)
], BusinessController.prototype, "patchLocation", null);
__decorate([
    Post(':businessId/locations/:locationId/here'),
    HttpCode(200),
    Biz(),
    ApiOperation({ summary: '«Я сейчас на месте работы» — точка филиала (F-00-075)' }),
    ZodBody(hereBody),
    ZodOk(locationOut),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('locationId')),
    __param(3, Body(new Zod(hereBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object]),
    __metadata("design:returntype", void 0)
], BusinessController.prototype, "here", null);
__decorate([
    Get(':businessId/security'),
    Biz(),
    ZodOk(securityOut),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], BusinessController.prototype, "security", null);
__decorate([
    Put(':businessId/security'),
    Biz('settings.manage'),
    ApiOperation({ summary: 'Запрет домашних записей в часы смены (F-00-047)' }),
    ZodBody(securityBody),
    ZodOk(securityOut),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(securityBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", Promise)
], BusinessController.prototype, "setSecurity", null);
__decorate([
    Get(':businessId/settings/:area'),
    Biz(),
    ApiOperation({ summary: 'Настройки раздела (JSON на раздел, F4)' }),
    ZodOk(settingOut),
    __param(0, Param('businessId')),
    __param(1, Param('area')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], BusinessController.prototype, "getSetting", null);
__decorate([
    Put(':businessId/settings/:area'),
    Biz('settings.manage'),
    ApiOperation({ summary: 'Сохранить настройки раздела целиком. If-Match: version (0 — ещё не сохраняли)' }),
    ZodBody(settingBody),
    ZodOk(settingOut),
    __param(0, Ctx()),
    __param(1, Req()),
    __param(2, Param('businessId')),
    __param(3, Param('area')),
    __param(4, Body(new Zod(settingBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, String, String, Object]),
    __metadata("design:returntype", void 0)
], BusinessController.prototype, "putSetting", null);
BusinessController = __decorate([
    ApiTags('business'),
    Controller('v1/biz'),
    __metadata("design:paramtypes", [BusinessService,
        PrismaService])
], BusinessController);
export { BusinessController };
//# sourceMappingURL=business.controller.js.map