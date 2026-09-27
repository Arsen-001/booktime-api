import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { newId } from '../../common/ids/ids.js';
import { PrismaService } from '../../common/prisma.service.js';
import type { ResourceCreateBody, RestoreResourceBody, ResourceUpdateBody } from './resources.schemas.js';
import { resourceView } from './resources.views.js';

const J = (v: unknown) => (v === undefined || v === null ? Prisma.DbNull : (v as Prisma.InputJsonValue));

function summaryOf(name: unknown, fallbackId: string): string {
  const n = name as Record<string, string> | null | undefined;
  return n?.ru || n?.en || n?.hy || fallbackId;
}

@Injectable()
export class ResourcesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ─────────── «Разделять запись с услугами, использующими разные ресурсы» (F-16-016) ───────────

  async getSplitByResource(businessId: string): Promise<boolean> {
    const row = await this.prisma.businessSetting.findUnique({ where: { businessId_area: { businessId, area: 'resources' } } });
    const data = row?.data as { splitByResource?: boolean } | undefined;
    return data?.splitByResource ?? true;
  }

  async setSplitByResource(businessId: string, value: boolean): Promise<boolean> {
    await this.prisma.businessSetting.upsert({
      where: { businessId_area: { businessId, area: 'resources' } },
      create: { businessId, area: 'resources', data: { splitByResource: value } },
      update: { data: { splitByResource: value }, version: { increment: 1 } },
    });
    return value;
  }

  // ─────────── ресурсы (F-16-001…026) ───────────

  async list(businessId: string) {
    const rows = await this.prisma.resource.findMany({ where: { businessId }, orderBy: [{ createdAt: 'asc' }] });
    return rows.map(resourceView);
  }

  async get(businessId: string, id: string) {
    const row = await this.prisma.resource.findFirst({ where: { id, businessId } });
    if (!row) throw new ApiError('not_found', 'Resource not found');
    return resourceView(row);
  }

  /** Новый ресурс сразу получает первый экземпляр (F-16-003/004) */
  async create(ctx: RequestContext, businessId: string, input: ResourceCreateBody) {
    if (!input.name.ru?.trim()) throw new ApiError('bad_name', 'Name required');
    const location = await this.prisma.location.findFirst({ where: { id: input.locationId, businessId, deletedAt: null } });
    if (!location) throw new ApiError('not_found', 'Location not found');
    const id = newId('resource');
    await this.prisma.$transaction(async (tx) => {
      await tx.resource.create({
        data: {
          id,
          businessId,
          locationId: input.locationId,
          name: input.name as Prisma.InputJsonValue,
          kind: input.kind,
          instances: [{ id: `${id}_1`, name: '1' }],
          serviceIds: input.serviceIds,
          description: input.description?.trim() || null,
          createdBy: ctx.member!.staffId,
          updatedBy: ctx.member!.staffId,
        },
      });
      await this.audit.record(tx, ctx, { action: 'create', entityType: 'resource', entityId: id, businessId, after: { name: input.name } });
    });
    return this.get(businessId, id);
  }

  async update(ctx: RequestContext, businessId: string, id: string, patch: ResourceUpdateBody) {
    const before = await this.prisma.resource.findFirst({ where: { id, businessId } });
    if (!before) throw new ApiError('not_found', 'Resource not found');
    const data: Record<string, unknown> = { updatedBy: ctx.member!.staffId, version: { increment: 1 } };
    if (patch.name !== undefined) {
      if (!patch.name.ru?.trim()) throw new ApiError('bad_name', 'Name required');
      data.name = patch.name;
    }
    if (patch.kind !== undefined) data.kind = patch.kind;
    if (patch.serviceIds !== undefined) data.serviceIds = patch.serviceIds;
    if (patch.description !== undefined) data.description = patch.description.trim() || null;
    if (patch.active !== undefined) data.active = patch.active;
    await this.prisma.$transaction(async (tx) => {
      await tx.resource.update({ where: { id }, data: data as Prisma.ResourceUpdateInput });
      const after = await tx.resource.findUniqueOrThrow({ where: { id } });
      await this.audit.record(tx, ctx, { action: 'update', entityType: 'resource', entityId: id, businessId, before: { name: before.name }, after: { name: after.name } });
    });
    return this.get(businessId, id);
  }

  /** Сколько будущих записей и событий держат этот ресурс (занятость resource_busy, этап 7) — предупреждение перед удалением */
  async countFutureUsage(businessId: string, id: string): Promise<number> {
    const rows = await this.prisma.resourceBusy.findMany({ where: { businessId, resourceId: id, active: true, startAt: { gt: new Date() } }, select: { sourceId: true } });
    return new Set(rows.map((r) => r.sourceId)).size;
  }

  async delete(ctx: RequestContext, businessId: string, id: string) {
    const row = await this.prisma.resource.findFirst({ where: { id, businessId } });
    if (!row) throw new ApiError('not_found', 'Resource not found');
    const view = resourceView(row);
    await this.prisma.$transaction(async (tx) => {
      await tx.resource.delete({ where: { id } });
      await this.audit.record(tx, ctx, { action: 'delete', entityType: 'resource', entityId: id, businessId, before: { name: row.name }, after: null });
    });
    return view;
  }

  /** Восстановить тем же id (F-00-061 — «Отменить», у Resource нет deletedAt) */
  async restore(ctx: RequestContext, businessId: string, input: RestoreResourceBody) {
    const exists = await this.prisma.resource.findUnique({ where: { id: input.resource.id } });
    if (exists) throw new ApiError('conflict', 'Already exists');
    await this.prisma.$transaction(async (tx) => {
      await tx.resource.create({
        data: {
          id: input.resource.id,
          businessId,
          locationId: input.resource.locationId,
          name: input.resource.name as Prisma.InputJsonValue,
          kind: input.resource.kind,
          instances: input.resource.instances as Prisma.InputJsonValue,
          serviceIds: input.resource.serviceIds,
          description: input.description?.trim() || null,
          createdBy: ctx.member!.staffId,
          updatedBy: ctx.member!.staffId,
        },
      });
      await this.audit.record(tx, ctx, { action: 'restore', entityType: 'resource', entityId: input.resource.id, businessId, before: null, after: { name: input.resource.name } });
    });
    return this.get(businessId, input.resource.id);
  }

  // ─────────── экземпляры (F-16-004…007) ───────────

  async addInstance(businessId: string, id: string, name: string) {
    const resource = await this.prisma.resource.findFirst({ where: { id, businessId } });
    if (!resource) throw new ApiError('not_found', 'Resource not found');
    const instances = Array.isArray(resource.instances) ? (resource.instances as { id: string; name: string }[]) : [];
    const n = instances.length + 1;
    const next = [...instances, { id: newId('resourceInstance'), name: name.trim() || String(n) }];
    await this.prisma.resource.update({ where: { id }, data: { instances: next as Prisma.InputJsonValue, version: { increment: 1 } } });
    return this.get(businessId, id);
  }

  async renameInstance(businessId: string, id: string, instanceId: string, name: string) {
    const resource = await this.prisma.resource.findFirst({ where: { id, businessId } });
    if (!resource) throw new ApiError('not_found', 'Resource not found');
    const instances = Array.isArray(resource.instances) ? (resource.instances as { id: string; name: string }[]) : [];
    const next = instances.map((i) => (i.id === instanceId ? { ...i, name: name.trim() || i.name } : i));
    await this.prisma.resource.update({ where: { id }, data: { instances: next as Prisma.InputJsonValue, version: { increment: 1 } } });
    return this.get(businessId, id);
  }

  async removeInstance(businessId: string, id: string, instanceId: string) {
    const resource = await this.prisma.resource.findFirst({ where: { id, businessId } });
    if (!resource) throw new ApiError('not_found', 'Resource not found');
    const instances = Array.isArray(resource.instances) ? (resource.instances as { id: string; name: string }[]) : [];
    if (instances.length <= 1) throw new ApiError('last_instance', 'Cannot remove the last instance');
    const next = instances.filter((i) => i.id !== instanceId);
    await this.prisma.resource.update({ where: { id }, data: { instances: next as Prisma.InputJsonValue, version: { increment: 1 } } });
    return this.get(businessId, id);
  }

  // ─────────── привязка ресурс ↔ услуга (F-16-006/007) ───────────

  async setServices(businessId: string, id: string, serviceIds: string[]) {
    const resource = await this.prisma.resource.findFirst({ where: { id, businessId } });
    if (!resource) throw new ApiError('not_found', 'Resource not found');
    await this.prisma.resource.update({ where: { id }, data: { serviceIds, version: { increment: 1 } } });
    return this.get(businessId, id);
  }

  async listForService(businessId: string, serviceId: string) {
    const rows = await this.prisma.resource.findMany({ where: { businessId } });
    return rows.filter((r) => (Array.isArray(r.serviceIds) ? (r.serviceIds as string[]) : []).includes(serviceId)).map(resourceView);
  }

  async toggleService(businessId: string, id: string, serviceId: string, linked: boolean) {
    const resource = await this.prisma.resource.findFirst({ where: { id, businessId } });
    if (!resource) throw new ApiError('not_found', 'Resource not found');
    const current = new Set(Array.isArray(resource.serviceIds) ? (resource.serviceIds as string[]) : []);
    if (linked) current.add(serviceId);
    else current.delete(serviceId);
    await this.prisma.resource.update({ where: { id }, data: { serviceIds: [...current], version: { increment: 1 } } });
    return this.get(businessId, id);
  }

  // ─────────── журнал изменений (F-16-171) — из общего audit_events ───────────

  async changelog(businessId: string) {
    const rows = await this.prisma.auditEvent.findMany({
      where: { businessId, entityType: { in: ['resource', 'package'] } },
      orderBy: { at: 'desc' },
      take: 500,
    });
    return rows.map((r) => ({
      id: r.id,
      businessId: r.businessId ?? businessId,
      entity: r.entityType as 'resource' | 'package',
      entityId: r.entityId,
      action: r.action as 'create' | 'update' | 'delete' | 'restore',
      actorName: r.actorName,
      at: r.at.toISOString(),
      summary: summaryOf(diffName(r.diff), r.entityId),
    }));
  }
}

function diffName(diff: unknown): unknown {
  const d = diff as Record<string, [unknown, unknown]> | null;
  const name = d?.name?.[1] ?? d?.name?.[0];
  return name;
}
