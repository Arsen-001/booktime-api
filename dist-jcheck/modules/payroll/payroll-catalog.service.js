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
import { AuditService } from '../../common/audit/audit.service.js';
import { ApiError } from '../../common/errors/api-error.js';
import { newId } from '../../common/ids/ids.js';
import { PrismaService } from '../../common/prisma.service.js';
import { emptySchemeBlocks } from './payroll-engine.js';
function jsonOf(v) {
    return v;
}
function settingsView(r) {
    return {
        locationId: r.locationId,
        accrualDateBasis: r.accrualDateBasis,
        bankCommissionSplit: r.bankCommissionSplit,
        assistCompensationEnabled: r.assistCompensationEnabled,
        multipleAssistantsAllowed: r.multipleAssistantsAllowed,
        assistantSplitRule: r.assistantSplitRule,
        payrollModel: r.payrollModel,
        statementApprovalEnabled: r.statementApprovalEnabled,
        payrollFundTargetPct: r.payrollFundTargetPct,
        payrollFundWarnPct: r.payrollFundWarnPct,
        version: r.version,
        updatedAt: r.updatedAt.toISOString(),
    };
}
function schemeView(r) {
    return { staffId: r.staffId, ...r.data, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(), version: r.version };
}
function ruleView(r) {
    return { id: r.id, businessId: r.businessId, name: r.name, ...r.data, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(), version: r.version };
}
function criterionView(r) {
    return {
        id: r.id,
        businessId: r.businessId,
        name: r.name,
        period: r.period,
        metric: r.metric,
        scope: r.scope,
        byServices: r.byServices,
        byProducts: r.byProducts,
        threshold: Number(r.threshold),
        includeDiscounts: r.includeDiscounts,
        countCategoryIds: r.countCategoryIds,
        countItemIds: r.countItemIds,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
        version: r.version,
    };
}
function chartView(r) {
    return { id: r.id, businessId: r.businessId, name: r.name, type: r.type, standardRuleId: r.standardRuleId ?? undefined, planRows: r.planRows, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(), version: r.version };
}
function assignmentView(r) {
    return { id: r.id, businessId: r.businessId, chartId: r.chartId, staffId: r.staffId, startDate: r.startDate.toISOString().slice(0, 10), createdAt: r.createdAt.toISOString() };
}
function bonusPenaltyTypeView(r) {
    return { id: r.id, businessId: r.businessId, kind: r.kind, name: r.name, defaultAmount: Number(r.defaultAmount), createdAt: r.createdAt.toISOString() };
}
/** Настройки, схема сотрудника и классическая модель (правила/критерии/схемы/назначения) — F-09-004…057. */
let PayrollCatalogService = class PayrollCatalogService {
    constructor(prisma, audit) {
        this.prisma = prisma;
        this.audit = audit;
    }
    // ─────────────────────────── Основные настройки локации (F-09-004/005) ───────────────────────────
    async ensureSettings(locationId, businessId) {
        const existing = await this.prisma.payrollSettings.findUnique({ where: { locationId } });
        if (existing)
            return existing;
        return this.prisma.payrollSettings.create({ data: { locationId, businessId } });
    }
    async getSettings(businessId, locationId) {
        const location = await this.prisma.location.findFirst({ where: { id: locationId, businessId } });
        if (!location)
            throw new ApiError('not_found', 'Location not found');
        return settingsView(await this.ensureSettings(locationId, businessId));
    }
    async saveSettings(ctx, locationId, body) {
        const businessId = ctx.member.businessId;
        const location = await this.prisma.location.findFirst({ where: { id: locationId, businessId } });
        if (!location)
            throw new ApiError('not_found', 'Location not found');
        await this.ensureSettings(locationId, businessId);
        await this.prisma.$transaction(async (tx) => {
            await tx.payrollSettings.update({
                where: { locationId },
                data: { ...body, updatedBy: ctx.member.staffId, version: { increment: 1 } },
            });
            await this.audit.record(tx, ctx, { action: 'update', entityType: 'payrollSettings', entityId: locationId, businessId, after: body });
        });
        return settingsView(await this.prisma.payrollSettings.findUniqueOrThrow({ where: { locationId } }));
    }
    // ─────────────────────────── Схема сотрудника (F-09-010…048) ───────────────────────────
    async getScheme(businessId, staffId) {
        const row = await this.prisma.payrollScheme.findFirst({ where: { staffId, businessId } });
        return row ? schemeView(row) : undefined;
    }
    async saveScheme(ctx, staffId, body) {
        const businessId = ctx.member.businessId;
        const staff = await this.prisma.staff.findFirst({ where: { id: staffId, businessId } });
        if (!staff)
            throw new ApiError('not_found', 'Staff not found');
        const existing = await this.prisma.payrollScheme.findUnique({ where: { staffId } });
        await this.prisma.$transaction(async (tx) => {
            if (existing) {
                await tx.payrollScheme.update({ where: { staffId }, data: { data: jsonOf(body), updatedBy: ctx.member.staffId, version: { increment: 1 } } });
            }
            else {
                await tx.payrollScheme.create({ data: { staffId, businessId, data: jsonOf(body), createdBy: ctx.member.staffId, updatedBy: ctx.member.staffId } });
            }
            await this.audit.record(tx, ctx, { action: existing ? 'update' : 'create', entityType: 'payrollScheme', entityId: staffId, businessId, after: { staffId } });
        });
        return schemeView(await this.prisma.payrollScheme.findUniqueOrThrow({ where: { staffId } }));
    }
    async copyScheme(ctx, staffId, fromStaffId) {
        const businessId = ctx.member.businessId;
        const [staff, source] = await Promise.all([
            this.prisma.staff.findFirst({ where: { id: staffId, businessId } }),
            this.prisma.payrollScheme.findFirst({ where: { staffId: fromStaffId, businessId } }),
        ]);
        if (!staff)
            throw new ApiError('not_found', 'Staff not found');
        if (!source)
            throw new ApiError('not_found', 'Source scheme not found');
        return this.saveScheme(ctx, staffId, source.data);
    }
    async listSetupTargets(businessId) {
        const [staff, schemes] = await Promise.all([
            this.prisma.staff.findMany({ where: { businessId, status: { notIn: ['fired', 'disabled'] } }, orderBy: { createdAt: 'asc' } }),
            this.prisma.payrollScheme.findMany({ where: { businessId }, select: { staffId: true } }),
        ]);
        const withScheme = new Set(schemes.map((s) => s.staffId));
        return staff.map((s) => ({ staffId: s.id, name: s.name, hasScheme: withScheme.has(s.id) }));
    }
    /** F-09-104: одна ставка за личные услуги всем выбранным сотрудникам без схемы (не трогает уже настроенных) */
    async bulkApplyDefaultScheme(ctx, staffIds, defaultPercent) {
        const businessId = ctx.member.businessId;
        const staff = await this.prisma.staff.findMany({ where: { id: { in: staffIds }, businessId } });
        const existing = new Set((await this.prisma.payrollScheme.findMany({ where: { staffId: { in: staff.map((s) => s.id) } }, select: { staffId: true } })).map((s) => s.staffId));
        let applied = 0;
        await this.prisma.$transaction(async (tx) => {
            for (const s of staff) {
                if (existing.has(s.id))
                    continue;
                const blocks = emptySchemeBlocks();
                blocks.personalServices = { ...blocks.personalServices, enabled: true, defaultPayout: { unit: 'percent', value: defaultPercent } };
                await tx.payrollScheme.create({ data: { staffId: s.id, businessId, data: jsonOf(blocks), createdBy: ctx.member.staffId, updatedBy: ctx.member.staffId } });
                applied += 1;
            }
            if (applied > 0)
                await this.audit.record(tx, ctx, { action: 'update', entityType: 'payrollScheme', entityId: businessId, businessId, after: { bulkApplied: applied } });
        });
        return applied;
    }
    // ─────────────────────────── Классическая модель: правила (F-09-049/050) ───────────────────────────
    async listRules(businessId) {
        return (await this.prisma.payrollRule.findMany({ where: { businessId }, orderBy: { createdAt: 'asc' } })).map(ruleView);
    }
    async getRule(businessId, id) {
        const row = await this.prisma.payrollRule.findFirst({ where: { id, businessId } });
        if (!row)
            throw new ApiError('not_found', 'Rule not found');
        return ruleView(row);
    }
    async saveRule(ctx, id, body) {
        const businessId = ctx.member.businessId;
        const { name, ...blocks } = body;
        const id_ = id ?? newId('payrollRule');
        if (id) {
            const existing = await this.prisma.payrollRule.findFirst({ where: { id, businessId } });
            if (!existing)
                throw new ApiError('not_found', 'Rule not found');
        }
        await this.prisma.$transaction(async (tx) => {
            if (id) {
                await tx.payrollRule.update({ where: { id }, data: { name, data: jsonOf(blocks), updatedBy: ctx.member.staffId, version: { increment: 1 } } });
            }
            else {
                await tx.payrollRule.create({ data: { id: id_, businessId, name, data: jsonOf(blocks), createdBy: ctx.member.staffId, updatedBy: ctx.member.staffId } });
            }
            await this.audit.record(tx, ctx, { action: id ? 'update' : 'create', entityType: 'payrollRule', entityId: id_, businessId, after: { name } });
        });
        return this.getRule(businessId, id_);
    }
    async deleteRule(ctx, id) {
        const businessId = ctx.member.businessId;
        const row = await this.prisma.payrollRule.findFirst({ where: { id, businessId } });
        if (!row)
            throw new ApiError('not_found', 'Rule not found');
        const inUse = await this.prisma.payrollChart.count({ where: { businessId, OR: [{ standardRuleId: id }] } });
        if (inUse > 0)
            throw new ApiError('in_use', 'Rule used by a chart');
        await this.prisma.$transaction(async (tx) => {
            await tx.payrollRule.delete({ where: { id } });
            await this.audit.record(tx, ctx, { action: 'delete', entityType: 'payrollRule', entityId: id, businessId, before: { name: row.name }, after: null });
        });
    }
    // ─────────────────────────── Классическая модель: критерии (F-09-052) ───────────────────────────
    async listCriteria(businessId) {
        return (await this.prisma.payrollCriterion.findMany({ where: { businessId }, orderBy: { createdAt: 'asc' } })).map(criterionView);
    }
    async getCriterion(businessId, id) {
        const row = await this.prisma.payrollCriterion.findFirst({ where: { id, businessId } });
        if (!row)
            throw new ApiError('not_found', 'Criterion not found');
        return criterionView(row);
    }
    async saveCriterion(ctx, id, body) {
        const businessId = ctx.member.businessId;
        const id_ = id ?? newId('payrollCriterion');
        const data = { name: body.name, period: body.period, metric: body.metric, scope: body.scope, byServices: body.byServices, byProducts: body.byProducts, threshold: BigInt(Math.round(body.threshold)), includeDiscounts: body.includeDiscounts, countCategoryIds: jsonOf(body.countCategoryIds), countItemIds: jsonOf(body.countItemIds) };
        if (id) {
            const existing = await this.prisma.payrollCriterion.findFirst({ where: { id, businessId } });
            if (!existing)
                throw new ApiError('not_found', 'Criterion not found');
        }
        await this.prisma.$transaction(async (tx) => {
            if (id) {
                await tx.payrollCriterion.update({ where: { id }, data: { ...data, updatedBy: ctx.member.staffId, version: { increment: 1 } } });
            }
            else {
                await tx.payrollCriterion.create({ data: { id: id_, businessId, ...data, createdBy: ctx.member.staffId, updatedBy: ctx.member.staffId } });
            }
            await this.audit.record(tx, ctx, { action: id ? 'update' : 'create', entityType: 'payrollCriterion', entityId: id_, businessId, after: { name: body.name } });
        });
        return this.getCriterion(businessId, id_);
    }
    async deleteCriterion(ctx, id) {
        const businessId = ctx.member.businessId;
        const row = await this.prisma.payrollCriterion.findFirst({ where: { id, businessId } });
        if (!row)
            throw new ApiError('not_found', 'Criterion not found');
        const charts = await this.prisma.payrollChart.findMany({ where: { businessId }, select: { planRows: true } });
        const inUse = charts.some((c) => c.planRows.some((r) => r.criterionId === id));
        if (inUse)
            throw new ApiError('in_use', 'Criterion used by a chart');
        await this.prisma.$transaction(async (tx) => {
            await tx.payrollCriterion.delete({ where: { id } });
            await this.audit.record(tx, ctx, { action: 'delete', entityType: 'payrollCriterion', entityId: id, businessId, before: { name: row.name }, after: null });
        });
    }
    // ─────────────────────────── Классическая модель: схемы расчёта — charts (F-09-054) ───────────────────────────
    async listCharts(businessId) {
        return (await this.prisma.payrollChart.findMany({ where: { businessId }, orderBy: { createdAt: 'asc' } })).map(chartView);
    }
    async getChart(businessId, id) {
        const row = await this.prisma.payrollChart.findFirst({ where: { id, businessId } });
        if (!row)
            throw new ApiError('not_found', 'Chart not found');
        return chartView(row);
    }
    async saveChart(ctx, id, body) {
        const businessId = ctx.member.businessId;
        const id_ = id ?? newId('payrollChart');
        const data = { name: body.name, type: body.type, standardRuleId: body.standardRuleId ?? null, planRows: jsonOf(body.planRows) };
        if (id) {
            const existing = await this.prisma.payrollChart.findFirst({ where: { id, businessId } });
            if (!existing)
                throw new ApiError('not_found', 'Chart not found');
        }
        await this.prisma.$transaction(async (tx) => {
            if (id) {
                await tx.payrollChart.update({ where: { id }, data: { ...data, updatedBy: ctx.member.staffId, version: { increment: 1 } } });
            }
            else {
                await tx.payrollChart.create({ data: { id: id_, businessId, ...data, createdBy: ctx.member.staffId, updatedBy: ctx.member.staffId } });
            }
            await this.audit.record(tx, ctx, { action: id ? 'update' : 'create', entityType: 'payrollChart', entityId: id_, businessId, after: { name: body.name } });
        });
        return this.getChart(businessId, id_);
    }
    async deleteChart(ctx, id) {
        const businessId = ctx.member.businessId;
        const row = await this.prisma.payrollChart.findFirst({ where: { id, businessId } });
        if (!row)
            throw new ApiError('not_found', 'Chart not found');
        const assigned = await this.prisma.payrollChartAssignment.count({ where: { chartId: id } });
        if (assigned > 0)
            throw new ApiError('in_use', 'Chart has assignments');
        await this.prisma.$transaction(async (tx) => {
            await tx.payrollChart.delete({ where: { id } });
            await this.audit.record(tx, ctx, { action: 'delete', entityType: 'payrollChart', entityId: id, businessId, before: { name: row.name }, after: null });
        });
    }
    // ─────────────────────────── Классическая модель: назначения (F-09-055) ───────────────────────────
    async listAssignments(businessId, staffId) {
        return (await this.prisma.payrollChartAssignment.findMany({ where: { businessId, ...(staffId ? { staffId } : {}) }, orderBy: { startDate: 'desc' } })).map(assignmentView);
    }
    async createAssignment(ctx, body) {
        const businessId = ctx.member.businessId;
        const [chart, staff] = await Promise.all([this.prisma.payrollChart.findFirst({ where: { id: body.chartId, businessId } }), this.prisma.staff.findFirst({ where: { id: body.staffId, businessId } })]);
        if (!chart)
            throw new ApiError('not_found', 'Chart not found');
        if (!staff)
            throw new ApiError('not_found', 'Staff not found');
        const id = newId('payrollChartAssignment');
        await this.prisma.$transaction(async (tx) => {
            await tx.payrollChartAssignment.create({ data: { id, businessId, chartId: body.chartId, staffId: body.staffId, startDate: new Date(`${body.startDate}T00:00:00.000Z`), createdBy: ctx.member.staffId } });
            await this.audit.record(tx, ctx, { action: 'create', entityType: 'payrollChartAssignment', entityId: id, businessId, after: { chartId: body.chartId, staffId: body.staffId, startDate: body.startDate } });
        });
        return assignmentView(await this.prisma.payrollChartAssignment.findUniqueOrThrow({ where: { id } }));
    }
    async deleteAssignment(ctx, id) {
        const businessId = ctx.member.businessId;
        const row = await this.prisma.payrollChartAssignment.findFirst({ where: { id, businessId } });
        if (!row)
            throw new ApiError('not_found', 'Assignment not found');
        await this.prisma.$transaction(async (tx) => {
            await tx.payrollChartAssignment.delete({ where: { id } });
            await this.audit.record(tx, ctx, { action: 'delete', entityType: 'payrollChartAssignment', entityId: id, businessId, before: { staffId: row.staffId }, after: null });
        });
    }
    // ─────────────────────────── Справочник «Премии и штрафы» (F-09-072) ───────────────────────────
    async listBonusPenaltyTypes(businessId, kind) {
        return (await this.prisma.bonusPenaltyType.findMany({ where: { businessId, ...(kind ? { kind } : {}) }, orderBy: { name: 'asc' } })).map(bonusPenaltyTypeView);
    }
    async saveBonusPenaltyType(ctx, id, body) {
        const businessId = ctx.member.businessId;
        const id_ = id ?? newId('bonusPenaltyType');
        if (id) {
            const existing = await this.prisma.bonusPenaltyType.findFirst({ where: { id, businessId } });
            if (!existing)
                throw new ApiError('not_found', 'Type not found');
        }
        await this.prisma.$transaction(async (tx) => {
            if (id) {
                await tx.bonusPenaltyType.update({ where: { id }, data: { name: body.name, defaultAmount: BigInt(Math.round(body.defaultAmount)) } });
            }
            else {
                await tx.bonusPenaltyType.create({ data: { id: id_, businessId, kind: body.kind, name: body.name, defaultAmount: BigInt(Math.round(body.defaultAmount)) } });
            }
            await this.audit.record(tx, ctx, { action: id ? 'update' : 'create', entityType: 'bonusPenaltyType', entityId: id_, businessId, after: { name: body.name } });
        });
        const row = await this.prisma.bonusPenaltyType.findUniqueOrThrow({ where: { id: id_ } });
        return bonusPenaltyTypeView(row);
    }
    /** F-09-072: удаление шаблона не трогает уже начисленные записи взаиморасчётов */
    async deleteBonusPenaltyType(ctx, id) {
        const businessId = ctx.member.businessId;
        const row = await this.prisma.bonusPenaltyType.findFirst({ where: { id, businessId } });
        if (!row)
            throw new ApiError('not_found', 'Type not found');
        await this.prisma.bonusPenaltyType.delete({ where: { id } });
    }
};
PayrollCatalogService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [PrismaService,
        AuditService])
], PayrollCatalogService);
export { PayrollCatalogService };
//# sourceMappingURL=payroll-catalog.service.js.map