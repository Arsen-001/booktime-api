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
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuditService, maskPhonesInDiff } from '../../common/audit/audit.service.js';
import { Biz, Ctx } from '../../common/http/guards.js';
import { ZodBody, ZodOk } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { PrismaService } from '../../common/prisma.service.js';
import { utcToLocal } from '../../common/time/time.js';
import { auditOut, exportLogBody, exportOut, loginRowOut } from './staff.schemas.js';
/** diff { поле: [было, стало] } → before/after как в журнале фронта (StaffAuditEntry) */
function split(diff, entity) {
    if (!diff)
        return {};
    // История прав (F-10-070) показывает сами наборы тонких прав
    if (entity === 'staffRights' && diff.rights)
        return { before: diff.rights[0] ?? undefined, after: diff.rights[1] ?? undefined };
    const before = {};
    const after = {};
    for (const [k, [a, b]] of Object.entries(diff)) {
        before[k] = a;
        after[k] = b;
    }
    return { before, after };
}
/** Журнал изменений, выгрузок и входов бизнеса (F-00-040, F-10-100…106) */
let JournalsController = class JournalsController {
    constructor(prisma, audit) {
        this.prisma = prisma;
        this.audit = audit;
    }
    async list(ctx, businessId, entity, entityId, action, actorStaffId, limit) {
        const rows = await this.prisma.auditEvent.findMany({
            where: {
                businessId,
                action: { not: 'export' },
                ...(entity ? { entityType: entity } : {}),
                ...(entityId ? { entityId } : {}),
                ...(action ? { action } : {}),
                ...(actorStaffId ? { actorId: actorStaffId } : {}),
            },
            orderBy: { at: 'desc' },
            take: Math.min(Math.max(Number(limit) || 200, 1), 1000),
        });
        const phones = ctx.member.permissions.has('clients.phones');
        return rows.map((r) => {
            const diff = phones ? r.diff : maskPhonesInDiff(r.diff);
            return {
                id: r.id,
                businessId,
                entity: r.entityType,
                entityId: r.entityId,
                action: r.action,
                actorStaffId: r.actorType === 'staff' && r.actorId ? r.actorId : undefined,
                actorLabel: r.actorName,
                ...split(diff, r.entityType),
                at: utcToLocal(r.at),
            };
        });
    }
    history(ctx, businessId, staffId) {
        return this.list(ctx, businessId, 'staffRights', staffId);
    }
    async logExport(ctx, businessId, body) {
        await this.prisma.$transaction((tx) => this.audit.record(tx, ctx, { action: 'export', entityType: body.reportType, entityId: businessId, businessId, after: body }));
    }
    async exports(businessId) {
        const rows = await this.prisma.auditEvent.findMany({ where: { businessId, action: 'export' }, orderBy: { at: 'desc' }, take: 500 });
        return rows.map((r) => {
            const d = (r.diff ?? {});
            return {
                id: r.id,
                businessId,
                actorStaffId: r.actorType === 'staff' && r.actorId ? r.actorId : undefined,
                actorLabel: r.actorName,
                reportType: String(d.reportType?.[1] ?? r.entityType),
                isImport: Boolean(d.isImport?.[1]),
                operationType: String(d.operationType?.[1] ?? 'browserDownload'),
                at: utcToLocal(r.at),
            };
        });
    }
    async logins(businessId) {
        const staff = await this.prisma.staff.findMany({ where: { businessId, userId: { not: null } }, select: { id: true, userId: true, name: true } });
        const byUser = new Map(staff.map((s) => [s.userId, s]));
        if (!byUser.size)
            return [];
        const events = await this.prisma.loginEvent.findMany({
            where: { userId: { in: [...byUser.keys()] }, app: 'business', result: 'ok' },
            orderBy: { at: 'asc' },
            take: 1000,
        });
        const seen = new Set();
        const rows = events.map((e) => {
            const s = byUser.get(e.userId);
            const key = `${e.userId}|${e.device}`;
            const newDevice = !seen.has(key);
            seen.add(key);
            return { id: e.id, businessId, staffId: s.id, staffLabel: s.name, at: utcToLocal(e.at), device: e.device, ip: e.ip, newDevice };
        });
        return rows.reverse();
    }
};
__decorate([
    Get('audit'),
    Biz('settings.manage'),
    ApiOperation({ summary: 'Журнал изменений (F-10-100): фильтры по сущности, объекту, действию, сотруднику. Телефоны — по праву clients.phones' }),
    ApiQuery({ name: 'entity', required: false }),
    ApiQuery({ name: 'entityId', required: false }),
    ApiQuery({ name: 'action', required: false }),
    ApiQuery({ name: 'actorStaffId', required: false }),
    ApiQuery({ name: 'limit', required: false }),
    ZodOk(z.array(auditOut)),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Query('entity')),
    __param(3, Query('entityId')),
    __param(4, Query('action')),
    __param(5, Query('actorStaffId')),
    __param(6, Query('limit')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, String, String, String, String]),
    __metadata("design:returntype", Promise)
], JournalsController.prototype, "list", null);
__decorate([
    Get('staff/:staffId/permissions/history'),
    Biz('staff.manage'),
    ApiOperation({ summary: 'История прав сотрудника (F-10-070)' }),
    ZodOk(z.array(auditOut)),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('staffId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String]),
    __metadata("design:returntype", void 0)
], JournalsController.prototype, "history", null);
__decorate([
    Post('exports-log'),
    HttpCode(204),
    Biz(),
    ApiOperation({ summary: 'Отметить выгрузку/загрузку файла (пишут разделы с кнопкой «Выгрузить», F-10-102)' }),
    ZodBody(exportLogBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(exportLogBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", Promise)
], JournalsController.prototype, "logExport", null);
__decorate([
    Get('exports-log'),
    Biz('clients.export'),
    ApiOperation({ summary: 'Журнал «Операции с данными» (F-10-102/103)' }),
    ZodOk(z.array(exportOut)),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], JournalsController.prototype, "exports", null);
__decorate([
    Get('logins'),
    Biz('settings.manage'),
    ApiOperation({ summary: 'Журнал входов сотрудников бизнеса (F-10-106)' }),
    ZodOk(z.array(loginRowOut)),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], JournalsController.prototype, "logins", null);
JournalsController = __decorate([
    ApiTags('staff'),
    Controller('v1/biz/:businessId'),
    __metadata("design:paramtypes", [PrismaService,
        AuditService])
], JournalsController);
export { JournalsController };
//# sourceMappingURL=journals.controller.js.map