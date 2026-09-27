import dayjs from 'dayjs';
import '../../common/time/time.js';
export function newSlotRule(id, overrides = {}) {
    return {
        id,
        isBase: false,
        weekdays: [0, 1, 2, 3, 4, 5, 6],
        density: 'optimal',
        startMode: 'from_window',
        windowFrom: '00:00',
        windowTo: '24:00',
        stepMin: 30,
        leadTimeMin: undefined,
        disabledSlots: [],
        ...overrides,
    };
}
// ─────────── время ───────────
export function toMinutes(time) {
    const [h, m] = time.split(':').map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
}
export function fromMinutes(total) {
    const h = Math.floor(total / 60);
    const m = total % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
/** 0 = пн … 6 = вс (как weekdayIndex фронта) */
export function weekdayIndex(date) {
    return (dayjs(date, 'YYYY-MM-DD').day() + 6) % 7;
}
export function addDays(date, n) {
    return dayjs(date, 'YYYY-MM-DD').add(n, 'day').format('YYYY-MM-DD');
}
export function eachDay(from, to) {
    const out = [];
    for (let d = from; d <= to && out.length < 3700; d = addDays(d, 1))
        out.push(d);
    return out;
}
/** Понедельник недели даты */
export function weekStart(date) {
    return addDays(date, -weekdayIndex(date));
}
export function combine(date, time) {
    return `${date}T${time}`;
}
export function addMinutesLocal(dt, minutes) {
    return dayjs(dt, 'YYYY-MM-DDTHH:mm').add(minutes, 'minute').format('YYYY-MM-DDTHH:mm');
}
// ─────────── интервалы ───────────
export function rangesToIntervals(ranges) {
    return ranges.map((r) => [toMinutes(r.from), toMinutes(r.to)]).filter(([a, b]) => b > a);
}
export function intervalsToRanges(list) {
    return list.map(([a, b]) => ({ from: fromMinutes(a), to: fromMinutes(b) }));
}
export function subtractInterval(list, cut) {
    const out = [];
    for (const [a, b] of list) {
        if (cut[1] <= a || cut[0] >= b)
            out.push([a, b]);
        else {
            if (cut[0] > a)
                out.push([a, cut[0]]);
            if (cut[1] < b)
                out.push([cut[1], b]);
        }
    }
    return out;
}
export function intersectIntervals(a, b) {
    const out = [];
    for (const [a1, a2] of a)
        for (const [b1, b2] of b) {
            const s = Math.max(a1, b1);
            const e = Math.min(a2, b2);
            if (e > s)
                out.push([s, e]);
        }
    return out;
}
export function mergeIntervals(list) {
    const sorted = [...list].sort((x, y) => x[0] - y[0]);
    const out = [];
    for (const [a, b] of sorted) {
        const last = out[out.length - 1];
        if (last && a <= last[1])
            last[1] = Math.max(last[1], b);
        else
            out.push([a, b]);
    }
    return out;
}
export function overlaps(a, b) {
    return a[0] < b[1] && b[0] < a[1];
}
// ─────────── часы ───────────
/** Часы одного графика на дату: исключение важнее шаблона недели; [] — выходной */
export function scheduleHours(s, date) {
    return s.overrides[date] ?? s.week[String(weekdayIndex(date))] ?? [];
}
/** Рабочие часы мастера на дату — объединение всех его графиков (с locationId — только этого филиала) */
export function staffDayHours(schedules, staffId, date, locationId) {
    const ranges = [];
    for (const s of schedules) {
        if (s.staffId !== staffId || (locationId && s.locationId !== locationId))
            continue;
        ranges.push(...scheduleHours(s, date));
    }
    return intervalsToRanges(mergeIntervals(rangesToIntervals(ranges)));
}
export function minutesOf(hours) {
    return hours.reduce((sum, r) => sum + (toMinutes(r.to) - toMinutes(r.from)), 0);
}
export function stripBreaks(hours) {
    if (hours.length <= 1)
        return hours;
    return [{ from: hours[0].from, to: hours[hours.length - 1].to }];
}
export function hoursText(hours) {
    if (hours.length === 0)
        return '—';
    return `${hours[0].from}–${hours[hours.length - 1].to}`;
}
/**
 * Когда мастер доступен для записи в дату — с учётом режима календаря (F-00-051): «всё свободно» — часы графика
 * минус отметки «занято»; «всё занято» — только часы, открытые отметками «свободно». Занятость здесь НЕ вычитается.
 * Режим busy без пересечения с часами — как во фронте (04 §7 вопрос 1 решён предложением только для салона — см. PROGRESS).
 */
export function staffWorkIntervals(staff, schedulesAll, marksAll, date, q = {}) {
    if (staff.status !== 'active')
        return [];
    let schedules = schedulesAll.filter((s) => s.staffId === staff.id && (!q.locationId || s.locationId === q.locationId) && (!s.openUntil || date <= s.openUntil));
    if (q.workplace && schedules.some((s) => s.workplace === q.workplace))
        schedules = schedules.filter((s) => s.workplace === q.workplace);
    if (!schedules.length)
        return [];
    const marks = marksAll.filter((m) => m.staffId === staff.id && m.date === date);
    const out = [];
    if (staff.calendarMode === 'busy') {
        for (const m of marks) {
            if (m.kind !== 'free')
                continue;
            const sch = schedules.find((s) => m.workplace && s.workplace === m.workplace) ?? schedules[0];
            for (const [from, to] of rangesToIntervals([m]))
                out.push({ from, to, locationId: sch.locationId, workplace: sch.workplace });
        }
    }
    else {
        const busyMarks = marks.filter((m) => m.kind === 'busy');
        for (const sch of schedules) {
            let free = rangesToIntervals(scheduleHours(sch, date));
            for (const cut of rangesToIntervals(busyMarks))
                free = subtractInterval(free, cut);
            for (const [from, to] of free)
                out.push({ from, to, locationId: sch.locationId, workplace: sch.workplace });
        }
    }
    return out.sort((a, b) => a.from - b.from);
}
// ─────────── правила слотов ───────────
export function resolveSlotRule(rules, date) {
    const list = rules && rules.length ? rules : [newSlotRule('scr_default', { isBase: true })];
    const wd = weekdayIndex(date);
    return list.find((r) => !r.isBase && r.weekdays.includes(wd)) ?? list.find((r) => r.isBase) ?? list[0];
}
export function passesServiceWindow(window, date, startMin) {
    if (!window)
        return true;
    if (window.from && date < window.from)
        return false;
    if (window.to && date > window.to)
        return false;
    if (window.hoursFrom && startMin < toMinutes(window.hoursFrom))
        return false;
    if (window.hoursTo && startMin > toMinutes(window.hoursTo))
        return false;
    const wd = weekdayIndex(date);
    if (window.days === 'weekdays' && wd >= 5)
        return false;
    if (window.days === 'weekends' && wd < 5)
        return false;
    if (window.days === 'custom' && !(window.customDates ?? []).includes(date))
        return false;
    return true;
}
/** Сетка кандидатов начала по правилу и типу слотов (F-02-046…050, F-02-053) */
export function candidateStarts(rule, free, shiftStartMin, need, stepOverride) {
    const step = Math.max(5, stepOverride ?? rule.stepMin);
    const extra = new Set();
    if (rule.density === 'dynamic') {
        const starts = [];
        for (const [a, b] of free) {
            let t = a;
            while (t + need <= b) {
                starts.push(t);
                t += step;
            }
        }
        return { starts, extra };
    }
    const anchor = rule.startMode === 'from_shift_start' ? shiftStartMin : toMinutes(rule.windowFrom);
    const windowEnd = rule.startMode === 'from_shift_start' ? 24 * 60 : toMinutes(rule.windowTo);
    const grid = new Set();
    for (let t = anchor; t < windowEnd; t += step) {
        if (free.some(([a, b]) => t >= a && t + need <= b))
            grid.add(t);
    }
    if (rule.density === 'optimal') {
        for (const [a, b] of free) {
            if (a + need <= b && !grid.has(a)) {
                grid.add(a);
                extra.add(a);
            }
        }
    }
    if (rule.startMode === 'from_window' && rule.disabledSlots.length > 0) {
        const disabled = new Set(rule.disabledSlots);
        for (const t of [...grid])
            if (disabled.has(fromMinutes(t)))
                grid.delete(t);
    }
    return { starts: [...grid].sort((a, b) => a - b), extra };
}
export function previewRuleGrid(rule, dayHours) {
    const free = rangesToIntervals(dayHours.length > 0 ? dayHours : [{ from: '00:00', to: '24:00' }]);
    const shiftStart = dayHours.length > 0 ? toMinutes(dayHours[0].from) : 0;
    const { starts, extra } = candidateStarts(rule, free, shiftStart, rule.stepMin);
    const disabled = new Set(rule.disabledSlots);
    return starts.map((t) => ({ time: fromMinutes(t), enabled: !disabled.has(fromMinutes(t)), extra: extra.has(t) }));
}
/** Свободные окна мастера на дату — computeFreeSlots фронта (04 §2) */
export function computeFreeSlots(q) {
    const { staff } = q;
    if (staff.status !== 'active' || staff.onlineBookingEnabled === false)
        return [];
    const todayIso = q.now.slice(0, 10);
    if (q.date < todayIso)
        return [];
    const work = staffWorkIntervals(staff, q.schedules, q.marks, q.date, { locationId: q.locationId });
    if (work.length === 0)
        return [];
    const explicitNeed = q.durationMax ?? q.durationMin;
    const busy = q.busy.filter((b) => !(q.overNoShow && b.noShow)).map((b) => [b.from, b.to]);
    const isToday = q.date === todayIso;
    const nowMin = Math.ceil(toMinutes(q.now.slice(11, 16)) / 5) * 5;
    const out = [];
    const groups = new Map();
    for (const w of work) {
        const key = `${w.locationId}|${w.workplace}`;
        const g = groups.get(key) ?? { locationId: w.locationId, workplace: w.workplace, free: [] };
        g.free.push([w.from, w.to]);
        groups.set(key, g);
    }
    for (const g of groups.values()) {
        if (q.unavailableFor(g.locationId).some((r) => q.date >= r.from && q.date <= r.to))
            continue;
        const buffer = q.bufferAfterMin || q.bufferFor(g.locationId);
        const need = explicitNeed + buffer;
        let free = mergeIntervals(g.free);
        for (const cut of busy)
            free = subtractInterval(free, cut);
        if (isToday)
            free = intersectIntervals(free, [[nowMin, 24 * 60]]);
        if (free.length === 0)
            continue;
        const schedule = q.schedules.find((s) => s.staffId === staff.id && s.locationId === g.locationId && s.workplace === g.workplace);
        const hours = schedule ? scheduleHours(schedule, q.date) : [];
        const rule = resolveSlotRule(q.rulesFor(g.locationId), q.date);
        const shiftStartMin = hours.length > 0 ? toMinutes(hours[0].from) : free[0][0];
        const { starts, extra } = candidateStarts(rule, free, shiftStartMin, need, q.stepMin);
        const leadCutoff = rule.leadTimeMin ? addMinutesLocal(q.now, rule.leadTimeMin) : null;
        const resources = q.resourcesFor?.(g.locationId) ?? [];
        for (const t of starts) {
            const start = combine(q.date, fromMinutes(t));
            if (leadCutoff && start < leadCutoff)
                continue;
            if (!passesServiceWindow(q.serviceWindow, q.date, t))
                continue;
            if (!resources.every((r) => r.used.filter((u) => overlaps(u, [t, t + need])).length < r.instances))
                continue;
            out.push({
                staffId: staff.id,
                locationId: g.locationId,
                workplace: g.workplace,
                start,
                end: combine(q.date, fromMinutes(t + explicitNeed)),
                ...(extra.has(t) ? { extra: true } : {}),
            });
        }
    }
    return out.sort((x, y) => x.start.localeCompare(y.start));
}
/** Окна быстрой записи мастера (F-00-060, Q-1): правила онлайн-записи не действуют, шаг 15 мин */
export function computeQuickSlots(q) {
    const work = staffWorkIntervals(q.staff, q.schedules, q.marks, q.date, { locationId: q.locationId });
    const busy = q.busy.map((b) => [b.from, b.to]);
    const minStart = q.date === q.now.slice(0, 10) ? Math.ceil(toMinutes(q.now.slice(11, 16)) / 15) * 15 : 0;
    const need = q.durationMin + q.bufferAfterMin;
    const out = [];
    for (const w of work) {
        for (let t = Math.max(w.from, minStart); t + need <= w.to; t += 15) {
            if (busy.some(([a, b]) => t < b && t + need > a))
                continue;
            out.push({
                staffId: q.staff.id,
                locationId: w.locationId,
                workplace: w.workplace,
                start: combine(q.date, fromMinutes(t)),
                end: combine(q.date, fromMinutes(t + q.durationMin)),
            });
        }
    }
    return out.sort((a, b) => a.start.localeCompare(b.start));
}
//# sourceMappingURL=engine.js.map