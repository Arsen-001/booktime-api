import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { Biz, Ctx } from '../../common/http/guards.js';
import { ZodBody, ZodOk } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { PayrollCatalogService } from './payroll-catalog.service.js';
import { PayrollComputeService } from './payroll-compute.service.js';
import { PayrollSettlementsService } from './payroll-settlements.service.js';
import { assignmentBody, bonusPenaltyTypeBody, bulkApplySchemeBody, chartBody, criterionBody, generalSettingsBody, payoutBody, payrollStaffRightsBatchBody, payrollStaffRightsBody, ruleBody, schemeBlocksBody, settlementEntryBody, settlementSheetBody, type PayrollStaffRightsBatchBody, type PayrollStaffRightsBody } from './payroll.schemas.js';

/**
 * Чьи строки видит сотрудник в расчёте (день/период/ведомость) — как мок (ownOnlyStaffIdForActor, решение владельца
 * 01.10.2026): payroll.manage или payroll.view — все строки; без обоих — только своя. Право сотрудника «Зарплата»
 * «только конкретный сотрудник» (F-09-088, ownOnlyStaffId), если задано, сужает до этого сотрудника.
 */
async function calcScope(ctx: RequestContext, catalog: PayrollCatalogService): Promise<string | undefined> {
  const member = ctx.member!;
  if (member.permissions.has('payroll.manage')) return undefined;
  if (!member.permissions.has('payroll.view')) return member.staffId;
  const rights = await catalog.getStaffRights(member.businessId, member.staffId);
  return rights?.ownOnlyStaffId || undefined;
}

function requireLocationId(locationId?: string): string {
  if (!locationId) throw new ApiError('validation', 'locationId is required');
  return locationId;
}

/** Основные настройки, классическая модель, расчёты, справочник премий/штрафов, аналитика (F-09-004…101). */
@ApiTags('payroll')
@Controller('v1/biz/:businessId/payroll')
export class PayrollController {
  constructor(
    private readonly catalog: PayrollCatalogService,
    private readonly compute: PayrollComputeService,
    private readonly settlements: PayrollSettlementsService,
  ) {}

  // ─────────────────────────── Основные настройки (F-09-004/005) ───────────────────────────

  @Get('settings')
  @Biz('payroll.view')
  getSettings(@Ctx() ctx: RequestContext, @Query('locationId') locationId?: string) {
    return this.catalog.getSettings(ctx.member!.businessId, requireLocationId(locationId));
  }

  @Patch('settings')
  @Biz('payroll.manage')
  @ZodBody(generalSettingsBody)
  saveSettings(@Ctx() ctx: RequestContext, @Query('locationId') locationId: string | undefined, @Body(new Zod(generalSettingsBody)) body: z.infer<typeof generalSettingsBody>) {
    return this.catalog.saveSettings(ctx, requireLocationId(locationId), body);
  }

  // ─────────────────────────── Расчёт (F-09-058…065) ───────────────────────────

  @Get('day')
  @Biz()
  async day(@Ctx() ctx: RequestContext, @Query('locationId') locationId: string | undefined, @Query('date') date: string) {
    return this.compute.computeDay(ctx.member!.businessId, requireLocationId(locationId), date, await calcScope(ctx, this.catalog));
  }

  @Get('period')
  @Biz()
  async period(@Ctx() ctx: RequestContext, @Query('locationId') locationId: string | undefined, @Query('from') from: string, @Query('to') to: string, @Query('positionKey') positionKey?: string) {
    return this.compute.computePeriod(ctx.member!.businessId, requireLocationId(locationId), from, to, positionKey, await calcScope(ctx, this.catalog));
  }

  @Get('statement')
  @Biz()
  async statement(@Ctx() ctx: RequestContext, @Query('locationId') locationId: string | undefined, @Query('staffId') staffId: string, @Query('from') from: string, @Query('to') to: string) {
    const own = await calcScope(ctx, this.catalog);
    if (own && own !== staffId) throw new ApiError('forbidden', 'Own statement only');
    return this.compute.computeStatement(ctx.member!.businessId, requireLocationId(locationId), staffId, from, to);
  }

