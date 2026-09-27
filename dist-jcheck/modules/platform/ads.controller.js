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
import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Platform } from '../../common/http/guards.js';
import { RateLimit } from '../../common/rate-limit/rate-limit.js';
import { Zod } from '../../common/http/validation.js';
import { AdsService } from './ads.service.js';
import { adContextQuery, adInputBody, adListQuery, adPauseBody, stockOfferQuery } from './platform.schemas.js';
/** Наша панель: реклама (F-00-163…166, docs/backend/02 §19). */
let PlatformAdsController = class PlatformAdsController {
    constructor(ads) {
        this.ads = ads;
    }
    placements() {
        return this.ads.listPlacements();
    }
    list(q) {
        return this.ads.list(q.kind);
    }
    create(body) {
        return this.ads.create(body);
    }
    pause(id, body) {
        return this.ads.setPaused(id, body.paused);
    }
    reach() {
        return this.ads.reach();
    }
};
__decorate([
    Get('ad-placements'),
    Platform(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], PlatformAdsController.prototype, "placements", null);
__decorate([
    Get('ads'),
    Platform(),
    __param(0, Query(new Zod(adListQuery))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], PlatformAdsController.prototype, "list", null);
__decorate([
    Post('ads'),
    Platform(),
    __param(0, Body(new Zod(adInputBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], PlatformAdsController.prototype, "create", null);
__decorate([
    Put('ads/:id/pause'),
    Platform(),
    __param(0, Param('id')),
    __param(1, Body(new Zod(adPauseBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], PlatformAdsController.prototype, "pause", null);
__decorate([
    Get('ads/reach'),
    Platform(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], PlatformAdsController.prototype, "reach", null);
PlatformAdsController = __decorate([
    ApiTags('platform-ads'),
    Controller('v1/platform'),
    __metadata("design:paramtypes", [AdsService])
], PlatformAdsController);
export { PlatformAdsController };
/** Показ рекламы клиенту/кабинету и учёт показов/нажатий — без входа, только чтение и счётчики (P10 07-mock-only). */
let PublicAdsController = class PublicAdsController {
    constructor(ads) {
        this.ads = ads;
    }
    active(q) {
        return this.ads.getActive(q.placement, { date: q.date, businessId: q.businessId, district: q.district, sphereId: q.sphere });
    }
    stockOffer(q) {
        return this.ads.getStockOffer(q.businessId, q.product).then((r) => r ?? null);
    }
    impression(id) {
        return this.ads.trackImpression(id);
    }
    click(id) {
        return this.ads.trackClick(id);
    }
};
__decorate([
    Get(),
    RateLimit({ bucket: 'public-ads', limit: 120, windowSec: 60, by: 'ip' }),
    __param(0, Query(new Zod(adContextQuery))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], PublicAdsController.prototype, "active", null);
__decorate([
    Get('stock-offer'),
    RateLimit({ bucket: 'public-ads', limit: 120, windowSec: 60, by: 'ip' }),
    __param(0, Query(new Zod(stockOfferQuery))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], PublicAdsController.prototype, "stockOffer", null);
__decorate([
    Post(':id/impression'),
    HttpCode(204),
    RateLimit({ bucket: 'public-ads-track', limit: 300, windowSec: 60, by: 'ip' }),
    __param(0, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], PublicAdsController.prototype, "impression", null);
__decorate([
    Post(':id/click'),
    HttpCode(204),
    RateLimit({ bucket: 'public-ads-track', limit: 300, windowSec: 60, by: 'ip' }),
    __param(0, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], PublicAdsController.prototype, "click", null);
PublicAdsController = __decorate([
    ApiTags('ads'),
    Controller('v1/public/ads'),
    __metadata("design:paramtypes", [AdsService])
], PublicAdsController);
export { PublicAdsController };
//# sourceMappingURL=ads.controller.js.map