import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);
/**
 * Время (PLAN.md §4.1): в базе DATETIME(3) всегда UTC; в API — местное 'YYYY-MM-DD' и 'YYYY-MM-DDTHH:mm' в поясе
 * филиала (locations.tz, по умолчанию Asia/Yerevan). Свободные строки в Date НЕ парсим: new Date('завтра') даёт
 * мусор, который читается как «срок истёк». Только строгие форматы ниже, иначе — ошибка.
 */
export const DEFAULT_TZ = 'Asia/Yerevan';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
export function isLocalDate(v) {
    return typeof v === 'string' && DATE_RE.test(v) && dayjs(v, 'YYYY-MM-DD', true).isValid();
}
export function isLocalDateTime(v) {
    return typeof v === 'string' && DATETIME_RE.test(v) && dayjs(v, 'YYYY-MM-DDTHH:mm', true).isValid();
}
/** Местное время филиала → момент UTC для базы */
export function localToUtc(local, tz = DEFAULT_TZ) {
    if (!isLocalDateTime(local))
        throw new RangeError(`not a local date-time 'YYYY-MM-DDTHH:mm': ${String(local)}`);
    return dayjs.tz(local, 'YYYY-MM-DDTHH:mm', tz).toDate();
}
/** Момент UTC из базы → местное время филиала для API */
export function utcToLocal(at, tz = DEFAULT_TZ) {
    return dayjs(at).tz(tz).format('YYYY-MM-DDTHH:mm');
}
/** Местная дата, в которую попадает момент */
export function utcToLocalDate(at, tz = DEFAULT_TZ) {
    return dayjs(at).tz(tz).format('YYYY-MM-DD');
}
/** Границы местного дня в UTC: [начало, начало следующего дня) — для выборок «записи за день» */
export function localDayRangeUtc(date, tz = DEFAULT_TZ) {
    if (!isLocalDate(date))
        throw new RangeError(`not a local date 'YYYY-MM-DD': ${String(date)}`);
    const start = dayjs.tz(date, 'YYYY-MM-DD', tz).startOf('day');
    return { from: start.toDate(), to: start.add(1, 'day').toDate() };
}
/** Сейчас в поясе (для «тихих часов», «календарной недели» — PLAN.md §5) */
export function nowLocal(tz = DEFAULT_TZ) {
    return dayjs().tz(tz).format('YYYY-MM-DDTHH:mm');
}
//# sourceMappingURL=time.js.map