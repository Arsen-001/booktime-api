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
import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Ctx, Platform } from '../../common/http/guards.js';
import { Zod } from '../../common/http/validation.js';
import { DemandService } from './demand.service.js';
import { demandQuery, firstAwardBody } from './platform.schemas.js';
/** Наша панель: спрос без предложения и «первый в районе/сфере» (F-00-180/181, docs/backend/02 §19). */
let PlatformDemandController = class PlatformDemandController {
    constructor(demand) {
        this.demand = demand;
    }
    report(q) {
        return this.demand.getReport(q.period);
    }
    candidates() {
        return this.demand.listFirstCandidates();
    }
    grant(ctx, body) {
        return this.demand.grantFirstAward(ctx.session.userId, body);
    }
};
__decorate([
    Get('demand'),
    Platform(),
    __param(0, Query(new Zod(demandQuery))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], PlatformDemandController.prototype, "report", null);
__decorate([
    Get('first-candidates'),
    Platform(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], PlatformDemandController.prototype, "candidates", null);
__decorate([
    Post('first-awards'),
    Platform(),
    __param(0, Ctx()),
    __param(1, Body(new Zod(firstAwardBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], PlatformDemandController.prototype, "grant", null);
PlatformDemandController = __decorate([
    ApiTags('platform-demand'),
    Controller('v1/platform'),
    __metadata("design:paramtypes", [DemandService])
], PlatformDemandController);
export { PlatformDemandController };
//# sourceMappingURL=demand.controller.js.map