  @Get('fund-analytics')
  @Biz('payroll.manage')
  fundAnalytics(@Ctx() ctx: RequestContext, @Query('locationId') locationId: string | undefined, @Query('from') from: string, @Query('to') to: string) {
    return this.settlements.fundAnalytics(ctx.member!.businessId, requireLocationId(locationId), from, to);
  }

  // ─────────────────────────── b04: быстрая настройка при подключении (F-09-104) ───────────────────────────

  @Get('setup-targets')
  @Biz('payroll.manage')
  setupTargets(@Ctx() ctx: RequestContext) {
    return this.catalog.listSetupTargets(ctx.member!.businessId);
  }

  @Post('setup-targets/bulk-apply')
  @Biz('payroll.manage')
  @ZodBody(bulkApplySchemeBody)
  bulkApply(@Ctx() ctx: RequestContext, @Body(new Zod(bulkApplySchemeBody)) body: z.infer<typeof bulkApplySchemeBody>) {
    return this.catalog.bulkApplyDefaultScheme(ctx, body.staffIds, body.defaultPercent).then((applied) => ({ applied }));
  }

  // ─────────────────────────── Классическая модель: правила (F-09-049/050) ───────────────────────────

  @Get('rules')
  @Biz('payroll.manage')
  listRules(@Ctx() ctx: RequestContext) {
    return this.catalog.listRules(ctx.member!.businessId);
  }

  @Get('rules/:id')
  @Biz('payroll.manage')
  getRule(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.catalog.getRule(ctx.member!.businessId, id);
  }

  @Post('rules')
  @Biz('payroll.manage')
  @ZodBody(ruleBody)
  createRule(@Ctx() ctx: RequestContext, @Body(new Zod(ruleBody)) body: z.infer<typeof ruleBody>) {
    return this.catalog.saveRule(ctx, undefined, body);
  }

