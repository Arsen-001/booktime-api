import { Injectable } from '@nestjs/common';
import { ApiError } from '../../common/errors/api-error.js';
import { newId } from '../../common/ids/ids.js';
import { PrismaService } from '../../common/prisma.service.js';
import { utcToLocal, utcToLocalDate } from '../../common/time/time.js';

const CSV_SEPARATOR = ';';

/** CSV для Excel — тот же приём, что src/lib/csv.ts фронта (';' + BOM, кавычки при спецсимволах) */
function csvCell(value: string | number | boolean | null | undefined): string {
  const text = value === null || value === undefined ? '' : String(value);
  return text.includes(CSV_SEPARATOR) || /["\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows: readonly (readonly (string | number | boolean | null | undefined)[])[], headers: readonly string[]): string {
  const lines = rows.map((row) => row.map((v) => csvCell(v)).join(CSV_SEPARATOR));
  return [headers.map((h) => csvCell(h)).join(CSV_SEPARATOR), ...lines].join('\r\n');
}

/** Бизнесы на платформе (docs/backend/06 §6, 02 §19): обзор, копии, выгрузка при уходе, согласие на рекламу. */
@Injectable()
export class PlatformBusinessesService {
  constructor(private readonly prisma: PrismaService) {}

  async overview() {
    const businesses = await this.prisma.business.findMany({ select: { id: true, name: true, kind: true, sphereIds: true, status: true, leftAt: true } });
    const bizIds = businesses.map((b) => b.id);
    const [locations, staffCounts, metas] = await Promise.all([
      this.prisma.location.findMany({ where: { businessId: { in: bizIds }, deletedAt: null }, select: { businessId: true, district: true }, orderBy: { sortOrder: 'asc' } }),
      this.prisma.staff.groupBy({ by: ['businessId'], where: { businessId: { in: bizIds }, deletedAt: null, status: { not: 'fired' } }, _count: { _all: true } }),
      this.prisma.bizMeta.findMany({ where: { businessId: { in: bizIds } } }),
    ]);
    const districtOf = new Map(locations.map((l) => [l.businessId, l.district]));
    const staffCountOf = new Map(staffCounts.map((s) => [s.businessId, s._count._all]));
    const metaOf = new Map(metas.map((m) => [m.businessId, m]));
    return businesses
      .map((b) => {
        const meta = metaOf.get(b.id);
        return {
          id: b.id,
          name: b.name,
          kind: b.kind as 'individual' | 'salon',
          sphereIds: Array.isArray(b.sphereIds) ? (b.sphereIds as string[]) : [],
          district: districtOf.get(b.id),
          status: (b.leftAt ? 'left' : b.status === 'frozen' ? 'frozen' : 'active') as 'active' | 'frozen' | 'left',
          staffCount: staffCountOf.get(b.id) ?? 0,
          meta: meta
            ? {
                businessId: meta.businessId,
                source: meta.source as 'visit' | 'self',
                responsibleId: meta.responsibleId ?? undefined,
                promoCodeId: meta.promoCodeId ?? undefined,
                leftAt: b.leftAt ? utcToLocalDate(b.leftAt) : undefined,
                dataHandedAt: meta.dataHandedAt ? utcToLocal(meta.dataHandedAt) : undefined,
                note: meta.note ?? undefined,
              }
            : b.leftAt
              ? { businessId: b.id, source: 'self' as const, leftAt: utcToLocalDate(b.leftAt) }
              : undefined,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async setAdsOptIn(businessId: string, optIn: boolean) {
    const n = await this.prisma.business.updateMany({ where: { id: businessId }, data: { adsOptIn: optIn } });
    if (!n.count) throw new ApiError('not_found', 'Business not found');
  }

  async listBackupCopies(businessId: string) {
    const rows = await this.prisma.backupCopy.findMany({ where: { businessId }, orderBy: { at: 'desc' }, take: 100 });
    return rows.map((r) => ({ id: r.id, businessId: r.businessId, at: utcToLocal(r.at), kind: r.kind as 'auto' | 'manual', counts: r.counts as { clients: number; bookings: number; services: number; staff: number }, sizeKb: r.sizeKb }));
  }

  async makeBackupCopy(businessId: string) {
    const biz = await this.prisma.business.findUnique({ where: { id: businessId }, select: { id: true } });
    if (!biz) throw new ApiError('not_found', 'Business not found');
    const [clients, bookings, services, staff] = await Promise.all([
      this.prisma.client.count({ where: { businessId, deletedAt: null } }),
      this.prisma.booking.count({ where: { businessId, deletedAt: null } }),
      this.prisma.service.count({ where: { businessId } }),
      this.prisma.staff.count({ where: { businessId, deletedAt: null } }),
    ]);
    const counts = { clients, bookings, services, staff };
    const row = await this.prisma.backupCopy.create({
      data: { id: newId('backupCopy'), businessId, kind: 'manual', counts, sizeKb: 40 + Math.ceil((clients + bookings) / 5) },
    });
    return { id: row.id, businessId: row.businessId, at: utcToLocal(row.at), kind: 'manual' as const, counts, sizeKb: row.sizeKb };
  }

  async exportBusinessData(businessId: string, what: 'clients' | 'bookings', headers: string[], authorId: string, authorName: string) {
    const biz = await this.prisma.business.findUnique({ where: { id: businessId }, select: { id: true } });
    if (!biz) throw new ApiError('not_found', 'Business not found');
    const rows: (string | number)[][] =
      what === 'clients'
        ? (await this.prisma.client.findMany({ where: { businessId, deletedAt: null } })).map((c) => [c.name, c.phone, c.gender, (Array.isArray(c.tags) ? (c.tags as string[]) : []).join(', '), c.noShowCount])
        : (await this.prisma.booking.findMany({ where: { businessId, deletedAt: null } })).map((b) => [utcToLocal(b.startAt).replace('T', ' '), b.status, Number(b.total), b.source]);
    await this.prisma.dataExport.create({ data: { id: newId('dataExport'), businessId, area: what, authorId, authorName, count: rows.length, fileName: `${what}-${businessId}-${utcToLocalDate(new Date())}.csv` } });
    return { fileName: `${what}-${businessId}-${utcToLocalDate(new Date())}.csv`, csv: toCsv(rows, headers), rows: rows.length };
  }

  /** «Бизнес ушёл, данные выданы» — пропадает из каталога (business.leftAt), не отменяется (F-00-183) */
  async markLeft(businessId: string, dataHanded: boolean) {
    const biz = await this.prisma.business.findUnique({ where: { id: businessId }, select: { id: true } });
    if (!biz) throw new ApiError('not_found', 'Business not found');
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.business.update({ where: { id: businessId }, data: { leftAt: now } }),
      this.prisma.bizMeta.upsert({
        where: { businessId },
        create: { businessId, source: 'self', dataHandedAt: dataHanded ? now : null },
        update: { dataHandedAt: dataHanded ? now : undefined },
      }),
    ]);
  }
}
