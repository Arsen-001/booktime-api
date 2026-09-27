export const NOTIFY_KINDS = [
    // клиенту (05 §3.1)
    { code: 1, kind: 'booking_created', recipient: 'client', messageKey: 'booking.createdByStaff' },
    { code: 2, kind: 'salon_confirmed', recipient: 'client', messageKey: 'booking.confirmedByMaster' },
    { code: 3, kind: 'salon_moved', recipient: 'client', messageKey: 'booking.movedByMaster' },
    { code: 4, kind: 'salon_deleted', recipient: 'client', messageKey: 'booking.deletedByMaster' },
    { code: 5, kind: 'cancelled_by_master', recipient: 'client', messageKey: 'booking.cancelledByMaster' },
    { code: 6, kind: 'prepayment_expired', recipient: 'client', messageKey: 'booking.prepaymentExpired' },
    { code: 7, kind: 'reminder24h', recipient: 'client', messageKey: 'booking.reminder24h' },
    { code: 8, kind: 'reminder2h', recipient: 'client', messageKey: 'booking.reminder2h' },
    { code: 9, kind: 'waitlist_available', recipient: 'client', messageKey: 'waitlist.slotAvailable' },
    // бизнесу (05 §3.2)
    { code: 50, kind: 'staff_new_booking', recipient: 'staff', messageKey: 'staff.newBooking' },
    { code: 51, kind: 'staff_client_cancelled', recipient: 'staff', messageKey: 'staff.clientCancelled' },
    { code: 52, kind: 'staff_client_rescheduled', recipient: 'staff', messageKey: 'staff.clientRescheduled' },
    { code: 53, kind: 'staff_empty_week', recipient: 'staff', messageKey: 'staff.emptyWeek' },
];
export const NOTIFY_KIND_BY_NAME = new Map(NOTIFY_KINDS.map((k) => [k.kind, k]));
export function notifyKindOf(kind) {
    return NOTIFY_KIND_BY_NAME.get(kind);
}
/** Отправлять вне тихих часов 21:00–10:00 по Еревану (§5, зафиксировано PLAN.md §6 №10 «E6») — только эти виды */
export const QUIET_HOURS_KINDS = new Set(['news']);
//# sourceMappingURL=kinds.js.map