  @Patch('rules/:id')
  @Biz('payroll.manage')
  @ZodBody(ruleBody)
  updateRule(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(ruleBody)) body: z.infer<typeof ruleBody>) {
    return this.catalog.saveRule(ctx, id, body);
  }

  @Delete('rules/:id')
  @Biz('payroll.manage')
  @HttpCode(200)
  @ZodOk(z.object({ ok: z.literal(true) }))
  async deleteRule(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    await this.catalog.deleteRule(ctx, id);
    return { ok: true as const };
  }

  // ─────────────────────────── Классическая модель: критерии (F-09-052) ───────────────────────────

  @Get('criteria')
  @Biz('payroll.manage')
  listCriteria(@Ctx() ctx: RequestContext) {
    return this.catalog.listCriteria(ctx.member!.businessId);
  }

  @Get('criteria/:id')
  @Biz('payroll.manage')
  getCriterion(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.catalog.getCriterion(ctx.member!.businessId, id);
  }

  // === stage 21 (лейн services+rest) ===
  /** F-09-052: предпросмотр значения критерия для сотрудника/филиала на дату (src/api/payroll.ts::evaluateCriterionValue) */
  @Get('criteria/:id/value')
  @Biz('payroll.manage')
  evaluateCriterionValue(@Ctx() ctx: RequestContext, @Param('id') id: string, @Query('staffId') staffId: string, @Query('locationId') locationId: string, @Query('atDate') atDate: string) {
    return this.catalog.evaluateCriterionValue(ctx.member!.businessId, id, staffId, locationId, atDate);
  }

  /** F-09-054/055/099: предпросмотр правила у сотрудника на дату (src/api/payroll.ts::previewChartForStaff) */
  @Get('preview')
  @Biz('payroll.manage')
  previewChartForStaff(@Ctx() ctx: RequestContext, @Query('staffId') staffId: string, @Query('locationId') locationId: string, @Query('atDate') atDate: string) {
    return this.catalog.previewChartForStaff(ctx.member!.businessId, staffId, locationId, atDate);
  }

  @Post('criteria')
  @Biz('payroll.manage')
  @ZodBody(criterionBody)
  createCriterion(@Ctx() ctx: RequestContext, @Body(new Zod(criterionBody)) body: z.infer<typeof criterionBody>) {
    return this.catalog.saveCriterion(ctx, undefined, body);
  }

  @Patch('criteria/:id')
  @Biz('payroll.manage')
  @ZodBody(criterionBody)
  updateCriterion(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(criterionBody)) body: z.infer<typeof criterionBody>) {
    return this.catalog.saveCriterion(ctx, id, body);
  }

  @Delete('criteria/:id')
  @Biz('payroll.manage')
  @HttpCode(200)
  @ZodOk(z.object({ ok: z.literal(true) }))
  async deleteCriterion(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    await this.catalog.deleteCriterion(ctx, id);
    return { ok: true as const };
  }

  // ─────────────────────────── Классическая модель: схемы расчёта — charts (F-09-054) ───────────────────────────

  @Get('charts')
  @Biz('payroll.manage')
  listCharts(@Ctx() ctx: RequestContext) {
    return this.catalog.listCharts(ctx.member!.businessId);
  }

  @Get('charts/:id')
  @Biz('payroll.manage')
  getChart(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.catalog.getChart(ctx.member!.businessId, id);
  }

  @Post('charts')
  @Biz('payroll.manage')
  @ZodBody(chartBody)
  createChart(@Ctx() ctx: RequestContext, @Body(new Zod(chartBody)) body: z.infer<typeof chartBody>) {
    return this.catalog.saveChart(ctx, undefined, body);
  }

  @Patch('charts/:id')
  @Biz('payroll.manage')
  @ZodBody(chartBody)
  updateChart(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(chartBody)) body: z.infer<typeof chartBody>) {
    return this.catalog.saveChart(ctx, id, body);
  }

  @Delete('charts/:id')
  @Biz('payroll.manage')
  @HttpCode(200)
  @ZodOk(z.object({ ok: z.literal(true) }))
  async deleteChart(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    await this.catalog.deleteChart(ctx, id);
    return { ok: true as const };
  }

  // ─────────────────────────── Классическая модель: назначения (F-09-055) ───────────────────────────

  @Get('assignments')
  @Biz('payroll.manage')
  listAssignments(@Ctx() ctx: RequestContext, @Query('staffId') staffId?: string) {
    return this.catalog.listAssignments(ctx.member!.businessId, staffId);
  }

  @Post('assignments')
  @Biz('payroll.manage')
  @ZodBody(assignmentBody)
  createAssignment(@Ctx() ctx: RequestContext, @Body(new Zod(assignmentBody)) body: z.infer<typeof assignmentBody>) {
    return this.catalog.createAssignment(ctx, body);
  }

  @Delete('assignments/:id')
  @Biz('payroll.manage')
  @HttpCode(200)
  @ZodOk(z.object({ ok: z.literal(true) }))
  async deleteAssignment(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    await this.catalog.deleteAssignment(ctx, id);
    return { ok: true as const };
  }

  // ─────────────────────────── Справочник «Премии и штрафы» (F-09-072) ───────────────────────────

  @Get('bonus-penalty-types')
  @Biz('payroll.view')
  listBonusPenaltyTypes(@Ctx() ctx: RequestContext, @Query('kind') kind?: 'bonus' | 'penalty') {
    return this.catalog.listBonusPenaltyTypes(ctx.member!.businessId, kind);
  }

  @Post('bonus-penalty-types')
  @Biz('payroll.manage')
  @ZodBody(bonusPenaltyTypeBody)
  createBonusPenaltyType(@Ctx() ctx: RequestContext, @Body(new Zod(bonusPenaltyTypeBody)) body: z.infer<typeof bonusPenaltyTypeBody>) {
    return this.catalog.saveBonusPenaltyType(ctx, undefined, body);
  }

  @Patch('bonus-penalty-types/:id')
  @Biz('payroll.manage')
  @ZodBody(bonusPenaltyTypeBody)
  updateBonusPenaltyType(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(bonusPenaltyTypeBody)) body: z.infer<typeof bonusPenaltyTypeBody>) {
    return this.catalog.saveBonusPenaltyType(ctx, id, body);
  }

  @Delete('bonus-penalty-types/:id')
  @Biz('payroll.manage')
  @HttpCode(200)
  @ZodOk(z.object({ ok: z.literal(true) }))
  async deleteBonusPenaltyType(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    await this.catalog.deleteBonusPenaltyType(ctx, id);
    return { ok: true as const };
  }

  // === stage 21 (лейн services+rest) ═══ Права на раздел «Зарплата» (F-09-085…089) ═══

  @Get('rights')
  // Все права видит staff.manage; остальные — только свою строку («Моя зарплата» читает ограничения о себе:
  // «только текущий день» и т. п.; раньше мастер получал 403 и ограничения не применялись)
  @Biz()
  async listRights(@Ctx() ctx: RequestContext) {
    const all = await this.catalog.listStaffRights(ctx.member!.businessId);
    if (ctx.member!.permissions.has('staff.manage')) return all;
    const own = ctx.member!.staffId ? all[ctx.member!.staffId] : undefined;
    return own && ctx.member!.staffId ? { [ctx.member!.staffId]: own } : {};
  }

  /** F-09-001/010: «Схемы расчёта» — статус схемы у всех сотрудников разом (этап 21, лейн rest) */
  @Get('schemes')
  @Biz('payroll.view')
  listSchemes(@Ctx() ctx: RequestContext) {
    return this.catalog.listSchemesByBusiness(ctx.member!.businessId);
  }

  @Post('rights')
  @Biz('staff.manage')
  @ZodBody(payrollStaffRightsBody)
  saveRights(@Ctx() ctx: RequestContext, @Body(new Zod(payrollStaffRightsBody)) body: PayrollStaffRightsBody) {
    return this.catalog.saveStaffRights(ctx, body);
  }

  /** З14/М2: несколько сотрудников одной кнопкой — один запрос, не N */
  @Post('rights/batch')
  @Biz('staff.manage')
  @ZodBody(payrollStaffRightsBatchBody)
  saveRightsBatch(@Ctx() ctx: RequestContext, @Body(new Zod(payrollStaffRightsBatchBody)) body: PayrollStaffRightsBatchBody) {
    return this.catalog.saveStaffRightsBatch(ctx, body.list);
  }

  // ─────────────────────────── Взаиморасчёты и выплата (F-07-159…162, F-09-066…080) ───────────────────────────

  @Post('settlements/sheet')
  @Biz('payroll.manage')
  @ZodBody(settlementSheetBody)
  createSheet(@Ctx() ctx: RequestContext, @Body(new Zod(settlementSheetBody)) body: z.infer<typeof settlementSheetBody>) {
    return this.settlements.createSheet(ctx, body);
  }

  @Post('settlements/:id/accrue')
  @Biz('payroll.manage')
  accrueSheet(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.settlements.accrueSheet(ctx, id);
  }

  @Post('settlements/entry')
  @Biz('payroll.manage')
  @ZodBody(settlementEntryBody)
  createEntry(@Ctx() ctx: RequestContext, @Body(new Zod(settlementEntryBody)) body: z.infer<typeof settlementEntryBody>) {
    return this.settlements.createEntry(ctx, body);
  }

  @Delete('settlements/:id')
  @Biz('payroll.manage')
  @HttpCode(200)
  @ZodOk(z.object({ ok: z.literal(true) }))
  async deleteEntry(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    await this.settlements.deleteEntry(ctx, id);
    return { ok: true as const };
  }

  @Post('payouts')
  @Biz('payroll.manage')
  @ZodBody(payoutBody)
  payout(@Ctx() ctx: RequestContext, @Body(new Zod(payoutBody)) body: z.infer<typeof payoutBody>) {
    return this.settlements.payout(ctx, body);
  }

  @Get('statements/:sheetId/approval')
  @Biz('payroll.view')
  getApproval(@Ctx() ctx: RequestContext, @Param('sheetId') sheetId: string) {
    return this.settlements.getApproval(ctx.member!.businessId, sheetId);
  }

  @Post('statements/:sheetId/approval/advance')
  @Biz('payroll.manage')
  advanceApproval(@Ctx() ctx: RequestContext, @Param('sheetId') sheetId: string) {
    return this.settlements.advanceApproval(ctx, sheetId);
  }

  @Post('statements/:sheetId/approval/sign')
  @Biz('payroll.view')
  signApproval(@Ctx() ctx: RequestContext, @Param('sheetId') sheetId: string) {
    return this.settlements.signApproval(ctx.member!.businessId, sheetId, ctx.member!.staffId);
  }
}

