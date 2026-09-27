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
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Platform } from '../../common/http/guards.js';
import { Zod } from '../../common/http/validation.js';
import { supportListQuery, supportReplyBody } from './platform.schemas.js';
import { PlatformSupportService } from './support.service.js';
/** Наша панель: единая очередь поддержки (F-00-182, docs/backend/02 §19). */
let PlatformSupportController = class PlatformSupportController {
    constructor(support) {
        this.support = support;
    }
    list(q) {
        return this.support.list(q);
    }
    reply(id, body) {
        return this.support.reply(id, body.text);
    }
    close(id) {
        return this.support.setStatus(id, 'closed');
    }
    reopen(id) {
        return this.support.setStatus(id, 'open');
    }
};
__decorate([
    Get(),
    Platform(),
    __param(0, Query(new Zod(supportListQuery))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], PlatformSupportController.prototype, "list", null);
__decorate([
    Post(':id/reply'),
    Platform(),
    __param(0, Param('id')),
    __param(1, Body(new Zod(supportReplyBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], PlatformSupportController.prototype, "reply", null);
__decorate([
    Post(':id/close'),
    Platform(),
    __param(0, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], PlatformSupportController.prototype, "close", null);
__decorate([
    Post(':id/reopen'),
    Platform(),
    __param(0, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], PlatformSupportController.prototype, "reopen", null);
PlatformSupportController = __decorate([
    ApiTags('platform-support'),
    Controller('v1/platform/support'),
    __metadata("design:paramtypes", [PlatformSupportService])
], PlatformSupportController);
export { PlatformSupportController };
//# sourceMappingURL=support.controller.js.map