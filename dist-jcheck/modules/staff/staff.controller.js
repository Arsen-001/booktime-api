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
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../common/errors/api-error.js';
import { Biz, Ctx } from '../../common/http/guards.js';
import { ZodBody, ZodOk } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { ifMatch } from '../../common/http/version.js';
import { Idempotent } from '../../common/idempotency/idempotency.js';
import { staffOut } from '../businesses/business.schemas.js';
import { accessBody, accessInfoBody, accessOut, addStaffBody, addStaffOut, deletedOut, dismissalOut, dismissBody, inviteOut, ipBody, jsonBody, loginBody, orderBody, patchStaffBody, positionBody, positionOut, positionRowOut, reissueOut, rightsBody, rightsOut, roleTemplateBody, scopesBody, staffRowOut, transferAccessBody, transferOwnerBody, } from './staff.schemas.js';
import { StaffService } from './staff.service.js';
/** Сотрудники, доступ, права, должности — /v1/biz/{b}/staff (docs/backend/02 §7) */
let StaffController = class StaffController {
    constructor(staff) {
        this.staff = staff;
    }
    // ─────────── список и добавление ───────────
    list(b) {
        return this.staff.list(b);
    }
    add(ctx, b, body) {
        return this.staff.add(ctx, b, body);
    }
    async reorder(ctx, b, body) {
        await this.staff.reorder(ctx, b, body.ids);
    }
    deleted(b) {
        return this.staff.listDeleted(b);
    }
    async transferAccess(ctx, b, body) {
        await this.staff.transferAccess(ctx, b, body);
    }
    positions(b) {
        return this.staff.positions(b);
    }
    addPosition(ctx, b, body) {
        return this.staff.addPosition(ctx, b, body);
    }
    renamePosition(ctx, b, p, body) {
        return this.staff.renamePosition(ctx, b, p, body);
    }
    async removePosition(ctx, b, p) {
        await this.staff.removePosition(ctx, b, p);
    }
    // ─────────── карточка ───────────
    get(b, s) {
        return this.staff.get(b, s);
    }
    patch(ctx, req, b, s, body) {
        return this.staff.patch(ctx, b, s, body, ifMatch(req));
    }
    fire(ctx, b, s, body) {
        return this.staff.dismiss(ctx, b, s, body);
    }
    dismissal(b, s) {
        return this.staff.dismissal(b, s);
    }
    restore(ctx, b, s) {
        return this.staff.restore(ctx, b, s);
    }
    async remove(ctx, b, s) {
        await this.staff.remove(ctx, b, s);
    }
    undelete(ctx, b, s) {
        return this.staff.undelete(ctx, b, s);
    }
    // ─────────── доступ ───────────
    access(b, s) {
        return this.staff.access(b, s);
    }
    setAccess(ctx, b, s, body) {
        return this.staff.setAccessEnabled(ctx, b, s, body.enabled);
    }
    disable(ctx, b, s) {
        return this.staff.setAccessEnabled(ctx, b, s, false);
    }
    setAccessInfo(ctx, b, s, body) {
        return this.staff.setAccessInfo(ctx, b, s, body.info);
    }
    setRoleTemplate(ctx, b, s, body) {
        return this.staff.setRoleTemplate(ctx, b, s, body.roleTemplateId);
    }
    setIp(ctx, b, s, body) {
        return this.staff.setIpRestriction(ctx, b, s, body);
    }
    setLogin(ctx, b, s, body) {
        return this.staff.setLogin(ctx, b, s, body);
    }
    reissue(ctx, b, s) {
        return this.staff.reissueInvite(ctx, b, s);
    }
    revokeInvite(ctx, b, s) {
        return this.staff.revokeInvite(ctx, b, s);
    }
    async transferOwnership(ctx, b, s, body) {
        await this.staff.transferOwnership(ctx, b, s, body.toStaffId);
    }
    // ─────────── права ───────────
    rights(b, s) {
        return this.staff.rights(b, s);
    }
    setRights(ctx, b, s, body) {
        return this.staff.setRights(ctx, b, s, body);
    }
    async setScopes(ctx, b, s, body) {
        await this.staff.setRightScopes(ctx, b, s, body.scopes);
    }
    // ─────────── вкладки: юр. данные (только staff.manage), настройки карточки, пуши мастера ───────────
    getTab(ctx, b, s, tab) {
        return this.staff.getJson(b, s, tabField(ctx, s, tab, 'read'));
    }
    setTab(ctx, b, s, tab, body) {
        return this.staff.setJson(ctx, b, s, tabField(ctx, s, tab, 'write'), body.value);
    }
};
__decorate([
    Get('staff'),
    Biz('staff.view'),
    ApiOperation({ summary: 'Сотрудники бизнеса с порядком (и уволенные; удалённые — /staff/deleted)' }),
    ZodOk(z.array(staffRowOut)),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], StaffController.prototype, "list", null);
