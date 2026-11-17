import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../common/prisma.service.js';
import { DEFAULT_TZ, localDayRangeUtc, nowLocal, utcToLocal } from '../../common/time/time.js';
import { BookingPaymentsService } from '../finance/booking-payments.service.js';
import { bookingView, type BookingView } from '../journal/journal.views.js';
import { extrasOf } from '../journal/rules.js';

/**
 * «Записи» (/biz/records, F-01-181) страницей и поиск журнала (F-01-163) — на сервере, а не всеми записями бизнеса
 * в браузере (скорость, 17.11.2026: «Записи» 574 КБ, поиск 350 КБ на открытие). Правила отбора — те же, что
 * src/domain/records.ts и src/domain/journal-search.ts сайта (мок зовёт их же).
 */

export type RecordsCancelFilter = 'all' | 'notCancelled' | 'cancelled' | 'deleted';
export type RecordsSourceFilter = 'all' | 'online' | 'offline';
export type RecordsPaidFilter = 'all' | 'paid' | 'unpaid';
export type RecordsSortKey = 'when' | 'total';

export interface RecordsQuery {
  cancel: RecordsCancelFilter;
  source: RecordsSourceFilter;
  paid: RecordsPaidFilter;
  categoryId?: string;
  resourceId?: string;
  /** Без права видеть чужие записи — только записи этого сотрудника (b.staffId, F-01-178) */
  staffId?: string;
  /** Окно истории (F-01-178): записи с этого дня 'YYYY-MM-DD' */
  from?: string;
  /** Сортировка колонки таблицы; нет — по времени, свежие первыми */
  sort?: RecordsSortKey;
  dir?: 'asc' | 'desc';
  page: number;
  pageSize: number;
}

/** Онлайн-источники записи (ONLINE_SOURCES экрана) */
const ONLINE_SOURCES = new Set(['app', 'link', 'widget']);
const CANCELLED_BY = ['cancelled_by_client', 'cancelled_by_master'];

const RECORD_SELECT = { id: true, status: true, source: true, total: true, deletedAt: true, startAt: true, resourceIds: true, extras: true } as const;

/** Запрос → цифры номера и слова имени — parseJournalSearch сайта */
export function parseJournalSearch(query: string): { text: string; digits: string } {
  const raw = query.replace(/\D/g, '');
  const digits = raw.startsWith('374') && raw.length > 3 ? raw.slice(3) : raw.startsWith('0') && raw.length > 1 ? raw.slice(1) : raw;
  const text = /\p{L}/u.test(query) ? normalizeSearch(query) : '';
  return { text, digits: digits.length >= 2 ? digits : '' };
}

/** normalizeSearch сайта (src/lib/text.ts): без регистра и ё */
export function normalizeSearch(value: string): string {
  return value.toLowerCase().replace(/ё/g, 'е').trim();
}

/** 8 местных цифр номера — localDigits сайта (src/lib/phone.ts) */
export function localDigits(phone: string | null | undefined): string {
  if (!phone) return '';
  let d = phone.replace(/\D/g, '');
  if (d.startsWith('374')) d = d.slice(3);
  if (d.startsWith('0') && d.length === 9) d = d.slice(1);
  return d.length === 8 ? d : phone.replace(/\D/g, '').slice(-8);
}

export function matchClient(c: { name: string; phone: string }, text: string, digits: string): boolean {
  if (digits && localDigits(c.phone).includes(digits)) return true;
  if (text.length < 2) return false;
  const name = normalizeSearch(c.name);
  // Каждое слово запроса — в имени: «арам кар» находит «Арам Карамян»
  return text.split(/\s+/).every((w) => name.includes(w));
}

