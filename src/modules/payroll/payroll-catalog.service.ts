import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { newId } from '../../common/ids/ids.js';
import { PrismaService } from '../../common/prisma.service.js';
import { DEFAULT_TZ, localDayRangeUtc } from '../../common/time/time.js';
import { emptySchemeBlocks, evaluateCriterion, pickRuleForChart, resolveActiveChartAssignment, roundMoney, type PayrollChartAssignmentData, type SchemeBlocks } from './payroll-engine.js';
import type { AssignmentBody, BonusPenaltyTypeBody, ChartBody, CriterionBody, GeneralSettingsBody, PayrollStaffRightsBody, RuleBody, SchemeBlocksBody } from './payroll.schemas.js';

function jsonOf<T>(v: T): Prisma.InputJsonValue {
  return v as unknown as Prisma.InputJsonValue;
}

function settingsView(r: { locationId: string; businessId: string; accrualDateBasis: string; bankCommissionSplit: string; assistCompensationEnabled: boolean; multipleAssistantsAllowed: boolean; assistantSplitRule: string; payrollModel: string; statementApprovalEnabled: boolean; payrollFundTargetPct: number; payrollFundWarnPct: number; version: number; updatedAt: Date }) {
  return {
    locationId: r.locationId,
    accrualDateBasis: r.accrualDateBasis as GeneralSettingsBody['accrualDateBasis'],
    bankCommissionSplit: r.bankCommissionSplit as GeneralSettingsBody['bankCommissionSplit'],
    assistCompensationEnabled: r.assistCompensationEnabled,
    multipleAssistantsAllowed: r.multipleAssistantsAllowed,
    assistantSplitRule: r.assistantSplitRule as GeneralSettingsBody['assistantSplitRule'],
    payrollModel: r.payrollModel as GeneralSettingsBody['payrollModel'],
    statementApprovalEnabled: r.statementApprovalEnabled,
    payrollFundTargetPct: r.payrollFundTargetPct,
    payrollFundWarnPct: r.payrollFundWarnPct,
    version: r.version,
    updatedAt: r.updatedAt.toISOString(),
  };
}

function schemeView(r: { staffId: string; data: unknown; createdAt: Date; updatedAt: Date; version: number }) {
  return { staffId: r.staffId, ...(r.data as SchemeBlocks), createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(), version: r.version };
}

function ruleView(r: { id: string; businessId: string; name: string; data: unknown; createdAt: Date; updatedAt: Date; version: number }) {
  return { id: r.id, businessId: r.businessId, name: r.name, ...(r.data as Record<string, unknown>), createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(), version: r.version };
}

function criterionView(r: { id: string; businessId: string; name: string; period: string; metric: string; scope: string; byServices: boolean; byProducts: boolean; threshold: bigint; includeDiscounts: boolean; countCategoryIds: unknown; countItemIds: unknown; createdAt: Date; updatedAt: Date; version: number }) {
  return {
    id: r.id,
    businessId: r.businessId,
    name: r.name,
    period: r.period as CriterionBody['period'],
    metric: r.metric as CriterionBody['metric'],
    scope: r.scope as CriterionBody['scope'],
    byServices: r.byServices,
    byProducts: r.byProducts,
    threshold: Number(r.threshold),
    includeDiscounts: r.includeDiscounts,
    countCategoryIds: r.countCategoryIds as string[],
    countItemIds: r.countItemIds as string[],
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    version: r.version,
  };
}

function chartView(r: { id: string; businessId: string; name: string; type: string; standardRuleId: string | null; planRows: unknown; createdAt: Date; updatedAt: Date; version: number }) {
  return { id: r.id, businessId: r.businessId, name: r.name, type: r.type as ChartBody['type'], standardRuleId: r.standardRuleId ?? undefined, planRows: r.planRows as ChartBody['planRows'], createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(), version: r.version };
}

function assignmentView(r: { id: string; businessId: string; chartId: string; staffId: string; startDate: Date; createdAt: Date }) {
  return { id: r.id, businessId: r.businessId, chartId: r.chartId, staffId: r.staffId, startDate: r.startDate.toISOString().slice(0, 10), createdAt: r.createdAt.toISOString() };
}

function bonusPenaltyTypeView(r: { id: string; businessId: string; kind: string; name: string; defaultAmount: bigint; createdAt: Date }) {
  return { id: r.id, businessId: r.businessId, kind: r.kind as BonusPenaltyTypeBody['kind'], name: r.name, defaultAmount: Number(r.defaultAmount), createdAt: r.createdAt.toISOString() };
}

