import { requireRange } from './reports-common.js';
import { byClientQuery, byServiceQuery, byStaffQuery, dashboardQuery, dataChangesQuery, eventsQuery, messagesQuery, promotionsQuery, recordsQuery, retentionQuery, visitsQuery, workloadQuery, } from './reports.schemas.js';
function splitCsv(v) {
    return v ? v.split(',').filter(Boolean) : undefined;
}
export const REPORT_REGISTRY = {
    overview: {
        schema: dashboardQuery,
        requiredPermission: 'reports.view',
        run: (svc, businessId, q) => svc.dashboard.overview(businessId, splitCsv(q.locationIds), requireRange(q), { staffId: q.staffId, position: q.position }),
        rowsOf: (r) => r.sales.byDay,
    },
    visits: {
        schema: visitsQuery,
        requiredPermission: 'reports.view',
        run: (svc, businessId, q) => svc.journal.visits(businessId, splitCsv(q.locationIds), q.tab ?? 'upcoming', true),
        rowsOf: (r) => r.days.flatMap((d) => d.rows),
    },
    records: {
        schema: recordsQuery,
        requiredPermission: 'reports.view',
        run: (svc, businessId, q) => svc.journal.records(businessId, splitCsv(q.locationIds), {
            createdFrom: q.from,
            createdTo: q.to,
            staffId: q.staffId,
            createdBy: q.createdBy,
            cancelled: q.cancelled ?? 'all',
            source: q.source ?? 'all',
            hasServices: q.hasServices ?? 'all',
            search: q.search,
            page: Number(q.page ?? 1),
            pageSize: Number(q.pageSize ?? 25),
        }, true, 'all'),
        rowsOf: (r) => r.rows,
    },
    events: {
        schema: eventsQuery,
        requiredPermission: 'reports.view',
        run: (svc, businessId, q) => svc.journal.events(businessId, splitCsv(q.locationIds), requireRange(q), { serviceId: q.serviceId, staffId: q.staffId, status: q.status ?? 'all' }),
        rowsOf: (r) => r.rows,
    },
    retention: {
        schema: retentionQuery,
        requiredPermission: 'reports.view',
        run: (svc, businessId, q) => svc.journal.retention(businessId, splitCsv(q.locationIds), requireRange(q), q.serviceId),
        rowsOf: (r) => r.rows,
    },
    load: {
        schema: workloadQuery,
        requiredPermission: 'reports.view',
        run: (svc, businessId, q) => svc.journal.workload(businessId, splitCsv(q.locationIds), requireRange(q)),
        rowsOf: (r) => r.rows,
    },
    'by-staff': {
        schema: byStaffQuery,
        requiredPermission: 'reports.view',
        run: (svc, businessId, q) => svc.sales.byStaff(businessId, splitCsv(q.locationIds), requireRange(q), { serviceId: q.serviceId, serviceCategoryId: q.serviceCategoryId, position: q.position }),
        rowsOf: (r) => r.rows,
    },
    'by-service': {
        schema: byServiceQuery,
        requiredPermission: 'reports.view',
        run: (svc, businessId, q) => svc.sales.byService(businessId, splitCsv(q.locationIds), requireRange(q), { staffId: q.staffId, categoryId: q.categoryId }),
        rowsOf: (r) => r.rows,
    },
    'by-client': {
        schema: byClientQuery,
        requiredPermission: 'reports.view',
        run: (svc, businessId, q) => svc.sales.byClient(businessId, splitCsv(q.locationIds), requireRange(q)),
        rowsOf: (r) => r.rows,
    },
    promotions: {
        schema: promotionsQuery,
        requiredPermission: 'reports.view',
        run: (svc, businessId, q) => svc.marketing.promotions(businessId, q.promotionId, requireRange(q)),
        rowsOf: (r) => r.staff,
    },
    messages: {
        schema: messagesQuery,
        requiredPermission: 'reports.view',
        run: (svc, businessId, q) => svc.marketing.messages(businessId, {
            range: requireRange(q),
            typeCode: q.typeCode,
            status: q.status,
            phoneSearch: q.phoneSearch,
            channel: q.channel,
            page: Number(q.page ?? 1),
            pageSize: Number(q.pageSize ?? 25),
        }),
        rowsOf: (r) => r.items,
    },
    'data-changes': {
        schema: dataChangesQuery,
        requiredPermission: 'reports.view',
        run: (svc, businessId, q) => svc.audit.dataChanges(businessId, { from: q.from, to: q.to, entity: q.entity, authorName: q.authorName, action: q.action }),
        rowsOf: (r) => r,
    },
};
//# sourceMappingURL=reports-registry.js.map