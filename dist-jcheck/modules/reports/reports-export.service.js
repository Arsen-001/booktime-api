var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { Injectable } from '@nestjs/common';
import { ApiError } from '../../common/errors/api-error.js';
import { newId } from '../../common/ids/ids.js';
import { PrismaService } from '../../common/prisma.service.js';
import { REPORT_REGISTRY } from './reports-registry.js';
/**
 * Выгрузка отчёта (docs/backend/02 §16: «тяжёлые — задачей в воркере с готовым файлом»). Строка ставится здесь
 * синхронно (`queued`), CSV считает `jobs/reports-export.ts` в воркере тем же реестром `REPORT_REGISTRY`, что
 * отдаёт экран — файл гарантированно совпадает со срезом, который видел человек. Заодно это и «Операции с
 * данными» (F-12-074…080): список выгрузок ЭТОЙ таблицы — тот же журнал, без второй строки на запись.
 */
let ReportsExportService = class ReportsExportService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async create(ctx, businessId, name, params) {
        if (!(name in REPORT_REGISTRY))
            throw new ApiError('not_found', `Unknown report: ${name}`);
        const row = await this.prisma.reportExport.create({
            data: { id: newId('reportExport'), businessId, staffId: ctx.member.staffId, staffName: ctx.member.name, name, params, status: 'queued' },
        });
        return this.toDto(row);
    }
    async list(businessId, filters = {}) {
        const rows = await this.prisma.reportExport.findMany({
            where: { businessId, ...(filters.staffId ? { staffId: filters.staffId } : {}), ...(filters.type ? { name: filters.type } : {}) },
            orderBy: { createdAt: 'desc' },
            take: 500,
        });
        return rows.map((r) => this.toDto(r));
    }
    async get(businessId, id) {
        const row = await this.prisma.reportExport.findFirst({ where: { id, businessId } });
        if (!row)
            throw new ApiError('not_found', 'Export not found');
        return this.toDto(row);
    }
    async storageKeyFor(businessId, id) {
        const row = await this.prisma.reportExport.findFirst({ where: { id, businessId } });
        if (!row || row.status !== 'ready' || !row.storageKey || !row.fileName)
            throw new ApiError('not_found', 'Export file not ready');
        return { storageKey: row.storageKey, fileName: row.fileName };
    }
    toDto(row) {
        return {
            id: row.id,
            staffId: row.staffId,
            staffName: row.staffName,
            type: row.name,
            operation: 'browserDownload',
            status: row.status,
            fileName: row.fileName ?? '',
            rowCount: row.rowCount ?? 0,
            at: row.createdAt.toISOString(),
            readyAt: row.readyAt?.toISOString(),
            error: row.error ?? undefined,
        };
    }
};
ReportsExportService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [PrismaService])
], ReportsExportService);
export { ReportsExportService };
//# sourceMappingURL=reports-export.service.js.map