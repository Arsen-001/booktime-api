import { Body, Controller, Delete, Get, Header, Param, Patch, Post, Query, StreamableFile } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { createFileStorage } from '../../adapters/storage/storage.js';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { Biz, Ctx } from '../../common/http/guards.js';
import { ZodBody, ZodOk } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { ReportsAuditService } from './reports-audit.service.js';
import { ReportsDashboardService } from './reports-dashboard.service.js';
import { ReportsExportService } from './reports-export.service.js';
import { ReportsJournalService } from './reports-journal.service.js';
import { ReportsMarketingService } from './reports-marketing.service.js';
import type { ReportServices } from './reports-registry.js';
import { REPORT_REGISTRY } from './reports-registry.js';
import { ReportsReviewsService } from './reports-reviews.service.js';
import { ReportsSalesService } from './reports-sales.service.js';
import { ReportsSettingsService } from './reports-settings.service.js';
import { ReportsStockService } from './reports-stock.service.js';
import {
  clientVisitsQuery,
  exportsListQuery,
  manualExportBody,
  promotionNotReturnedQuery,
  reportsPermissionsPatchBody,
  reviewsQuery,
  setReviewHiddenBody,
  stockBalanceQuery,
  stockOrderQuery,
  stockRangeCategoryQuery,
  stockTurnoverQuery,
  stockWriteOffQuery,
  workloadIncludedBody,
} from './reports.schemas.js';

/**
 * Отчёты (docs/backend/02 §16): «один маршрут на отчёт» — `GET /v1/biz/{b}/reports/{name}`, диспетчер
 * `REPORT_REGISTRY` (reports-registry.ts), а не 11 разных обработчиков. Выгрузка ставит задачу воркеру
 * (`POST …/reports/{name}/export`) и отдаёт файл, когда он готов (`GET …/reports/exports/{id}/download`).
 * Деньги в отчётах — отдельное право `finance.view` (F-00-132, открыто в ТЗ, кто именно в салоне видит деньги) —
 * здесь решение: то же `reports.view`, «Финансовый отчёт»/P&L документ §16 не входят в эту пачку (см. PROGRESS.md).
 */
@ApiTags('reports')
@Controller('v1/biz/:businessId/reports')
export class ReportsController {
  private readonly services: ReportServices;

  constructor(
    dashboard: ReportsDashboardService,
    private readonly journal: ReportsJournalService,
    sales: ReportsSalesService,
    private readonly marketing: ReportsMarketingService,
    audit: ReportsAuditService,
    private readonly settings: ReportsSettingsService,
    private readonly exports: ReportsExportService,
    private readonly reviews: ReportsReviewsService,
    private readonly stock: ReportsStockService,
  ) {
    this.services = { dashboard, journal, sales, marketing, audit };
  }

  // ─────────────────────────── F-12-003: избранное, F-12-084…089: права ───────────────────────────

  @Get('favorites')
  @Biz()
  favorites(@Ctx() ctx: RequestContext) {
    return this.settings.listFavorites(ctx.member!.staffId);
  }

  @Post('favorites/:slug')
  @Biz()
  @ZodOk(z.array(z.object({ slug: z.string(), addedAt: z.string() })))
  toggleFavorite(@Ctx() ctx: RequestContext, @Param('slug') slug: string) {
    return this.settings.toggleFavorite(ctx.member!.staffId, slug);
  }

  @Get('permissions/:staffId')
  @Biz('staff.view')
  permissions(@Param('businessId') businessId: string, @Param('staffId') staffId: string) {
    return this.settings.getPermissions(businessId, staffId);
  }

  @Patch('permissions/:staffId')
  @Biz('staff.manage')
  @ZodBody(reportsPermissionsPatchBody)
  setPermissions(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('staffId') staffId: string, @Body(new Zod(reportsPermissionsPatchBody)) body: z.infer<typeof reportsPermissionsPatchBody>) {
    return this.settings.setPermissions(ctx, businessId, staffId, body);
  }

