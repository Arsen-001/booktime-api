import dayjs from 'dayjs';
import type { ClientRowView } from './clients.views.js';
import type { FilterState, QuickPick } from './clients.schemas.js';

/**
 * Подборки, поиск, конструктор фильтров, сортировка — порт `booking-platform/src/domain/clients/filters.ts`
 * (те же чистые функции, PLAN §7 «на сервер переезжают как есть»). `FilterContext.bookings/certificates/
 * subscriptions/productPurchases` пока всегда пусты — тех таблиц ещё нет (этапы 7/11/13); с пустым контекстом
 * функции возвращают ровно то же, что дал бы настоящий контекст с нулём визитов/продаж — честно, не выдумано.
 */
export interface BookingIndexEntry {
  clientId: string;
  status: string;
  start: string;
  total: number;
  staffId: string;
  serviceIds: string[];
}
export interface CertificateEntry {
  clientId: string;
  name: string;
  balance: number;
  soldAt: string;
  expiresAt: string;
}
export interface SubscriptionEntry {
  clientId: string;
  name: string;
  status: 'active' | 'expired';
  frozen: boolean;
  soldAt: string;
  expiresAt: string;
  remainingVisits: number;
}
export interface ProductPurchaseEntry {
  clientId: string;
  productName: string;
}

export interface FilterContext {
  bookings: BookingIndexEntry[];
  certificates: CertificateEntry[];
  subscriptions: SubscriptionEntry[];
  productPurchases: ProductPurchaseEntry[];
  lostAfterDays: number;
  today: string;
}

/** Пока bookings/loyalty на сервере нет (этапы 7/11/13) — пустой, честный контекст */
export function emptyContext(lostAfterDays: number, today: string): FilterContext {
  return { bookings: [], certificates: [], subscriptions: [], productPurchases: [], lostAfterDays, today };
}

function addDays(date: string, n: number): string {
  return dayjs(date).add(n, 'day').format('YYYY-MM-DD');
}

function inRange(date: string | undefined, range?: { from?: string; to?: string }): boolean {
  if (!date) return false;
  if (range?.from && date < range.from) return false;
  if (range?.to && date > range.to) return false;
  return true;
}

const CHAT_LEAD_TAG = 'Лид из чата';

function matchesSegment(row: ClientRowView, segment: Exclude<QuickPick, 'noShow'>, ctx: FilterContext): boolean {
  const daysAgo = (n: number) => addDays(ctx.today, -n);
  switch (segment) {
    // ⭐ Пора записать: срок повтора услуги наступил, будущей записи нет (dueAt считает clients.visits.ts)
    case 'due':
      return Boolean(row.dueAt) && row.dueAt! <= ctx.today;
    case 'new':
      return Boolean(row.firstVisit) && row.firstVisit! >= daysAgo(30);
    case 'repeat':
      return row.visits >= 2 && Boolean(row.lastVisit) && row.lastVisit! >= daysAgo(30);
    case 'lost':
      return row.visits > 0 && Boolean(row.lastVisit) && row.lastVisit! < daysAgo(ctx.lostAfterDays);
    case 'subscriptionEnding':
      return ctx.subscriptions.some((s) => s.clientId === row.id && s.status === 'active' && (s.remainingVisits <= 1 || s.expiresAt <= daysAgo(-14)));
    case 'chatLeads':
      return row.tags.includes(CHAT_LEAD_TAG) && row.visits === 0;
  }
}

export function matchesPick(row: ClientRowView, pick: QuickPick, ctx: FilterContext): boolean {
  return pick === 'noShow' ? row.noShowCount > 0 : matchesSegment(row, pick, ctx);
}

export function matchesSearch(row: ClientRowView, query: string): boolean {
  const norm = (v: string) => v.toLowerCase().replace(/ё/g, 'е').trim();
  const q = norm(query);
  if (!q) return true;
  const qDigits = q.replace(/\D/g, '');
  const name = norm([row.name, row.lastName, row.middleName].filter(Boolean).join(' '));
  return (
    name.includes(q) ||
    (qDigits.length >= 3 && (row.phone.replace(/\D/g, '').includes(qDigits) || (row.additionalPhone ?? '').replace(/\D/g, '').includes(qDigits))) ||
    norm(row.email ?? '').includes(q) ||
    norm(row.cardNumber ?? '')
      .replace(/[\s-]/g, '')
      .includes(q.replace(/[\s-]/g, ''))
  );
}

