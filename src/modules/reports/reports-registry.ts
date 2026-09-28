import type { ZodType } from 'zod';
import { requireRange } from './reports-common.js';
import { ReportsAuditService, type DataChangeAction, type DataChangeEntity } from './reports-audit.service.js';
import { ReportsDashboardService } from './reports-dashboard.service.js';
import { ReportsJournalService } from './reports-journal.service.js';
import { ReportsMarketingService } from './reports-marketing.service.js';
import { ReportsSalesService } from './reports-sales.service.js';
import {
  activityQuery,
  byClientQuery,
  byServiceQuery,
  byStaffQuery,
  dashboardQuery,
  dataChangesQuery,
  eventsQuery,
  messagesQuery,
  promotionsQuery,
  recordsQuery,
  retentionQuery,
  visitsQuery,
  workloadQuery,
} from './reports.schemas.js';

/**
 * Реестр отчётов: один маршрут `GET /v1/biz/{b}/reports/{name}` (docs/backend/02 §16), диспетчер по `name` —
 * не 11 разных контроллерных методов. Тот же реестр использует выгрузка (`POST …/reports/{name}/export`,
 * воркер `jobs/reports-export.ts`) — пересчитывает ТОЧНО ту же функцию, что отдала экран, без второй копии
 * логики. `rowsOf` — плоские строки для CSV; отчётам без построчной формы (overview) отдаём срез по дням.
 */
export interface ReportServices {
  dashboard: ReportsDashboardService;
  journal: ReportsJournalService;
  sales: ReportsSalesService;
  marketing: ReportsMarketingService;
  audit: ReportsAuditService;
}

function splitCsv(v?: string): string[] | undefined {
  return v ? v.split(',').filter(Boolean) : undefined;
}

export interface ReportDef {
  schema: ZodType;
  requiredPermission: 'reports.view' | 'finance.view';
  run(svc: ReportServices, businessId: string, query: Record<string, unknown>): Promise<unknown>;
  rowsOf(result: unknown): Record<string, unknown>[];
}

