import dayjs from 'dayjs';
import { DEFAULT_TZ } from '../../common/time/time.js';
/** Тихие часы 21:00–10:00 по Еревану (docs/backend/05 §7, зафиксировано PLAN.md §6 №10 «E6») — фиксированное окно */
const QUIET_START_HOUR = 21;
const QUIET_END_HOUR = 10;
export function inQuietHours(at, tz = DEFAULT_TZ) {
    const h = dayjs(at).tz(tz).hour();
    return h >= QUIET_START_HOUR || h < QUIET_END_HOUR;
}
/** Ближайшее «конец тихих часов» после `at` — куда сдвинуть send_at, если попали в тихое окно */
export function nextQuietHoursEnd(at, tz = DEFAULT_TZ) {
    const local = dayjs(at).tz(tz);
    const today10 = local.hour(QUIET_END_HOUR).minute(0).second(0).millisecond(0);
    const target = local.hour() < QUIET_END_HOUR ? today10 : today10.add(1, 'day');
    return target.toDate();
}
//# sourceMappingURL=quiet-hours.js.map