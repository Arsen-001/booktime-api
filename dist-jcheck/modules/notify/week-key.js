import dayjs from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek.js';
import { DEFAULT_TZ } from '../../common/time/time.js';
dayjs.extend(isoWeek);
/** Календарная неделя по Еревану (§5 «понятно мастеру, пн–вс»): '2026-W39' */
export function weekKeyOf(at, tz = DEFAULT_TZ) {
    const local = dayjs(at).tz(tz);
    return `${local.isoWeekYear()}-W${String(local.isoWeek()).padStart(2, '0')}`;
}
//# sourceMappingURL=week-key.js.map