import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { ApiError } from '../../common/errors/api-error.js';
import { newId } from '../../common/ids/ids.js';
import { PrismaService } from '../../common/prisma.service.js';
import { utcToLocal } from '../../common/time/time.js';

type SphereKind = 'noSphere' | 'newSphere';
type SphereStatus = 'open' | 'agreed' | 'inProgress' | 'done';

const STATUS_RANK: Record<SphereStatus, number> = { open: 0, agreed: 1, inProgress: 2, done: 3 };

/** Старые строки (до этапа 19: только open|answered|closed, см. settings.sphereRequests) → словарь панели */
const LEGACY_STATUS: Record<string, SphereStatus> = { open: 'open', answered: 'agreed', closed: 'done' };

function view(row: Prisma.SphereRequestGetPayload<object>, businessName?: string) {
  return {
    id: row.id,
    kind: row.kind as SphereKind,
    businessId: row.businessId ?? undefined,
    businessName,
    masterName: row.name,
    phone: row.phone ?? '',
    sphereName: row.sphereName ?? row.name,
    needs: (row.needs ?? []) as string[],
    status: (['open', 'agreed', 'inProgress', 'done'].includes(row.status) ? row.status : (LEGACY_STATUS[row.status] ?? 'open')) as SphereStatus,
    createdAt: utcToLocal(row.createdAt),
    readyAt: row.readyAt ?? undefined,
    note: row.note ?? undefined,
    decidedAt: row.decidedAt ? utcToLocal(row.decidedAt) : undefined,
  };
}

/**
 * Заявки на сферы, наша сторона (F-00-151/152). Делит таблицу sphere_requests с settings (кабинет заводит
 * kind=noSphere без телефона/needs — эта сторона читает их тоже, sphereName подставляется из name).
 */
@Injectable()
export class SphereRequestsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(kind?: SphereKind) {
    const rows = await this.prisma.sphereRequest.findMany({ where: kind ? { kind } : undefined, take: 500 });
    const bizIds = [...new Set(rows.map((r) => r.businessId).filter((x): x is string => Boolean(x)))];
    const names = new Map((await this.prisma.business.findMany({ where: { id: { in: bizIds } }, select: { id: true, name: true } })).map((b) => [b.id, b.name]));
    return rows
      .map((r) => view(r, r.businessId ? names.get(r.businessId) : undefined))
      .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.createdAt.localeCompare(a.createdAt));
  }

  /** Заводит наша панель — кандидат без бизнеса ещё (визит, звонок); из кабинета идёт settings.createSphereRequest */
  async create(input: { kind: SphereKind; businessId?: string; masterName: string; phone: string; sphereName: string; needs?: string[]; note?: string }) {
    const masterName = input.masterName.trim();
    const sphereName = input.sphereName.trim();
    if (!masterName || !sphereName || !input.phone.trim()) throw new ApiError('validation', 'Master name, sphere and phone required');
    const row = await this.prisma.sphereRequest.create({
      data: {
        id: newId('sphereRequest'),
        kind: input.kind,
        businessId: input.businessId ?? null,
        name: masterName,
        phone: input.phone.trim(),
        sphereName,
        needs: (input.needs ?? []) as unknown as Prisma.InputJsonValue,
        note: input.note ?? null,
        status: 'open',
      },
    });
    return view(row);
  }

  async save(id: string, patch: { status?: SphereStatus; needs?: string[]; readyAt?: string; note?: string }) {
    const row = await this.prisma.sphereRequest.findUnique({ where: { id } });
    if (!row) throw new ApiError('not_found', 'Sphere request not found');
    const updated = await this.prisma.sphereRequest.update({
      where: { id },
      data: {
        ...(patch.status !== undefined ? { status: patch.status, decidedAt: new Date() } : {}),
        ...(patch.needs !== undefined ? { needs: patch.needs as unknown as Prisma.InputJsonValue } : {}),
        ...(patch.readyAt !== undefined ? { readyAt: patch.readyAt } : {}),
        ...(patch.note !== undefined ? { note: patch.note } : {}),
      },
    });
    const biz = updated.businessId ? await this.prisma.business.findUnique({ where: { id: updated.businessId }, select: { name: true } }) : null;
    return view(updated, biz?.name);
  }
}
