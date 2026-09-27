import dayjs from 'dayjs';
import { ApiError } from '../../common/errors/api-error.js';
import { DEFAULT_TZ, isLocalDate, utcToLocalDate } from '../../common/time/time.js';
export function requireRange(input) {
    const from = input.from;
    const to = input.to;
    if (!isLocalDate(from) || !isLocalDate(to))
        throw new ApiError('validation', 'from/to must be YYYY-MM-DD', { from: 'bad_date', to: 'bad_date' });
    if (from > to)
        throw new ApiError('validation', 'from must be <= to', { from: 'range' });
    return { from, to };
}
/** Диапазон в UTC заведомо покрывающий [from,to] в любом поясе — фильтр по месту сузит его до реальной локальной даты */
export function wideUtcBounds(range) {
    return { from: dayjs.utc(range.from).subtract(2, 'day').toDate(), to: dayjs.utc(range.to).add(3, 'day').toDate() };
}
/** Предыдущий период той же длины, вплотную примыкающий к началу текущего (F-12-017/023) */
export function priorRange(range) {
    const days = dayjs(range.to).diff(dayjs(range.from), 'day') + 1;
    const to = dayjs(range.from).subtract(1, 'day');
    const from = to.subtract(days - 1, 'day');
    return { from: from.format('YYYY-MM-DD'), to: to.format('YYYY-MM-DD') };
}
/** F-12-017: было 0, стало >0 → «новое», не процент; было 0 и осталось 0 → без deltaPct */
export function metricValue(current, previous) {
    if (previous === 0)
        return current > 0 ? { value: current, isNew: true } : { value: current };
    return { value: current, deltaPct: Math.round(((current - previous) / previous) * 1000) / 10 };
}
export async function locationsOf(prisma, businessId, locationIds) {
    const rows = await prisma.location.findMany({
        where: { businessId, deletedAt: null, ...(locationIds?.length ? { id: { in: locationIds } } : {}) },
        select: { id: true, tz: true },
    });
    if (locationIds?.length && !rows.length)
        throw new ApiError('validation', 'Unknown locationIds');
    return rows;
}
export function tzMapOf(locations) {
    return new Map(locations.map((l) => [l.id, l.tz]));
}
/** Локальная дата записи в поясе ЕЁ филиала; неизвестный филиал — запасной пояс (PLAN §4.1 умолчание) */
export function localDateAt(at, locationId, tzMap) {
    return utcToLocalDate(at, tzMap.get(locationId) ?? DEFAULT_TZ);
}
export function inRange(date, range) {
    return date >= range.from && date <= range.to;
}
//# sourceMappingURL=reports-common.js.map