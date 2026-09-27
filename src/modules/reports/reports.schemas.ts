import { z } from 'zod';

/**
 * Входы отчётов (docs/backend/02 §16): `GET …/reports/{name}?from,to,locationIds,staffIds…` — один маршрут на
 * отчёт, общий кусок запроса вынесен сюда. `locationIds`/`staffIds` — CSV, как остальные фильтры-списки бизнеса
 * (см. `splitCsv` finance.controller.ts).
 */
export const id32 = z.string().min(1).max(32);

export const rangeQuery = z.object({
  from: z.string(),
  to: z.string(),
  locationIds: z.string().max(2000).optional(),
});

export const dashboardQuery = rangeQuery.extend({
  staffId: id32.optional(),
  position: z.string().max(120).optional(),
});

export const visitsQuery = z.object({
  locationIds: z.string().max(2000).optional(),
  tab: z.enum(['upcoming', 'past']).default('upcoming'),
});

export const recordsQuery = rangeQuery.extend({
  visitFrom: z.string().optional(),
  visitTo: z.string().optional(),
  staffId: id32.optional(),
  createdBy: z.string().max(32).optional(),
  cancelled: z.enum(['all', 'cancelled', 'notCancelled']).default('all'),
  source: z.enum(['all', 'online', 'offline']).default('all'),
  hasServices: z.enum(['all', 'with', 'without']).default('all'),
  search: z.string().max(160).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().refine((v) => [25, 50, 100].includes(v), 'pageSize must be 25|50|100').default(25),
});

export const retentionQuery = rangeQuery.extend({ serviceId: id32.optional() });
export const workloadQuery = rangeQuery;

export const eventsQuery = rangeQuery.extend({
  serviceId: id32.optional(),
  staffId: id32.optional(),
  status: z.enum(['all', 'cancelled', 'notCancelled']).default('all'),
});

export const byStaffQuery = rangeQuery.extend({
  serviceCategoryId: id32.optional(),
  serviceId: id32.optional(),
  position: z.string().max(120).optional(),
});

export const byServiceQuery = rangeQuery.extend({ staffId: id32.optional(), categoryId: id32.optional() });
export const byClientQuery = rangeQuery;

export const promotionsQuery = z.object({ promotionId: id32, from: z.string(), to: z.string() });

export const messagesQuery = z.object({
  from: z.string(),
  to: z.string(),
  typeCode: z.string().max(40).optional(),
  status: z.string().max(20).optional(),
  phoneSearch: z.string().max(20).optional(),
  channel: z.string().max(20).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

export const dataChangesQuery = z.object({
  from: z.string(),
  to: z.string(),
  entity: z.enum(['booking', 'stockOperation', 'financeOperation']).optional(),
  authorName: z.string().max(160).optional(),
  action: z.enum(['create', 'update', 'delete', 'restore']).optional(),
});

export const workloadIncludedBody = z.object({ included: z.boolean() });

export const reportsPermissionsPatchBody = z
  .object({
    dashboard: z.boolean(),
    recordsView: z.boolean(),
    recordsDepth: z.union([z.literal(30), z.literal('all')]),
    recordsExport: z.boolean(),
    recordsPhones: z.boolean(),
    financePeriod: z.boolean(),
    financeYear: z.boolean(),
    cashDayTodayOnly: z.boolean(),
    events: z.boolean(),
    visits: z.boolean(),
    visitsPhones: z.boolean(),
    retention: z.boolean(),
    workload: z.boolean(),
  })
  .partial();

export const exportRequestBody = z.object({ format: z.literal('csv').default('csv'), params: z.record(z.string(), z.string()).default({}) });