@Injectable()
export class RecordsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: BookingPaymentsService,
  ) {}

  private async tzByLocation(businessId: string): Promise<Map<string, string>> {
    const rows = await this.prisma.location.findMany({ where: { businessId }, select: { id: true, tz: true } });
    return new Map(rows.map((r) => [r.id, r.tz ?? DEFAULT_TZ]));
  }

  /**
   * Одна страница «Записей» с итогами по всему отбору: «Показано», «Выручка» (без удалённых), «Удалено». Отбор и
   * порядок — filterRecords/compareRecords сайта: статус отмены/удаления, источник, оплата (оплачено = сумма записи −
   * остаток к оплате, как у окна оплаты), категория записи, ресурс; по умолчанию — свежие первыми.
   */
  async recordsPage(businessId: string, q: RecordsQuery) {
    const where: Prisma.BookingWhereInput = { businessId };
    if (q.staffId) where.staffId = q.staffId;
    if (q.from) where.startAt = { gte: localDayRangeUtc(q.from).from };
    if (q.cancel === 'deleted') where.deletedAt = { not: null };
    else if (q.cancel === 'cancelled') where.OR = [{ deletedAt: { not: null } }, { status: { in: CANCELLED_BY } }];
    else if (q.cancel === 'notCancelled') Object.assign(where, { deletedAt: null, status: { notIn: CANCELLED_BY } });
    if (q.source === 'online') where.source = { in: [...ONLINE_SOURCES] };
    else if (q.source === 'offline') where.source = { notIn: [...ONLINE_SOURCES] };
    let rows = await this.prisma.booking.findMany({ where, select: RECORD_SELECT });

    if (q.categoryId) rows = rows.filter((b) => extrasOf(b.extras).categoryIds.includes(q.categoryId!));
    if (q.resourceId) {
      const resource = await this.prisma.resource.findFirst({ where: { id: q.resourceId, businessId }, select: { instances: true } });
      const instanceIds = new Set((Array.isArray(resource?.instances) ? (resource.instances as { id: string }[]) : []).map((i) => i.id));
      rows = rows.filter((b) => (Array.isArray(b.resourceIds) ? (b.resourceIds as string[]) : []).some((id) => instanceIds.has(id)));
    }
    if (q.paid !== 'all') {
      const briefs = await this.payments.briefs([businessId], rows.map((b) => b.id));
      rows = rows.filter((b) => {
        const total = Number(b.total);
        const brief = briefs[b.id];
        const paid = brief ? Math.max(0, total - brief.due) : 0;
        const isPaid = paid > 0 && paid >= total;
        return q.paid === 'paid' ? isPaid : !isPaid;
      });
    }

    const total = rows.length;
    const revenue = rows.reduce((s, b) => (b.deletedAt ? s : s + Number(b.total)), 0);
    const deleted = rows.filter((b) => b.deletedAt).length;
    // Порядок: по времени, свежие первыми (одна минута — по id); колонка таблицы — поверх него, как устойчивая сортировка
    const base = (a: (typeof rows)[number], b: (typeof rows)[number]) => b.startAt.getTime() - a.startAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const dir = q.dir === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      if (q.sort === 'when') return (a.startAt.getTime() - b.startAt.getTime()) * dir || base(a, b);
      if (q.sort === 'total') return (Number(a.total) - Number(b.total)) * dir || base(a, b);
      return base(a, b);
    });
    const pageSize = Math.min(100, Math.max(1, q.pageSize));
    const lastPage = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(Math.max(1, q.page), lastPage);
    const ids = rows.slice((page - 1) * pageSize, page * pageSize).map((b) => b.id);
    const full = ids.length ? await this.prisma.booking.findMany({ where: { id: { in: ids } } }) : [];
    const byId = new Map(full.map((b) => [b.id, b]));
    const tz = await this.tzByLocation(businessId);
    const items: BookingView[] = ids.map((id) => byId.get(id)).filter((b): b is NonNullable<typeof b> => Boolean(b)).map((b) => bookingView(b, tz.get(b.locationId) ?? DEFAULT_TZ));
    // Клиенты строк страницы: у старых записей их нет в зеркале браузера. Телефон — полем clientPhone: без права
    // clients.phones его скрывает ClientPhonesInterceptor, как и везде в кабинете
    const clientIds = [...new Set(items.map((b) => b.clientId).filter((x): x is string => Boolean(x)))];
    const clientRows = clientIds.length ? await this.prisma.client.findMany({ where: { id: { in: clientIds }, businessId }, select: { id: true, name: true, phone: true } }) : [];
    const clients = Object.fromEntries(clientRows.map((c) => [c.id, { id: c.id, name: c.name, clientPhone: c.phone }]));
    return { items, clients, total, revenue, deleted, page, pageSize };
  }

  /**
   * Поиск журнала (F-01-163): клиенты бизнеса по имени или части номера и их записи — сначала будущие (ближайшая
   * первой), потом прошедшие (свежая первой). Без групповых и удалённых; свои записи и окно истории — по правам.
   * Номер ищется только с правом видеть телефоны (clients.phones): без него телефоны скрыты, искать по ним нельзя.
   */
  async search(businessId: string, input: { q: string; staffId?: string; from?: string; byPhone: boolean; clientsLimit: number }) {
    const { text, digits: rawDigits } = parseJournalSearch(input.q);
    const digits = input.byPhone ? rawDigits : '';
    if (text.length < 2 && digits.length < 2) return { clients: [], clientsTotal: 0, bookings: [], upcoming: 0, recent: 0 };
    const all = await this.prisma.client.findMany({ where: { businessId, deletedAt: null }, select: { id: true, name: true, phone: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    const firstWord = text.split(/\s+/)[0] ?? '';
    // Сначала те, у кого слово имени начинается с запроса («Арам Есаян» раньше «Давид Карамян»)
    const rank = (c: { name: string }) => (text && normalizeSearch(c.name).split(/\s+/).some((w) => w.startsWith(firstWord)) ? 0 : 1);
    const matched = all.filter((c) => matchClient(c, text, digits)).sort((a, b) => rank(a) - rank(b));
    const nameById = new Map(matched.map((c) => [c.id, c.name]));
    const where: Prisma.BookingWhereInput = { businessId, clientId: { in: matched.map((c) => c.id) }, deletedAt: null, groupEventId: null };
    if (input.staffId) where.staffId = input.staffId;
    if (input.from) where.startAt = { gte: localDayRangeUtc(input.from).from };
    const rows = matched.length
      ? await this.prisma.booking.findMany({ where, select: { id: true, startAt: true, staffId: true, clientId: true, status: true, locationId: true }, orderBy: [{ startAt: 'asc' }, { id: 'asc' }] })
      : [];
    const tz = await this.tzByLocation(businessId);
    const now = nowLocal();
    const list = rows.map((b) => ({ id: b.id, start: utcToLocal(b.startAt, tz.get(b.locationId) ?? DEFAULT_TZ), staffId: b.staffId, clientId: b.clientId!, clientName: nameById.get(b.clientId!) ?? '', status: b.status }));
    const upcoming = list.filter((b) => b.start >= now);
    const recent = list.filter((b) => b.start < now).reverse();
    return {
      clients: matched.slice(0, input.clientsLimit).map((c) => ({ id: c.id, name: c.name, clientPhone: c.phone })),
      clientsTotal: matched.length,
      bookings: [...upcoming, ...recent],
      upcoming: upcoming.length,
      recent: recent.length,
    };
  }
}
