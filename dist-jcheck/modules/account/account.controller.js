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
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Authed, Ctx } from '../../common/http/guards.js';
import { ZodBody, ZodOk } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { ifMatch } from '../../common/http/version.js';
import { RateLimit } from '../../common/rate-limit/rate-limit.js';
import { codeSent } from '../auth/auth.schemas.js';
import { accountView, dataExportRow, loginEventRow, patchAccountBody, phoneCodeBody, phoneConfirmBody, pushTokenBody, pushTokenDeleteBody, sessionRow, twoFactorBody, } from './account.schemas.js';
import { AccountService } from './account.service.js';
/** Аккаунт вошедшего человека — /v1/me (docs/backend/02 §1) */
let AccountController = class AccountController {
    constructor(account) {
        this.account = account;
    }
    get(ctx) {
        return this.account.get(ctx.session.userId);
    }
    patch(ctx, req, body) {
        return this.account.patch(ctx, body, ifMatch(req));
    }
    requestDeletion(ctx) {
        return this.account.requestDeletion(ctx);
    }
    cancelDeletion(ctx) {
        return this.account.cancelDeletion(ctx);
    }
    requestDataExport(ctx) {
        return this.account.requestDataExport(ctx);
    }
    listDataExports(ctx) {
        return this.account.listDataExports(ctx);
    }
    requestDataBlock(ctx) {
        return this.account.requestDataBlock(ctx);
    }
    phoneCode(ctx, body) {
        return this.account.sendPhoneCode(ctx, body);
    }
    phoneConfirm(ctx, body) {
        return this.account.confirmPhone(ctx, body);
    }
    twoFactor(ctx, body) {
        return this.account.setTwoFactor(ctx, body.enabled);
    }
    consent(ctx) {
        return this.account.consent(ctx.session.userId);
    }
    acceptConsent(ctx) {
        return this.account.acceptConsent(ctx.session.userId);
    }
    sessions(ctx) {
        return this.account.listSessions(ctx);
    }
    async revoke(ctx, id) {
        await this.account.revokeSession(ctx, id);
    }
    loginEvents(ctx, limit) {
        return this.account.loginEvents(ctx, Number(limit) || 50);
    }
    async pushToken(ctx, body) {
        await this.account.savePushToken(ctx, body);
    }
    async deletePushToken(ctx, body) {
        await this.account.deletePushToken(ctx, body.token);
    }
};
__decorate([
    Get('account'),
    ApiOperation({ summary: 'Профиль, язык, крупный шрифт, 2FA, удаление (F-00-124, F-15-158)' }),
    ZodOk(accountView),
    __param(0, Ctx()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], AccountController.prototype, "get", null);
__decorate([
    Patch('account'),
    ApiOperation({ summary: 'Изменить профиль. If-Match: version — чужая правка между чтением и записью → 409' }),
    ZodBody(patchAccountBody),
    ZodOk(accountView),
    __param(0, Ctx()),
    __param(1, Req()),
    __param(2, Body(new Zod(patchAccountBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object]),
    __metadata("design:returntype", void 0)
], AccountController.prototype, "patch", null);
__decorate([
    Post('account/delete'),
    HttpCode(200),
    ApiOperation({ summary: 'Удалить аккаунт через 25 дней (можно отменить)' }),
    ZodOk(accountView),
    __param(0, Ctx()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], AccountController.prototype, "requestDeletion", null);
__decorate([
    Post('account/delete/cancel'),
    HttpCode(200),
    ApiOperation({ summary: 'Отменить удаление аккаунта' }),
    ZodOk(accountView),
    __param(0, Ctx()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], AccountController.prototype, "cancelDeletion", null);
__decorate([
    Post('account/data-export'),
    HttpCode(200),
    ApiOperation({ summary: 'Выгрузить мои данные (F-15-154) — не чаще раза в сутки' }),
    ZodOk(dataExportRow),
    __param(0, Ctx()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], AccountController.prototype, "requestDataExport", null);
__decorate([
    Get('account/data-exports'),
    ApiOperation({ summary: 'История заявок на выгрузку (F-15-154), новые сверху' }),
    ZodOk(z.array(dataExportRow)),
    __param(0, Ctx()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], AccountController.prototype, "listDataExports", null);
__decorate([
    Post('account/data-block'),
    HttpCode(200),
    ApiOperation({ summary: 'Запрос на блокировку данных (F-15-155) — заявка, не мгновенное действие' }),
    ZodOk(accountView),
    __param(0, Ctx()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], AccountController.prototype, "requestDataBlock", null);
__decorate([
    Post('account/phone/code'),
    HttpCode(200),
    RateLimit({ bucket: 'phone-change', limit: 10, windowSec: 3600, by: 'session' }),
    ApiOperation({ summary: 'Смена номера: код на новый номер (F-15-149)' }),
    ZodBody(phoneCodeBody),
    ZodOk(codeSent),
    __param(0, Ctx()),
    __param(1, Body(new Zod(phoneCodeBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], AccountController.prototype, "phoneCode", null);
__decorate([
    Post('account/phone/confirm'),
    HttpCode(200),
    ApiOperation({ summary: 'Смена номера: подтвердить код' }),
    ZodBody(phoneConfirmBody),
    ZodOk(accountView),
    __param(0, Ctx()),
    __param(1, Body(new Zod(phoneConfirmBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], AccountController.prototype, "phoneConfirm", null);
__decorate([
    Put('security/two-factor'),
    ApiOperation({ summary: 'Двухэтапная проверка входа по паролю (F-15-159)' }),
    ZodBody(twoFactorBody),
    ZodOk(accountView),
    __param(0, Ctx()),
    __param(1, Body(new Zod(twoFactorBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], AccountController.prototype, "twoFactor", null);
__decorate([
    Get('consent'),
    ApiOperation({ summary: 'Принято ли пользовательское соглашение (F-14-008)' }),
    __param(0, Ctx()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], AccountController.prototype, "consent", null);
__decorate([
    Post('consent'),
    HttpCode(200),
    ApiOperation({ summary: 'Принять соглашение (человек вошёл как бизнес и открыл приложение клиента)' }),
    __param(0, Ctx()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], AccountController.prototype, "acceptConsent", null);
__decorate([
    Get('sessions'),
    ApiOperation({ summary: 'Устройства, где открыт вход' }),
    ZodOk(z.array(sessionRow)),
    __param(0, Ctx()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], AccountController.prototype, "sessions", null);
__decorate([
    Delete('sessions/:id'),
    HttpCode(204),
    ApiOperation({ summary: 'Закрыть вход на одном устройстве' }),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], AccountController.prototype, "revoke", null);
__decorate([
    Get('login-events'),
    ApiOperation({ summary: 'Журнал входов (F-10-106, F-15-159), новые сверху' }),
    ZodOk(z.array(loginEventRow)),
    __param(0, Ctx()),
    __param(1, Query('limit')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], AccountController.prototype, "loginEvents", null);
__decorate([
    Post('push-tokens'),
    HttpCode(204),
    ApiOperation({ summary: 'Сохранить токен пуша (Web Push / FCM)' }),
    ZodBody(pushTokenBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(pushTokenBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AccountController.prototype, "pushToken", null);
__decorate([
    Delete('push-tokens'),
    HttpCode(204),
    ApiOperation({ summary: 'Удалить токен пуша (выход, отказ от пушей)' }),
    ZodBody(pushTokenDeleteBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(pushTokenDeleteBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AccountController.prototype, "deletePushToken", null);
AccountController = __decorate([
    ApiTags('account'),
    Controller('v1/me'),
    Authed(),
    __metadata("design:paramtypes", [AccountService])
], AccountController);
export { AccountController };
//# sourceMappingURL=account.controller.js.map