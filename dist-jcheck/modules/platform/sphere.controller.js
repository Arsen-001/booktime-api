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
import { sphereCreateBody, sphereListQuery, sphereSaveBody } from './platform.schemas.js';
import { SphereRequestsService } from './sphere.service.js';
/** Наша панель: заявки на сферы (F-00-151/152, docs/backend/02 §19). */
let PlatformSphereController = class PlatformSphereController {
    constructor(sphere) {
        this.sphere = sphere;
    }
    list(q) {
        return this.sphere.list(q.kind);
    }
    create(body) {
        return this.sphere.create(body);
    }
    save(id, body) {
        return this.sphere.save(id, body);
    }
};
__decorate([
    Get(),
    Platform(),
    __param(0, Query(new Zod(sphereListQuery))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], PlatformSphereController.prototype, "list", null);
__decorate([
    Post(),
    Platform(),
    __param(0, Body(new Zod(sphereCreateBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], PlatformSphereController.prototype, "create", null);
__decorate([
    Put(':id'),
    Platform(),
    __param(0, Param('id')),
    __param(1, Body(new Zod(sphereSaveBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], PlatformSphereController.prototype, "save", null);
PlatformSphereController = __decorate([
    ApiTags('platform-sphere-requests'),
    Controller('v1/platform/sphere-requests'),
    __metadata("design:paramtypes", [SphereRequestsService])
], PlatformSphereController);
export { PlatformSphereController };
//# sourceMappingURL=sphere.controller.js.map