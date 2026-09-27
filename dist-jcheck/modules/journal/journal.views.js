import { DEFAULT_TZ, utcToLocal } from '../../common/time/time.js';
import { extrasOf } from './rules.js';
const arr = (v) => (Array.isArray(v) ? v : []);
export function bookingView(b, tz = DEFAULT_TZ) {
    const prepayment = b.prepayment;
    return {
        id: b.id,
        businessId: b.businessId,
        locationId: b.locationId,
        staffId: b.staffId,
        ...(b.clientId ? { clientId: b.clientId } : {}),
        ...(b.appUserId ? { appUserId: b.appUserId } : {}),
        start: utcToLocal(b.startAt, tz),
        durationMin: b.durationMin,
        status: b.status,
        services: arr(b.services),
        total: Number(b.total),
        resourceIds: arr(b.resourceIds),
        workplace: b.workplace,
        source: b.source,
        createdBy: b.createdByRef,
        forWhom: b.forWhom,
        ...(b.visitorName ? { visitorName: b.visitorName } : {}),
        ...(b.comment ? { comment: b.comment } : {}),
        ...(prepayment ? { prepayment } : {}),
        ...(b.cancelledLate ? { cancelledLate: true } : {}),
        ...(b.cancelReason ? { cancelReason: b.cancelReason } : {}),
        ...(b.confirmDeadline && b.status === 'awaiting_confirmation' ? { confirmDeadline: utcToLocal(b.confirmDeadline, tz) } : {}),
        ...(b.groupEventId ? { groupEventId: b.groupEventId } : {}),
        ...(b.seriesId ? { seriesId: b.seriesId } : {}),
        ...(b.visitId ? { visitId: b.visitId } : {}),
        ...(b.staffAssignment ? { staffAssignment: b.staffAssignment } : {}),
        createdAt: utcToLocal(b.createdAt, tz),
        updatedAt: utcToLocal(b.updatedAt, tz),
        ...(b.deletedAt ? { deletedAt: utcToLocal(b.deletedAt, tz) } : {}),
        version: b.version,
    };
}
/** BookingExtras фронта (src/domain/journal.ts): доп. данные визита + автор удаления */
export function extrasView(b, tz = DEFAULT_TZ) {
    const e = extrasOf(b.extras);
    return {
        ...e,
        paidAmount: Number(b.paidAmount),
        ...(b.deletedAt
            ? {
                deletion: {
                    byName: b.deletedByName ?? '',
                    byClient: b.deletedByClient,
                    at: utcToLocal(b.deletedAt, tz),
                    ...(b.deletionRestore ? { restore: b.deletionRestore } : {}),
                },
            }
            : {}),
    };
}
export function eventView(e, tz = DEFAULT_TZ) {
    return {
        id: e.id,
        bookingId: e.bookingId,
        businessId: e.businessId,
        staffId: e.staffId,
        ...(e.clientId ? { clientId: e.clientId } : {}),
        ...(e.appUserId ? { appUserId: e.appUserId } : {}),
        kind: e.kind,
        ...(e.fromStatus ? { from: e.fromStatus } : {}),
        ...(e.toStatus ? { to: e.toStatus } : {}),
        ...(e.prevStart ? { prevStart: e.prevStart } : {}),
        ...(e.prevStaffId ? { prevStaffId: e.prevStaffId } : {}),
        ...(e.freed ? { freed: e.freed } : {}),
        by: e.byRef,
        ...(e.late ? { late: true } : {}),
        ...(e.reason ? { reason: e.reason } : {}),
        ...(e.delayMin ? { delayMin: e.delayMin } : {}),
        start: e.startLocal,
        at: utcToLocal(e.at, tz),
    };
}
export function groupEventView(e, tz = DEFAULT_TZ) {
    return {
        id: e.id,
        businessId: e.businessId,
        locationId: e.locationId,
        serviceId: e.serviceId,
        staffId: e.staffId,
        start: utcToLocal(e.startAt, tz),
        durationMin: e.durationMin,
        capacity: e.capacity,
        resourceIds: arr(e.resourceIds),
        ...(e.onlineUrl ? { onlineUrl: e.onlineUrl } : {}),
        ...(e.seriesId ? { seriesId: e.seriesId } : {}),
        status: e.status,
        createdAt: utcToLocal(e.createdAt, tz),
        version: e.version,
    };
}
//# sourceMappingURL=journal.views.js.map