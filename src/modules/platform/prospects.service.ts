import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { ApiError } from '../../common/errors/api-error.js';
import { newId } from '../../common/ids/ids.js';
import { PrismaService } from '../../common/prisma.service.js';
import { utcToLocal } from '../../common/time/time.js';
import { updateVersioned } from '../../common/http/version.js';
import {
  countBySystem,
  dedupKeyOf,
  groupVisits,
  importPatch,
  matchesExceptSystem,
  matchesFilter,
  parseImportRow,
  sortProspects,
  statusFromVisits,
  toProspectsCsv,
  type BookingSystem,
  type ProspectCategory,
  type ProspectData,
  type ProspectDistrict,
  type ProspectFilter,
  type ProspectReviews,
  type ProspectSort,
  type ProspectStatusInfo,
  type VisitBrief,
} from './prospects.logic.js';

type ProspectRow = Prisma.ProspectGetPayload<object>;

export interface ProspectPatch {
  name?: string;
  category?: ProspectCategory;
  district?: ProspectDistrict;
  address?: string;
  branches?: number | null;
  staffEstimate?: number | null;
  staffSource?: string;
  bookingSystem?: BookingSystem;
  bookingUrl?: string;
  website?: string;
  instagram?: string;
  phone?: string;
  reviews?: ProspectReviews | null;
  sourceUrls?: string[];
  note?: string;
  tags?: string[];
}

export interface ImportReport {
  added: number;
  updated: number;
  unchanged: number;
  skipped: number;
  errors: { index: number; reason: string }[];
}

function dataOf(row: ProspectRow): ProspectData {
  return {
    name: row.name,
    category: row.category as ProspectCategory,
    district: row.district as ProspectDistrict,
    address: row.address ?? undefined,
    branches: row.branches ?? undefined,
    staffEstimate: row.staffEstimate ?? undefined,
    staffSource: row.staffSource ?? undefined,
    bookingSystem: row.bookingSystem as BookingSystem,
    bookingUrl: row.bookingUrl ?? undefined,
    website: row.website ?? undefined,
    instagram: row.instagram ?? undefined,
    phone: row.phone ?? undefined,
    reviews: (row.reviews ?? undefined) as ProspectReviews | undefined,
    sourceUrls: (Array.isArray(row.sourceUrls) ? row.sourceUrls : []) as string[],
  };
}

function view(row: ProspectRow, info: ProspectStatusInfo) {
  return {
    id: row.id,
    ...dataOf(row),
    note: row.note ?? undefined,
    tags: (Array.isArray(row.tags) ? row.tags : undefined) as string[] | undefined,
    status: info.status,
    lastVisit: info.lastVisit,
    visitCount: info.visitCount,
    version: row.version,
    createdAt: utcToLocal(row.createdAt),
    updatedAt: utcToLocal(row.updatedAt),
  };
}

/** Поля для записи в базу; undefined — не трогать, null — очистить */
type Writable = Partial<Omit<ProspectData, 'branches' | 'staffEstimate' | 'reviews'>> & { branches?: number | null; staffEstimate?: number | null; reviews?: ProspectReviews | null };

function columns(d: Writable): Prisma.ProspectUncheckedUpdateInput {
  const out: Prisma.ProspectUncheckedUpdateInput = {};
  const nul = (v: string | undefined) => (v === undefined ? undefined : v.trim() || null);
  if (d.name !== undefined) out.name = d.name.trim();
  if (d.category !== undefined) out.category = d.category;
  if (d.district !== undefined) out.district = d.district;
  if (d.bookingSystem !== undefined) out.bookingSystem = d.bookingSystem;
  if (d.address !== undefined) out.address = nul(d.address);
  if (d.staffSource !== undefined) out.staffSource = nul(d.staffSource);
  if (d.bookingUrl !== undefined) out.bookingUrl = nul(d.bookingUrl);
  if (d.website !== undefined) out.website = nul(d.website);
  if (d.instagram !== undefined) out.instagram = nul(d.instagram);
  if (d.phone !== undefined) out.phone = nul(d.phone);
  if ('branches' in d) out.branches = d.branches ?? null;
  if ('staffEstimate' in d) out.staffEstimate = d.staffEstimate ?? null;
  if ('reviews' in d) out.reviews = d.reviews ? (d.reviews as Prisma.InputJsonValue) : Prisma.DbNull;
  if (d.sourceUrls !== undefined) out.sourceUrls = d.sourceUrls as Prisma.InputJsonValue;
  return out;
}

