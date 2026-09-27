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
import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Biz, Ctx, Platform } from '../../common/http/guards.js';
import { Zod } from '../../common/http/validation.js';
import { ideaCreateBody, ideaStatusBody } from './platform.schemas.js';
import { IdeasService } from './ideas.service.js';
/** Кабинет: «Предложить идею» и голос — любой сотрудник (F-00-009) */
let BizIdeasController = class BizIdeasController {
    constructor(ideas) {
        this.ideas = ideas;
    }
    create(ctx, businessId, body) {
        return this.ideas.create(businessId, ctx.member.name, body.text);
    }
    vote(businessId, id) {
        return this.ideas.vote(id, businessId);
    }
};
__decorate([
    Post(),
    Biz(),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(ideaCreateBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], BizIdeasController.prototype, "create", null);
__decorate([
    Post(':id/vote'),
    Biz(),
    __param(0, Param('businessId')),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], BizIdeasController.prototype, "vote", null);
BizIdeasController = __decorate([
    ApiTags('ideas'),
    Controller('v1/biz/:businessId/ideas'),
    __metadata("design:paramtypes", [IdeasService])
], BizIdeasController);
export { BizIdeasController };
/** Наша панель: очередь идей (F-00-009) */
let PlatformIdeasController = class PlatformIdeasController {
    constructor(ideas) {
        this.ideas = ideas;
    }
    list() {
        return this.ideas.list();
    }
    setStatus(id, body) {
        return this.ideas.setStatus(id, body.status);
    }
};
__decorate([
    Get(),
    Platform(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], PlatformIdeasController.prototype, "list", null);
__decorate([
    Post(':id/status'),
    Platform(),
    __param(0, Param('id')),
    __param(1, Body(new Zod(ideaStatusBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], PlatformIdeasController.prototype, "setStatus", null);
PlatformIdeasController = __decorate([
    ApiTags('platform-ideas'),
    Controller('v1/platform/ideas'),
    __metadata("design:paramtypes", [IdeasService])
], PlatformIdeasController);
export { PlatformIdeasController };
//# sourceMappingURL=ideas.controller.js.map