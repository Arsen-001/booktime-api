import { isLocale, t } from '../../common/i18n/i18n.js';
import { notifyKindOf } from './kinds.js';
import { isStaffEventEnabled } from './notify-staff-prefs.service.js';
import { enqueueOutbox } from './outbox.js';
/** F-00-055 (воскресенье, PLAN.md §6 №10): мастеру в режиме «всё занято» без открытых окон на неделю */
export async function notifyEmptyWeek(prisma, staffIds) {
    if (!staffIds.length)
        return 0;
    const def = notifyKindOf('staff_empty_week');
    const staff = await prisma.staff.findMany({ where: { id: { in: staffIds }, userId: { not: null } }, select: { id: true, userId: true, businessId: true } });
    if (!staff.length)
        return 0;
    const users = await prisma.user.findMany({ where: { id: { in: staff.map((s) => s.userId) } }, select: { id: true, locale: true } });
    const localeByUser = new Map(users.map((u) => [u.id, isLocale(u.locale) ? u.locale : 'ru']));
    const today = new Date().toISOString().slice(0, 10);
    let sent = 0;
    for (const s of staff) {
        if (!s.userId)
            continue;
        if (!(await isStaffEventEnabled(prisma, s.id, 'empty_week')))
            continue;
        const created = await enqueueOutbox(prisma, {
            businessId: s.businessId,
            app: 'business',
            kind: def.kind,
            recipientUserId: s.userId,
            title: 'BookTime',
            body: t(localeByUser.get(s.userId) ?? 'ru', def.messageKey, {}),
            dedupeKey: `staff:empty_week:${s.id}:${today}`,
        });
        if (created)
            sent++;
    }
    return sent;
}
//# sourceMappingURL=notify-empty-week.js.map