function sortValue(row: ClientRowView, column: string): string | number {
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

export function sortClientRows(rows: ClientRowView[], sort: { columnId: string; dir: 'asc' | 'desc' }): ClientRowView[] {
  const dir = sort.dir === 'asc' ? 1 : -1;
  return rows.slice().sort((a, b) => {
    const va = sortValue(a, sort.columnId);
    const vb = sortValue(b, sort.columnId);
    const emptyA = va === '';
    const emptyB = vb === '';
    if (emptyA !== emptyB) return emptyA ? 1 : -1;
    if (va < vb) return -dir;
    if (va > vb) return dir;
    return a.name.localeCompare(b.name);
  });
}

/**
 * ⭐ «Пора записать» без выбранной сортировки: самые просроченные первыми (срок повтора раньше — выше), как
 * «Кого позвать»; без срока — в конце (sortByDue мока, src/domain/clients/filters.ts).
 */
export function sortByDue(rows: ClientRowView[]): ClientRowView[] {
  return rows.slice().sort((a, b) => {
    if (!a.dueAt !== !b.dueAt) return a.dueAt ? -1 : 1;
    if (a.dueAt && b.dueAt && a.dueAt !== b.dueAt) return a.dueAt < b.dueAt ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function ageOf(birthday: string | undefined, today: string): number | undefined {
  if (!birthday) return undefined;
  return dayjs(today).diff(dayjs(birthday), 'year');
}

function birthdayInRange(birthday: string | undefined, range?: { from?: string; to?: string }): boolean {
  if (!birthday || !range?.from || !range.to) return false;
  const md = (d: string) => d.slice(5);
  const from = md(range.from);
  const to = md(range.to);
  const value = md(birthday);
  return from <= to ? value >= from && value <= to : value >= from || value <= to;
}

function matchVisitsGroup(row: ClientRowView, f: FilterState['visits'], ctx: FilterContext, logic: 'and' | 'or'): boolean {
  const own = ctx.bookings.filter((b) => b.clientId === row.id);
  const checks: (boolean | undefined)[] = [];
  if (f.presence) {
    const inPeriod = f.presenceRange ? own.filter((b) => b.start.slice(0, 10) >= (f.presenceRange!.from ?? '0000') && b.start.slice(0, 10) <= (f.presenceRange!.to ?? '9999')) : own;
    checks.push(f.presence === 'has' ? inPeriod.length > 0 : inPeriod.length === 0);
  }
  if (f.status?.length) checks.push(own.some((b) => f.status!.includes(b.status)));
  if (f.visitsCount) {
    const count = own.length;
    checks.push((f.visitsCount.from === undefined || count >= f.visitsCount.from) && (f.visitsCount.to === undefined || count <= f.visitsCount.to));
  }
  if (f.period?.from || f.period?.to) checks.push(own.some((b) => inRange(b.start.slice(0, 10), f.period)));
  if (f.staffIds?.length) checks.push(own.some((b) => f.staffIds!.includes(b.staffId)));
  if (f.serviceIds?.length) checks.push(own.some((b) => b.serviceIds.some((id) => f.serviceIds!.includes(id))));
  if (f.serviceAmount) {
    const sum = own.reduce((s, b) => s + b.total, 0);
    checks.push((f.serviceAmount.from === undefined || sum >= f.serviceAmount.from) && (f.serviceAmount.to === undefined || sum <= f.serviceAmount.to));
  }
  const active = checks.filter((c): c is boolean => c !== undefined);
  if (active.length === 0) return true;
  return logic === 'and' ? active.every(Boolean) : active.some(Boolean);
}

function matchClientsGroup(row: ClientRowView, f: FilterState['clients'], logic: 'and' | 'or', today: string): boolean {
  const checks: (boolean | undefined)[] = [];
  if (f.gender?.length) checks.push(f.gender.includes(row.gender === 'unknown' ? 'unset' : row.gender));
  if (f.hasMobileApp) checks.push(f.hasMobileApp === 'yes' ? Boolean(row.appUserId) : !row.appUserId);
  if (f.categoryTags?.length) checks.push(row.tags.some((tag) => f.categoryTags!.includes(tag)));
  if (f.sold) checks.push((f.sold.from === undefined || row.sold >= f.sold.from) && (f.sold.to === undefined || row.sold <= f.sold.to));
  if (f.balance) checks.push((f.balance.from === undefined || row.balance >= f.balance.from) && (f.balance.to === undefined || row.balance <= f.balance.to));
  if (f.broadcastPeriod?.from || f.broadcastPeriod?.to) checks.push(row.broadcastDates.some((d) => inRange(d, f.broadcastPeriod)));
  if (f.importance?.length) checks.push(f.importance.includes(row.importanceClass ?? 'none'));
  if (f.birthdayPeriod?.from && f.birthdayPeriod.to) checks.push(birthdayInRange(row.birthday, f.birthdayPeriod));
  if (f.age) {
    const age = ageOf(row.birthday, today);
    checks.push(age !== undefined && (f.age.from === undefined || age >= f.age.from) && (f.age.to === undefined || age <= f.age.to));
  }
  const active = checks.filter((c): c is boolean => c !== undefined);
  if (active.length === 0) return true;
  return logic === 'and' ? active.every(Boolean) : active.some(Boolean);
}

function matchSalesGroup(row: ClientRowView, f: FilterState['sales'], ctx: FilterContext, logic: 'and' | 'or'): boolean {
  const checks: (boolean | undefined)[] = [];
  if (f.productNames?.length) {
    const own = ctx.productPurchases.filter((p) => p.clientId === row.id);
    checks.push(own.some((p) => f.productNames!.includes(p.productName)));
  }
  if (f.certificate && Object.keys(f.certificate).length > 0) {
    const cert = ctx.certificates.find((c) => c.clientId === row.id && (!f.certificate!.name || c.name === f.certificate!.name));
    checks.push(
      Boolean(cert) &&
        (!f.certificate.used || (f.certificate.used === 'yes' ? cert!.balance === 0 : cert!.balance > 0)) &&
        (!f.certificate.balance || ((f.certificate.balance.from === undefined || cert!.balance >= f.certificate.balance.from) && (f.certificate.balance.to === undefined || cert!.balance <= f.certificate.balance.to))) &&
        (!f.certificate.expiringSoon || cert!.expiresAt <= addDays(ctx.today, 14)) &&
        (!f.certificate.soldAt || inRange(cert!.soldAt, f.certificate.soldAt)),
    );
  }
  if (f.subscription && Object.keys(f.subscription).length > 0) {
    const sub = ctx.subscriptions.find((s) => s.clientId === row.id && (!f.subscription!.name || s.name === f.subscription!.name));
    checks.push(
      Boolean(sub) &&
        (!f.subscription.used || (f.subscription.used === 'yes' ? sub!.remainingVisits === 0 : sub!.remainingVisits > 0)) &&
        (!f.subscription.status || sub!.status === f.subscription.status) &&
        (f.subscription.frozen === undefined || sub!.frozen === f.subscription.frozen) &&
        (!f.subscription.expiringSoon || sub!.expiresAt <= addDays(ctx.today, 14)) &&
        (!f.subscription.soldAt || inRange(sub!.soldAt, f.subscription.soldAt)) &&
        (!f.subscription.remainingVisits ||
          ((f.subscription.remainingVisits.from === undefined || sub!.remainingVisits >= f.subscription.remainingVisits.from) &&
            (f.subscription.remainingVisits.to === undefined || sub!.remainingVisits <= f.subscription.remainingVisits.to))),
    );
  }
  const active = checks.filter((c): c is boolean => c !== undefined);
  if (active.length === 0) return true;
  return logic === 'and' ? active.every(Boolean) : active.some(Boolean);
}

function isGroupActive(group: 'visits' | 'clients' | 'sales', f: FilterState): boolean {
  if (group === 'visits') return Object.keys(f.visits).length > 0;
  if (group === 'clients') return Object.keys(f.clients).length > 0;
  return Object.keys(f.sales).some((k) => {
    const v = f.sales[k as keyof typeof f.sales];
    return v && (Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0);
  });
}

export function matchesFilters(row: ClientRowView, f: FilterState, ctx: FilterContext): boolean {
  if (isGroupActive('visits', f) && !matchVisitsGroup(row, f.visits, ctx, f.logic.visits)) return false;
  if (isGroupActive('clients', f) && !matchClientsGroup(row, f.clients, f.logic.clients, ctx.today)) return false;
  if (isGroupActive('sales', f) && !matchSalesGroup(row, f.sales, ctx, f.logic.sales)) return false;
  return true;
}