const VISIT_BRIEF = { id: true, prospectId: true, status: true, visitedAt: true, createdAt: true, businessId: true } as const;

/**
 * «Места» (03.10.2026): база заведений Еревана для отдела продаж. Статус места не хранится — выводится из визитов
 * (SalesVisit.prospectId). Список фильтруется и сортируется в памяти: мест в городе — тысячи, а статус зависит от
 * визитов; так фильтр «статус» и счётчики по системам записи считаются одним правилом с моком фронта.
 */
@Injectable()
export class ProspectsService {
  constructor(private readonly prisma: PrismaService) {}

  private async statusMap(ids?: string[]): Promise<Map<string, VisitBrief[]>> {
    const visits = await this.prisma.salesVisit.findMany({
      where: ids ? { prospectId: { in: ids } } : { prospectId: { not: null } },
      select: VISIT_BRIEF,
    });
    return groupVisits(visits);
  }

  private async allWithStatus(f: ProspectFilter) {
    // Простые условия — в базе (сужают выборку), статус и поиск без учёта регистра/знаков — в памяти
    const where: Prisma.ProspectWhereInput = {
      category: f.category,
      district: f.district,
      ...(f.staffMin !== undefined || f.staffMax !== undefined ? { staffEstimate: { gte: f.staffMin, lte: f.staffMax } } : {}),
    };
    const rows = await this.prisma.prospect.findMany({ where, take: 20000 });
    const visits = await this.statusMap();
    return rows.map((row) => {
      const info = statusFromVisits(visits.get(row.id) ?? []);
      return {
        row,
        info,
        status: info.status,
        name: row.name,
        address: row.address,
        category: row.category,
        district: row.district,
        staffEstimate: row.staffEstimate,
        bookingSystem: row.bookingSystem,
        reviews: (row.reviews ?? null) as ProspectReviews | null,
      };
    });
  }

  async list(f: ProspectFilter & { sort?: ProspectSort; page?: number; pageSize?: number }) {
    const all = await this.allWithStatus(f);
    const base = all.filter((p) => matchesExceptSystem(p, f));
    const filtered = base.filter((p) => matchesFilter(p, f));
    const sorted = sortProspects(filtered, f.sort);
    const pageSize = f.pageSize ?? 20;
    const page = f.page ?? 1;
    return {
      items: sorted.slice((page - 1) * pageSize, page * pageSize).map((p) => view(p.row, p.info)),
      total: filtered.length,
      /** Сколько мест на каждой системе записи — при всех фильтрах, кроме самой системы */
      systemCounts: countBySystem(base),
      /** Всего мест в базе — для «из N» и пустого состояния */
      totalAll: (await this.prisma.prospect.count()) as number,
    };
  }

  async get(id: string) {
    const row = await this.prisma.prospect.findUnique({ where: { id } });
    if (!row) throw new ApiError('not_found', 'Prospect not found');
    const visits = await this.prisma.salesVisit.findMany({ where: { prospectId: id }, orderBy: [{ visitedAt: 'desc' }, { createdAt: 'desc' }], take: 50 });
    const info = statusFromVisits(visits);
    return {
      ...view(row, info),
      visits: visits.map((v) => ({ id: v.id, visitedAt: v.visitedAt, status: v.status, responsibleId: v.responsibleId, note: v.note ?? undefined, businessId: v.businessId ?? undefined })),
    };
  }

  async update(id: string, patch: ProspectPatch, version?: number) {
    const row = await this.prisma.prospect.findUnique({ where: { id } });
    if (!row) throw new ApiError('not_found', 'Prospect not found');
    const data: Record<string, unknown> = { ...columns(patch) };
    if (patch.note !== undefined) data.note = patch.note.trim() || null;
    if (patch.tags !== undefined) data.tags = patch.tags.length ? (patch.tags as Prisma.InputJsonValue) : Prisma.DbNull;
    if (patch.name !== undefined || patch.address !== undefined) {
      const key = dedupKeyOf(patch.name ?? row.name, patch.address !== undefined ? patch.address : row.address);
      if (key !== row.dedupKey) {
        const clash = await this.prisma.prospect.findUnique({ where: { dedupKey: key }, select: { id: true } });
        if (clash && clash.id !== id) throw new ApiError('conflict', 'Same name and address already exist', { name: 'duplicate' });
        data.dedupKey = key;
      }
    }
    await updateVersioned(this.prisma.prospect as never, { id }, version, data);
    return this.get(id);
  }