export type PayrollStaffRightsView = PayrollStaffRightsBody & { updatedAt: string };

function rightsView(r: { staffId: string; data: unknown; updatedAt: Date }): PayrollStaffRightsView {
  const d = r.data as { schemesAccess: boolean; calcAccess: PayrollStaffRightsBody['calcAccess']; accrueAccess: PayrollStaffRightsBody['accrueAccess']; ownOnlyStaffId: string | null };
  return { staffId: r.staffId, schemesAccess: d.schemesAccess, calcAccess: d.calcAccess, accrueAccess: d.accrueAccess, ownOnlyStaffId: d.ownOnlyStaffId ?? undefined, updatedAt: r.updatedAt.toISOString() };
}

/** Настройки, схема сотрудника и классическая модель (правила/критерии/схемы/назначения) — F-09-004…057. */
@Injectable()
export class PayrollCatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ─────────────────────────── Основные настройки локации (F-09-004/005) ───────────────────────────

  async ensureSettings(locationId: string, businessId: string) {
    const existing = await this.prisma.payrollSettings.findUnique({ where: { locationId } });
    if (existing) return existing;
    return this.prisma.payrollSettings.create({ data: { locationId, businessId } });
  }

  async getSettings(businessId: string, locationId: string) {
    const location = await this.prisma.location.findFirst({ where: { id: locationId, businessId } });
    if (!location) throw new ApiError('not_found', 'Location not found');
    return settingsView(await this.ensureSettings(locationId, businessId));
  }

  async saveSettings(ctx: RequestContext, locationId: string, body: GeneralSettingsBody) {
    const businessId = ctx.member!.businessId;
    const location = await this.prisma.location.findFirst({ where: { id: locationId, businessId } });
    if (!location) throw new ApiError('not_found', 'Location not found');
    await this.ensureSettings(locationId, businessId);
    await this.prisma.$transaction(async (tx) => {
      await tx.payrollSettings.update({
        where: { locationId },
        data: { ...body, updatedBy: ctx.member!.staffId, version: { increment: 1 } },
      });
      await this.audit.record(tx, ctx, { action: 'update', entityType: 'payrollSettings', entityId: locationId, businessId, after: body });
    });
    return settingsView(await this.prisma.payrollSettings.findUniqueOrThrow({ where: { locationId } }));
  }

  // ─────────────────────────── Схема сотрудника (F-09-010…048) ───────────────────────────

  async getScheme(businessId: string, staffId: string) {
    const row = await this.prisma.payrollScheme.findFirst({ where: { staffId, businessId } });
    return row ? schemeView(row) : undefined;
  }

  async saveScheme(ctx: RequestContext, staffId: string, body: SchemeBlocksBody) {
    const businessId = ctx.member!.businessId;
    const staff = await this.prisma.staff.findFirst({ where: { id: staffId, businessId } });
    if (!staff) throw new ApiError('not_found', 'Staff not found');
    const existing = await this.prisma.payrollScheme.findUnique({ where: { staffId } });
    await this.prisma.$transaction(async (tx) => {
      if (existing) {
        await tx.payrollScheme.update({ where: { staffId }, data: { data: jsonOf(body), updatedBy: ctx.member!.staffId, version: { increment: 1 } } });
      } else {
        await tx.payrollScheme.create({ data: { staffId, businessId, data: jsonOf(body), createdBy: ctx.member!.staffId, updatedBy: ctx.member!.staffId } });
      }
      await this.audit.record(tx, ctx, { action: existing ? 'update' : 'create', entityType: 'payrollScheme', entityId: staffId, businessId, after: { staffId } });
    });
    return schemeView(await this.prisma.payrollScheme.findUniqueOrThrow({ where: { staffId } }));
  }

  async copyScheme(ctx: RequestContext, staffId: string, fromStaffId: string) {
    const businessId = ctx.member!.businessId;
    const [staff, source] = await Promise.all([
      this.prisma.staff.findFirst({ where: { id: staffId, businessId } }),
      this.prisma.payrollScheme.findFirst({ where: { staffId: fromStaffId, businessId } }),
    ]);
    if (!staff) throw new ApiError('not_found', 'Staff not found');
    if (!source) throw new ApiError('not_found', 'Source scheme not found');
    return this.saveScheme(ctx, staffId, source.data as unknown as SchemeBlocksBody);
  }

  async listSetupTargets(businessId: string) {
    const [staff, schemes] = await Promise.all([
      this.prisma.staff.findMany({ where: { businessId, status: { notIn: ['fired', 'disabled'] } }, orderBy: { createdAt: 'asc' } }),
      this.prisma.payrollScheme.findMany({ where: { businessId }, select: { staffId: true } }),
    ]);
    const withScheme = new Set(schemes.map((s) => s.staffId));
    return staff.map((s) => ({ staffId: s.id, name: s.name, hasScheme: withScheme.has(s.id) }));
  }

  /** F-09-104: одна ставка за личные услуги всем выбранным сотрудникам без схемы (не трогает уже настроенных) */
  async bulkApplyDefaultScheme(ctx: RequestContext, staffIds: string[], defaultPercent: number) {
    const businessId = ctx.member!.businessId;
    const staff = await this.prisma.staff.findMany({ where: { id: { in: staffIds }, businessId } });
    const existing = new Set((await this.prisma.payrollScheme.findMany({ where: { staffId: { in: staff.map((s) => s.id) } }, select: { staffId: true } })).map((s) => s.staffId));
    let applied = 0;
    await this.prisma.$transaction(async (tx) => {
      for (const s of staff) {
        if (existing.has(s.id)) continue;
        const blocks = emptySchemeBlocks();
        blocks.personalServices = { ...blocks.personalServices, enabled: true, defaultPayout: { unit: 'percent', value: defaultPercent } };
        await tx.payrollScheme.create({ data: { staffId: s.id, businessId, data: jsonOf(blocks), createdBy: ctx.member!.staffId, updatedBy: ctx.member!.staffId } });
        applied += 1;
      }
      if (applied > 0) await this.audit.record(tx, ctx, { action: 'update', entityType: 'payrollScheme', entityId: businessId, businessId, after: { bulkApplied: applied } });
    });
    return applied;
  }

  // ─────────────────────────── Классическая модель: правила (F-09-049/050) ───────────────────────────

  async listRules(businessId: string) {
    return (await this.prisma.payrollRule.findMany({ where: { businessId }, orderBy: { createdAt: 'asc' } })).map(ruleView);
  }

  async getRule(businessId: string, id: string) {
    const row = await this.prisma.payrollRule.findFirst({ where: { id, businessId } });
    if (!row) throw new ApiError('not_found', 'Rule not found');
    return ruleView(row);
  }

  async saveRule(ctx: RequestContext, id: string | undefined, body: RuleBody) {
    const businessId = ctx.member!.businessId;
    const { name, ...blocks } = body;
    const id_ = id ?? newId('payrollRule');
    if (id) {
      const existing = await this.prisma.payrollRule.findFirst({ where: { id, businessId } });
      if (!existing) throw new ApiError('not_found', 'Rule not found');
    }
    await this.prisma.$transaction(async (tx) => {
      if (id) {
        await tx.payrollRule.update({ where: { id }, data: { name, data: jsonOf(blocks), updatedBy: ctx.member!.staffId, version: { increment: 1 } } });
      } else {
        await tx.payrollRule.create({ data: { id: id_, businessId, name, data: jsonOf(blocks), createdBy: ctx.member!.staffId, updatedBy: ctx.member!.staffId } });
      }
      await this.audit.record(tx, ctx, { action: id ? 'update' : 'create', entityType: 'payrollRule', entityId: id_, businessId, after: { name } });
    });
    return this.getRule(businessId, id_);
  }

  async deleteRule(ctx: RequestContext, id: string) {
    const businessId = ctx.member!.businessId;
    const row = await this.prisma.payrollRule.findFirst({ where: { id, businessId } });
    if (!row) throw new ApiError('not_found', 'Rule not found');
    const inUse = await this.prisma.payrollChart.count({ where: { businessId, OR: [{ standardRuleId: id }] } });
    if (inUse > 0) throw new ApiError('in_use', 'Rule used by a chart');
    await this.prisma.$transaction(async (tx) => {
      await tx.payrollRule.delete({ where: { id } });
      await this.audit.record(tx, ctx, { action: 'delete', entityType: 'payrollRule', entityId: id, businessId, before: { name: row.name }, after: null });
    });
  }

  // ─────────────────────────── Классическая модель: критерии (F-09-052) ───────────────────────────

  async listCriteria(businessId: string) {
    return (await this.prisma.payrollCriterion.findMany({ where: { businessId }, orderBy: { createdAt: 'asc' } })).map(criterionView);
  }

  async getCriterion(businessId: string, id: string) {
    const row = await this.prisma.payrollCriterion.findFirst({ where: { id, businessId } });
    if (!row) throw new ApiError('not_found', 'Criterion not found');
    return criterionView(row);
  }

  async saveCriterion(ctx: RequestContext, id: string | undefined, body: CriterionBody) {
    const businessId = ctx.member!.businessId;
    const id_ = id ?? newId('payrollCriterion');
    const data = { name: body.name, period: body.period, metric: body.metric, scope: body.scope, byServices: body.byServices, byProducts: body.byProducts, threshold: BigInt(Math.round(body.threshold)), includeDiscounts: body.includeDiscounts, countCategoryIds: jsonOf(body.countCategoryIds), countItemIds: jsonOf(body.countItemIds) };
    if (id) {
      const existing = await this.prisma.payrollCriterion.findFirst({ where: { id, businessId } });
      if (!existing) throw new ApiError('not_found', 'Criterion not found');
    }
    await this.prisma.$transaction(async (tx) => {
      if (id) {
        await tx.payrollCriterion.update({ where: { id }, data: { ...data, updatedBy: ctx.member!.staffId, version: { increment: 1 } } });
      } else {
        await tx.payrollCriterion.create({ data: { id: id_, businessId, ...data, createdBy: ctx.member!.staffId, updatedBy: ctx.member!.staffId } });
      }
      await this.audit.record(tx, ctx, { action: id ? 'update' : 'create', entityType: 'payrollCriterion', entityId: id_, businessId, after: { name: body.name } });
    });
    return this.getCriterion(businessId, id_);
  }

  async deleteCriterion(ctx: RequestContext, id: string) {
    const businessId = ctx.member!.businessId;
    const row = await this.prisma.payrollCriterion.findFirst({ where: { id, businessId } });
    if (!row) throw new ApiError('not_found', 'Criterion not found');
    const charts = await this.prisma.payrollChart.findMany({ where: { businessId }, select: { planRows: true } });
    const inUse = charts.some((c) => (c.planRows as { criterionId: string }[]).some((r) => r.criterionId === id));
    if (inUse) throw new ApiError('in_use', 'Criterion used by a chart');
    await this.prisma.$transaction(async (tx) => {
      await tx.payrollCriterion.delete({ where: { id } });
      await this.audit.record(tx, ctx, { action: 'delete', entityType: 'payrollCriterion', entityId: id, businessId, before: { name: row.name }, after: null });
    });
  }

  // ─────────────────────────── Классическая модель: схемы расчёта — charts (F-09-054) ───────────────────────────

  async listCharts(businessId: string) {
    return (await this.prisma.payrollChart.findMany({ where: { businessId }, orderBy: { createdAt: 'asc' } })).map(chartView);
  }

  async getChart(businessId: string, id: string) {
    const row = await this.prisma.payrollChart.findFirst({ where: { id, businessId } });
    if (!row) throw new ApiError('not_found', 'Chart not found');
    return chartView(row);
  }

  async saveChart(ctx: RequestContext, id: string | undefined, body: ChartBody) {
    const businessId = ctx.member!.businessId;
    const id_ = id ?? newId('payrollChart');
    const data = { name: body.name, type: body.type, standardRuleId: body.standardRuleId ?? null, planRows: jsonOf(body.planRows) };
    if (id) {
      const existing = await this.prisma.payrollChart.findFirst({ where: { id, businessId } });
      if (!existing) throw new ApiError('not_found', 'Chart not found');
    }
    await this.prisma.$transaction(async (tx) => {
      if (id) {
        await tx.payrollChart.update({ where: { id }, data: { ...data, updatedBy: ctx.member!.staffId, version: { increment: 1 } } });
      } else {
        await tx.payrollChart.create({ data: { id: id_, businessId, ...data, createdBy: ctx.member!.staffId, updatedBy: ctx.member!.staffId } });
      }
      await this.audit.record(tx, ctx, { action: id ? 'update' : 'create', entityType: 'payrollChart', entityId: id_, businessId, after: { name: body.name } });
    });
    return this.getChart(businessId, id_);
  }

  async deleteChart(ctx: RequestContext, id: string) {
    const businessId = ctx.member!.businessId;
    const row = await this.prisma.payrollChart.findFirst({ where: { id, businessId } });
    if (!row) throw new ApiError('not_found', 'Chart not found');
    const assigned = await this.prisma.payrollChartAssignment.count({ where: { chartId: id } });
    if (assigned > 0) throw new ApiError('in_use', 'Chart has assignments');
    await this.prisma.$transaction(async (tx) => {
      await tx.payrollChart.delete({ where: { id } });
      await this.audit.record(tx, ctx, { action: 'delete', entityType: 'payrollChart', entityId: id, businessId, before: { name: row.name }, after: null });
    });
  }

  // === stage 21 (лейн services+rest) ===
  // Предпросмотр классической модели (F-09-052/054/099, src/api/payroll.ts::evaluateCriterionValue/
  // previewChartForStaff) — не участвует в расчёте ведомости (PayrollComputeService), это отдельный
  // инструмент редактора схем «что сработает у сотрудника на дату». Полный набор метрик (count/profit/
  // категории/позиции/includeDiscounts), в отличие от `evaluateCriterionForStaff` внутри самого расчёта,
  // который сознательно ограничен только `metric==='turnover'` (комментарий в payroll-compute.service.ts) —
  // трогать расчёт ведомости здесь не стал, отдельная зона.
  private async criterionActualValue(
    criterion: { businessId: string; period: string; metric: string; scope: string; byServices: boolean; threshold: bigint; includeDiscounts: boolean; countCategoryIds: unknown; countItemIds: unknown },
    staffId: string,
    locationId: string,
    atDate: string,
  ): Promise<number> {
    const from = criterion.period === 'day' ? atDate : `${atDate.slice(0, 7)}-01`;
    const { from: gte } = localDayRangeUtc(from, DEFAULT_TZ);
    const { to: lt } = localDayRangeUtc(atDate, DEFAULT_TZ);
    const bookings = await this.prisma.booking.findMany({ where: { businessId: criterion.businessId, locationId, startAt: { gte, lt }, status: 'arrived', deletedAt: null }, select: { services: true } });
    const countCategoryIds = (criterion.countCategoryIds as string[] | null) ?? [];
    const countItemIds = (criterion.countItemIds as string[] | null) ?? [];
    let serviceCategoryById: Map<string, string | null> | undefined;
    if (countCategoryIds.length) {
      const services = await this.prisma.service.findMany({ where: { businessId: criterion.businessId }, select: { id: true, categoryId: true } });
      serviceCategoryById = new Map(services.map((s) => [s.id, s.categoryId]));
    }
    let turnover = 0;
    let count = 0;
    for (const row of bookings) {
      const lines = (row.services as unknown as { serviceId: string; staffId: string; price: number; qty: number; unitPrice?: number }[] | null) ?? [];
      for (const line of lines) {
        if (criterion.scope === 'staff' && line.staffId !== staffId) continue;
        if (!criterion.byServices) continue;
        if (countCategoryIds.length || countItemIds.length) {
          const categoryId = serviceCategoryById?.get(line.serviceId);
          const matches = countItemIds.includes(line.serviceId) || (categoryId != null && countCategoryIds.includes(categoryId));
          if (!matches) continue;
        }
        const amount = criterion.includeDiscounts ? line.price * line.qty : (line.unitPrice ?? line.price) * line.qty;
        turnover = roundMoney(turnover + amount);
        count += line.qty;
      }
    }
    if (criterion.metric === 'count') return count;
    if (criterion.metric === 'profit') return roundMoney(turnover * 0.3);
    return turnover;
  }

  async evaluateCriterionValue(businessId: string, criterionId: string, staffId: string, locationId: string, atDate: string): Promise<number> {
    const criterion = await this.prisma.payrollCriterion.findFirst({ where: { id: criterionId, businessId } });
    if (!criterion) throw new ApiError('not_found', 'Criterion not found');
    return this.criterionActualValue(criterion, staffId, locationId, atDate);
  }

  async previewChartForStaff(businessId: string, staffId: string, locationId: string, atDate: string) {
    const assignmentRows = await this.prisma.payrollChartAssignment.findMany({ where: { businessId, staffId } });
    const assignments: PayrollChartAssignmentData[] = assignmentRows.map((a) => ({ chartId: a.chartId, staffId: a.staffId, startDate: a.startDate.toISOString().slice(0, 10) }));
    const assignment = resolveActiveChartAssignment(assignments, staffId, atDate);
    if (!assignment) return undefined;
    const chartRow = await this.prisma.payrollChart.findFirst({ where: { id: assignment.chartId, businessId } });
    if (!chartRow) return undefined;
    const planRows = chartRow.planRows as { criterionId: string; ruleId: string }[];
    const criterionIds = [...new Set(planRows.map((r) => r.criterionId))];
    const criterionRows = criterionIds.length ? await this.prisma.payrollCriterion.findMany({ where: { id: { in: criterionIds }, businessId } }) : [];
    const criterionById = new Map(criterionRows.map((c) => [c.id, c]));
    const met = new Map<string, boolean>();
    for (const row of planRows) {
      const criterion = criterionById.get(row.criterionId);
      if (!criterion) continue;
      const value = await this.criterionActualValue(criterion, staffId, locationId, atDate);
      met.set(row.criterionId, evaluateCriterion(Number(criterion.threshold), value));
    }
    const ruleId = pickRuleForChart({ type: chartRow.type as 'standard' | 'planned', standardRuleId: chartRow.standardRuleId, planRows }, (id) => met.get(id) ?? false);
    const matchedRow = planRows.find((r) => met.get(r.criterionId));
    const rule = ruleId ? await this.getRule(businessId, ruleId).catch(() => undefined) : undefined;
    return { chart: chartView(chartRow), ruleId, rule, matchedCriterionId: matchedRow?.criterionId };
  }

  // ─────────────────────────── Классическая модель: назначения (F-09-055) ───────────────────────────

  async listAssignments(businessId: string, staffId?: string) {
    return (await this.prisma.payrollChartAssignment.findMany({ where: { businessId, ...(staffId ? { staffId } : {}) }, orderBy: { startDate: 'desc' } })).map(assignmentView);
  }

  async createAssignment(ctx: RequestContext, body: AssignmentBody) {
    const businessId = ctx.member!.businessId;
    const [chart, staff] = await Promise.all([this.prisma.payrollChart.findFirst({ where: { id: body.chartId, businessId } }), this.prisma.staff.findFirst({ where: { id: body.staffId, businessId } })]);
    if (!chart) throw new ApiError('not_found', 'Chart not found');
    if (!staff) throw new ApiError('not_found', 'Staff not found');
    const id = newId('payrollChartAssignment');
    await this.prisma.$transaction(async (tx) => {
      await tx.payrollChartAssignment.create({ data: { id, businessId, chartId: body.chartId, staffId: body.staffId, startDate: new Date(`${body.startDate}T00:00:00.000Z`), createdBy: ctx.member!.staffId } });
      await this.audit.record(tx, ctx, { action: 'create', entityType: 'payrollChartAssignment', entityId: id, businessId, after: { chartId: body.chartId, staffId: body.staffId, startDate: body.startDate } });
    });
    return assignmentView(await this.prisma.payrollChartAssignment.findUniqueOrThrow({ where: { id } }));
  }

  async deleteAssignment(ctx: RequestContext, id: string) {
    const businessId = ctx.member!.businessId;
    const row = await this.prisma.payrollChartAssignment.findFirst({ where: { id, businessId } });
    if (!row) throw new ApiError('not_found', 'Assignment not found');
    await this.prisma.$transaction(async (tx) => {
      await tx.payrollChartAssignment.delete({ where: { id } });
      await this.audit.record(tx, ctx, { action: 'delete', entityType: 'payrollChartAssignment', entityId: id, businessId, before: { staffId: row.staffId }, after: null });
    });
  }

  // ─────────────────────────── Справочник «Премии и штрафы» (F-09-072) ───────────────────────────

  async listBonusPenaltyTypes(businessId: string, kind?: 'bonus' | 'penalty') {
    return (await this.prisma.bonusPenaltyType.findMany({ where: { businessId, ...(kind ? { kind } : {}) }, orderBy: { name: 'asc' } })).map(bonusPenaltyTypeView);
  }

  async saveBonusPenaltyType(ctx: RequestContext, id: string | undefined, body: BonusPenaltyTypeBody) {
    const businessId = ctx.member!.businessId;
    const id_ = id ?? newId('bonusPenaltyType');
    if (id) {
      const existing = await this.prisma.bonusPenaltyType.findFirst({ where: { id, businessId } });
      if (!existing) throw new ApiError('not_found', 'Type not found');
    }
    await this.prisma.$transaction(async (tx) => {
      if (id) {
        await tx.bonusPenaltyType.update({ where: { id }, data: { name: body.name, defaultAmount: BigInt(Math.round(body.defaultAmount)) } });
      } else {
        await tx.bonusPenaltyType.create({ data: { id: id_, businessId, kind: body.kind, name: body.name, defaultAmount: BigInt(Math.round(body.defaultAmount)) } });
      }
      await this.audit.record(tx, ctx, { action: id ? 'update' : 'create', entityType: 'bonusPenaltyType', entityId: id_, businessId, after: { name: body.name } });
    });
    const row = await this.prisma.bonusPenaltyType.findUniqueOrThrow({ where: { id: id_ } });
    return bonusPenaltyTypeView(row);
  }

  /** F-09-072: удаление шаблона не трогает уже начисленные записи взаиморасчётов */
  async deleteBonusPenaltyType(ctx: RequestContext, id: string) {
    const businessId = ctx.member!.businessId;
    const row = await this.prisma.bonusPenaltyType.findFirst({ where: { id, businessId } });
    if (!row) throw new ApiError('not_found', 'Type not found');
    await this.prisma.bonusPenaltyType.delete({ where: { id } });
  }

  // === stage 21 (лейн services+rest) ═══ Права на раздел «Зарплата» (F-09-085…089) ═══

  async getStaffRights(businessId: string, staffId: string): Promise<PayrollStaffRightsView | undefined> {
    const row = await this.prisma.payrollStaffRights.findFirst({ where: { staffId, businessId } });
    return row ? rightsView(row) : undefined;
  }

  async listStaffRights(businessId: string): Promise<Record<string, PayrollStaffRightsView>> {
    const rows = await this.prisma.payrollStaffRights.findMany({ where: { businessId } });
    const out: Record<string, PayrollStaffRightsView> = {};
    for (const row of rows) out[row.staffId] = rightsView(row);
    return out;
  }

  /** F-09-085: точка входа — без `staff.manage` меняет права только тот, у кого уже включён `schemesAccess` */
  private assertCanEditRights(ctx: RequestContext) {
    if (ctx.member!.permissions.has('staff.manage')) return;
    throw new ApiError('forbidden', 'Only staff.manage can change payroll rights');
  }

  async saveStaffRights(ctx: RequestContext, body: PayrollStaffRightsBody): Promise<PayrollStaffRightsView> {
    this.assertCanEditRights(ctx);
    const businessId = ctx.member!.businessId;
    const staff = await this.prisma.staff.findFirst({ where: { id: body.staffId, businessId } });
    if (!staff) throw new ApiError('not_found', 'Staff not found');
    const data = jsonOf({ schemesAccess: body.schemesAccess, calcAccess: body.calcAccess, accrueAccess: body.accrueAccess, ownOnlyStaffId: body.ownOnlyStaffId ?? null });
    const row = await this.prisma.payrollStaffRights.upsert({
      where: { staffId: body.staffId },
      create: { staffId: body.staffId, businessId, data, updatedBy: ctx.member!.staffId },
      update: { data, updatedBy: ctx.member!.staffId },
    });
    return rightsView(row);
  }

  async saveStaffRightsBatch(ctx: RequestContext, list: PayrollStaffRightsBody[]): Promise<PayrollStaffRightsView[]> {
    this.assertCanEditRights(ctx);
    const businessId = ctx.member!.businessId;
    const staffIds = list.map((r) => r.staffId);
    const known = new Set((await this.prisma.staff.findMany({ where: { id: { in: staffIds }, businessId }, select: { id: true } })).map((s) => s.id));
    for (const r of list) if (!known.has(r.staffId)) throw new ApiError('not_found', `Staff not found: ${r.staffId}`);
    const rows = await this.prisma.$transaction(
      list.map((body) => {
        const data = jsonOf({ schemesAccess: body.schemesAccess, calcAccess: body.calcAccess, accrueAccess: body.accrueAccess, ownOnlyStaffId: body.ownOnlyStaffId ?? null });
        return this.prisma.payrollStaffRights.upsert({
          where: { staffId: body.staffId },
          create: { staffId: body.staffId, businessId, data, updatedBy: ctx.member!.staffId },
          update: { data, updatedBy: ctx.member!.staffId },
        });
      }),
    );
    return rows.map(rightsView);
  }
}
