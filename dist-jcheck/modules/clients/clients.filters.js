import dayjs from 'dayjs';
/** Пока bookings/loyalty на сервере нет (этапы 7/11/13) — пустой, честный контекст */
export function emptyContext(lostAfterDays, today) {
    return { bookings: [], certificates: [], subscriptions: [], productPurchases: [], lostAfterDays, today };
}
function addDays(date, n) {
    return dayjs(date).add(n, 'day').format('YYYY-MM-DD');
}
function inRange(date, range) {
    if (!date)
        return false;
    if (range?.from && date < range.from)
        return false;
    if (range?.to && date > range.to)
        return false;
    return true;
}
const CHAT_LEAD_TAG = 'Лид из чата';
function matchesSegment(row, segment, ctx) {
    const daysAgo = (n) => addDays(ctx.today, -n);
    switch (segment) {
        case 'new':
            return Boolean(row.firstVisit) && row.firstVisit >= daysAgo(30);
        case 'repeat':
            return row.visits >= 2 && Boolean(row.lastVisit) && row.lastVisit >= daysAgo(30);
        case 'lost':
            return row.visits > 0 && Boolean(row.lastVisit) && row.lastVisit < daysAgo(ctx.lostAfterDays);
        case 'subscriptionEnding':
            return ctx.subscriptions.some((s) => s.clientId === row.id && s.status === 'active' && (s.remainingVisits <= 1 || s.expiresAt <= daysAgo(-14)));
        case 'chatLeads':
            return row.tags.includes(CHAT_LEAD_TAG) && row.visits === 0;
    }
}
export function matchesPick(row, pick, ctx) {
    return pick === 'noShow' ? row.noShowCount > 0 : matchesSegment(row, pick, ctx);
}
export function matchesSearch(row, query) {
    const norm = (v) => v.toLowerCase().replace(/ё/g, 'е').trim();
    const q = norm(query);
    if (!q)
        return true;
    const qDigits = q.replace(/\D/g, '');
    const name = norm([row.name, row.lastName, row.middleName].filter(Boolean).join(' '));
    return (name.includes(q) ||
        (qDigits.length >= 3 && (row.phone.replace(/\D/g, '').includes(qDigits) || (row.additionalPhone ?? '').replace(/\D/g, '').includes(qDigits))) ||
        norm(row.email ?? '').includes(q) ||
        norm(row.cardNumber ?? '')
            .replace(/[\s-]/g, '')
            .includes(q.replace(/[\s-]/g, '')));
}
function sortValue(row, column) {
    switch (column) {
        case 'name':
            return row.name.toLowerCase().replace(/ё/g, 'е');
        case 'phone':
            return row.phone;
        case 'email':
            return row.email ?? '';
        case 'sold':
            return row.sold;
        case 'balance':
            return row.balance;
        case 'visits':
            return row.visits;
        case 'discount':
            return row.discount;
        case 'lastVisit':
            return row.lastVisit ?? '';
        case 'firstVisit':
            return row.firstVisit ?? '';
        default:
            return '';
    }
}
export function sortClientRows(rows, sort) {
    const dir = sort.dir === 'asc' ? 1 : -1;
    return rows.slice().sort((a, b) => {
        const va = sortValue(a, sort.columnId);
        const vb = sortValue(b, sort.columnId);
        const emptyA = va === '';
        const emptyB = vb === '';
        if (emptyA !== emptyB)
            return emptyA ? 1 : -1;
        if (va < vb)
            return -dir;
        if (va > vb)
            return dir;
        return a.name.localeCompare(b.name);
    });
}
function ageOf(birthday, today) {
    if (!birthday)
        return undefined;
    return dayjs(today).diff(dayjs(birthday), 'year');
}
function birthdayInRange(birthday, range) {
    if (!birthday || !range?.from || !range.to)
        return false;
    const md = (d) => d.slice(5);
    const from = md(range.from);
    const to = md(range.to);
    const value = md(birthday);
    return from <= to ? value >= from && value <= to : value >= from || value <= to;
}
function matchVisitsGroup(row, f, ctx, logic) {
    const own = ctx.bookings.filter((b) => b.clientId === row.id);
    const checks = [];
    if (f.presence) {
        const inPeriod = f.presenceRange ? own.filter((b) => b.start.slice(0, 10) >= (f.presenceRange.from ?? '0000') && b.start.slice(0, 10) <= (f.presenceRange.to ?? '9999')) : own;
        checks.push(f.presence === 'has' ? inPeriod.length > 0 : inPeriod.length === 0);
    }
    if (f.status?.length)
        checks.push(own.some((b) => f.status.includes(b.status)));
    if (f.visitsCount) {
        const count = own.length;
        checks.push((f.visitsCount.from === undefined || count >= f.visitsCount.from) && (f.visitsCount.to === undefined || count <= f.visitsCount.to));
    }
    if (f.period?.from || f.period?.to)
        checks.push(own.some((b) => inRange(b.start.slice(0, 10), f.period)));
    if (f.staffIds?.length)
        checks.push(own.some((b) => f.staffIds.includes(b.staffId)));
    if (f.serviceIds?.length)
        checks.push(own.some((b) => b.serviceIds.some((id) => f.serviceIds.includes(id))));
    if (f.serviceAmount) {
        const sum = own.reduce((s, b) => s + b.total, 0);
        checks.push((f.serviceAmount.from === undefined || sum >= f.serviceAmount.from) && (f.serviceAmount.to === undefined || sum <= f.serviceAmount.to));
    }
    const active = checks.filter((c) => c !== undefined);
    if (active.length === 0)
        return true;
    return logic === 'and' ? active.every(Boolean) : active.some(Boolean);
}
function matchClientsGroup(row, f, logic, today) {
    const checks = [];
    if (f.gender?.length)
        checks.push(f.gender.includes(row.gender === 'unknown' ? 'unset' : row.gender));
    if (f.hasMobileApp)
        checks.push(f.hasMobileApp === 'yes' ? Boolean(row.appUserId) : !row.appUserId);
    if (f.categoryTags?.length)
        checks.push(row.tags.some((tag) => f.categoryTags.includes(tag)));
    if (f.sold)
        checks.push((f.sold.from === undefined || row.sold >= f.sold.from) && (f.sold.to === undefined || row.sold <= f.sold.to));
    if (f.balance)
        checks.push((f.balance.from === undefined || row.balance >= f.balance.from) && (f.balance.to === undefined || row.balance <= f.balance.to));
    if (f.broadcastPeriod?.from || f.broadcastPeriod?.to)
        checks.push(row.broadcastDates.some((d) => inRange(d, f.broadcastPeriod)));
    if (f.importance?.length)
        checks.push(f.importance.includes(row.importanceClass ?? 'none'));
    if (f.birthdayPeriod?.from && f.birthdayPeriod.to)
        checks.push(birthdayInRange(row.birthday, f.birthdayPeriod));
    if (f.age) {
        const age = ageOf(row.birthday, today);
        checks.push(age !== undefined && (f.age.from === undefined || age >= f.age.from) && (f.age.to === undefined || age <= f.age.to));
    }
    const active = checks.filter((c) => c !== undefined);
    if (active.length === 0)
        return true;
    return logic === 'and' ? active.every(Boolean) : active.some(Boolean);
}
function matchSalesGroup(row, f, ctx, logic) {
    const checks = [];
    if (f.productNames?.length) {
        const own = ctx.productPurchases.filter((p) => p.clientId === row.id);
        checks.push(own.some((p) => f.productNames.includes(p.productName)));
    }
    if (f.certificate && Object.keys(f.certificate).length > 0) {
        const cert = ctx.certificates.find((c) => c.clientId === row.id && (!f.certificate.name || c.name === f.certificate.name));
        checks.push(Boolean(cert) &&
            (!f.certificate.used || (f.certificate.used === 'yes' ? cert.balance === 0 : cert.balance > 0)) &&
            (!f.certificate.balance || ((f.certificate.balance.from === undefined || cert.balance >= f.certificate.balance.from) && (f.certificate.balance.to === undefined || cert.balance <= f.certificate.balance.to))) &&
            (!f.certificate.expiringSoon || cert.expiresAt <= addDays(ctx.today, 14)) &&
            (!f.certificate.soldAt || inRange(cert.soldAt, f.certificate.soldAt)));
    }
    if (f.subscription && Object.keys(f.subscription).length > 0) {
        const sub = ctx.subscriptions.find((s) => s.clientId === row.id && (!f.subscription.name || s.name === f.subscription.name));
        checks.push(Boolean(sub) &&
            (!f.subscription.used || (f.subscription.used === 'yes' ? sub.remainingVisits === 0 : sub.remainingVisits > 0)) &&
            (!f.subscription.status || sub.status === f.subscription.status) &&
            (f.subscription.frozen === undefined || sub.frozen === f.subscription.frozen) &&
            (!f.subscription.expiringSoon || sub.expiresAt <= addDays(ctx.today, 14)) &&
            (!f.subscription.soldAt || inRange(sub.soldAt, f.subscription.soldAt)) &&
            (!f.subscription.remainingVisits ||
                ((f.subscription.remainingVisits.from === undefined || sub.remainingVisits >= f.subscription.remainingVisits.from) &&
                    (f.subscription.remainingVisits.to === undefined || sub.remainingVisits <= f.subscription.remainingVisits.to))));
    }
    const active = checks.filter((c) => c !== undefined);
    if (active.length === 0)
        return true;
    return logic === 'and' ? active.every(Boolean) : active.some(Boolean);
}
function isGroupActive(group, f) {
    if (group === 'visits')
        return Object.keys(f.visits).length > 0;
    if (group === 'clients')
        return Object.keys(f.clients).length > 0;
    return Object.keys(f.sales).some((k) => {
        const v = f.sales[k];
        return v && (Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0);
    });
}
export function matchesFilters(row, f, ctx) {
    if (isGroupActive('visits', f) && !matchVisitsGroup(row, f.visits, ctx, f.logic.visits))
        return false;
    if (isGroupActive('clients', f) && !matchClientsGroup(row, f.clients, f.logic.clients, ctx.today))
        return false;
    if (isGroupActive('sales', f) && !matchSalesGroup(row, f.sales, ctx, f.logic.sales))
        return false;
    return true;
}
//# sourceMappingURL=clients.filters.js.map