export const REPORT_REGISTRY: Record<string, ReportDef> = {
  overview: {
    schema: dashboardQuery,
    requiredPermission: 'reports.view',
    run: (svc, businessId, q) => svc.dashboard.overview(businessId, splitCsv(q.locationIds as string | undefined), requireRange(q as { from: string; to: string }), { staffId: q.staffId as string | undefined, position: q.position as string | undefined }),
    rowsOf: (r) => (r as { sales: { byDay: Record<string, unknown>[] } }).sales.byDay,
  },
  visits: {
    schema: visitsQuery,
    requiredPermission: 'reports.view',
    run: (svc, businessId, q) => svc.journal.visits(businessId, splitCsv(q.locationIds as string | undefined), (q.tab as 'upcoming' | 'past') ?? 'upcoming', true),
    rowsOf: (r) => (r as { days: { rows: Record<string, unknown>[] }[] }).days.flatMap((d) => d.rows),
  },
  records: {
    schema: recordsQuery,
    requiredPermission: 'reports.view',
    run: (svc, businessId, q) =>
      svc.journal.records(
        businessId,
        splitCsv(q.locationIds as string | undefined),
        {
          createdFrom: q.from as string,
          createdTo: q.to as string,
          staffId: q.staffId as string | undefined,
          createdBy: q.createdBy as string | undefined,
          cancelled: (q.cancelled as never) ?? 'all',
          source: (q.source as never) ?? 'all',
          hasServices: (q.hasServices as never) ?? 'all',
          search: q.search as string | undefined,
          page: Number(q.page ?? 1),
          pageSize: Number(q.pageSize ?? 25),
        },
        true,
        'all',
      ),
    rowsOf: (r) => (r as { rows: Record<string, unknown>[] }).rows,
  },
  events: {
    schema: eventsQuery,
    requiredPermission: 'reports.view',
    run: (svc, businessId, q) => svc.journal.events(businessId, splitCsv(q.locationIds as string | undefined), requireRange(q as { from: string; to: string }), { serviceId: q.serviceId as string | undefined, staffId: q.staffId as string | undefined, status: (q.status as never) ?? 'all' }),
    rowsOf: (r) => (r as { rows: Record<string, unknown>[] }).rows,
  },
  retention: {
    schema: retentionQuery,
    requiredPermission: 'reports.view',
    run: (svc, businessId, q) => svc.journal.retention(businessId, splitCsv(q.locationIds as string | undefined), requireRange(q as { from: string; to: string }), q.serviceId as string | undefined),
    rowsOf: (r) => (r as { rows: Record<string, unknown>[] }).rows,
  },
  load: {
    schema: workloadQuery,
    requiredPermission: 'reports.view',
    run: (svc, businessId, q) => svc.journal.workload(businessId, splitCsv(q.locationIds as string | undefined), requireRange(q as { from: string; to: string })),
    rowsOf: (r) => (r as { rows: Record<string, unknown>[] }).rows,
  },
  'by-staff': {
    schema: byStaffQuery,
    requiredPermission: 'reports.view',
    run: (svc, businessId, q) => svc.sales.byStaff(businessId, splitCsv(q.locationIds as string | undefined), requireRange(q as { from: string; to: string }), { serviceId: q.serviceId as string | undefined, serviceCategoryId: q.serviceCategoryId as string | undefined, position: q.position as string | undefined }),
    rowsOf: (r) => (r as { rows: Record<string, unknown>[] }).rows,
  },
  'by-service': {
    schema: byServiceQuery,
    requiredPermission: 'reports.view',
    run: (svc, businessId, q) => svc.sales.byService(businessId, splitCsv(q.locationIds as string | undefined), requireRange(q as { from: string; to: string }), { staffId: q.staffId as string | undefined, categoryId: q.categoryId as string | undefined }),
    rowsOf: (r) => (r as { rows: Record<string, unknown>[] }).rows,
  },
  'by-client': {
    schema: byClientQuery,
    requiredPermission: 'reports.view',
    run: (svc, businessId, q) => svc.sales.byClient(businessId, splitCsv(q.locationIds as string | undefined), requireRange(q as { from: string; to: string })),
    rowsOf: (r) => (r as { rows: Record<string, unknown>[] }).rows,
  },
  promotions: {
    schema: promotionsQuery,
    requiredPermission: 'reports.view',
    run: (svc, businessId, q) => svc.marketing.promotions(businessId, q.promotionId as string, requireRange(q as { from: string; to: string })),
    rowsOf: (r) => (r as { staff: Record<string, unknown>[] }).staff,
  },
  messages: {
    schema: messagesQuery,
    requiredPermission: 'reports.view',
    run: (svc, businessId, q) =>
      svc.marketing.messages(businessId, {
        range: requireRange(q as { from: string; to: string }),
        typeCode: q.typeCode as string | undefined,
        status: q.status as string | undefined,
        phoneSearch: q.phoneSearch as string | undefined,
        channel: q.channel as string | undefined,
        page: Number(q.page ?? 1),
        pageSize: Number(q.pageSize ?? 25),
      }),
    rowsOf: (r) => (r as { items: Record<string, unknown>[] }).items,
  },
  'data-changes': {
    schema: dataChangesQuery,
    requiredPermission: 'reports.view',
    run: (svc, businessId, q) => svc.audit.dataChanges(businessId, { from: q.from as string, to: q.to as string, entity: q.entity as DataChangeEntity | undefined, authorName: q.authorName as string | undefined, action: q.action as DataChangeAction | undefined }),
    rowsOf: (r) => r as Record<string, unknown>[],
  },
  /** F-12-030/038, этап 21 «network+reports» попытка 2: «Лента активности» — canSeePhones=true как у visits/records выше (то же упрощение, не заведена права-матрица под неё) */
  activity: {
    schema: activityQuery,
    requiredPermission: 'reports.view',
    run: (svc, businessId, q) => svc.journal.activityFeed(businessId, splitCsv(q.locationIds as string | undefined), (q.filter as never) ?? 'all', true),
    rowsOf: (r) => r as Record<string, unknown>[],
  },
};

export type ReportName = keyof typeof REPORT_REGISTRY;
