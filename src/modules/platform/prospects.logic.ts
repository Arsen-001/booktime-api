/**
 * «Места» (03.10.2026) — чистые правила без базы: ключ дедупликации, разбор строки импорта (snake_case от сборщиков
 * данных), районы импорта → DistrictId фронта, статус места из визитов, фильтр и сортировка списка, CSV.
 * Та же логика у мока фронта — booking-platform src/domain/platform/prospects.ts (держать одинаковыми).
 */

export const PROSPECT_CATEGORIES = ['beauty', 'nails', 'barber', 'hair', 'brows_lashes', 'cosmetology', 'massage_spa', 'clinic', 'dental', 'other'] as const;
export type ProspectCategory = (typeof PROSPECT_CATEGORIES)[number];

export const BOOKING_SYSTEMS = [
  'emly',
  'altegio',
  'fresha',
  'dikidi',
  'booksy',
  'own_site',
  'other_online',
  'medical_platform',
  'phone_whatsapp',
  'instagram',
  'unknown',
] as const;
export type BookingSystem = (typeof BOOKING_SYSTEMS)[number];

/** DistrictId фронта (src/config/districts.ts) + unknown */
export const PROSPECT_DISTRICTS = [
  'kentron',
  'arabkir',
  'davtashen',
  'malatia-sebastia',
  'nor-nork',
  'achapnyak',
  'shengavit',
  'avan',
  'erebuni',
  'kanaker-zeytun',
  'nork-marash',
  'nubarashen',
  'unknown',
] as const;
export type ProspectDistrict = (typeof PROSPECT_DISTRICTS)[number];

/** не были / думает / подключили (визит) / отказ / работает в BookTime (есть бизнес) */
export const PROSPECT_STATUSES = ['new', 'thinking', 'connected', 'refused', 'live'] as const;
export type ProspectStatus = (typeof PROSPECT_STATUSES)[number];

export const PROSPECT_SORTS = ['staff_desc', 'staff_asc', 'name_asc', 'name_desc'] as const;
export type ProspectSort = (typeof PROSPECT_SORTS)[number];

export interface ProspectReviews {
  rating?: number;
  count?: number;
  text?: string;
}

/** Поля места, которые приносит импорт (и правит панель) */
export interface ProspectData {
  name: string;
  category: ProspectCategory;
  district: ProspectDistrict;
  address?: string;
  branches?: number;
  staffEstimate?: number;
  staffSource?: string;
  bookingSystem: BookingSystem;
  bookingUrl?: string;
  website?: string;
  instagram?: string;
  phone?: string;
  reviews?: ProspectReviews;
  sourceUrls: string[];
}

// ─────────────────────────── Ключ дедупликации ───────────────────────────

/** Нижний регистр, ё→е, без кавычек и знаков, пробелы схлопнуты: «Салон "Ева"» и «салон ева» — одно имя */
export function normalizeText(s: string | undefined | null): string {
  return (s ?? '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Ключ «имя|адрес» — по нему импорт обновляет уже известное место, а не заводит второе */
export function dedupKeyOf(name: string, address?: string | null): string {
  return `${normalizeText(name)}|${normalizeText(address)}`.slice(0, 255);
}

// ─────────────────────────── Разбор строки импорта ───────────────────────────

/** Районы импорта (snake_case, «ajapnyak») → DistrictId фронта; неизвестное → unknown */
const DISTRICT_ALIASES: Record<string, ProspectDistrict> = {
  kentron: 'kentron',
  center: 'kentron',
  arabkir: 'arabkir',
  ajapnyak: 'achapnyak',
  achapnyak: 'achapnyak',
  avan: 'avan',
  davtashen: 'davtashen',
  erebuni: 'erebuni',
  kanaker_zeytun: 'kanaker-zeytun',
  malatia_sebastia: 'malatia-sebastia',
  nork_marash: 'nork-marash',
  nor_nork: 'nor-nork',
  nubarashen: 'nubarashen',
  shengavit: 'shengavit',
};

export function mapDistrict(raw: unknown): ProspectDistrict {
  if (typeof raw !== 'string') return 'unknown';
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return DISTRICT_ALIASES[key] ?? 'unknown';
}

function pickEnum<T extends string>(list: readonly T[], raw: unknown, fallback: T): T {
  if (typeof raw !== 'string') return fallback;
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return (list as readonly string[]).includes(key) ? (key as T) : fallback;
}

function str(raw: unknown, max: number): string | undefined {
  if (typeof raw === 'number') raw = String(raw);
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim();
  return v ? v.slice(0, max) : undefined;
}

function int(raw: unknown): number | undefined {
  const n = typeof raw === 'string' ? Number(raw.replace(/[^\d.]/g, '')) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return undefined;
  return Math.min(Math.round(n), 100000);
}

/** reviews в импорте: число (сколько отзывов), строка («4.8 · 120 в Google») или { rating, count, text|source } */
export function parseReviews(raw: unknown): ProspectReviews | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined;
  if (typeof raw === 'number') return Number.isFinite(raw) ? { count: Math.max(0, Math.round(raw)) } : undefined;
  if (typeof raw === 'string') return { text: raw.trim().slice(0, 300) };
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    const rating = typeof o.rating === 'number' && Number.isFinite(o.rating) ? Math.round(o.rating * 10) / 10 : undefined;
    const count = int(o.count ?? o.reviews ?? o.total);
    const text = str(o.text ?? o.source ?? o.summary, 300);
    const out: ProspectReviews = {};
    if (rating !== undefined) out.rating = rating;
    if (count !== undefined) out.count = count;
    if (text !== undefined) out.text = text;
    return Object.keys(out).length ? out : undefined;
  }
  return undefined;
}

