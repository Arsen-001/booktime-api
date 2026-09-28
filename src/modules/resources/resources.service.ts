import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { newId } from '../../common/ids/ids.js';
import { PrismaService } from '../../common/prisma.service.js';
import type { ResourceCreateBody, RestoreResourceBody, ResourceUpdateBody } from './resources.schemas.js';
import { resourceView } from './resources.views.js';
import { staffView } from '../businesses/views.js';
import { localDayRangeUtc, utcToLocal } from '../../common/time/time.js';

import { CANCELLED_STATUSES as CANCELLED } from '../journal/rules.js';

const J = (v: unknown) => (v === undefined || v === null ? Prisma.DbNull : (v as Prisma.InputJsonValue));
const arr = <T = string>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

function summaryOf(name: unknown, fallbackId: string): string {
  const n = name as Record<string, string> | null | undefined;
  return n?.ru || n?.en || n?.hy || fallbackId;
}

// ─────────── stage 21: настройки-списки раздела resources — одна строка BusinessSetting(area='resources') ───────────
// Тот же приём, что splitByResource выше: JSON-блоб на бизнес, а не своя таблица на каждую мелкую настройку
// (шаблоны повтора/категории событий — списки в пределах пары десятков, ассистенты/права — по staffId).

export interface ResourcesAssistantSettings {
  compensationEnabled: boolean;
  allowMultiple: boolean;
  shareRule: 'full' | 'split';
}
export interface ResourcesFineRights {
  viewResources: boolean;
  editServiceResources: boolean;
  viewWaitlist: boolean;
  addAssistants: boolean;
  editAssistantShare: boolean;
}
export interface ResourcesEventTemplate {
  id: string;
  businessId: string;
  name: string;
  freq: string;
  weekIntervalWeeks?: number;
}
export interface ResourcesEventCategory {
  id: string;
  businessId: string;
  name: string;
  colorIndex: number;
}
export interface ResourcesGroupServicePayment {
  serviceId: string;
  onlinePrepaymentEnabled: boolean;
  membershipBookingEnabled: boolean;
}
interface ResourcesSettingsData {
  splitByResource?: boolean;
  assistantSettings?: ResourcesAssistantSettings;
  staffAssistantEligible?: Record<string, boolean>;
  staffRights?: Record<string, Partial<ResourcesFineRights>>;
  groupSeatsSettings?: { allowMultiSeat: boolean; maxSeats: number };
  eventTemplates?: ResourcesEventTemplate[];
  eventCategories?: ResourcesEventCategory[];
  groupServicePayment?: Record<string, ResourcesGroupServicePayment>;
}