  @Patch('load/staff/:staffId')
  @Biz('staff.manage')
  @ApiOperation({ summary: '«Учитывать сотрудника в заполненности» (F-12-008)' })
  @ZodBody(workloadIncludedBody)
  async setWorkloadIncluded(@Param('businessId') businessId: string, @Param('staffId') staffId: string, @Body(new Zod(workloadIncludedBody)) body: z.infer<typeof workloadIncludedBody>) {
    await this.settings.setWorkloadIncluded(businessId, staffId, body.included);
    return { ok: true as const };
  }

  // ─────────────────────────── Выгрузки (F-12-074…080) ───────────────────────────

  @Get('exports')
  @Biz()
  @ApiOperation({ summary: 'Журнал выгрузок отчётов — «Операции с данными» (F-12-074…080)' })
  listExports(@Param('businessId') businessId: string, @Query(new Zod(exportsListQuery)) q: z.infer<typeof exportsListQuery>) {
    return this.exports.list(businessId, q);
  }

  @Post('exports')
  @Biz()
  @ApiOperation({ summary: 'Ручной след в журнале выгрузок/загрузок — кнопка «Выгрузить»/«Загрузить» вне REPORT_REGISTRY (F-12-074…080)' })
  @ZodBody(manualExportBody)
  logManualExport(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(manualExportBody)) body: z.infer<typeof manualExportBody>) {
    return this.exports.logManual(ctx, businessId, body);
  }

  @Get('exports/:id')
  @Biz()
  getExport(@Param('businessId') businessId: string, @Param('id') id: string) {
    return this.exports.get(businessId, id);
  }

  @Get('exports/:id/download')
  @Biz()
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async download(@Param('businessId') businessId: string, @Param('id') id: string) {
    const { storageKey, fileName } = await this.exports.storageKeyFor(businessId, id);
    const buf = await createFileStorage().get(storageKey);
    if (!buf) throw new ApiError('not_found', 'File missing on storage');
    return new StreamableFile(buf, { disposition: `attachment; filename="${fileName}"` });
  }

  @Post(':name/export')
  @Biz('reports.view')
  @ApiOperation({ summary: 'Поставить выгрузку отчёта в очередь воркера (PLAN §6 №16)' })
  requestExport(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('name') name: string, @Query() query: Record<string, string>) {
    return this.exports.create(ctx, businessId, name, query);
  }

  // ─────────────────────────── F-12-056: выгрузка визитов одного клиента ───────────────────────────

  @Get('client-visits/:clientId')
  @Biz('reports.view')
  @ApiOperation({ summary: 'Визиты одного клиента за диапазон — данные CSV «По клиентам» (F-12-056)' })
  clientVisits(@Param('businessId') businessId: string, @Param('clientId') clientId: string, @Query(new Zod(clientVisitsQuery)) q: z.infer<typeof clientVisitsQuery>) {
    return this.journal.clientVisits(businessId, clientId, { from: q.from, to: q.to });
  }

  // ─────────────────────────── F-12-070: типы сообщений, встреченные в журнале ───────────────────────────

  @Get('message-types')
  @Biz('reports.view')
  messageTypes(@Param('businessId') businessId: string) {
    return this.marketing.messageTypes(businessId);
  }

  // ─────────────────────────── F-12-067: «Не вернулись после акции» ───────────────────────────

  @Get('promotion-not-returned')
  @Biz('reports.view')
  promotionNotReturned(@Param('businessId') businessId: string, @Query(new Zod(promotionNotReturnedQuery)) q: z.infer<typeof promotionNotReturnedQuery>) {
    return this.marketing.promotionNotReturned(businessId, q.promotionId);
  }

  // ─────────────────────────── F-12-068…069: «Отзывы» ───────────────────────────

  @Get('reviews')
  @Biz('reports.view')
  reviewsReport(@Param('businessId') businessId: string, @Query(new Zod(reviewsQuery)) q: z.infer<typeof reviewsQuery>) {
    return this.reviews.report(businessId, { range: { from: q.from, to: q.to }, subject: q.subject });
  }

  @Delete('reviews/company/:id')
  @Biz('reports.view')
  @ApiOperation({ summary: 'Удалить текстовый отзыв о месте (F-12-069, право reviews.delete проверяет экран)' })
  async deleteCompanyReview(@Param('businessId') businessId: string, @Param('id') id: string) {
    await this.reviews.deleteCompanyReview(businessId, id);
    return { ok: true as const };
  }

  @Patch('reviews/staff/:id')
  @Biz('reports.view')
  @ApiOperation({ summary: 'Скрыть/вернуть отзыв мастера из онлайн-записи, не удаляя (В-24, F-12-069)' })
  @ZodBody(setReviewHiddenBody)
  async setStaffReviewHidden(@Param('businessId') businessId: string, @Param('id') id: string, @Body(new Zod(setReviewHiddenBody)) body: z.infer<typeof setReviewHiddenBody>) {
    await this.reviews.setStaffReviewHidden(businessId, id, body.hidden);
    return { ok: true as const };
  }

  // ─────────────────────────── F-12-057…062: «Товары» ───────────────────────────
  // Упрощение против мока (записано в docs/PROGRESS.md этапа 21): «Просмотр себестоимости» — общее право
  // `finance.view` (то же решение, что докстринг класса выше про «Финансовый отчёт»), а не отдельная матрица
  // складов StockStaffPermissions.warehouseAccess лейна «finance+stock» — те склады сервер пока не режет.

  @Get('stock-balance')
  @Biz('reports.view')
  stockBalance(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Query(new Zod(stockBalanceQuery)) q: z.infer<typeof stockBalanceQuery>) {
    const { locationId, ...filters } = q;
    return this.stock.balance(businessId, locationId, filters, ctx.member!.permissions.has('finance.view'), undefined);
  }

  @Get('stock-order')
  @Biz('reports.view')
  stockOrder(@Param('businessId') businessId: string, @Query(new Zod(stockOrderQuery)) q: z.infer<typeof stockOrderQuery>) {
    return this.stock.order(businessId, q.locationId, q.categoryId, q.onlyCritical);
  }

  @Get('stock-sales-analysis')
  @Biz('reports.view')
  stockSalesAnalysis(@Param('businessId') businessId: string, @Query(new Zod(stockRangeCategoryQuery)) q: z.infer<typeof stockRangeCategoryQuery>) {
    return this.stock.salesAnalysis(businessId, q.locationId, { from: q.from, to: q.to }, q.categoryId, q.staffId);
  }

  @Get('stock-usage-analysis')
  @Biz('reports.view')
  stockUsageAnalysis(@Param('businessId') businessId: string, @Query(new Zod(stockRangeCategoryQuery)) q: z.infer<typeof stockRangeCategoryQuery>) {
    return this.stock.usageAnalysis(businessId, q.locationId, { from: q.from, to: q.to }, q.categoryId);
  }

  @Get('stock-write-off')
  @Biz('reports.view')
  stockWriteOff(@Param('businessId') businessId: string, @Query(new Zod(stockWriteOffQuery)) q: z.infer<typeof stockWriteOffQuery>) {
    return this.stock.writeOff(businessId, q.locationId, { range: { from: q.from, to: q.to }, warehouseId: q.warehouseId, categoryId: q.categoryId, unitMode: q.unitMode, countMoves: q.countMoves });
  }

  @Get('stock-turnover')
  @Biz('reports.view')
  stockTurnover(@Param('businessId') businessId: string, @Query(new Zod(stockTurnoverQuery)) q: z.infer<typeof stockTurnoverQuery>) {
    return this.stock.turnover(businessId, q.locationId, { from: q.from, to: q.to }, q.categoryId, q.warehouseId);
  }

  // ─────────────────────────── docs/backend/02 §16: `GET …/reports/{name}` ───────────────────────────

  @Get(':name')
  @Biz('reports.view')
  @ApiOperation({ summary: 'Один маршрут на отчёт: overview | visits | records | events | retention | load | by-staff | by-service | by-client | promotions | messages | data-changes' })
  async run(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('name') name: string, @Query() query: Record<string, string>) {
    const def = REPORT_REGISTRY[name];
    if (!def) throw new ApiError('not_found', `Unknown report: ${name}`);
    if (def.requiredPermission !== 'reports.view' && !ctx.member!.permissions.has(def.requiredPermission)) throw new ApiError('forbidden', `Missing permission: ${def.requiredPermission}`);
    const parsed = new Zod(def.schema).transform(query);
    return def.run(this.services, businessId, parsed as unknown as Record<string, unknown>);
  }
}
