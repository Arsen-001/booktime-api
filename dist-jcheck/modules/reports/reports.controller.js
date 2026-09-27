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
import { Body, Controller, Get, Header, Param, Patch, Post, Query, StreamableFile } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { createFileStorage } from '../../adapters/storage/storage.js';
import { ApiError } from '../../common/errors/api-error.js';
import { Biz, Ctx } from '../../common/http/guards.js';
import { ZodBody, ZodOk } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { ReportsAuditService } from './reports-audit.service.js';
import { ReportsDashboardService } from './reports-dashboard.service.js';
import { ReportsExportService } from './reports-export.service.js';
import { ReportsJournalService } from './reports-journal.service.js';
import { ReportsMarketingService } from './reports-marketing.service.js';
import { REPORT_REGISTRY } from './reports-registry.js';
import { ReportsSalesService } from './reports-sales.service.js';
import { ReportsSettingsService } from './reports-settings.service.js';
import { reportsPermissionsPatchBody, workloadIncludedBody } from './reports.schemas.js';
/**
 * Отчёты (docs/backend/02 §16): «один маршрут на отчёт» — `GET /v1/biz/{b}/reports/{name}`, диспетчер
 * `REPORT_REGISTRY` (reports-registry.ts), а не 11 разных обработчиков. Выгрузка ставит задачу воркеру
 * (`POST …/reports/{name}/export`) и отдаёт файл, когда он готов (`GET …/reports/exports/{id}/download`).
 * Деньги в отчётах — отдельное право `finance.view` (F-00-132, открыто в ТЗ, кто именно в салоне видит деньги) —
 * здесь решение: то же `reports.view`, «Финансовый отчёт»/P&L документ §16 не входят в эту пачку (см. PROGRESS.md).
 */
let ReportsController = class ReportsController {
    constructor(dashboard, journal, sales, marketing, audit, settings, exports) {
        this.settings = settings;
        this.exports = exports;
        this.services = { dashboard, journal, sales, marketing, audit };
    }
    // ─────────────────────────── F-12-003: избранное, F-12-084…089: права ───────────────────────────
    favorites(ctx) {
        return this.settings.listFavorites(ctx.member.staffId);
    }
    toggleFavorite(ctx, slug) {
        return this.settings.toggleFavorite(ctx.member.staffId, slug);
    }
    permissions(businessId, staffId) {
        return this.settings.getPermissions(businessId, staffId);
    }
    setPermissions(ctx, businessId, staffId, body) {
        return this.settings.setPermissions(ctx, businessId, staffId, body);
    }
    async setWorkloadIncluded(businessId, staffId, body) {
        await this.settings.setWorkloadIncluded(businessId, staffId, body.included);
        return { ok: true };
    }
    // ─────────────────────────── Выгрузки (F-12-074…080) ───────────────────────────
    listExports(businessId, staffId, type) {
        return this.exports.list(businessId, { staffId, type });
    }
    getExport(businessId, id) {
        return this.exports.get(businessId, id);
    }
    async download(businessId, id) {
        const { storageKey, fileName } = await this.exports.storageKeyFor(businessId, id);
        const buf = await createFileStorage().get(storageKey);
        if (!buf)
            throw new ApiError('not_found', 'File missing on storage');
        return new StreamableFile(buf, { disposition: `attachment; filename="${fileName}"` });
    }
    requestExport(ctx, businessId, name, query) {
        return this.exports.create(ctx, businessId, name, query);
    }
    // ─────────────────────────── docs/backend/02 §16: `GET …/reports/{name}` ───────────────────────────
    async run(ctx, businessId, name, query) {
        const def = REPORT_REGISTRY[name];
        if (!def)
            throw new ApiError('not_found', `Unknown report: ${name}`);
        if (def.requiredPermission !== 'reports.view' && !ctx.member.permissions.has(def.requiredPermission))
            throw new ApiError('forbidden', `Missing permission: ${def.requiredPermission}`);
        const parsed = new Zod(def.schema).transform(query);
        return def.run(this.services, businessId, parsed);
    }
};
__decorate([
    Get('favorites'),
    Biz(),
    __param(0, Ctx()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], ReportsController.prototype, "favorites", null);
__decorate([
    Post('favorites/:slug'),
    Biz(),
    ZodOk(z.array(z.object({ slug: z.string(), addedAt: z.string() }))),
    __param(0, Ctx()),
    __param(1, Param('slug')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], ReportsController.prototype, "toggleFavorite", null);
__decorate([
    Get('permissions/:staffId'),
    Biz('staff.view'),
    __param(0, Param('businessId')),
    __param(1, Param('staffId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], ReportsController.prototype, "permissions", null);
__decorate([
    Patch('permissions/:staffId'),
    Biz('staff.manage'),
    ZodBody(reportsPermissionsPatchBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('staffId')),
    __param(3, Body(new Zod(reportsPermissionsPatchBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object]),
    __metadata("design:returntype", void 0)
], ReportsController.prototype, "setPermissions", null);
__decorate([
    Patch('load/staff/:staffId'),
    Biz('staff.manage'),
    ApiOperation({ summary: '«Учитывать сотрудника в заполненности» (F-12-008)' }),
    ZodBody(workloadIncludedBody),
    __param(0, Param('businessId')),
    __param(1, Param('staffId')),
    __param(2, Body(new Zod(workloadIncludedBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object]),
    __metadata("design:returntype", Promise)
], ReportsController.prototype, "setWorkloadIncluded", null);
__decorate([
    Get('exports'),
    Biz(),
    ApiOperation({ summary: 'Журнал выгрузок отчётов — «Операции с данными» (F-12-074…080)' }),
    __param(0, Param('businessId')),
    __param(1, Query('staffId')),
    __param(2, Query('type')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String]),
    __metadata("design:returntype", void 0)
], ReportsController.prototype, "listExports", null);
__decorate([
    Get('exports/:id'),
    Biz(),
    __param(0, Param('businessId')),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], ReportsController.prototype, "getExport", null);
__decorate([
    Get('exports/:id/download'),
    Biz(),
    Header('Content-Type', 'text/csv; charset=utf-8'),
    __param(0, Param('businessId')),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], ReportsController.prototype, "download", null);
__decorate([
    Post(':name/export'),
    Biz('reports.view'),
    ApiOperation({ summary: 'Поставить выгрузку отчёта в очередь воркера (PLAN §6 №16)' }),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('name')),
    __param(3, Query()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object]),
    __metadata("design:returntype", void 0)
], ReportsController.prototype, "requestExport", null);
__decorate([
    Get(':name'),
    Biz('reports.view'),
    ApiOperation({ summary: 'Один маршрут на отчёт: overview | visits | records | events | retention | load | by-staff | by-service | by-client | promotions | messages | data-changes' }),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('name')),
    __param(3, Query()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object]),
    __metadata("design:returntype", Promise)
], ReportsController.prototype, "run", null);
ReportsController = __decorate([
    ApiTags('reports'),
    Controller('v1/biz/:businessId/reports'),
    __metadata("design:paramtypes", [ReportsDashboardService,
        ReportsJournalService,
        ReportsSalesService,
        ReportsMarketingService,
        ReportsAuditService,
        ReportsSettingsService,
        ReportsExportService])
], ReportsController);
export { ReportsController };
//# sourceMappingURL=reports.controller.js.map