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
import { Body, Controller, Delete, Get, HttpCode, Injectable, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuditService } from '../../common/audit/audit.service.js';
import { ApiError } from '../../common/errors/api-error.js';
import { Authed, Ctx } from '../../common/http/guards.js';
import { ZodBody, ZodOk } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { newId } from '../../common/ids/ids.js';
import { PrismaService } from '../../common/prisma.service.js';
import { NetworkAccessService } from './network-access.service.js';
import { addNewUserBody, inviteExistingBody, networkUserOut, setPermissionsBody, setPlanReportFreqBody } from './network.schemas.js';
function out(u) {
    return {
        id: u.id,
        networkId: u.networkId,
        name: u.name,
        phone: u.phone,
        email: u.email ?? undefined,
        permissions: Array.isArray(u.permissions) ? u.permissions : [],
        lastVisitAt: u.lastVisitAt?.toISOString(),
        planReportFrequency: (u.planReportFrequency ?? undefined),
        version: u.version,
    };
}
/**
 * Пользователи сети (F-11-024…036, docs/backend/02 §15): доступ к сетевым разделам без своей строки staff.
 * Владелец сети (Network.ownerUserId) — отдельная строка «Владелец» рисуется на фронте, здесь не хранится
 * (isOwner ставит фронт по networkId, F-11-024). Оплата «первый бесплатно, дальше по 2000 ֏» (NETWORK_USER_PRICE
 * фронта) — часть подписки/биллинга (этап 18, PLAN §6 №18), здесь не списывается (Р14/Р17 — стоимость решает 08).
 */
