import { Injectable } from '@nestjs/common';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { newId } from '../../common/ids/ids.js';
import { PrismaService } from '../../common/prisma.service.js';
import { REPORT_REGISTRY } from './reports-registry.js';

/**
 * Выгрузка отчёта (docs/backend/02 §16: «тяжёлые — задачей в воркере с готовым файлом»). Строка ставится здесь
 * синхронно (`queued`), CSV считает `jobs/reports-export.ts` в воркере тем же реестром `REPORT_REGISTRY`, что
 * отдаёт экран — файл гарантированно совпадает со срезом, который видел человек. Заодно это и «Операции с
 * данными» (F-12-074…080): список выгрузок ЭТОЙ таблицы — тот же журнал, без второй строки на запись.
 */
@Injectable()
export class ReportsExportService {
  constructor(private readonly prisma: PrismaService) {}

  async create(ctx: RequestContext, businessId: string, name: string, params: Record<string, string>) {
    if (!(name in REPORT_REGISTRY)) throw new ApiError('not_found', `Unknown report: ${name}`);
    const row = await this.prisma.reportExport.create({
      data: { id: newId('reportExport'), businessId, staffId: ctx.member!.staffId, staffName: ctx.member!.name, name, params, status: 'queued', operation: 'browserDownload' },
    });
    return this.toDto(row);
  }

  /**
   * F-12-074…080 «Операции с данными» — журнал ручных выгрузок/загрузок вне `REPORT_REGISTRY` (импорт/экспорт
   * клиентов, записей, карт лояльности, абонементов, сертификатов, тарифов маркетплейса — `DataExportType`,
   * `src/api/reports.ts::logDataExport` во фронте). В отличие от `create()` выше — не ставит задачу воркеру,
   * пишет строку сразу `ready`: файл уже построен экраном (CSV) или загрузка уже прошла, это только след в
   * журнале, тот же реестр таблицы `report_exports`, чтобы не заводить вторую.
   */
  async logManual(ctx: RequestContext, businessId: string, input: { type: string; operation: string; fileName: string; rowCount: number }) {
    const row = await this.prisma.reportExport.create({
      data: {
        id: newId('reportExport'),
        businessId,
        staffId: ctx.member!.staffId,
        staffName: ctx.member!.name,
        name: input.type.slice(0, 24),
        params: {},
        status: 'ready',
        operation: input.operation,
        fileName: input.fileName.slice(0, 200),
        rowCount: input.rowCount,
        readyAt: new Date(),
      },
    });
    return this.toDto(row);
  }

  async list(businessId: string, filters: { staffId?: string; type?: string; operation?: string } = {}) {
    const rows = await this.prisma.reportExport.findMany({
      where: {
        businessId,
        ...(filters.staffId ? { staffId: filters.staffId } : {}),
        ...(filters.type ? { name: filters.type } : {}),
        ...(filters.operation ? { operation: filters.operation } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return rows.map((r) => this.toDto(r));
  }

  async get(businessId: string, id: string) {
    const row = await this.prisma.reportExport.findFirst({ where: { id, businessId } });
    if (!row) throw new ApiError('not_found', 'Export not found');
    return this.toDto(row);
  }

  async storageKeyFor(businessId: string, id: string): Promise<{ storageKey: string; fileName: string }> {
    const row = await this.prisma.reportExport.findFirst({ where: { id, businessId } });
    if (!row || row.status !== 'ready' || !row.storageKey || !row.fileName) throw new ApiError('not_found', 'Export file not ready');
    return { storageKey: row.storageKey, fileName: row.fileName };
  }

  private toDto(row: { id: string; staffId: string; staffName: string; name: string; status: string; fileName: string | null; rowCount: number | null; createdAt: Date; readyAt: Date | null; error: string | null; operation?: string | null }) {
    return {
      id: row.id,
      staffId: row.staffId,
      staffName: row.staffName,
      type: row.name,
      operation: row.operation ?? 'browserDownload',
      status: row.status,
      fileName: row.fileName ?? '',
      rowCount: row.rowCount ?? 0,
      at: row.createdAt.toISOString(),
      readyAt: row.readyAt?.toISOString(),
      error: row.error ?? undefined,
    };
  }
}
