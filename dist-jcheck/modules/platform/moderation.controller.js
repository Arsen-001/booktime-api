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
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Authed, Biz, Ctx, Platform } from '../../common/http/guards.js';
import { Zod } from '../../common/http/validation.js';
import { moderationListQuery, moderationSubmitBody, rejectBody, rejectReasonBody } from './platform.schemas.js';
import { ModerationService } from './moderation.service.js';
/** Наша панель: очередь проверки (docs/backend/02 §19, 06 §1). */
let PlatformModerationController = class PlatformModerationController {
    constructor(moderation) {
        this.moderation = moderation;
    }
    list(q) {
        return this.moderation.list(q);
    }
    counts() {
        return this.moderation.counts();
    }
    approve(id) {
        return this.moderation.approve(id);
    }
    reject(ctx, id, body) {
        return this.moderation.reject(id, body.reasonId, body.note, ctx.session.userId);
    }
    reopen(ctx, id) {
        return this.moderation.reopen(id, ctx.session.userId);
    }
    reasons(all) {
        return this.moderation.listReasons(all === '1' || all === 'true');
    }
    saveReason(body) {
        return this.moderation.saveReason(body);
    }
    hideReason(id) {
        return this.moderation.hideReason(id);
    }
};
__decorate([
    Get('moderation'),
    Platform(),
    __param(0, Query(new Zod(moderationListQuery))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], PlatformModerationController.prototype, "list", null);
__decorate([
    Get('moderation/counts'),
    Platform(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], PlatformModerationController.prototype, "counts", null);
__decorate([
    Post('moderation/:id/approve'),
    Platform(),
    __param(0, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], PlatformModerationController.prototype, "approve", null);
__decorate([
    Post('moderation/:id/reject'),
    Platform(),
    ApiOperation({ summary: 'Отклонить с причиной (F-00-170) — платное возвращает монеты' }),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body(new Zod(rejectBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], PlatformModerationController.prototype, "reject", null);
__decorate([
    Post('moderation/:id/reopen'),
    Platform(),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], PlatformModerationController.prototype, "reopen", null);
__decorate([
    Get('reject-reasons'),
    Platform(),
    __param(0, Query('all')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], PlatformModerationController.prototype, "reasons", null);
__decorate([
    Put('reject-reasons'),
    Platform(),
    __param(0, Body(new Zod(rejectReasonBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], PlatformModerationController.prototype, "saveReason", null);
__decorate([
    Post('reject-reasons/:id/hide'),
    Platform(),
    HttpCode(204),
    __param(0, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], PlatformModerationController.prototype, "hideReason", null);
PlatformModerationController = __decorate([
    ApiTags('platform-moderation'),
    Controller('v1/platform'),
    __metadata("design:paramtypes", [ModerationService])
], PlatformModerationController);
export { PlatformModerationController };
/** Кабинет бизнеса: отправить материал на проверку (F-00-168…170) — любой сотрудник, без права */
let BizModerationController = class BizModerationController {
    constructor(moderation) {
        this.moderation = moderation;
    }
    submit(businessId, body) {
        return this.moderation.submit({ ...body, businessId });
    }
};
__decorate([
    Post('submit'),
    Biz(),
    __param(0, Param('businessId')),
    __param(1, Body(new Zod(moderationSubmitBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], BizModerationController.prototype, "submit", null);
BizModerationController = __decorate([
    ApiTags('moderation'),
    Controller('v1/biz/:businessId/moderation'),
    __metadata("design:paramtypes", [ModerationService])
], BizModerationController);
export { BizModerationController };
/**
 * Узнать статус по refId (F-00-168…170) — мок зовёт getModerationStatus/isVisibleToClients без businessId
 * (refId сам по себе ключ вызывающей стороны), поэтому маршрут не под /v1/biz/{b}/: любой вошедший сотрудник
 * кабинета может спросить статус своего же материала, без арендатора в пути.
 */
let ModerationStatusController = class ModerationStatusController {
    constructor(moderation) {
        this.moderation = moderation;
    }
    status(refId) {
        return this.moderation.getStatus(refId);
    }
    async visible(refId) {
        return { visible: await this.moderation.isVisibleToClients(refId) };
    }
};
__decorate([
    Get('status/:refId'),
    Authed(),
    __param(0, Param('refId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], ModerationStatusController.prototype, "status", null);
__decorate([
    Get('visible/:refId'),
    Authed(),
    __param(0, Param('refId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], ModerationStatusController.prototype, "visible", null);
ModerationStatusController = __decorate([
    ApiTags('moderation'),
    Controller('v1/moderation'),
    __metadata("design:paramtypes", [ModerationService])
], ModerationStatusController);
export { ModerationStatusController };
//# sourceMappingURL=moderation.controller.js.map