__decorate([
    Post('staff'),
    Biz('staff.manage'),
    Idempotent(),
    ApiOperation({ summary: 'Добавить сотрудника; с доступом — приглашение с согласием (F-00-042, F-10-015…023)' }),
    ZodBody(addStaffBody),
    ZodOk(addStaffOut),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(addStaffBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], StaffController.prototype, "add", null);
__decorate([
    Put('staff/order'),
    HttpCode(204),
    Biz('staff.manage'),
    ApiOperation({ summary: 'Порядок сотрудников (F-10-009/013)' }),
    ZodBody(orderBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(orderBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", Promise)
], StaffController.prototype, "reorder", null);
__decorate([
    Get('staff/deleted'),
    Biz('staff.manage'),
    ApiOperation({ summary: 'Удалённые сотрудники — для восстановления (F-10-044)' }),
    ZodOk(z.array(deletedOut)),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], StaffController.prototype, "deleted", null);
__decorate([
    Post('staff/transfer-access'),
    HttpCode(204),
    Biz('staff.manage'),
    ApiOperation({ summary: 'Перенести вход и роль на другую карточку (F-10-045)' }),
    ZodBody(transferAccessBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(transferAccessBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", Promise)
], StaffController.prototype, "transferAccess", null);
__decorate([
    Get('positions'),
    Biz('staff.view'),
    ApiOperation({ summary: 'Должности со счётчиком сотрудников (F-10-046)' }),
    ZodOk(z.array(positionRowOut)),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], StaffController.prototype, "positions", null);
__decorate([
    Post('positions'),
    Biz('staff.manage'),
    ApiOperation({ summary: 'Добавить должность; такая уже есть — вернуть её' }),
    ZodBody(positionBody),
    ZodOk(positionOut),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(positionBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], StaffController.prototype, "addPosition", null);
__decorate([
    Patch('positions/:positionId'),
    Biz('staff.manage'),
    ApiOperation({ summary: 'Переименовать должность — и у назначенных сотрудников' }),
    ZodBody(positionBody),
    ZodOk(positionOut),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('positionId')),
    __param(3, Body(new Zod(positionBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object]),
    __metadata("design:returntype", void 0)
], StaffController.prototype, "renamePosition", null);
__decorate([
    Delete('positions/:positionId'),
    HttpCode(204),
    Biz('staff.manage'),
    ApiOperation({ summary: 'Удалить должность; есть сотрудники — 409 in_use (F-10-049)' }),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('positionId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String]),
    __metadata("design:returntype", Promise)
], StaffController.prototype, "removePosition", null);
__decorate([
    Get('staff/:staffId'),
    Biz('staff.view'),
    ZodOk(staffOut),
    __param(0, Param('businessId')),
    __param(1, Param('staffId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], StaffController.prototype, "get", null);
__decorate([
    Patch('staff/:staffId'),
    Biz(),
    ApiOperation({ summary: 'Профиль, места работы, услуги мастера. staff.manage; свой профиль — сам мастер (часть полей). If-Match: version' }),
    ZodBody(patchStaffBody),
    ZodOk(staffOut),
    __param(0, Ctx()),
    __param(1, Req()),
    __param(2, Param('businessId')),
    __param(3, Param('staffId')),
    __param(4, Body(new Zod(patchStaffBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, String, String, Object]),
    __metadata("design:returntype", void 0)
], StaffController.prototype, "patch", null);
__decorate([
    Post('staff/:staffId/fire'),
    HttpCode(200),
    Biz('staff.manage'),
    ApiOperation({ summary: 'Уволить (F-10-040): вход гаснет сразу, портфолио уходит с мастером (C4)' }),
    ZodBody(dismissBody),
    ZodOk(staffOut),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('staffId')),
    __param(3, Body(new Zod(dismissBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object]),
    __metadata("design:returntype", void 0)
], StaffController.prototype, "fire", null);
__decorate([
    Get('staff/:staffId/dismissal'),
    Biz('staff.view'),
    ZodOk(dismissalOut),
    __param(0, Param('businessId')),
    __param(1, Param('staffId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], StaffController.prototype, "dismissal", null);
__decorate([
    Post('staff/:staffId/restore'),
    HttpCode(200),
    Biz('staff.manage'),
    ApiOperation({ summary: 'Восстановить уволенного: 24 ч — сразу, до 30 дней — нельзя (F-10-044)' }),
    ZodOk(staffOut),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('staffId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String]),
    __metadata("design:returntype", void 0)
], StaffController.prototype, "restore", null);
__decorate([
    Delete('staff/:staffId'),
    HttpCode(204),
    Biz('staff.manage'),
    ApiOperation({ summary: 'Удалить (слово DELETE — на экране, F-10-155); клиенты и записи остаются бизнесу' }),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('staffId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String]),
    __metadata("design:returntype", Promise)
], StaffController.prototype, "remove", null);
__decorate([
    Post('staff/:staffId/undelete'),
    HttpCode(200),
    Biz('staff.manage'),
    ZodOk(staffOut),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('staffId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String]),
    __metadata("design:returntype", void 0)
], StaffController.prototype, "undelete", null);
__decorate([
    Get('staff/:staffId/access'),
    Biz('staff.view'),
    ZodOk(accessOut),
    __param(0, Param('businessId')),
    __param(1, Param('staffId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], StaffController.prototype, "access", null);
__decorate([
    Put('staff/:staffId/access'),
    Biz('staff.manage'),
    ApiOperation({ summary: '«Предоставить доступ» (F-10-031); выключение гасит сессии сразу (F-00-040)' }),
    ZodBody(accessBody),
    ZodOk(accessOut),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('staffId')),
    __param(3, Body(new Zod(accessBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object]),
    __metadata("design:returntype", void 0)
], StaffController.prototype, "setAccess", null);
__decorate([
    Post('staff/:staffId/disable'),
    HttpCode(200),
    Biz('staff.manage'),
    ApiOperation({ summary: 'Отключить администратора одним нажатием — сессии гаснут (F-00-040)' }),
    ZodOk(accessOut),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('staffId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String]),
    __metadata("design:returntype", void 0)
], StaffController.prototype, "disable", null);
__decorate([
    Put('staff/:staffId/access/info'),
    Biz('staff.manage'),
    ZodBody(accessInfoBody),
    ZodOk(accessOut),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('staffId')),
    __param(3, Body(new Zod(accessInfoBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object]),
    __metadata("design:returntype", void 0)
], StaffController.prototype, "setAccessInfo", null);
__decorate([
    Put('staff/:staffId/role-template'),
    Biz('staff.manage'),
    ApiOperation({ summary: 'Роль-шаблон (8 шаблонов, F-10-053…061)' }),
    ZodBody(roleTemplateBody),
    ZodOk(accessOut),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('staffId')),
    __param(3, Body(new Zod(roleTemplateBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object]),
    __metadata("design:returntype", void 0)
], StaffController.prototype, "setRoleTemplate", null);
__decorate([
    Put('staff/:staffId/ip-restriction'),
    Biz('staff.manage'),
    ApiOperation({ summary: 'Вход только с доверенных IP (F-10-091)' }),
    ZodBody(ipBody),
    ZodOk(ipBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('staffId')),
    __param(3, Body(new Zod(ipBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object]),
    __metadata("design:returntype", void 0)
], StaffController.prototype, "setIp", null);
__decorate([
    Put('staff/:staffId/login'),
    Biz('staff.manage'),
    ApiOperation({ summary: 'Логин и пароль администратора (F-00-034/038); смена пароля при первом входе' }),
    ZodBody(loginBody),
    ZodOk(accessOut),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('staffId')),
    __param(3, Body(new Zod(loginBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object]),
    __metadata("design:returntype", void 0)
], StaffController.prototype, "setLogin", null);
__decorate([
    Post('staff/:staffId/invite'),
    HttpCode(200),
    Biz('staff.manage'),
    ApiOperation({ summary: 'Новая ссылка-приглашение (прежняя перестаёт работать)' }),
    ZodOk(reissueOut),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('staffId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String]),
    __metadata("design:returntype", void 0)
], StaffController.prototype, "reissue", null);
__decorate([
    Delete('staff/:staffId/invite'),
    Biz('staff.manage'),
    ApiOperation({ summary: 'Отозвать непринятое приглашение (F-10-020)' }),
    ZodOk(inviteOut),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('staffId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String]),
    __metadata("design:returntype", void 0)
], StaffController.prototype, "revokeInvite", null);
__decorate([
    Post('staff/:staffId/transfer-ownership'),
    HttpCode(204),
    Biz(),
    ApiOperation({ summary: 'Передать роль «Владелец» (F-10-149): звонящий — владелец, становится администратором' }),
    ZodBody(transferOwnerBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('staffId')),
    __param(3, Body(new Zod(transferOwnerBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object]),
    __metadata("design:returntype", Promise)
], StaffController.prototype, "transferOwnership", null);
__decorate([
    Get('staff/:staffId/permissions'),
    Biz('staff.manage'),
    ZodOk(rightsOut),
    __param(0, Param('businessId')),
    __param(1, Param('staffId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], StaffController.prototype, "rights", null);
__decorate([
    Put('staff/:staffId/permissions'),
    Biz('staff.manage'),
    ApiOperation({ summary: 'Права галочками (F-00-039): действуют со следующего запроса' }),
    ZodBody(rightsBody),
    ZodOk(rightsOut),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('staffId')),
    __param(3, Body(new Zod(rightsBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object]),
    __metadata("design:returntype", void 0)
], StaffController.prototype, "setRights", null);
__decorate([
    Put('staff/:staffId/permissions/scopes'),
    HttpCode(204),
    Biz('staff.manage'),
    ZodBody(scopesBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('staffId')),
    __param(3, Body(new Zod(scopesBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object]),
    __metadata("design:returntype", Promise)
], StaffController.prototype, "setScopes", null);
__decorate([
    Get('staff/:staffId/tabs/:tab'),
    Biz(),
    ApiOperation({ summary: 'legal (staff.manage) · card-settings (staff.view) · push-prefs (сам или staff.manage)' }),
    ZodOk(z.record(z.string(), z.unknown()).nullable()),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('staffId')),
    __param(3, Param('tab')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, String]),
    __metadata("design:returntype", void 0)
], StaffController.prototype, "getTab", null);
__decorate([
    Put('staff/:staffId/tabs/:tab'),
    Biz(),
    ZodBody(jsonBody),
    ZodOk(z.record(z.string(), z.unknown())),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('staffId')),
    __param(3, Param('tab')),
    __param(4, Body(new Zod(jsonBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, String, Object]),
    __metadata("design:returntype", void 0)
], StaffController.prototype, "setTab", null);
StaffController = __decorate([
    ApiTags('staff'),
    Controller('v1/biz/:businessId'),
    __metadata("design:paramtypes", [StaffService])
], StaffController);
export { StaffController };
function tabField(ctx, staffId, tab, mode) {
    const m = ctx.member;
    const manage = m.permissions.has('staff.manage');
    if (tab === 'legal') {
        if (!manage)
            throw new ApiError('forbidden', 'Missing permission: staff.manage');
        return 'legalInfo';
    }
    if (tab === 'card-settings') {
        if (!(mode === 'read' ? m.permissions.has('staff.view') : manage))
            throw new ApiError('forbidden', 'Missing permission');
        return 'cardSettings';
    }
    if (tab === 'push-prefs') {
        if (!manage && m.staffId !== staffId)
            throw new ApiError('forbidden', 'Own push preferences only');
        return 'pushPrefs';
    }
    throw new ApiError('not_found', 'Unknown tab');
}
//# sourceMappingURL=staff.controller.js.map