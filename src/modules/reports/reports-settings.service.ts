import { Injectable } from '@nestjs/common';
import type { RequestContext } from '../../common/http/context.js';
import { PrismaService } from '../../common/prisma.service.js';

/**
 * Настройки раздела «Отчёты» (docs/backend/02 §16), per-СОТРУДНИК, не per-бизнес — избранные отчёты (F-12-003)
 * и мелкие права (F-12-084…089, F-12-008) видны сотруднику на любом месте, отдельно от 39 прав бизнеса
 * (тот же приём, что у прав сети — этап 15 `NetworkPermissionKey`).
 */
export interface ReportsStaffPermissions {
  dashboard: boolean;
  recordsView: boolean;
  recordsDepth: 30 | 'all';
  recordsExport: boolean;
  recordsPhones: boolean;
  financePeriod: boolean;
  financeYear: boolean;
  cashDayTodayOnly: boolean;
  events: boolean;
  visits: boolean;
  visitsPhones: boolean;
  retention: boolean;
  workload: boolean;
  /** F-12-008: «Учитывать сотрудника в заполненности» — своя строка в этой же таблице, а не в Staff */
  workloadIncluded: boolean;
}

function defaultPermissions(base: { edit: boolean; view: boolean }): ReportsStaffPermissions {
  const full = base.edit || base.view;
  return {
    dashboard: full,
    recordsView: full,
    recordsDepth: full ? 'all' : 30,
    recordsExport: base.edit,
    recordsPhones: base.edit,
    financePeriod: full,
    financeYear: full,
    cashDayTodayOnly: !base.edit,
    events: full,
    visits: full,
    visitsPhones: base.edit,
    retention: full,
    workload: full,
    workloadIncluded: true,
  };
}

@Injectable()
export class ReportsSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  private async staffOf(businessId: string, staffId: string) {
    const s = await this.prisma.staff.findFirst({ where: { id: staffId, businessId, deletedAt: null }, select: { role: true } });
    return s;
  }

  /** Дефолт до первой правки владельца: edit ~ владелец/администратор, view ~ есть право reports.view (03 §2 не заводит reports.edit) */
  async getPermissions(businessId: string, staffId: string): Promise<ReportsStaffPermissions> {
    const row = await this.prisma.staffReportsPermission.findUnique({ where: { staffId } });
    if (row) return row.data as unknown as ReportsStaffPermissions;
    const staff = await this.staffOf(businessId, staffId);
    const edit = staff?.role === 'owner' || staff?.role === 'individual' || staff?.role === 'admin';
    return defaultPermissions({ edit, view: Boolean(edit) });
  }

  async setPermissions(ctx: RequestContext, businessId: string, staffId: string, patch: Partial<ReportsStaffPermissions>): Promise<ReportsStaffPermissions> {
    const current = await this.getPermissions(businessId, staffId);
    const next = { ...current, ...patch };
    await this.prisma.staffReportsPermission.upsert({
      where: { staffId },
      create: { staffId, data: next, updatedBy: ctx.member?.staffId },
      update: { data: next, updatedBy: ctx.member?.staffId },
    });
    return next;
  }

  async setWorkloadIncluded(businessId: string, staffId: string, included: boolean): Promise<void> {
    const current = await this.getPermissions(businessId, staffId);
    await this.prisma.staffReportsPermission.upsert({
      where: { staffId },
      create: { staffId, data: { ...current, workloadIncluded: included } },
      update: { data: { ...current, workloadIncluded: included } },
    });
  }

  async listFavorites(staffId: string): Promise<{ slug: string; addedAt: string }[]> {
    const rows = await this.prisma.reportFavorite.findMany({ where: { staffId }, orderBy: { createdAt: 'asc' } });
    return rows.map((r) => ({ slug: r.slug, addedAt: r.createdAt.toISOString() }));
  }

  async toggleFavorite(staffId: string, slug: string): Promise<{ slug: string; addedAt: string }[]> {
    const existing = await this.prisma.reportFavorite.findUnique({ where: { staffId_slug: { staffId, slug } } });
    if (existing) await this.prisma.reportFavorite.delete({ where: { staffId_slug: { staffId, slug } } });
    else await this.prisma.reportFavorite.create({ data: { staffId, slug } });
    return this.listFavorites(staffId);
  }
}