/** Схема сотрудника и его взаиморасчёты — гнездится под /staff/:staffId (F-09-010…048, F-07-159…162). */
@ApiTags('payroll')
@Controller('v1/biz/:businessId/staff/:staffId')
export class PayrollStaffController {
  constructor(
    private readonly catalog: PayrollCatalogService,
    private readonly settlements: PayrollSettlementsService,
  ) {}

  private assertOwnOrManage(ctx: RequestContext, staffId: string) {
    if (!ctx.member!.permissions.has('payroll.manage') && ctx.member!.staffId !== staffId) throw new ApiError('forbidden', 'Own scheme/settlements only');
  }

  @Get('payroll-scheme')
  @Biz('payroll.view')
  getScheme(@Ctx() ctx: RequestContext, @Param('staffId') staffId: string) {
    this.assertOwnOrManage(ctx, staffId);
    return this.catalog.getScheme(ctx.member!.businessId, staffId);
  }

  @Patch('payroll-scheme')
  @Biz('payroll.manage')
  @ZodBody(schemeBlocksBody)
  saveScheme(@Ctx() ctx: RequestContext, @Param('staffId') staffId: string, @Body(new Zod(schemeBlocksBody)) body: z.infer<typeof schemeBlocksBody>) {
    return this.catalog.saveScheme(ctx, staffId, body);
  }

