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
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Ctx } from '../../common/http/guards.js';
import { ZodBody } from '../../common/http/openapi.js';
import { RateLimit } from '../../common/rate-limit/rate-limit.js';
import { Zod } from '../../common/http/validation.js';
import { CatalogService } from './catalog.service.js';
import { callbackBody, demandBody } from './client.schemas.js';
const num = z.coerce.number().optional();
const intOpt = z.coerce.number().int().positive().optional();
/**
 * Раздел «client», без входа (docs/backend/02 §2.1, PLAN §6 №9): каталог «кто когда свободен», карточка
 * мастера/места, дни/окна для потока записи, оттенок, срок отмены, «не нашли», «попросить перезвонить».
 */
let PublicCatalogController = class PublicCatalogController {
    constructor(svc) {
        this.svc = svc;
    }
    catalog(search, sphereId, district, workplace, accepts, material, freeTodayRaw, freeTomorrowRaw, lat, lng, businessId, limit) {
        // 'false'/'0' → выкл: z.coerce.boolean() трактует ЛЮБУЮ непустую строку как true (Boolean('false') === true) —
        // та же ловушка, что уже обходят includeDeleted/freedOnly журнала своим === 'true' || === '1'.
        const truthy = (v) => v === 'true' || v === '1';
        const freeToday = freeTodayRaw === undefined ? undefined : truthy(freeTodayRaw);
        const freeTomorrow = freeTomorrowRaw === undefined ? undefined : truthy(freeTomorrowRaw);
        return this.svc.catalog({ search, sphereId, district, workplace, accepts, material, freeToday, freeTomorrow, lat, lng, businessId, limit });
    }
    masterCard(ctx, staffId) {
        return this.svc.masterCard(staffId, ctx.session && !ctx.session.platform ? ctx.session.userId : undefined);
    }
    placeCard(businessId) {
        return this.svc.placeCard(businessId);
    }
    days(staffId, serviceId, workplace, days) {
        return this.svc.bookingDays(staffId, serviceId, workplace, days);
    }
    slots(staffId, date, serviceId, workplace) {
        return this.svc.slotsFor(staffId, date, serviceId, workplace);
    }
    shades(serviceId) {
        return this.svc.shadeOptions(serviceId);
    }
    async cancelWindow(staffId) {
        return { cancelWindowHours: await this.svc.cancelWindowHours(staffId) };
    }
    async demand(ctx, body) {
        await this.svc.submitDemand({ ...body, appUserId: ctx.session && !ctx.session.platform ? ctx.session.userId : undefined });
    }
    async callback(body) {
        await this.svc.requestCallback(body);
    }
};
__decorate([
    Get('catalog'),
    RateLimit({ bucket: 'public-catalog', limit: 120, windowSec: 60, by: 'ip' }),
    ApiOperation({ summary: 'Каталог мастеров с ближайшими окнами (F-00-108…112)' }),
    __param(0, Query('search')),
    __param(1, Query('sphere')),
    __param(2, Query('district')),
    __param(3, Query('workplace')),
    __param(4, Query('accepts')),
    __param(5, Query('material')),
    __param(6, Query('freeToday')),
    __param(7, Query('freeTomorrow')),
    __param(8, Query('lat', new Zod(num))),
    __param(9, Query('lng', new Zod(num))),
    __param(10, Query('businessId')),
    __param(11, Query('limit', new Zod(intOpt))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object, Object, Object, Object, Object, Object, Object, Object, Object, Object]),
    __metadata("design:returntype", void 0)
], PublicCatalogController.prototype, "catalog", null);
__decorate([
    Get('masters/:staffId'),
    RateLimit({ bucket: 'public-master-card', limit: 300, windowSec: 60, by: 'ip' }),
    ApiOperation({ summary: 'Карточка мастера (F-00-123)' }),
    __param(0, Ctx()),
    __param(1, Param('staffId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], PublicCatalogController.prototype, "masterCard", null);
__decorate([
    Get('places/:businessId'),
    RateLimit({ bucket: 'public-master-card', limit: 300, windowSec: 60, by: 'ip' }),
    ApiOperation({ summary: 'Карточка места/компании (F-14-028)' }),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], PublicCatalogController.prototype, "placeCard", null);
__decorate([
    Get('masters/:staffId/days'),
    RateLimit({ bucket: 'public-slots', limit: 300, windowSec: 60, by: 'ip' }),
    ApiOperation({ summary: 'Окна мастера на N дней по услуге (F-00-092)' }),
    __param(0, Param('staffId')),
    __param(1, Query('serviceId')),
    __param(2, Query('workplace')),
    __param(3, Query('days', new Zod(intOpt))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object, Object]),
    __metadata("design:returntype", void 0)
], PublicCatalogController.prototype, "days", null);
__decorate([
    Get('masters/:staffId/slots'),
    RateLimit({ bucket: 'public-slots', limit: 300, windowSec: 60, by: 'ip' }),
    ApiOperation({ summary: 'Окна мастера на дату (клиентский режим, 04 §5)' }),
    __param(0, Param('staffId')),
    __param(1, Query('date')),
    __param(2, Query('serviceId')),
    __param(3, Query('workplace')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object, Object]),
    __metadata("design:returntype", void 0)
], PublicCatalogController.prototype, "slots", null);
__decorate([
    Get('services/:serviceId/shades'),
    RateLimit({ bucket: 'public-slots', limit: 300, windowSec: 60, by: 'ip' }),
    ApiOperation({ summary: 'Варианты оттенка при записи (F-00-094…096) — со склада, пока честно пусто без него' }),
    __param(0, Param('serviceId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], PublicCatalogController.prototype, "shades", null);
__decorate([
    Get('masters/:staffId/cancel-window'),
    RateLimit({ bucket: 'public-slots', limit: 300, windowSec: 60, by: 'ip' }),
    ApiOperation({ summary: 'Часы бесплатной отмены у мастера (F-00-098)' }),
    __param(0, Param('staffId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], PublicCatalogController.prototype, "cancelWindow", null);
__decorate([
    Post('demand'),
    HttpCode(204),
    RateLimit({ bucket: 'public-demand', limit: 20, windowSec: 3600, by: 'ip' }),
    ApiOperation({ summary: '«Не нашли? Сообщить, когда появится» (F-00-112, F-00-180)' }),
    ZodBody(demandBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(demandBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], PublicCatalogController.prototype, "demand", null);
__decorate([
    Post('callback'),
    HttpCode(204),
    RateLimit({ bucket: 'public-callback', limit: 20, windowSec: 3600, by: 'ip' }),
    ApiOperation({ summary: '«Попросить перезвонить» (F-00-106)' }),
    ZodBody(callbackBody),
    __param(0, Body(new Zod(callbackBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], PublicCatalogController.prototype, "callback", null);
PublicCatalogController = __decorate([
    ApiTags('client'),
    Controller('v1/public'),
    __metadata("design:paramtypes", [CatalogService])
], PublicCatalogController);
export { PublicCatalogController };
//# sourceMappingURL=catalog.controller.js.map