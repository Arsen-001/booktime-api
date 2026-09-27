import type { PrismaService } from '../common/prisma.service.js';
import { createFileStorage } from '../adapters/storage/storage.js';
import { ReportsAuditService } from '../modules/reports/reports-audit.service.js';
import { ReportsDashboardService } from '../modules/reports/reports-dashboard.service.js';
import { ReportsJournalService, type ScheduleHoursSource } from '../modules/reports/reports-journal.service.js';
import { ReportsMarketingService } from '../modules/reports/reports-marketing.service.js';
import { REPORT_REGISTRY, type ReportServices } from '../modules/reports/reports-registry.js';
import { ReportsSalesService } from '../modules/reports/reports-sales.service.js';
import { ReportsSettingsService } from '../modules/reports/reports-settings.service.js';

/**
 * Выгрузка отчёта — тяжёлая работает задачей в воркере (PLAN §6 №16, docs/backend/02 §16). Пересчитывает ТОТ ЖЕ
 * `REPORT_REGISTRY`, что отдаёт экран (reports.controller.ts), поэтому файл не может разойтись со срезом,
 * который видел человек. `ScheduleService` (нужен только «Загруженности») не поднимаем целиком в воркере
 * (тянет Redis/Live) — заглушка возвращает «график недоступен», отчёт вежливо деградирует до `scheduledHours:
 * null` (уже предусмотрено в ReportsJournalService.workload), а не падает всей выгрузкой.
 */
const NO_SCHEDULE: ScheduleHoursSource = {
  hours() {
    throw new Error('schedule unavailable in export worker');
  },
};

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return '';
  const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const lines = [headers.join(';'), ...rows.map((r) => headers.map((h) => csvCell(r[h])).join(';'))];
  return '﻿' + lines.join('\r\n');
}

export async function reportsExportDispatch(prisma: PrismaService): Promise<{ done: number; failed: number }> {
  const queued = await prisma.reportExport.findMany({ where: { status: 'queued' }, orderBy: { createdAt: 'asc' }, take: 10 });
  if (!queued.length) return { done: 0, failed: 0 };

  const services: ReportServices = {
    dashboard: new ReportsDashboardService(prisma),
    journal: new ReportsJournalService(prisma, NO_SCHEDULE, new ReportsSettingsService(prisma)),
    sales: new ReportsSalesService(prisma),
    marketing: new ReportsMarketingService(prisma),
    audit: new ReportsAuditService(prisma),
  };
  const storage = createFileStorage();
  let done = 0;
  let failed = 0;
  for (const job of queued) {
    const def = REPORT_REGISTRY[job.name];
    try {
      if (!def) throw new Error(`unknown report: ${job.name}`);
      const parsed = def.schema.parse(job.params);
      const result = await def.run(services, job.businessId, parsed as unknown as Record<string, unknown>);
      const rows = def.rowsOf(result);
      const csv = toCsv(rows);
      const fileName = `${job.name}-${job.createdAt.toISOString().slice(0, 10)}.csv`;
      const storageKey = `report-exports/${job.businessId}/${job.id}.csv`;
      await storage.put(storageKey, Buffer.from(csv, 'utf8'), 'text/csv');
      await prisma.reportExport.update({ where: { id: job.id }, data: { status: 'ready', fileName, storageKey, rowCount: rows.length, readyAt: new Date() } });
      done += 1;
    } catch (e) {
      await prisma.reportExport.update({ where: { id: job.id }, data: { status: 'failed', error: String((e as Error).message ?? e).slice(0, 300) } });
      failed += 1;
    }
  }
  return { done, failed };
}