function urls(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\s,]+/) : [];
  const out: string[] = [];
  for (const u of list) {
    const v = str(u, 500);
    if (v && !out.includes(v)) out.push(v);
  }
  return out.slice(0, 30);
}

export type ImportParse = { ok: true; data: ProspectData } | { ok: false; reason: 'not_object' | 'name_required' };

/** Одна строка импорта → поля места. Пустое и неизвестное не роняет строку: район → unknown, система → unknown */
export function parseImportRow(raw: unknown): ImportParse {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'not_object' };
  const o = raw as Record<string, unknown>;
  const name = str(o.name, 200);
  if (!name) return { ok: false, reason: 'name_required' };
  const data: ProspectData = {
    name,
    category: pickEnum(PROSPECT_CATEGORIES, o.category, 'other'),
    district: mapDistrict(o.district),
    bookingSystem: pickEnum(BOOKING_SYSTEMS, o.booking_system ?? o.bookingSystem, 'unknown'),
    sourceUrls: urls(o.source_urls ?? o.sourceUrls),
  };
  const opt = {
    address: str(o.address, 300),
    branches: int(o.branches),
    staffEstimate: int(o.staff_estimate ?? o.staffEstimate),
    staffSource: str(o.staff_source ?? o.staffSource, 300),
    bookingUrl: str(o.booking_url ?? o.bookingUrl, 500),
    website: str(o.website, 500),
    instagram: str(o.instagram, 500),
    phone: str(o.phone, 40),
    reviews: parseReviews(o.reviews),
  };
  for (const [k, v] of Object.entries(opt)) if (v !== undefined) (data as unknown as Record<string, unknown>)[k] = v;
  return { ok: true, data };
}

/**
 * Что импорт меняет у уже известного места: непустые значения импорта перекрывают старые, пустые — не стирают
 * (сборщики приносят неполные данные); источники — объединяются; заметку и метки импорт не трогает.
 * Пусто — ничего не поменялось (строка «без изменений»).
 */
export function importPatch(existing: ProspectData, incoming: ProspectData): Partial<ProspectData> {
  const patch: Partial<ProspectData> = {};
  // Имя не трогаем: тот же ключ — то же имя с точностью до регистра и знаков, первое написание остаётся
  const keys: (keyof ProspectData)[] = ['address', 'branches', 'staffEstimate', 'staffSource', 'bookingUrl', 'website', 'instagram', 'phone'];
  for (const k of keys) {
    const v = incoming[k];
    if (v !== undefined && v !== existing[k]) (patch as Record<string, unknown>)[k] = v;
  }
  if (incoming.category !== 'other' && incoming.category !== existing.category) patch.category = incoming.category;
  if (incoming.district !== 'unknown' && incoming.district !== existing.district) patch.district = incoming.district;
  if (incoming.bookingSystem !== 'unknown' && incoming.bookingSystem !== existing.bookingSystem) patch.bookingSystem = incoming.bookingSystem;
  if (incoming.reviews && JSON.stringify(incoming.reviews) !== JSON.stringify(existing.reviews ?? null)) patch.reviews = incoming.reviews;
  const merged = [...existing.sourceUrls];
  for (const u of incoming.sourceUrls) if (!merged.includes(u)) merged.push(u);
  if (merged.length !== existing.sourceUrls.length) patch.sourceUrls = merged.slice(0, 30);
  return patch;
}

// ─────────────────────────── Статус из визитов ───────────────────────────

export interface VisitBrief {
  id: string;
  prospectId: string | null;
  status: string;
  visitedAt: string;
  createdAt: Date | string;
  businessId: string | null;
}

export interface ProspectStatusInfo {
  status: ProspectStatus;
  lastVisit?: { id: string; visitedAt: string; status: string };
  visitCount: number;
}

const ts = (d: Date | string) => (typeof d === 'string' ? d : d.toISOString());