export const DEFAULT_ASSISTANT_SETTINGS: ResourcesAssistantSettings = { compensationEnabled: false, allowMultiple: false, shareRule: 'split' };
export const DEFAULT_GROUP_SEATS_SETTINGS = { allowMultiSeat: true, maxSeats: 6 };
export function defaultGroupServicePayment(serviceId: string): ResourcesGroupServicePayment {
  return { serviceId, onlinePrepaymentEnabled: false, membershipBookingEnabled: false };
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

  /** Будущие записи и события по каждому экземпляру ресурса — предупреждение перед удалением экземпляра (этап 21, сдача) */
  async futureUsageByInstance(businessId: string, id: string): Promise<Record<string, number>> {
    const row = await this.prisma.resource.findFirst({ where: { id, businessId } });
    if (!row) return {};
    const out: Record<string, number> = {};
    for (const inst of resourceView(row).instances) out[inst.id] = 0;
    const now = new Date();
    const [bookings, events] = await Promise.all([
      this.prisma.booking.findMany({ where: { businessId, startAt: { gte: now }, deletedAt: null, groupEventId: null, status: { notIn: [...CANCELLED] } }, select: { resourceIds: true } }),
      this.prisma.groupEvent.findMany({ where: { businessId, startAt: { gte: now }, status: 'scheduled' }, select: { resourceIds: true } }),
    ]);
    for (const x of [...bookings, ...events]) for (const rid of (x.resourceIds as string[] | null) ?? []) if (rid in out) out[rid]! += 1;
    return out;
  }

  /** Занятость ресурса на день по экземплярам (F-16-019): записи и групповые события, местное время филиала */
  async dayLoad(businessId: string, id: string, date: string) {
    const row = await this.prisma.resource.findFirst({ where: { id, businessId } });
    if (!row) throw new ApiError('not_found', 'Resource not found');
    const loc = await this.prisma.location.findFirst({ where: { businessId, deletedAt: null }, orderBy: { sortOrder: 'asc' }, select: { tz: true } });
    const tz = loc?.tz ?? 'Asia/Yerevan';
    const { from, to } = localDayRangeUtc(date, tz);
    const [bookings, events] = await Promise.all([
      this.prisma.booking.findMany({ where: { businessId, startAt: { gte: from, lt: to }, deletedAt: null, groupEventId: null, status: { notIn: [...CANCELLED] } }, select: { id: true, startAt: true, durationMin: true, services: true, staffId: true, resourceIds: true } }),
      this.prisma.groupEvent.findMany({ where: { businessId, startAt: { gte: from, lt: to }, status: 'scheduled' } }),
    ]);
    const serviceIds = new Set<string>();
    for (const b of bookings) for (const l of (b.services as { serviceId?: string }[] | null) ?? []) if (l.serviceId) serviceIds.add(l.serviceId);
    for (const e of events) if (e.serviceId) serviceIds.add(e.serviceId);
    const staffIds = new Set<string>([...bookings.map((b) => b.staffId), ...events.map((e) => e.staffId)]);
    const [services, staff] = await Promise.all([
      this.prisma.service.findMany({ where: { id: { in: [...serviceIds] } }, select: { id: true, name: true } }),
      this.prisma.staff.findMany({ where: { id: { in: [...staffIds] } }, select: { id: true, name: true } }),
    ]);
    const svcName = new Map(services.map((x) => [x.id, x.name as Record<string, string>]));
    const stName = new Map(staff.map((x) => [x.id, x.name]));
    const byInstance = new Map(resourceView(row).instances.map((i) => [i.id, [] as Array<Record<string, unknown>>] as const));
    for (const b of bookings) {
      for (const rid of (b.resourceIds as string[] | null) ?? []) {
        byInstance.get(rid)?.push({
          id: b.id,
          kind: 'booking',
          start: utcToLocal(b.startAt, tz),
          durationMin: b.durationMin,
          services: ((b.services as { serviceId?: string }[] | null) ?? []).map((l) => svcName.get(l.serviceId ?? '')).filter(Boolean),
          staffName: stName.get(b.staffId),
        });
      }
    }
    for (const e of events) {
      for (const rid of (e.resourceIds as string[] | null) ?? []) {
        byInstance.get(rid)?.push({ id: e.id, kind: 'event', start: utcToLocal(e.startAt, tz), durationMin: e.durationMin, services: [svcName.get(e.serviceId)].filter(Boolean), staffName: stName.get(e.staffId) });
      }
    }
    return {
      instances: resourceView(row).instances.map((i) => ({ id: i.id, name: i.name, items: (byInstance.get(i.id) ?? []).sort((a, b) => String(a.start).localeCompare(String(b.start))) })),
    };
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
      // stage 21: 'event'/'waitlist' — записи ResourcesEventsService (детали события, лист ожидания
      // resources.ts), тот же общий audit_events, что 'resource'/'package' уже читали (F-16-171)
      where: { businessId, entityType: { in: ['resource', 'package', 'event', 'waitlist'] } },
      orderBy: { at: 'desc' },
      take: 500,
    });
    return rows.map((r) => ({
      id: r.id,
      businessId: r.businessId ?? businessId,
      entity: r.entityType as 'resource' | 'package' | 'event' | 'waitlist',
      entityId: r.entityId,
      action: r.action as 'create' | 'update' | 'delete' | 'restore',
      actorName: r.actorName,
      at: r.at.toISOString(),
      summary: summaryOf(diffName(r.diff), r.entityId),
    }));
  }

  // ─────────── stage 21: настройки-списки (JSON-блоб, см. пояснение выше конструктора) ───────────

  private async settings(businessId: string): Promise<ResourcesSettingsData> {
    const row = await this.prisma.businessSetting.findUnique({ where: { businessId_area: { businessId, area: 'resources' } } });
    return (row?.data as ResourcesSettingsData | undefined) ?? {};
  }

  private async patchSettings(businessId: string, recipe: (s: ResourcesSettingsData) => void): Promise<ResourcesSettingsData> {
    const current = await this.settings(businessId);
    recipe(current);
    await this.prisma.businessSetting.upsert({
      where: { businessId_area: { businessId, area: 'resources' } },
      create: { businessId, area: 'resources', data: current as Prisma.InputJsonValue },
      update: { data: current as Prisma.InputJsonValue, version: { increment: 1 } },
    });
    return current;
  }

  async getAssistantSettings(businessId: string): Promise<ResourcesAssistantSettings> {
    return (await this.settings(businessId)).assistantSettings ?? DEFAULT_ASSISTANT_SETTINGS;
  }
  async saveAssistantSettings(businessId: string, patch: Partial<ResourcesAssistantSettings>): Promise<ResourcesAssistantSettings> {
    const s = await this.patchSettings(businessId, (s) => {
      s.assistantSettings = { ...(s.assistantSettings ?? DEFAULT_ASSISTANT_SETTINGS), ...patch };
    });
    return s.assistantSettings!;
  }

  async listAssistantStaff(businessId: string): Promise<{ id: string; name: string; eligible: boolean }[]> {
    const [eligible, staff] = await Promise.all([
      this.settings(businessId).then((s) => s.staffAssistantEligible ?? {}),
      this.prisma.staff.findMany({ where: { businessId, deletedAt: null }, select: { id: true, name: true } }),
    ]);
    return staff.map((s) => ({ id: s.id, name: s.name, eligible: eligible[s.id] ?? false }));
  }
  async setStaffAssistantEligible(businessId: string, staffId: string, value: boolean): Promise<boolean> {
    await this.patchSettings(businessId, (s) => {
      s.staffAssistantEligible = { ...(s.staffAssistantEligible ?? {}), [staffId]: value };
    });
    return value;
  }

  /** F-09-044/F-16-137/139: помощник без графика, не занимает платное место подписки (см. resources.ts фронта) */
  async createAssistant(ctx: RequestContext, businessId: string, locationId: string, name: string, phone: string) {
    const location = await this.prisma.location.findFirst({ where: { id: locationId, businessId, deletedAt: null } });
    if (!location) throw new ApiError('not_found', 'Location not found');
    const id = newId('staff');
    await this.prisma.$transaction(async (tx) => {
      await tx.staff.create({
        data: {
          id,
          businessId,
          name: name.trim(),
          phone,
          role: 'master',
          status: 'active',
          sphereIds: [],
          photos: [],
          materials: [],
          workplaces: ['salon'],
          accepts: 'all',
          calendarVisibility: 'all',
          calendarMode: 'free',
          confirmMode: 'instant',
          colorIndex: 1,
          serviceIds: [],
          hiredAt: new Date().toISOString().slice(0, 10),
          hiddenInJournal: true,
          assistantOnly: true,
          createdBy: ctx.member!.staffId,
          updatedBy: ctx.member!.staffId,
        },
      });
      await tx.staffLocation.create({ data: { staffId: id, locationId } });
    });
    await this.setStaffAssistantEligible(businessId, id, true);
    const created = await this.prisma.staff.findUniqueOrThrow({ where: { id }, include: { locations: true } });
    return staffView(created);
  }

  async getStaffResourcesRights(businessId: string, staffId: string): Promise<Partial<ResourcesFineRights> | undefined> {
    return (await this.settings(businessId)).staffRights?.[staffId];
  }
  async setStaffResourcesRights(businessId: string, staffId: string, rights: Partial<ResourcesFineRights>): Promise<Partial<ResourcesFineRights>> {
    const s = await this.patchSettings(businessId, (s) => {
      s.staffRights = { ...(s.staffRights ?? {}), [staffId]: { ...(s.staffRights?.[staffId] ?? {}), ...rights } };
    });
    return s.staffRights![staffId]!;
  }

  async getGroupSeatsSettings(businessId: string) {
    return (await this.settings(businessId)).groupSeatsSettings ?? DEFAULT_GROUP_SEATS_SETTINGS;
  }
  async saveGroupSeatsSettings(businessId: string, patch: { allowMultiSeat: boolean; maxSeats: number }) {
    await this.patchSettings(businessId, (s) => {
      s.groupSeatsSettings = patch;
    });
    return patch;
  }

  async listEventTemplates(businessId: string): Promise<ResourcesEventTemplate[]> {
    return (await this.settings(businessId)).eventTemplates ?? [];
  }
  async saveEventTemplate(businessId: string, input: { name: string; freq: string; weekIntervalWeeks?: number }): Promise<ResourcesEventTemplate> {
    const template: ResourcesEventTemplate = { id: newId('recurrenceTemplate'), businessId, name: input.name.trim(), freq: input.freq, weekIntervalWeeks: input.weekIntervalWeeks };
    await this.patchSettings(businessId, (s) => {
      s.eventTemplates = [...(s.eventTemplates ?? []), template];
    });
    return template;
  }

  async listEventCategories(businessId: string): Promise<ResourcesEventCategory[]> {
    return (await this.settings(businessId)).eventCategories ?? [];
  }
  async createEventCategory(businessId: string, name: string, colorIndex: number): Promise<ResourcesEventCategory> {
    const category: ResourcesEventCategory = { id: newId('bookingCategory'), businessId, name: name.trim(), colorIndex };
    await this.patchSettings(businessId, (s) => {
      s.eventCategories = [...(s.eventCategories ?? []), category];
    });
    return category;
  }
  async updateEventCategory(businessId: string, id: string, patch: { name: string; colorIndex: number }): Promise<ResourcesEventCategory> {
    let updated: ResourcesEventCategory | undefined;
    await this.patchSettings(businessId, (s) => {
      const list = s.eventCategories ?? [];
      const found = list.find((c) => c.id === id);
      if (!found) throw new ApiError('not_found', 'Category not found');
      found.name = patch.name.trim();
      found.colorIndex = patch.colorIndex;
      updated = found;
      s.eventCategories = list;
    });
    return updated!;
  }
  async deleteEventCategory(businessId: string, id: string): Promise<void> {
    await this.patchSettings(businessId, (s) => {
      s.eventCategories = (s.eventCategories ?? []).filter((c) => c.id !== id);
    });
  }

  async getGroupServicePayment(businessId: string, serviceId: string): Promise<ResourcesGroupServicePayment> {
    return (await this.settings(businessId)).groupServicePayment?.[serviceId] ?? defaultGroupServicePayment(serviceId);
  }
  async setGroupServicePayment(businessId: string, serviceId: string, patch: Partial<Pick<ResourcesGroupServicePayment, 'onlinePrepaymentEnabled' | 'membershipBookingEnabled'>>) {
    const s = await this.patchSettings(businessId, (s) => {
      const current = s.groupServicePayment?.[serviceId] ?? defaultGroupServicePayment(serviceId);
      s.groupServicePayment = { ...(s.groupServicePayment ?? {}), [serviceId]: { ...current, ...patch } };
    });
    return s.groupServicePayment![serviceId];
  }

  /** Пояс первой локации бизнеса (упрощение как GroupEventsService.tzOfBusiness — resources.ts фронта тоже
   * не спрашивает locationId у pickFreeResourceInstances/listResourceOptions, PLAN §4.1 «по умолчанию Asia/Yerevan») */
  async tzOfBusiness(businessId: string): Promise<string> {
    const loc = await this.prisma.location.findFirst({ where: { businessId, deletedAt: null }, select: { tz: true } });
    return loc?.tz ?? 'Asia/Yerevan';
  }

  // ─────────── stage 21: подбор свободного экземпляра ресурса (F-16-011…013) — из resource_busy, не из мока ───────────
  // Сервер уже держит настоящую занятость по экземпляру в resource_busy (occupy.ts, этап 6/7): своя копия
  // instanceBusy/pickFreeInstances мока здесь не нужна — считаем напрямую по таблице, это и точнее (живые
  // данные), и проще (никакого «собери занятость записей+событий вручную», как в src/domain/resources.ts).

  private async instancesBusyMap(businessId: string, resourceIds: string[], start: Date, end: Date, excludeBookingId?: string): Promise<Map<string, Set<string>>> {
    const rows = await this.prisma.resourceBusy.findMany({
      where: {
        businessId,
        resourceId: { in: resourceIds },
        active: true,
        startAt: { lt: end },
        endAt: { gt: start },
        ...(excludeBookingId ? { NOT: { source: 'booking', sourceId: excludeBookingId } } : {}),
      },
      select: { resourceId: true, instanceId: true },
    });
    const byResource = new Map<string, { pinned: Set<string>; loose: number }>();
    for (const r of rows) {
      const e = byResource.get(r.resourceId) ?? { pinned: new Set<string>(), loose: 0 };
      if (r.instanceId) e.pinned.add(r.instanceId);
      else e.loose += 1;
      byResource.set(r.resourceId, e);
    }
    const busyByResource = new Map<string, Set<string>>();
    const resources = await this.prisma.resource.findMany({ where: { id: { in: resourceIds } }, select: { id: true, instances: true } });
    for (const res of resources) {
      const instances = arr<{ id: string; name: string }>(res.instances).map((i) => i.id);
      const e = byResource.get(res.id) ?? { pinned: new Set<string>(), loose: 0 };
      const busy = new Set(e.pinned);
      // Занятость без привязки к конкретному экземпляру («любой свободный») — считаем занятыми первые
      // непомеченные экземпляры по счётчику, чтобы никогда не занизить фактическую загрузку ресурса.
      let remaining = e.loose;
      for (const id of instances) {
        if (remaining <= 0) break;
        if (busy.has(id)) continue;
        busy.add(id);
        remaining -= 1;
      }
      busyByResource.set(res.id, busy);
    }
    return busyByResource;
  }

  /** F-16-011/012: по одному свободному экземпляру каждого ресурса услуги; чего-то не хватает — undefined */
  async pickFreeInstances(businessId: string, serviceIds: string[], start: Date, durationMin: number, excludeBookingId?: string): Promise<string[] | undefined> {
    // Resource не мягко удаляется (delete() выше — настоящий DELETE), своего deletedAt в схеме нет —
    // отдельная от "мягко удалённых" сущностей модель; найдена и починена этапом 21 (лейн resources):
    // `deletedAt: null` в where молча проходил TypeScript (generic Subset у Prisma не ловит лишний ключ
    // литерала where excess-property-check'ом) и падал 500 `PrismaClientValidationError` в рантайме на
    // ЛЮБОМ вызове окна записи — не поймано `tsc`, поймано только настоящим HTTP-запросом.
    const resources = await this.prisma.resource.findMany({ where: { businessId, active: true } });
    const relevant = resources.filter((r) => arr<string>(r.serviceIds).some((id) => serviceIds.includes(id)));
    if (!relevant.length) return [];
    const end = new Date(start.getTime() + durationMin * 60_000);
    const busyByResource = await this.instancesBusyMap(businessId, relevant.map((r) => r.id), start, end, excludeBookingId);
    const picked: string[] = [];
    for (const r of relevant) {
      const instances = arr<{ id: string; name: string }>(r.instances).map((i) => i.id);
      const free = instances.find((id) => !busyByResource.get(r.id)?.has(id));
      if (!free) return undefined;
      picked.push(free);
    }
    return picked;
  }

  /** F-16-013: экземпляры, выбранные вручную, все ещё свободны? Экземпляр может принадлежать любому активному
   * ресурсу бизнеса — считаем занятость по всем сразу, id экземпляра уникален в пределах бизнеса. */
  async checkInstancesFree(businessId: string, instanceIds: string[], start: Date, durationMin: number, excludeBookingId?: string): Promise<boolean> {
    if (!instanceIds.length) return true;
    const end = new Date(start.getTime() + durationMin * 60_000);
    const all = await this.prisma.resource.findMany({ where: { businessId, active: true }, select: { id: true } });
    const busyByResource = await this.instancesBusyMap(businessId, all.map((r) => r.id), start, end, excludeBookingId);
    const busy = new Set<string>();
    for (const set of busyByResource.values()) for (const id of set) busy.add(id);
    return instanceIds.every((id) => !busy.has(id));
  }

  /** F-16-013: все активные ресурсы локации с отметкой занятых сейчас экземпляров (окно записи) */
  async listResourceOptions(businessId: string, start: Date, durationMin: number, excludeBookingId?: string) {
    const resources = await this.prisma.resource.findMany({ where: { businessId, active: true } });
    const end = new Date(start.getTime() + durationMin * 60_000);
    const busyByResource = await this.instancesBusyMap(businessId, resources.map((r) => r.id), start, end, excludeBookingId);
    return resources.map((r) => ({
      resource: resourceView(r),
      instances: arr<{ id: string; name: string }>(r.instances).map((i) => ({ id: i.id, name: i.name, busy: busyByResource.get(r.id)?.has(i.id) ?? false })),
    }));
  }
}

function diffName(diff: unknown): unknown {
  const d = diff as Record<string, [unknown, unknown]> | null;
  const name = d?.name?.[1] ?? d?.name?.[0];
  return name;
}
