import { Body, Controller, Get, Header, Param, Patch, Post, Query, StreamableFile } from '@nestjs/common';
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
@ApiTags('reports')
@Controller('v1/biz/:businessId/reports')
export class ReportsController {
  private readonly services: ReportServices;

  constructor(
    dashboard: ReportsDashboardService,
    journal: ReportsJournalService,
    sales: ReportsSalesService,
    marketing: ReportsMarketingService,
    audit: ReportsAuditService,
    private readonly settings: ReportsSettingsService,
    private readonly exports: ReportsExportService,
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
  listExports(@Param('businessId') businessId: string, @Query('staffId') staffId?: string, @Query('type') type?: string) {
    return this.exports.list(businessId, { staffId, type });
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
