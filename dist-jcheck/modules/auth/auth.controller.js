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
import { Body, Controller, Get, HttpCode, Post, Put, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Authed, Ctx } from '../../common/http/guards.js';
import { ZodBody, ZodOk } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { RateLimit } from '../../common/rate-limit/rate-limit.js';
import { challengeBody, changePasswordBody, codeSent, logoutAllBody, modeBody, passwordBody, platformView, secondFactor, sendCodeBody, sessionOrGuest, sessionView, verifyCodeBody, } from './auth.schemas.js';
import { AuthService } from './auth.service.js';
/** Вход и сессии — /v1/auth (docs/backend/02 §1, 05 §6, PLAN Р8/Р11) */
let AuthController = class AuthController {
    constructor(auth) {
        this.auth = auth;
    }
    async session(ctx) {
        if (!ctx.session)
            return { session: null };
        return { session: await this.auth.view(ctx.session.sessionId) };
    }
    sendCode(ctx, body) {
        return this.auth.sendCode(ctx, body);
    }
    verify(ctx, res, body) {
        return this.auth.verifyCode(ctx, res, body);
    }
    password(ctx, res, body) {
        return this.auth.passwordLogin(ctx, res, body);
    }
    secondFactor(ctx, res, body) {
        return this.auth.secondFactor(ctx, res, body);
    }
    async changePassword(ctx, body) {
        await this.auth.changePassword(ctx, body);
    }
    mode(ctx, body) {
        return this.auth.setMode(ctx, body);
    }
    async logout(ctx, res) {
        await this.auth.logout(ctx, res, false);
    }
    logoutAll(ctx, res, body) {
        return this.auth.logoutAll(ctx, res, body.keepCurrent);
    }
    // ─────────── команда платформы (Р11) — своя cookie ───────────
    platformLogin(ctx, body) {
        return this.auth.platformLogin(ctx, body);
    }
    platformVerify(ctx, res, body) {
        return this.auth.platformVerify(ctx, res, body);
    }
    async platformSession(ctx) {
        if (!ctx.session?.platform)
            return { session: null };
        return { session: await this.auth.platformView(ctx.session.sessionId) };
    }
    async platformLogout(ctx, res) {
        await this.auth.logout(ctx, res, true);
    }
};
__decorate([
    Get('session'),
    ApiOperation({ summary: 'Кто вошёл: сессия или { session: null } для гостя' }),
    ZodOk(sessionOrGuest),
    __param(0, Ctx()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "session", null);
__decorate([
    Post('code'),
    HttpCode(200),
    RateLimit({ bucket: 'auth-code-ip', limit: 30, windowSec: 600, by: 'ip' }),
    ApiOperation({ summary: 'Отправить код входа (4 цифры, 5 мин, повтор через 60 с). Ответ одинаков для любого номера.' }),
    ZodBody(sendCodeBody),
    ZodOk(codeSent),
    __param(0, Ctx()),
    __param(1, Body(new Zod(sendCodeBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], AuthController.prototype, "sendCode", null);
__decorate([
    Post('verify'),
    HttpCode(200),
    RateLimit({ bucket: 'auth-verify-ip', limit: 40, windowSec: 600, by: 'ip' }),
    ApiOperation({ summary: 'Проверить код и войти (клиент или кабинет бизнеса). Ставит httpOnly cookie сессии.' }),
    ZodBody(verifyCodeBody),
    ZodOk(sessionView),
    __param(0, Ctx()),
    __param(1, Res({ passthrough: true })),
    __param(2, Body(new Zod(verifyCodeBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object]),
    __metadata("design:returntype", void 0)
], AuthController.prototype, "verify", null);
__decorate([
    Post('password'),
    HttpCode(200),
    RateLimit({ bucket: 'auth-password-ip', limit: 30, windowSec: 600, by: 'ip' }),
    ApiOperation({ summary: 'Вход администратора логином и паролем (F-00-034). Если включён второй шаг — { secondFactor }.' }),
    ZodBody(passwordBody),
    __param(0, Ctx()),
    __param(1, Res({ passthrough: true })),
    __param(2, Body(new Zod(passwordBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object]),
    __metadata("design:returntype", void 0)
], AuthController.prototype, "password", null);
__decorate([
    Post('second-factor'),
    HttpCode(200),
    RateLimit({ bucket: 'auth-verify-ip', limit: 40, windowSec: 600, by: 'ip' }),
    ApiOperation({ summary: 'Второй шаг входа по паролю: код на телефон (F-15-159)' }),
    ZodBody(challengeBody),
    ZodOk(sessionView),
    __param(0, Ctx()),
    __param(1, Res({ passthrough: true })),
    __param(2, Body(new Zod(challengeBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object]),
    __metadata("design:returntype", void 0)
], AuthController.prototype, "secondFactor", null);
__decorate([
    Post('password/change'),
    HttpCode(204),
    Authed(),
    ApiOperation({ summary: 'Сменить пароль администратора; при первом входе старый не нужен (F-00-034)' }),
    ZodBody(changePasswordBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(changePasswordBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "changePassword", null);
__decorate([
    Put('mode'),
    Authed(),
    ApiOperation({ summary: 'Переключатель «Я клиент / Мой бизнес» (В-21)' }),
    ZodBody(modeBody),
    ZodOk(sessionView),
    __param(0, Ctx()),
    __param(1, Body(new Zod(modeBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], AuthController.prototype, "mode", null);
__decorate([
    Post('logout'),
    HttpCode(204),
    ApiOperation({ summary: 'Выйти на этом устройстве' }),
    __param(0, Ctx()),
    __param(1, Res({ passthrough: true })),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "logout", null);
__decorate([
    Post('logout-all'),
    HttpCode(200),
    Authed(),
    ApiOperation({ summary: '«Завершить все сеансы» (F-15-152, F-10-125); keepCurrent — кроме этого устройства' }),
    ZodBody(logoutAllBody),
    __param(0, Ctx()),
    __param(1, Res({ passthrough: true })),
    __param(2, Body(new Zod(logoutAllBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object]),
    __metadata("design:returntype", void 0)
], AuthController.prototype, "logoutAll", null);
__decorate([
    Post('platform/login'),
    HttpCode(200),
    RateLimit({ bucket: 'auth-platform-ip', limit: 10, windowSec: 600, by: 'ip' }),
    ApiOperation({ summary: 'Панель: логин + пароль → код на телефон (всегда второй шаг)' }),
    ZodBody(passwordBody),
    ZodOk(secondFactor),
    __param(0, Ctx()),
    __param(1, Body(new Zod(passwordBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], AuthController.prototype, "platformLogin", null);
__decorate([
    Post('platform/verify'),
    HttpCode(200),
    RateLimit({ bucket: 'auth-platform-ip', limit: 10, windowSec: 600, by: 'ip' }),
    ApiOperation({ summary: 'Панель: код второго шага → сессия платформы' }),
    ZodBody(challengeBody),
    ZodOk(platformView),
    __param(0, Ctx()),
    __param(1, Res({ passthrough: true })),
    __param(2, Body(new Zod(challengeBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object]),
    __metadata("design:returntype", void 0)
], AuthController.prototype, "platformVerify", null);
__decorate([
    Get('platform/session'),
    ApiOperation({ summary: 'Панель: кто вошёл ({ session: null } — не вошёл)' }),
    __param(0, Ctx()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "platformSession", null);
__decorate([
    Post('platform/logout'),
    HttpCode(204),
    ApiOperation({ summary: 'Панель: выйти' }),
    __param(0, Ctx()),
    __param(1, Res({ passthrough: true })),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "platformLogout", null);
AuthController = __decorate([
    ApiTags('auth'),
    Controller('v1/auth'),
    __metadata("design:paramtypes", [AuthService])
], AuthController);
export { AuthController };
//# sourceMappingURL=auth.controller.js.map