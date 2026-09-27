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
import { PrismaService } from '../../common/prisma.service.js';
function defaultPermissions(base) {
    const full = base.edit || base.view;
    return {
        dashboard: full,
        recordsView: full,
        recordsDepth: full ? 'all' : 30,
        recordsExport: base.edit,
        recordsPhones: base.edit,
        financePeriod: full,
        financeYear: full,
        cashDayTodayOnly: !base.edit,
        events: full,
        visits: full,
        visitsPhones: base.edit,
        retention: full,
        workload: full,
        workloadIncluded: true,
    };
}
let ReportsSettingsService = class ReportsSettingsService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async staffOf(businessId, staffId) {
        const s = await this.prisma.staff.findFirst({ where: { id: staffId, businessId, deletedAt: null }, select: { role: true } });
        return s;
    }
    /** Дефолт до первой правки владельца: edit ~ владелец/администратор, view ~ есть право reports.view (03 §2 не заводит reports.edit) */
    async getPermissions(businessId, staffId) {
        const row = await this.prisma.staffReportsPermission.findUnique({ where: { staffId } });
        if (row)
            return row.data;
        const staff = await this.staffOf(businessId, staffId);
        const edit = staff?.role === 'owner' || staff?.role === 'individual' || staff?.role === 'admin';
        return defaultPermissions({ edit, view: Boolean(edit) });
    }
    async setPermissions(ctx, businessId, staffId, patch) {
        const current = await this.getPermissions(businessId, staffId);
        const next = { ...current, ...patch };
        await this.prisma.staffReportsPermission.upsert({
            where: { staffId },
            create: { staffId, data: next, updatedBy: ctx.member?.staffId },
            update: { data: next, updatedBy: ctx.member?.staffId },
        });
        return next;
    }
    async setWorkloadIncluded(businessId, staffId, included) {
        const current = await this.getPermissions(businessId, staffId);
        await this.prisma.staffReportsPermission.upsert({
            where: { staffId },
            create: { staffId, data: { ...current, workloadIncluded: included } },
            update: { data: { ...current, workloadIncluded: included } },
        });
    }
    async listFavorites(staffId) {
        const rows = await this.prisma.reportFavorite.findMany({ where: { staffId }, orderBy: { createdAt: 'asc' } });
        return rows.map((r) => ({ slug: r.slug, addedAt: r.createdAt.toISOString() }));
    }
    async toggleFavorite(staffId, slug) {
        const existing = await this.prisma.reportFavorite.findUnique({ where: { staffId_slug: { staffId, slug } } });
        if (existing)
            await this.prisma.reportFavorite.delete({ where: { staffId_slug: { staffId, slug } } });
        else
            await this.prisma.reportFavorite.create({ data: { staffId, slug } });
        return this.listFavorites(staffId);
    }
};
ReportsSettingsService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [PrismaService])
], ReportsSettingsService);
export { ReportsSettingsService };
//# sourceMappingURL=reports-settings.service.js.map