let NetworkUsersService = class NetworkUsersService {
    constructor(prisma, access, audit) {
        this.prisma = prisma;
        this.access = access;
        this.audit = audit;
    }
    async list(ctx, networkId) {
        await this.access.require(ctx, networkId, 'users');
        const rows = await this.prisma.networkUser.findMany({ where: { networkId }, orderBy: { createdAt: 'asc' } });
        return rows.map(out);
    }
    /** F-11-025: пригласить существующего пользователя (у него уже есть аккаунт по номеру) */
    async inviteExisting(ctx, networkId, input) {
        await this.access.require(ctx, networkId, 'users');
        const user = await this.prisma.user.findUnique({ where: { phone: input.phone } });
        if (!user || user.deletedAt)
            throw new ApiError('not_found', 'No account with this phone yet — use "add new"');
        const existing = await this.prisma.networkUser.findUnique({ where: { networkId_userId: { networkId, userId: user.id } } });
        if (existing)
            throw new ApiError('conflict', 'Already a network user');
        const id = newId('networkUser');
        await this.prisma.$transaction(async (tx) => {
            await tx.networkUser.create({ data: { id, networkId, userId: user.id, name: user.name, phone: user.phone ?? input.phone, permissions: input.permissions, createdBy: ctx.session.userId, updatedBy: ctx.session.userId } });
            await this.audit.record(tx, ctx, { action: 'create', entityType: 'networkUser', entityId: id, networkId, after: { phone: input.phone, permissions: input.permissions } });
        });
        return out((await this.prisma.networkUser.findUniqueOrThrow({ where: { id } })));
    }
    /** F-11-026: добавить нового пользователя — заводит аккаунт по номеру (входит потом обычным кодом, этап 2) */
    async addNew(ctx, networkId, input) {
        await this.access.require(ctx, networkId, 'users');
        const id = newId('networkUser');
        await this.prisma.$transaction(async (tx) => {
            let user = await tx.user.findUnique({ where: { phone: input.phone } });
            if (!user)
                user = await tx.user.create({ data: { id: newId('user'), phone: input.phone, name: input.name, createdBy: ctx.session.userId, updatedBy: ctx.session.userId } });
            const existing = await tx.networkUser.findUnique({ where: { networkId_userId: { networkId, userId: user.id } } });
            if (existing)
                throw new ApiError('conflict', 'Already a network user');
            await tx.networkUser.create({ data: { id, networkId, userId: user.id, name: input.name, phone: input.phone, email: input.email, permissions: input.permissions, createdBy: ctx.session.userId, updatedBy: ctx.session.userId } });
            await this.audit.record(tx, ctx, { action: 'create', entityType: 'networkUser', entityId: id, networkId, after: { phone: input.phone, name: input.name } });
        });
        return out((await this.prisma.networkUser.findUniqueOrThrow({ where: { id } })));
    }
    async setPermissions(ctx, networkId, id, permissions) {
        await this.access.require(ctx, networkId, 'users');
        const before = await this.prisma.networkUser.findFirst({ where: { id, networkId } });
        if (!before)
            throw new ApiError('not_found', 'Network user not found');
        await this.prisma.$transaction(async (tx) => {
            await tx.networkUser.update({ where: { id }, data: { permissions, updatedBy: ctx.session.userId, version: { increment: 1 } } });
            await this.audit.record(tx, ctx, { action: 'update', entityType: 'networkUser', entityId: id, networkId, before: { permissions: before.permissions }, after: { permissions } });
        });
        return out((await this.prisma.networkUser.findUniqueOrThrow({ where: { id } })));
    }
    async setPlanReportFrequency(ctx, networkId, id, frequency) {
        await this.access.require(ctx, networkId, 'users');
        const before = await this.prisma.networkUser.findFirst({ where: { id, networkId } });
        if (!before)
            throw new ApiError('not_found', 'Network user not found');
        await this.prisma.networkUser.update({ where: { id }, data: { planReportFrequency: frequency, version: { increment: 1 } } });
        return out((await this.prisma.networkUser.findUniqueOrThrow({ where: { id } })));
    }
    async remove(ctx, networkId, id) {
        await this.access.require(ctx, networkId, 'users');
        const before = await this.prisma.networkUser.findFirst({ where: { id, networkId } });
        if (!before)
            return;
        await this.prisma.$transaction(async (tx) => {
            await tx.networkUser.delete({ where: { id } });
            await this.audit.record(tx, ctx, { action: 'deleted', entityType: 'networkUser', entityId: id, networkId, before: { phone: before.phone, name: before.name } });
        });
    }
};
NetworkUsersService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [PrismaService,
        NetworkAccessService,
        AuditService])
], NetworkUsersService);
export { NetworkUsersService };
let NetworkUsersController = class NetworkUsersController {
    constructor(svc) {
        this.svc = svc;
    }
    list(ctx, n) {
        return this.svc.list(ctx, n);
    }
    invite(ctx, n, body) {
        return this.svc.inviteExisting(ctx, n, body);
    }
    add(ctx, n, body) {
        return this.svc.addNew(ctx, n, body);
    }
    setPermissions(ctx, n, id, body) {
        return this.svc.setPermissions(ctx, n, id, body.permissions);
    }
    setFreq(ctx, n, id, body) {
        return this.svc.setPlanReportFrequency(ctx, n, id, body.frequency);
    }
    async remove(ctx, n, id) {
        await this.svc.remove(ctx, n, id);
        return { ok: true };
    }
};
__decorate([
    Get(),
    ZodOk(z.array(networkUserOut)),
    __param(0, Ctx()),
    __param(1, Param('networkId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], NetworkUsersController.prototype, "list", null);
__decorate([
    Post('invite'),
    ApiOperation({ summary: 'Пригласить существующего пользователя по телефону (F-11-025)' }),
    ZodBody(inviteExistingBody),
    ZodOk(networkUserOut),
    __param(0, Ctx()),
    __param(1, Param('networkId')),
    __param(2, Body(new Zod(inviteExistingBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], NetworkUsersController.prototype, "invite", null);
__decorate([
    Post(),
    ApiOperation({ summary: 'Добавить нового пользователя сети (F-11-026)' }),
    ZodBody(addNewUserBody),
    ZodOk(networkUserOut),
    __param(0, Ctx()),
    __param(1, Param('networkId')),
    __param(2, Body(new Zod(addNewUserBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], NetworkUsersController.prototype, "add", null);
__decorate([
    Patch(':id/permissions'),
    ZodBody(setPermissionsBody),
    ZodOk(networkUserOut),
    __param(0, Ctx()),
    __param(1, Param('networkId')),
    __param(2, Param('id')),
    __param(3, Body(new Zod(setPermissionsBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object]),
    __metadata("design:returntype", void 0)
], NetworkUsersController.prototype, "setPermissions", null);
__decorate([
    Patch(':id/plan-report-frequency'),
    ApiOperation({ summary: 'Как часто присылать письмо о выполнении плана (F-11-030)' }),
    ZodBody(setPlanReportFreqBody),
    ZodOk(networkUserOut),
    __param(0, Ctx()),
    __param(1, Param('networkId')),
    __param(2, Param('id')),
    __param(3, Body(new Zod(setPlanReportFreqBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object]),
    __metadata("design:returntype", void 0)
], NetworkUsersController.prototype, "setFreq", null);
__decorate([
    Delete(':id'),
    HttpCode(200),
    ZodOk(z.object({ ok: z.literal(true) })),
    __param(0, Ctx()),
    __param(1, Param('networkId')),
    __param(2, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String]),
    __metadata("design:returntype", Promise)
], NetworkUsersController.prototype, "remove", null);
NetworkUsersController = __decorate([
    ApiTags('network'),
    Controller('v1/net/:networkId/users'),
    Authed(),
    __metadata("design:paramtypes", [NetworkUsersService])
], NetworkUsersController);
export { NetworkUsersController };
//# sourceMappingURL=network-users.controller.js.map