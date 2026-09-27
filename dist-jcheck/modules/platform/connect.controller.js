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
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Idempotent } from '../../common/idempotency/idempotency.js';
import { Ctx, Platform } from '../../common/http/guards.js';
import { Zod } from '../../common/http/validation.js';
import { ConnectService } from './connect.service.js';
import { connectDraftPatchBody, connectFinishBody, connectInviteInputBody, connectStartBody } from './platform.schemas.js';
/** Наша панель: подключение салона на визите за 10 минут (docs/backend/02 §19, 06 §1; F-00-176). */
let PlatformConnectController = class PlatformConnectController {
    constructor(connect) {
        this.connect = connect;
    }
    list() {
        return this.connect.list();
    }
    get(id) {
        return this.connect.get(id);
    }
    start(ctx, body) {
        return this.connect.start(ctx, body);
    }
    save(id, body) {
        return this.connect.save(id, body);
    }
    delete(id) {
        return this.connect.delete(id);
    }
    addInvite(id, body) {
        return this.connect.addInvite(id, body);
    }
    removeInvite(id, inviteId) {
        return this.connect.removeInvite(id, inviteId);
    }
    finish(ctx, id, body) {
        return this.connect.finish(ctx, id, body);
    }
};
__decorate([
    Get(),
    Platform(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], PlatformConnectController.prototype, "list", null);
__decorate([
    Get(':id'),
    Platform(),
    __param(0, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], PlatformConnectController.prototype, "get", null);
__decorate([
    Post(),
    Platform(),
    ApiOperation({ summary: 'Новый черновик; из карточки визита — сразу с его названием/контактом/районом/сферой' }),
    __param(0, Ctx()),
    __param(1, Body(new Zod(connectStartBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], PlatformConnectController.prototype, "start", null);
__decorate([
    Put(':id'),
    Platform(),
    ApiOperation({ summary: 'Сохранить поля шага; смена сферы подставляет её услуги, все отмечены' }),
    __param(0, Param('id')),
    __param(1, Body(new Zod(connectDraftPatchBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], PlatformConnectController.prototype, "save", null);
__decorate([
    Delete(':id'),
    Platform(),
    HttpCode(204),
    __param(0, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], PlatformConnectController.prototype, "delete", null);
__decorate([
    Post(':id/invites'),
    Platform(),
    __param(0, Param('id')),
    __param(1, Body(new Zod(connectInviteInputBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], PlatformConnectController.prototype, "addInvite", null);
__decorate([
    Delete(':id/invites/:inviteId'),
    Platform(),
    __param(0, Param('id')),
    __param(1, Param('inviteId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], PlatformConnectController.prototype, "removeInvite", null);
__decorate([
    Post(':id/finish'),
    Platform(),
    Idempotent(),
    ApiOperation({ summary: 'Подключить: бизнес+филиал+владелец+мастера+услуги+часы+фото+бесплатный месяц+промокод одной транзакцией' }),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body(new Zod(connectFinishBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], PlatformConnectController.prototype, "finish", null);
PlatformConnectController = __decorate([
    ApiTags('platform-connect'),
    Controller('v1/platform/connect-drafts'),
    __metadata("design:paramtypes", [ConnectService])
], PlatformConnectController);
export { PlatformConnectController };
/** Итог подключения для экрана «передать владельцу» — переживает перезагрузку (`?done=<businessId>`) */
let PlatformConnectResultController = class PlatformConnectResultController {
    constructor(connect) {
        this.connect = connect;
    }
    result(businessId) {
        return this.connect.getResult(businessId);
    }
};
__decorate([
    Get(':businessId'),
    Platform(),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], PlatformConnectResultController.prototype, "result", null);
PlatformConnectResultController = __decorate([
    ApiTags('platform-connect'),
    Controller('v1/platform/connect-result'),
    __metadata("design:paramtypes", [ConnectService])
], PlatformConnectResultController);
export { PlatformConnectResultController };
//# sourceMappingURL=connect.controller.js.map