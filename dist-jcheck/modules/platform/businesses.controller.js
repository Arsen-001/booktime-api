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
import { Ctx, Platform } from '../../common/http/guards.js';
import { Zod } from '../../common/http/validation.js';
import { adsOptInBody, exportBody, exportQuery, markLeftBody } from './platform.schemas.js';
import { PlatformBusinessesService } from './businesses.service.js';
/** Наша панель: бизнесы, копии данных, выгрузка при уходе, согласие на рекламу (docs/backend/02 §19, 06 §6). */
let PlatformBusinessesController = class PlatformBusinessesController {
    constructor(businesses) {
        this.businesses = businesses;
    }
    overview() {
        return this.businesses.overview();
    }
    visitConnected() {
        return this.businesses.listVisitBusinesses();
    }
    setAdsOptIn(id, body) {
        return this.businesses.setAdsOptIn(id, body.optIn);
    }
    backups(id) {
        return this.businesses.listBackupCopies(id);
    }
    makeBackup(id) {
        return this.businesses.makeBackupCopy(id);
    }
    export(ctx, id, q, body) {
        return this.businesses.exportBusinessData(id, q.what, body.headers, ctx.session.userId, 'platform');
    }
    markLeft(id, body) {
        return this.businesses.markLeft(id, body.dataHanded);
    }
};
__decorate([
    Get(),
    Platform(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], PlatformBusinessesController.prototype, "overview", null);
__decorate([
    Get('visit-connected'),
    Platform(),
    ApiOperation({ summary: 'Подключённые на визите — только им можно выдать бесплатный месяц вручную (F-00-019)' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], PlatformBusinessesController.prototype, "visitConnected", null);
__decorate([
    Post(':id/ads-opt-in'),
    Platform(),
    HttpCode(204),
    __param(0, Param('id')),
    __param(1, Body(new Zod(adsOptInBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], PlatformBusinessesController.prototype, "setAdsOptIn", null);
__decorate([
    Get(':id/backups'),
    Platform(),
    __param(0, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], PlatformBusinessesController.prototype, "backups", null);
__decorate([
    Post(':id/backups'),
    Platform(),
    __param(0, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], PlatformBusinessesController.prototype, "makeBackup", null);
__decorate([
    Post(':id/export'),
    Platform(),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Query(new Zod(exportQuery))),
    __param(3, Body(new Zod(exportBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object, Object]),
    __metadata("design:returntype", void 0)
], PlatformBusinessesController.prototype, "export", null);
__decorate([
    Post(':id/leave'),
    Platform(),
    HttpCode(204),
    __param(0, Param('id')),
    __param(1, Body(new Zod(markLeftBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], PlatformBusinessesController.prototype, "markLeft", null);
PlatformBusinessesController = __decorate([
    ApiTags('platform-businesses'),
    Controller('v1/platform/businesses'),
    __metadata("design:paramtypes", [PlatformBusinessesService])
], PlatformBusinessesController);
export { PlatformBusinessesController };
//# sourceMappingURL=businesses.controller.js.map