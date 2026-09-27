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
import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Platform } from '../../common/http/guards.js';
import { Zod } from '../../common/http/validation.js';
import { completeCallbackBody, visitInputBody, visitListQuery, visitPatchBody } from './platform.schemas.js';
import { VisitsService } from './visits.service.js';
/** Наша панель: учёт визитов (F-00-177, docs/backend/02 §19). */
let PlatformVisitsController = class PlatformVisitsController {
    constructor(visits) {
        this.visits = visits;
    }
    list(q) {
        return this.visits.list(q);
    }
    counts() {
        return this.visits.counts();
    }
    callbacksToday() {
        return this.visits.listCallbacksToday();
    }
    create(body) {
        return this.visits.create(body);
    }
    update(id, body) {
        return this.visits.update(id, body);
    }
    completeCallback(id, body) {
        return this.visits.completeCallback(id, body.note);
    }
};
__decorate([
    Get(),
    Platform(),
    __param(0, Query(new Zod(visitListQuery))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], PlatformVisitsController.prototype, "list", null);
__decorate([
    Get('counts'),
    Platform(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], PlatformVisitsController.prototype, "counts", null);
__decorate([
    Get('callbacks-today'),
    Platform(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], PlatformVisitsController.prototype, "callbacksToday", null);
__decorate([
    Post(),
    Platform(),
    __param(0, Body(new Zod(visitInputBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], PlatformVisitsController.prototype, "create", null);
__decorate([
    Put(':id'),
    Platform(),
    __param(0, Param('id')),
    __param(1, Body(new Zod(visitPatchBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], PlatformVisitsController.prototype, "update", null);
__decorate([
    Post(':id/callback-done'),
    Platform(),
    __param(0, Param('id')),
    __param(1, Body(new Zod(completeCallbackBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], PlatformVisitsController.prototype, "completeCallback", null);
PlatformVisitsController = __decorate([
    ApiTags('platform-visits'),
    Controller('v1/platform/visits'),
    __metadata("design:paramtypes", [VisitsService])
], PlatformVisitsController);
export { PlatformVisitsController };
//# sourceMappingURL=visits.controller.js.map