/** Последний визит (по дате визита, потом по времени записи) задаёт статус; подключённый бизнес — «работает в BookTime» */
export function statusFromVisits(visits: readonly VisitBrief[]): ProspectStatusInfo {
  if (!visits.length) return { status: 'new', visitCount: 0 };
  const last = [...visits].sort((a, b) => b.visitedAt.localeCompare(a.visitedAt) || ts(b.createdAt).localeCompare(ts(a.createdAt)))[0]!;
  const live = visits.some((v) => v.businessId);
  const fromVisit: ProspectStatus = last.status === 'connected' || last.status === 'refused' || last.status === 'thinking' ? last.status : 'thinking';
  return { status: live ? 'live' : fromVisit, lastVisit: { id: last.id, visitedAt: last.visitedAt, status: last.status }, visitCount: visits.length };
}

export function groupVisits(visits: readonly VisitBrief[]): Map<string, VisitBrief[]> {
  const map = new Map<string, VisitBrief[]>();
  for (const v of visits) {
    if (!v.prospectId) continue;
    const list = map.get(v.prospectId);
    if (list) list.push(v);
    else map.set(v.prospectId, [v]);
  }
  return map;
}

// ─────────────────────────── Фильтр и сортировка ───────────────────────────

export interface ProspectFilter {
  systems?: BookingSystem[];
  category?: ProspectCategory;
  district?: ProspectDistrict;
  staffMin?: number;
  staffMax?: number;
  status?: ProspectStatus;
  q?: string;
}

interface Filterable {
  name: string;
  category: string;
  district: string;
  staffEstimate?: number | null;
  bookingSystem: string;
  status: ProspectStatus;
}

/** Все условия, кроме системы записи, — по ним считаются счётчики «сколько на Emly / Altegio…» */
export function matchesExceptSystem(p: Filterable, f: ProspectFilter): boolean {
  if (f.category && p.category !== f.category) return false;
  if (f.district && p.district !== f.district) return false;
  if (f.staffMin !== undefined && (p.staffEstimate ?? -1) < f.staffMin) return false;
  if (f.staffMax !== undefined && (p.staffEstimate === null || p.staffEstimate === undefined || p.staffEstimate > f.staffMax)) return false;
  if (f.status && p.status !== f.status) return false;
  const q = normalizeText(f.q);
  if (q && !normalizeText(p.name).includes(q)) return false;
  return true;
}

export function matchesFilter(p: Filterable, f: ProspectFilter): boolean {
  if (f.systems?.length && !f.systems.includes(p.bookingSystem as BookingSystem)) return false;
  return matchesExceptSystem(p, f);
}

/** По мастерам — неизвестное число всегда в конце; при равенстве — по имени */
export function sortProspects<T extends { name: string; staffEstimate?: number | null }>(rows: readonly T[], sort: ProspectSort = 'staff_desc'): T[] {
  const byName = (a: T, b: T) => a.name.localeCompare(b.name, 'ru', { sensitivity: 'base', numeric: true });
  return [...rows].sort((a, b) => {
    if (sort === 'name_asc') return byName(a, b);
    if (sort === 'name_desc') return byName(b, a);
    const sa = a.staffEstimate ?? null;
    const sb = b.staffEstimate ?? null;
    if (sa === null && sb === null) return byName(a, b);
    if (sa === null) return 1;
    if (sb === null) return -1;
    return (sort === 'staff_asc' ? sa - sb : sb - sa) || byName(a, b);
  });
}

export function countBySystem(rows: readonly { bookingSystem: string }[]): Record<BookingSystem, number> {
  const out = Object.fromEntries(BOOKING_SYSTEMS.map((s) => [s, 0])) as Record<BookingSystem, number>;
  for (const r of rows) if (r.bookingSystem in out) out[r.bookingSystem as BookingSystem] += 1;
  return out;
}

// ─────────────────────────── CSV ───────────────────────────

function cell(v: unknown): string {
  const s = v === undefined || v === null ? '' : String(v);
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const CSV_HEADERS = [
  'name',
  'category',
  'district',
  'address',
  'branches',
  'staff_estimate',
  'staff_source',
  'booking_system',
  'booking_url',
  'website',
  'instagram',
  'phone',
  'reviews',
  'status',
  'last_visit',
  'note',
  'source_urls',
] as const;

/** CSV для Excel: «;», BOM, поля как в импорте (snake_case) + статус и последний визит */
export function toProspectsCsv(
  rows: readonly (ProspectData & { note?: string | null; status: ProspectStatus; lastVisit?: { visitedAt: string } })[],
): string {
  const lines = [CSV_HEADERS.join(';')];
  for (const r of rows) {
    const reviews = r.reviews ? [r.reviews.rating, r.reviews.count, r.reviews.text].filter((x) => x !== undefined).join(' · ') : '';
    lines.push(
      [
        r.name,
        r.category,
        r.district,
        r.address,
        r.branches,
        r.staffEstimate,
        r.staffSource,
        r.bookingSystem,
        r.bookingUrl,
        r.website,
        r.instagram,
        r.phone,
        reviews,
        r.status,
        r.lastVisit?.visitedAt,
        r.note,
        r.sourceUrls.join(' '),
      ]
        .map(cell)
        .join(';'),
    );
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}
