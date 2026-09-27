import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { updateVersioned } from '../../common/http/version.js';
import { newId } from '../../common/ids/ids.js';
import { money, moneyToJson } from '../../common/money/money.js';
import { PrismaService } from '../../common/prisma.service.js';
import { staffView } from '../businesses/views.js';
import type {
  CategoryBody,
  CreateServiceBody,
  PackageCreateBody,
  PackageSaveBody,
  RestoreServiceBody,
  ServiceBody,
  ServiceExtraBody,
  TechBreakMode,
} from './services.schemas.js';
import { categoryOnlineNameView, categoryView, defaultPackageExtra, packageWithExtraView, serviceExtraView, serviceView } from './services.views.js';

const J = (v: unknown) => (v === undefined || v === null ? Prisma.DbNull : (v as Prisma.InputJsonValue));

/** null — «общая настройка» (shared), 0 — без перерыва (F-02-060), N — своя длительность */
function techBreakToBuffer(mode: TechBreakMode, min?: number): number | null {
  if (mode === 'shared') return null;
  if (mode === 'none') return 0;
  return min ?? 15;
}


@Injectable()
export class ServicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ─────────── категории ───────────

  async listCategories(businessId: string) {
    const rows = await this.prisma.serviceCategory.findMany({ where: { businessId }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
    return rows.map(categoryView);
  }

  async getCategory(businessId: string, id: string) {
    const row = await this.prisma.serviceCategory.findFirst({ where: { id, businessId } });
    if (!row) throw new ApiError('not_found', 'Category not found');
    return categoryView(row);
  }

  async createCategory(ctx: RequestContext, businessId: string, input: CategoryBody) {
    if (!input.name.ru?.trim()) throw new ApiError('bad_name', 'Name required');
    const id = newId('serviceCategory');
    await this.prisma.$transaction(async (tx) => {
      const count = await tx.serviceCategory.count({ where: { businessId } });
      await tx.serviceCategory.create({
        data: {
          id,
          businessId,
          name: input.name as Prisma.InputJsonValue,
          onlineNameEnabled: input.onlineNameEnabled,
          onlineName: J(input.onlineName),
          sortOrder: count,
          createdBy: ctx.member!.staffId,
          updatedBy: ctx.member!.staffId,
        },
      });
      await this.audit.record(tx, ctx, { action: 'create', entityType: 'serviceCategory', entityId: id, businessId, after: { name: input.name } });
    });
    return this.getCategory(businessId, id);
  }

  async updateCategory(ctx: RequestContext, businessId: string, id: string, input: CategoryBody) {
    const before = await this.prisma.serviceCategory.findFirst({ where: { id, businessId } });
    if (!before) throw new ApiError('not_found', 'Category not found');
    if (!input.name.ru?.trim()) throw new ApiError('bad_name', 'Name required');
    await this.prisma.$transaction(async (tx) => {
      await tx.serviceCategory.update({
        where: { id },
        data: {
          name: input.name as Prisma.InputJsonValue,
          onlineNameEnabled: input.onlineNameEnabled,
          onlineName: J(input.onlineName),
          updatedBy: ctx.member!.staffId,
          version: { increment: 1 },
        },
      });
      await this.audit.record(tx, ctx, {
        action: 'update',
        entityType: 'serviceCategory',
        entityId: id,
        businessId,
        before: { name: before.name },
        after: { name: input.name },
      });
    });
    return this.getCategory(businessId, id);
  }

  async categoryOnlineName(businessId: string, id: string) {
    const row = await this.prisma.serviceCategory.findFirst({ where: { id, businessId } });
    if (!row) throw new ApiError('not_found', 'Category not found');
    return categoryOnlineNameView(row);
  }

  async categoryDeleteImpact(businessId: string, id: string) {
    const serviceCount = await this.prisma.service.count({ where: { businessId, categoryId: id } });
    return { serviceCount };
  }

  /** Как в моке: удаляет сразу, без проверки — услуги категории остаются с «висячим» categoryId (F-16-171) */
  async deleteCategory(ctx: RequestContext, businessId: string, id: string): Promise<void> {
    const row = await this.prisma.serviceCategory.findFirst({ where: { id, businessId } });
    if (!row) throw new ApiError('not_found', 'Category not found');
    await this.prisma.$transaction(async (tx) => {
      await tx.serviceCategory.delete({ where: { id } });
      await this.audit.record(tx, ctx, { action: 'delete', entityType: 'serviceCategory', entityId: id, businessId, before: { name: row.name } });
    });
  }

  // ─────────── услуги ───────────

  async listServices(businessId: string, kind?: 'individual' | 'group') {
    const rows = await this.prisma.service.findMany({
      where: { businessId, kind: kind ?? undefined, servicePackage: { equals: Prisma.DbNull } },
      orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map(serviceView);
  }

  async listServiceRows(businessId: string) {
    const rows = await this.prisma.service.findMany({ where: { businessId, servicePackage: { equals: Prisma.DbNull } }, orderBy: [{ order: 'asc' }, { createdAt: 'asc' }] });
    const terms = await this.prisma.staffServiceTerm.findMany({ where: { serviceId: { in: rows.map((r) => r.id) } } });
    return rows.map((s) => ({
      service: serviceView(s),
      extra: serviceExtraView(s),
      staffTerms: terms.filter((t) => t.serviceId === s.id).map((t) => ({ serviceId: t.serviceId, staffId: t.staffId, price: opt(t.price), durationMin: opt(t.durationMin) })),
    }));
  }

  async getService(businessId: string, id: string) {
    const row = await this.prisma.service.findFirst({ where: { id, businessId } });
    if (!row) throw new ApiError('not_found', 'Service not found');
    return serviceView(row);
  }

  private async nextOrder(businessId: string): Promise<number> {
    return this.prisma.service.count({ where: { businessId, servicePackage: { equals: Prisma.DbNull } } });
  }

  async createService(ctx: RequestContext, businessId: string, input: CreateServiceBody) {
    if (!input.name.ru?.trim()) throw new ApiError('bad_name', 'Name required');
    const category = await this.prisma.serviceCategory.findFirst({ where: { id: input.categoryId, businessId } });
    if (!category) throw new ApiError('not_found', 'Category not found');
    const id = newId('service');
    await this.prisma.$transaction(async (tx) => {
      const order = await this.nextOrder(businessId);
      await tx.service.create({
        data: {
          id,
          businessId,
          categoryId: input.categoryId,
          sphereId: input.sphereId,
          name: input.name as Prisma.InputJsonValue,
          description: J(input.description),
          kind: input.kind,
          capacity: input.kind === 'group' ? (input.capacity ?? null) : null,
          durationMin: input.durationMin,
          durationMax: input.durationMax ?? null,
          priceMin: money(input.priceMin),
          priceMax: input.priceMax !== undefined ? money(input.priceMax) : null,
          bufferAfterMin: techBreakToBuffer(input.techBreak, input.techBreakMin),
          repeatIntervalDays: input.repeatIntervalDays ?? null,
          photos: input.photos,
          materials: [],
          staffIds: [],
          workplaces: [],
          onlineBookable: input.onlineBookable,
          active: true,
          order,
          shadeChoice: input.shadeChoice ?? null,
          createdBy: ctx.member!.staffId,
          updatedBy: ctx.member!.staffId,
        },
      });
      await this.audit.record(tx, ctx, { action: 'create', entityType: 'service', entityId: id, businessId, after: { name: input.name, priceMin: input.priceMin } });
    });
    return this.getService(businessId, id);
  }

  async updateService(ctx: RequestContext, businessId: string, id: string, input: ServiceBody, version: number | undefined) {
    const before = await this.prisma.service.findFirst({ where: { id, businessId } });
    if (!before) throw new ApiError('not_found', 'Service not found');
    if (!input.name.ru?.trim()) throw new ApiError('bad_name', 'Name required');
    if (input.categoryId !== before.categoryId && !(await this.prisma.serviceCategory.findFirst({ where: { id: input.categoryId, businessId } }))) {
      throw new ApiError('not_found', 'Category not found');
    }
    const data: Record<string, unknown> = {
      categoryId: input.categoryId,
      name: input.name,
      description: J(input.description),
      kind: input.kind,
      capacity: input.kind === 'group' ? (input.capacity ?? null) : null,
      durationMin: input.durationMin,
      durationMax: input.durationMax ?? null,
      priceMin: money(input.priceMin),
      priceMax: input.priceMax !== undefined ? money(input.priceMax) : null,
      bufferAfterMin: techBreakToBuffer(input.techBreak, input.techBreakMin),
      repeatIntervalDays: input.repeatIntervalDays ?? null,
      photos: input.photos,
      onlineBookable: input.onlineBookable,
      shadeChoice: input.shadeChoice ?? null,
      updatedBy: ctx.member!.staffId,
    };
    await this.prisma.$transaction(async (tx) => {
      await updateVersioned(tx.service, { id, businessId }, version, data);
      await this.audit.record(tx, ctx, {
        action: 'update',
        entityType: 'service',
        entityId: id,
        businessId,
        before: { name: before.name, priceMin: moneyToJson(before.priceMin) },
        after: { name: input.name, priceMin: input.priceMin },
      });
    });
    return this.getService(businessId, id);
  }

  async setActive(ctx: RequestContext, businessId: string, id: string, active: boolean) {
    const row = await this.prisma.service.findFirst({ where: { id, businessId } });
    if (!row) throw new ApiError('not_found', 'Service not found');
    await this.prisma.$transaction(async (tx) => {
      await tx.service.update({ where: { id }, data: { active, updatedBy: ctx.member!.staffId, version: { increment: 1 } } });
      await this.audit.record(tx, ctx, { action: active ? 'activated' : 'deactivated', entityType: 'service', entityId: id, businessId, before: null, after: null });
    });
    return this.getService(businessId, id);
  }

  async reorder(businessId: string, ids: string[]): Promise<void> {
    await this.prisma.$transaction(
      ids.map((id, order) => this.prisma.service.updateMany({ where: { id, businessId }, data: { order } })),
    );
  }

  async setTechBreak(ctx: RequestContext, businessId: string, id: string, mode: TechBreakMode, min: number | undefined) {
    const row = await this.prisma.service.findFirst({ where: { id, businessId } });
    if (!row) throw new ApiError('not_found', 'Service not found');
    await this.prisma.$transaction(async (tx) => {
      await tx.service.update({ where: { id }, data: { bufferAfterMin: techBreakToBuffer(mode, min), updatedBy: ctx.member!.staffId, version: { increment: 1 } } });
      await this.audit.record(tx, ctx, { action: 'techBreakChanged', entityType: 'service', entityId: id, businessId, before: null, after: null });
    });
    return this.getService(businessId, id);
  }

  async techBreakExportRows(businessId: string) {
    const rows = await this.prisma.service.findMany({ where: { businessId, servicePackage: { equals: Prisma.DbNull } }, orderBy: [{ order: 'asc' }] });
    return rows.map((s) => ({
      id: s.id,
      name: (s.name as Record<string, string>).ru ?? '',
      seconds: s.bufferAfterMin == null ? ('Default' as const) : s.bufferAfterMin * 60,
    }));
  }

  parseTechBreakSeconds(raw: string): { mode: TechBreakMode; min?: number } | undefined {
    const value = raw.trim();
    if (!value) return undefined;
    if (/^default$/i.test(value)) return { mode: 'shared' };
    if (!/^\d+$/.test(value)) return undefined;
    const seconds = Number(value);
    if (seconds === 0) return { mode: 'none' };
    if (seconds % 300 !== 0 || seconds > 3600) return undefined;
    return { mode: 'custom', min: seconds / 60 };
  }

  async importTechBreaks(ctx: RequestContext, businessId: string, rows: { id: string; name: string; raw: string }[]) {
    const failed: { name: string; reason: string }[] = [];
    let applied = 0;
    await this.prisma.$transaction(async (tx) => {
      for (const row of rows) {
        const parsed = this.parseTechBreakSeconds(row.raw);
        if (!parsed) {
          failed.push({ name: row.name, reason: row.raw });
          continue;
        }
        const res = await tx.service.updateMany({ where: { id: row.id, businessId }, data: { bufferAfterMin: techBreakToBuffer(parsed.mode, parsed.min) } });
        if (res.count === 0) {
          failed.push({ name: row.name, reason: 'not_found' });
          continue;
        }
        applied += 1;
      }
      if (applied) await this.audit.record(tx, ctx, { action: 'import', entityType: 'service', entityId: businessId, businessId, before: null, after: { applied, failed: failed.length } });
    });
    return { applied, failed };
  }

  async deleteImpact(businessId: string, id: string) {
    const service = await this.prisma.service.findFirst({ where: { id, businessId } });
    const staffCount = service && Array.isArray(service.staffIds) ? (service.staffIds as string[]).length : 0;
    const pkgs = await this.prisma.service.findMany({ where: { businessId, NOT: { servicePackage: { equals: Prisma.DbNull } } }, select: { servicePackage: true } });
    const packagesUsing = pkgs.filter((p) => ((p.servicePackage as { items?: { serviceId: string }[] } | null)?.items ?? []).some((it) => it.serviceId === id)).length;
    // Записи/события ещё не на сервере (этап 7) — считаем 0 до того, как появится таблица bookings/group_events
    return { staffCount, futureBookings: 0, futureEvents: 0, packagesUsing };
  }

  /** Удаляет сразу (F-16-170); «Отменить» — экран хранит снимок и зовёт restoreService в те же 5 с */
  async deleteService(ctx: RequestContext, businessId: string, id: string) {
    const service = await this.prisma.service.findFirst({ where: { id, businessId } });
    if (!service) throw new ApiError('not_found', 'Service not found');
    const view = serviceView(service);
    await this.prisma.$transaction(async (tx) => {
      // Снять услугу у мастеров, которые её делают, и удалить сроки (staff_service_terms) — как в моке
      const staffIds = Array.isArray(service.staffIds) ? (service.staffIds as string[]) : [];
      for (const staffId of staffIds) {
        const staff = await tx.staff.findUnique({ where: { id: staffId }, select: { serviceIds: true } });
        if (staff) {
          const ids = (Array.isArray(staff.serviceIds) ? (staff.serviceIds as string[]) : []).filter((x) => x !== id);
          await tx.staff.update({ where: { id: staffId }, data: { serviceIds: ids } });
        }
      }
      await tx.staffServiceTerm.deleteMany({ where: { serviceId: id } });
      await tx.service.delete({ where: { id } });
      await this.audit.record(tx, ctx, { action: 'delete', entityType: 'service', entityId: id, businessId, before: { name: service.name }, after: null });
    });
    return view;
  }

  /** Восстановить тем же id (снимок держит экран, F-00-061) */
  async restoreService(ctx: RequestContext, businessId: string, input: RestoreServiceBody) {
    const exists = await this.prisma.service.findUnique({ where: { id: input.id } });
    if (exists) throw new ApiError('conflict', 'Already exists');
    // Категория могла исчезнуть за 5 с окна «Отменить» — снимаем её, а не падаем на внешнем ключе (F-16-171)
    const category = await this.prisma.serviceCategory.findFirst({ where: { id: input.categoryId, businessId } });
    const rec = input as unknown as Record<string, unknown>;
    await this.prisma.$transaction(async (tx) => {
      await tx.service.create({
        data: {
          id: input.id,
          businessId,
          categoryId: category ? input.categoryId : null,
          sphereId: input.sphereId,
          name: input.name as Prisma.InputJsonValue,
          description: J(rec.description),
          kind: input.kind,
          capacity: typeof rec.capacity === 'number' ? rec.capacity : null,
          durationMin: input.durationMin,
          durationMax: typeof rec.durationMax === 'number' ? rec.durationMax : null,
          priceMin: money(input.priceMin),
          priceMax: typeof rec.priceMax === 'number' ? money(rec.priceMax) : null,
          bufferAfterMin: typeof rec.bufferAfterMin === 'number' ? rec.bufferAfterMin : null,
          repeatIntervalDays: typeof rec.repeatIntervalDays === 'number' ? rec.repeatIntervalDays : null,
          photos: Array.isArray(rec.photos) ? (rec.photos as Prisma.InputJsonValue) : [],
          materials: Array.isArray(rec.materials) ? (rec.materials as Prisma.InputJsonValue) : [],
          staffIds: Array.isArray(rec.staffIds) ? (rec.staffIds as Prisma.InputJsonValue) : [],
          workplaces: Array.isArray(rec.workplaces) ? (rec.workplaces as Prisma.InputJsonValue) : [],
          onlineBookable: rec.onlineBookable !== false,
          active: rec.active !== false,
          order: typeof rec.order === 'number' ? Math.trunc(rec.order) : await this.nextOrder(businessId),
          shadeChoice: typeof rec.shadeChoice === 'string' ? rec.shadeChoice : null,
          servicePackage: J(rec.servicePackage),
          packageExtra: J(rec.packageExtra),
          createdBy: ctx.member!.staffId,
          updatedBy: ctx.member!.staffId,
        },
      });
      await this.audit.record(tx, ctx, { action: 'restore', entityType: 'service', entityId: input.id, businessId, before: null, after: { name: input.name } });
    });
    return this.getService(businessId, input.id);
  }

  // ─────────── мастера услуги (F-10-156, F-02-058, F-16-030) ───────────

  async listServiceStaff(businessId: string, serviceId: string) {
    const service = await this.prisma.service.findFirst({ where: { id: serviceId, businessId } });
    if (!service) throw new ApiError('not_found', 'Service not found');
    const staffIds = Array.isArray(service.staffIds) ? (service.staffIds as string[]) : [];
    if (!staffIds.length) return [];
    const [staff, terms] = await Promise.all([
      this.prisma.staff.findMany({ where: { id: { in: staffIds }, businessId }, include: { locations: { select: { locationId: true } } } }),
      this.prisma.staffServiceTerm.findMany({ where: { serviceId, staffId: { in: staffIds } } }),
    ]);
    return staff.map((s) => ({ staff: staffView(s), term: termView(terms.find((t) => t.staffId === s.id)) }));
  }

  async assignStaffToService(ctx: RequestContext, businessId: string, serviceId: string, staffId: string): Promise<void> {
    const [service, staff] = await Promise.all([
      this.prisma.service.findFirst({ where: { id: serviceId, businessId } }),
      this.prisma.staff.findFirst({ where: { id: staffId, businessId } }),
    ]);
    if (!service) throw new ApiError('not_found', 'Service not found');
    if (!staff) throw new ApiError('not_found', 'Staff not found');
    await this.prisma.$transaction(async (tx) => {
      const serviceStaffIds = new Set(Array.isArray(service.staffIds) ? (service.staffIds as string[]) : []);
      if (!serviceStaffIds.has(staffId)) {
        serviceStaffIds.add(staffId);
        await tx.service.update({ where: { id: serviceId }, data: { staffIds: [...serviceStaffIds] } });
      }
      const staffServiceIds = new Set(Array.isArray(staff.serviceIds) ? (staff.serviceIds as string[]) : []);
      if (!staffServiceIds.has(serviceId)) {
        staffServiceIds.add(serviceId);
        await tx.staff.update({ where: { id: staffId }, data: { serviceIds: [...staffServiceIds] } });
      }
      await this.audit.record(tx, ctx, { action: 'staffAssigned', entityType: 'service', entityId: serviceId, businessId, before: null, after: { staffId } });
    });
  }

  async removeStaffFromService(ctx: RequestContext, businessId: string, serviceId: string, staffId: string): Promise<void> {
    const [service, staff] = await Promise.all([
      this.prisma.service.findFirst({ where: { id: serviceId, businessId } }),
      this.prisma.staff.findFirst({ where: { id: staffId, businessId } }),
    ]);
    if (!service) throw new ApiError('not_found', 'Service not found');
    if (!staff) throw new ApiError('not_found', 'Staff not found');
    await this.prisma.$transaction(async (tx) => {
      await tx.service.update({ where: { id: serviceId }, data: { staffIds: (Array.isArray(service.staffIds) ? (service.staffIds as string[]) : []).filter((x) => x !== staffId) } });
      await tx.staff.update({ where: { id: staffId }, data: { serviceIds: (Array.isArray(staff.serviceIds) ? (staff.serviceIds as string[]) : []).filter((x) => x !== serviceId) } });
      await tx.staffServiceTerm.deleteMany({ where: { serviceId, staffId } });
      await this.audit.record(tx, ctx, { action: 'staffRemoved', entityType: 'service', entityId: serviceId, businessId, before: null, after: { staffId } });
    });
  }

  async setStaffServiceTerm(businessId: string, serviceId: string, staffId: string, price: number | undefined, durationMin: number | undefined) {
    const service = await this.prisma.service.findFirst({ where: { id: serviceId, businessId } });
    if (!service) throw new ApiError('not_found', 'Service not found');
    const row = await this.prisma.staffServiceTerm.upsert({
      where: { staffId_serviceId: { staffId, serviceId } },
      create: { staffId, serviceId, price: price !== undefined ? money(price) : null, durationMin: durationMin ?? null },
      update: { price: price !== undefined ? money(price) : null, durationMin: durationMin ?? null },
    });
    return termView(row)!;
  }

  async getStaffServiceTerms(businessId: string, serviceId: string, staffId: string) {
    const service = await this.prisma.service.findFirst({ where: { id: serviceId, businessId } });
    if (!service) throw new ApiError('not_found', 'Service not found');
    const term = await this.prisma.staffServiceTerm.findUnique({ where: { staffId_serviceId: { staffId, serviceId } } });
    return {
      price: term?.price !== undefined && term?.price !== null ? moneyToJson(term.price) : moneyToJson(service.priceMin),
      priceMax: service.priceMax != null ? moneyToJson(service.priceMax) : undefined,
      durationMin: term?.durationMin ?? service.durationMin,
      durationMax: opt(service.durationMax),
    };
  }

  async listStaffServices(businessId: string, staffId: string) {
    const staff = await this.prisma.staff.findFirst({ where: { id: staffId, businessId } });
    const staffServiceIds = new Set(staff && Array.isArray(staff.serviceIds) ? (staff.serviceIds as string[]) : []);
    const categories = await this.prisma.serviceCategory.findMany({ where: { businessId }, orderBy: [{ sortOrder: 'asc' }] });
    const services = await this.prisma.service.findMany({ where: { businessId, id: { in: [...staffServiceIds] } } });
    const terms = await this.prisma.staffServiceTerm.findMany({ where: { staffId } });
    return categories
      .map((category) => ({
        category: categoryView(category),
        services: services
          .filter((s) => s.categoryId === category.id)
          .map((service) => ({ service: serviceView(service), term: termView(terms.find((t) => t.serviceId === service.id)) })),
      }))
      .filter((g) => g.services.length > 0);
  }

  async listAssignableStaff(businessId: string, serviceId: string) {
    const service = await this.prisma.service.findFirst({ where: { id: serviceId, businessId } });
    const staffIds = new Set(service && Array.isArray(service.staffIds) ? (service.staffIds as string[]) : []);
    const staff = await this.prisma.staff.findMany({ where: { businessId, status: { not: 'fired' }, deletedAt: null }, include: { locations: { select: { locationId: true } } } });
    return staff.filter((s) => !staffIds.has(s.id)).map(staffView);
  }

  async listAssignableServices(businessId: string, staffId: string) {
    const staff = await this.prisma.staff.findFirst({ where: { id: staffId, businessId } });
    const serviceIds = new Set(staff && Array.isArray(staff.serviceIds) ? (staff.serviceIds as string[]) : []);
    const rows = await this.prisma.service.findMany({ where: { businessId, servicePackage: { equals: Prisma.DbNull } } });
    return rows.filter((s) => !serviceIds.has(s.id)).map(serviceView);
  }

  // ─────────── языки, чек, выбор при записи (F-03-115, F-15-141, F-07-149, F-00-094) ───────────

  async getServiceExtra(businessId: string, id: string) {
    const row = await this.prisma.service.findFirst({ where: { id, businessId } });
    if (!row) throw new ApiError('not_found', 'Service not found');
    return serviceExtraView(row);
  }

  async updateServiceExtra(businessId: string, id: string, patch: ServiceExtraBody) {
    const row = await this.prisma.service.findFirst({ where: { id, businessId } });
    if (!row) throw new ApiError('not_found', 'Service not found');
    const merged = { ...serviceExtraView(row), ...patch };
    await this.prisma.service.update({ where: { id }, data: { extra: merged as Prisma.InputJsonValue } });
    return merged;
  }

  async getReceiptName(businessId: string, id: string) {
    const row = await this.prisma.service.findFirst({ where: { id, businessId } });
    if (!row) throw new ApiError('not_found', 'Service not found');
    const extra = serviceExtraView(row) as { receipt?: { receiptName?: Record<string, string> } };
    return extra.receipt?.receiptName;
  }

  async getServiceTranslations(businessId: string, id: string) {
    const row = await this.prisma.service.findFirst({ where: { id, businessId } });
    if (!row) throw new ApiError('not_found', 'Service not found');
    return row.name as Record<string, string>;
  }

  // ─────────── пакеты «Комплекс» (F-16-107…135) ───────────

  async listPackages(businessId: string) {
    const rows = await this.prisma.service.findMany({ where: { businessId, NOT: { servicePackage: { equals: Prisma.DbNull } } }, orderBy: [{ createdAt: 'desc' }] });
    return rows.map(packageWithExtraView);
  }

  async getPackage(businessId: string, id: string) {
    const row = await this.prisma.service.findFirst({ where: { id, businessId, NOT: { servicePackage: { equals: Prisma.DbNull } } } });
    if (!row) throw new ApiError('not_found', 'Package not found');
    return packageWithExtraView(row);
  }

  async createPackage(ctx: RequestContext, businessId: string, input: PackageCreateBody) {
    if (!input.name.ru?.trim()) throw new ApiError('bad_name', 'Name required');
    const category = await this.prisma.serviceCategory.findFirst({ where: { id: input.categoryId, businessId } });
    if (!category) throw new ApiError('not_found', 'Category not found');
    const id = newId('service');
    const servicePackage = { items: [] as { serviceId: string; order: number }[], mode: 'sequentialAny' as const };
    await this.prisma.$transaction(async (tx) => {
      await tx.service.create({
        data: {
          id,
          businessId,
          categoryId: input.categoryId,
          sphereId: input.sphereId,
          name: input.name as Prisma.InputJsonValue,
          kind: 'individual',
          durationMin: 0,
          priceMin: money(0),
          photos: [],
          materials: [],
          staffIds: [],
          workplaces: ['salon'],
          onlineBookable: false,
          active: true,
          order: Date.now(),
          servicePackage: servicePackage as unknown as Prisma.InputJsonValue,
          packageExtra: defaultPackageExtra(id) as unknown as Prisma.InputJsonValue,
          createdBy: ctx.member!.staffId,
          updatedBy: ctx.member!.staffId,
        },
      });
      await this.audit.record(tx, ctx, { action: 'create', entityType: 'package', entityId: id, businessId, after: { name: input.name } });
    });
    return this.getPackage(businessId, id);
  }

  async savePackage(ctx: RequestContext, businessId: string, id: string, patch: PackageSaveBody) {
    const current = await this.prisma.service.findFirst({ where: { id, businessId, NOT: { servicePackage: { equals: Prisma.DbNull } } } });
    if (!current) throw new ApiError('not_found', 'Package not found');
    if (patch.categoryId && !(await this.prisma.serviceCategory.findFirst({ where: { id: patch.categoryId, businessId } }))) {
      throw new ApiError('not_found', 'Category not found');
    }
    const data: Record<string, unknown> = {};
    if (patch.name) data.name = patch.name;
    if (patch.categoryId) data.categoryId = patch.categoryId;
    if (patch.onlineBookable !== undefined) data.onlineBookable = patch.onlineBookable;
    if (patch.description !== undefined) data.description = J(patch.description);
    if (patch.photos) data.photos = patch.photos;
    if (patch.items || patch.mode) {
      const current_pkg = current.servicePackage as { items: { serviceId: string; order: number }[]; mode: string };
      data.servicePackage = { items: patch.items ?? current_pkg.items, mode: patch.mode ?? current_pkg.mode };
    }
    if (patch.extra) {
      const merged = { ...defaultPackageExtra(id), ...(current.packageExtra as Record<string, unknown> | null), ...patch.extra };
      data.packageExtra = merged as Prisma.InputJsonValue;
    }
    if (Object.keys(data).length) {
      await this.prisma.$transaction(async (tx) => {
        await tx.service.update({ where: { id }, data: { ...data, version: { increment: 1 } } as Prisma.ServiceUpdateInput });
        await this.audit.record(tx, ctx, { action: 'update', entityType: 'package', entityId: id, businessId, before: null, after: { name: patch.name } });
      });
    }
    return this.getPackage(businessId, id);
  }

  async countFuturePackageBookings(_businessId: string, _serviceId: string): Promise<number> {
    // Записи на сервере — этап 7 (журнал). До тех пор пакет ничем не занят.
    return 0;
  }

  async deletePackage(ctx: RequestContext, businessId: string, id: string): Promise<void> {
    const row = await this.prisma.service.findFirst({ where: { id, businessId, NOT: { servicePackage: { equals: Prisma.DbNull } } } });
    if (!row) throw new ApiError('not_found', 'Package not found');
    await this.prisma.$transaction(async (tx) => {
      await tx.service.delete({ where: { id } });
      await this.audit.record(tx, ctx, { action: 'delete', entityType: 'package', entityId: id, businessId, before: { name: row.name }, after: null });
    });
  }
}

function opt<T>(v: T | null | undefined): T | undefined {
  return v === null || v === undefined ? undefined : v;
}

function termView(t: { serviceId: string; staffId: string; price: bigint | null; durationMin: number | null } | undefined) {
  if (!t) return undefined;
  return { serviceId: t.serviceId, staffId: t.staffId, price: t.price != null ? moneyToJson(t.price) : undefined, durationMin: opt(t.durationMin) };
}