  /** Удалить место; визиты остаются, связь с местом снимается */
  async remove(id: string) {
    const row = await this.prisma.prospect.findUnique({ where: { id }, select: { id: true } });
    if (!row) throw new ApiError('not_found', 'Prospect not found');
    await this.prisma.$transaction([
      this.prisma.salesVisit.updateMany({ where: { prospectId: id }, data: { prospectId: null } }),
      this.prisma.prospect.delete({ where: { id } }),
    ]);
    return { ok: true };
  }

  /**
   * Импорт JSON-массива от сборщиков (upsert по ключу «имя|адрес»). Повтор в том же файле — сливается с первым.
   * Отчёт: добавлено / обновлено / без изменений / пропущено (+ номера и причины пропущенных строк).
   */
  async import(rows: unknown[]): Promise<ImportReport> {
    const report: ImportReport = { added: 0, updated: 0, unchanged: 0, skipped: 0, errors: [] };
    const parsed: { key: string; data: ProspectData }[] = [];
    const byKey = new Map<string, number>();
    rows.forEach((raw, index) => {
      const r = parseImportRow(raw);
      if (!r.ok) {
        report.skipped += 1;
        if (report.errors.length < 100) report.errors.push({ index, reason: r.reason });
        return;
      }
      const key = dedupKeyOf(r.data.name, r.data.address);
      const seen = byKey.get(key);
      if (seen !== undefined) {
        const prev = parsed[seen]!;
        prev.data = { ...prev.data, ...importPatch(prev.data, r.data) };
        return;
      }
      byKey.set(key, parsed.length);
      parsed.push({ key, data: r.data });
    });

    const CHUNK = 500;
    for (let i = 0; i < parsed.length; i += CHUNK) {
      const chunk = parsed.slice(i, i + CHUNK);
      const existing = await this.prisma.prospect.findMany({ where: { dedupKey: { in: chunk.map((c) => c.key) } } });
      const known = new Map(existing.map((e) => [e.dedupKey, e]));
      const creates: Prisma.ProspectCreateManyInput[] = [];
      const updates: Prisma.PrismaPromise<unknown>[] = [];
      for (const { key, data } of chunk) {
        const row = known.get(key);
        if (!row) {
          creates.push({ id: newId('prospect'), dedupKey: key, ...(columns(data) as object), name: data.name, sourceUrls: data.sourceUrls as Prisma.InputJsonValue });
          continue;
        }
        const patch = importPatch(dataOf(row), data);
        if (!Object.keys(patch).length) {
          report.unchanged += 1;
          continue;
        }
        const upd: Record<string, unknown> = { ...columns(patch), version: { increment: 1 } };
        // Имя могло прийти в другом написании с тем же ключом — ключ не меняется
        updates.push(this.prisma.prospect.update({ where: { id: row.id }, data: upd }));
        report.updated += 1;
      }
      if (creates.length) {
        await this.prisma.prospect.createMany({ data: creates, skipDuplicates: true });
        report.added += creates.length;
      }
      if (updates.length) await this.prisma.$transaction(updates);
    }
    return report;
  }

  /** CSV тех же мест, что в списке с этими фильтрами (без страниц) */
  async exportCsv(f: ProspectFilter & { sort?: ProspectSort }) {
    const all = await this.allWithStatus(f);
    const rows = sortProspects(all.filter((p) => matchesFilter(p, f)), f.sort).map((p) => ({ ...dataOf(p.row), note: p.row.note, status: p.info.status, lastVisit: p.info.lastVisit }));
    return { fileName: `prospects-${utcToLocal(new Date()).slice(0, 10)}.csv`, csv: toProspectsCsv(rows), rows: rows.length };
  }
}
