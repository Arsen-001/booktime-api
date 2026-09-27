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
import { networkOut } from '../businesses/business.schemas.js';
import { networkView } from '../businesses/views.js';
const createBody = z.object({ name: z.string().max(160), businessIds: z.array(z.string().max(32)).min(1).max(50), mainBusinessId: z.string().max(32).optional() });
const patchBody = z.object({ name: z.string().max(160).optional(), mainBusinessId: z.string().max(32).optional() });
const addBody = z.object({ businessId: z.string().max(32) });
/**
 * Сеть и её филиалы (docs/backend/02 §15, F-11-001…023; этап 3 — устройство сети, остальное — этап 15).
 * Сеть создаёт владелец из СВОИХ бизнесов; владелец сети получает в каждом филиале роль network (все права).
 */
let NetworkService = class NetworkService {
    constructor(prisma, audit) {
        this.prisma = prisma;
        this.audit = audit;
    }
    /** Бизнес, в котором вошедший — владелец (строка staff role=owner) */
    async ownerRow(userId, businessId) {
        return this.prisma.staff.findFirst({ where: { businessId, userId, role: 'owner', status: 'active', deletedAt: null } });
    }
    async own(ctx, networkId) {
        const n = await this.prisma.network.findUnique({ where: { id: networkId }, include: { businesses: { select: { id: true }, where: { leftAt: null }, orderBy: { createdAt: 'asc' } } } });
        if (!n || n.ownerUserId !== ctx.session.userId)
            throw new ApiError('forbidden', 'Network is not accessible');
        return n;
    }
    async view(networkId) {
        const n = await this.prisma.network.findUniqueOrThrow({ where: { id: networkId }, include: { businesses: { select: { id: true }, where: { leftAt: null }, orderBy: { createdAt: 'asc' } } } });
        return { ...networkView(n, n.businesses.map((b) => b.id)), deleted: Boolean(n.deletedAt) };
    }
    async create(ctx, input) {
        const userId = ctx.session.userId;
        const name = input.name.trim();
        if (!name)
            throw new ApiError('validation', 'name required');
        const rows = [];
        for (const b of input.businessIds) {
            const row = await this.ownerRow(userId, b);
            if (!row)
                throw new ApiError('forbidden', 'Only own businesses join a network');
            const biz = await this.prisma.business.findUniqueOrThrow({ where: { id: b } });
            if (biz.networkId)
                throw new ApiError('conflict', 'Business is already in a network');
            rows.push(row);
        }
        const id = newId('network');
        await this.prisma.$transaction(async (tx) => {
            await tx.network.create({
                data: { id, name, ownerUserId: userId, ownerStaffId: rows[0].id, mainBusinessId: input.mainBusinessId ?? input.businessIds[0], createdBy: userId, updatedBy: userId },
            });
            await tx.business.updateMany({ where: { id: { in: input.businessIds } }, data: { networkId: id } });
            await this.audit.record(tx, ctx, { action: 'create', entityType: 'network', entityId: id, networkId: id, after: { name, businessIds: input.businessIds } });
        });
        return this.view(id);
    }
    async patch(ctx, networkId, input) {
        const n = await this.own(ctx, networkId);
        if (input.mainBusinessId && !n.businesses.some((b) => b.id === input.mainBusinessId))
            throw new ApiError('validation', 'Main location must be in the network');
        if (input.name !== undefined && !input.name.trim())
            throw new ApiError('validation', 'name required');
        await this.prisma.$transaction(async (tx) => {
            await tx.network.update({
                where: { id: networkId },
                data: { ...(input.name ? { name: input.name.trim() } : {}), ...(input.mainBusinessId ? { mainBusinessId: input.mainBusinessId } : {}), updatedBy: ctx.session.userId, version: { increment: 1 } },
            });
            await this.audit.record(tx, ctx, { action: 'update', entityType: 'network', entityId: networkId, networkId, before: { name: n.name, mainBusinessId: n.mainBusinessId }, after: { name: input.name ?? n.name, mainBusinessId: input.mainBusinessId ?? n.mainBusinessId } });
        });
        return this.view(networkId);
    }
    async addBusiness(ctx, networkId, businessId) {
        const n = await this.own(ctx, networkId);
        if (n.businesses.some((b) => b.id === businessId))
            return this.view(networkId);
        const biz = await this.prisma.business.findUnique({ where: { id: businessId } });
        if (!biz || !(await this.ownerRow(ctx.session.userId, businessId)))
            throw new ApiError('forbidden', 'Only own businesses join a network');
        if (biz.networkId)
            throw new ApiError('conflict', 'Business is already in a network');
        await this.prisma.$transaction(async (tx) => {
            await tx.business.update({ where: { id: businessId }, data: { networkId, version: { increment: 1 } } });
            await this.audit.record(tx, ctx, { action: 'locationAdded', entityType: 'network', entityId: networkId, networkId, businessId, after: { businessId } });
        });
        return this.view(networkId);
    }
    /** Выход филиала из сети (F-11-013): счета клиентов и история остаются в бизнесе */
    async removeBusiness(ctx, networkId, businessId) {
        const n = await this.own(ctx, networkId);
        if (!n.businesses.some((b) => b.id === businessId))
            return this.view(networkId);
        const rest = n.businesses.filter((b) => b.id !== businessId).map((b) => b.id);
        await this.prisma.$transaction(async (tx) => {
            await tx.business.update({ where: { id: businessId }, data: { networkId: null, version: { increment: 1 } } });
            if (n.mainBusinessId === businessId)
                await tx.network.update({ where: { id: networkId }, data: { mainBusinessId: rest[0] ?? null } });
            await this.audit.record(tx, ctx, { action: 'locationRemoved', entityType: 'network', entityId: networkId, networkId, businessId, before: { businessId } });
        });
        return this.view(networkId);
    }
    async setDeleted(ctx, networkId, deleted) {
        await this.own(ctx, networkId);
        await this.prisma.$transaction(async (tx) => {
            await tx.network.update({ where: { id: networkId }, data: { deletedAt: deleted ? new Date() : null, version: { increment: 1 } } });
            await this.audit.record(tx, ctx, { action: deleted ? 'deleted' : 'restored', entityType: 'network', entityId: networkId, networkId });
        });
        return this.view(networkId);
    }
};
NetworkService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [PrismaService,
        AuditService])
], NetworkService);
export { NetworkService };
const netOut = networkOut.extend({ deleted: z.boolean() });
let NetworkController = class NetworkController {
    constructor(net) {
        this.net = net;
    }
    create(ctx, body) {
        return this.net.create(ctx, body);
    }
    async get(ctx, id) {
        await this.net.own(ctx, id);
        return this.net.view(id);
    }
    patch(ctx, id, body) {
        return this.net.patch(ctx, id, body);
    }
    add(ctx, id, body) {
        return this.net.addBusiness(ctx, id, body.businessId);
    }
    remove(ctx, id, b) {
        return this.net.removeBusiness(ctx, id, b);
    }
    del(ctx, id) {
        return this.net.setDeleted(ctx, id, true);
    }
    restore(ctx, id) {
        return this.net.setDeleted(ctx, id, false);
    }
};
__decorate([
    Post(),
    ApiOperation({ summary: 'Создать сеть из своих бизнесов (F-11-001, F-11-006)' }),
    ZodBody(createBody),
    ZodOk(netOut),
    __param(0, Ctx()),
    __param(1, Body(new Zod(createBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], NetworkController.prototype, "create", null);
__decorate([
    Get(':networkId'),
    ZodOk(netOut),
    __param(0, Ctx()),
    __param(1, Param('networkId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], NetworkController.prototype, "get", null);
__decorate([
    Patch(':networkId'),
    ApiOperation({ summary: 'Название, главная локация (F-11-017)' }),
    ZodBody(patchBody),
    ZodOk(netOut),
    __param(0, Ctx()),
    __param(1, Param('networkId')),
    __param(2, Body(new Zod(patchBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], NetworkController.prototype, "patch", null);
__decorate([
    Post(':networkId/businesses'),
    HttpCode(200),
    ApiOperation({ summary: 'Добавить свой бизнес филиалом (F-11-014)' }),
    ZodBody(addBody),
    ZodOk(netOut),
    __param(0, Ctx()),
    __param(1, Param('networkId')),
    __param(2, Body(new Zod(addBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], NetworkController.prototype, "add", null);
__decorate([
    Delete(':networkId/businesses/:businessId'),
    ApiOperation({ summary: 'Выход филиала из сети (F-11-013)' }),
    ZodOk(netOut),
    __param(0, Ctx()),
    __param(1, Param('networkId')),
    __param(2, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String]),
    __metadata("design:returntype", void 0)
], NetworkController.prototype, "remove", null);
__decorate([
    Delete(':networkId'),
    ApiOperation({ summary: 'Удалить сеть (мягко, F-11-019)' }),
    ZodOk(netOut),
    __param(0, Ctx()),
    __param(1, Param('networkId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], NetworkController.prototype, "del", null);
__decorate([
    Post(':networkId/restore'),
    HttpCode(200),
    ApiOperation({ summary: 'Восстановить сеть (F-11-020)' }),
    ZodOk(netOut),
    __param(0, Ctx()),
    __param(1, Param('networkId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], NetworkController.prototype, "restore", null);
NetworkController = __decorate([
    ApiTags('network'),
    Controller('v1/net'),
    Authed(),
    __metadata("design:paramtypes", [NetworkService])
], NetworkController);
export { NetworkController };
//# sourceMappingURL=network.controller.js.map