  @Post('payroll-scheme/copy-from/:otherStaffId')
  @Biz('payroll.manage')
  copyScheme(@Ctx() ctx: RequestContext, @Param('staffId') staffId: string, @Param('otherStaffId') otherStaffId: string) {
    return this.catalog.copyScheme(ctx, staffId, otherStaffId);
  }

  /** === stage 21 (лейн services+rest) === F-09-085…089: одного сотрудника — управленческий экран, не самообслуживание */
  @Get('payroll-rights')
  @Biz('staff.manage')
  getRights(@Ctx() ctx: RequestContext, @Param('staffId') staffId: string) {
    return this.catalog.getStaffRights(ctx.member!.businessId, staffId);
  }

  @Get('settlements')
  // Свои взаиморасчёты видит любой сотрудник («Моя зарплата» → «Выплаты»; у мастера с 01.10 нет payroll.view),
  // чужие — только с payroll.manage (assertOwnOrManage)
  @Biz()
  listSettlements(@Ctx() ctx: RequestContext, @Param('staffId') staffId: string, @Query('periodFrom') periodFrom?: string, @Query('periodTo') periodTo?: string) {
    this.assertOwnOrManage(ctx, staffId);
    return this.settlements.list(ctx.member!.businessId, staffId, periodFrom, periodTo);
  }

  @Get('settlements/balance')
  // Свои взаиморасчёты видит любой сотрудник («Моя зарплата» → «Выплаты»; у мастера с 01.10 нет payroll.view),
  // чужие — только с payroll.manage (assertOwnOrManage)
  @Biz()
  balance(@Ctx() ctx: RequestContext, @Param('staffId') staffId: string) {
    this.assertOwnOrManage(ctx, staffId);
    return this.settlements.staffBalance(ctx.member!.businessId, staffId);
  }
}
