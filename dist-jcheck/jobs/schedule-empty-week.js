import { nowLocal } from '../common/time/time.js';
import { addDays } from '../modules/availability/engine.js';
/**
 * Воскресное напоминание «откройте окна на неделю» (F-00-055, docs/backend/04 §3): мастера в режиме «всё занято»
 * с графиком, у которых на следующие 7 дней нет ни одного открытого часа. Сам пуш — этап 10 (уведомления):
 * до него задача только находит адресатов и пишет их в лог.
 */
export async function scheduleEmptyWeek(prisma) {
    const from = addDays(nowLocal().slice(0, 10), 1);
    const to = addDays(from, 6);
    const staff = await prisma.staff.findMany({
        where: { calendarMode: 'busy', status: 'active', deletedAt: null, schedules: { some: {} } },
        select: { id: true },
    });
    const withOpen = new Set((await prisma.calendarMark.findMany({
        where: { staffId: { in: staff.map((s) => s.id) }, kind: 'free', date: { gte: from, lte: to } },
        select: { staffId: true },
        distinct: ['staffId'],
    })).map((m) => m.staffId));
    return { from, to, staffIds: staff.map((s) => s.id).filter((id) => !withOpen.has(id)) };
}
//# sourceMappingURL=schedule-empty-week.js.map