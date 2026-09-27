var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { ApiError } from '../../common/errors/api-error.js';
import { newId } from '../../common/ids/ids.js';
import { PrismaService } from '../../common/prisma.service.js';
import { resourceView } from './resources.views.js';
import { staffView } from '../businesses/views.js';
const J = (v) => (v === undefined || v === null ? Prisma.DbNull : v);
const arr = (v) => (Array.isArray(v) ? v : []);
function summaryOf(name, fallbackId) {
    const n = name;
    return n?.ru || n?.en || n?.hy || fallbackId;
}
export const DEFAULT_ASSISTANT_SETTINGS = { compensationEnabled: false, allowMultiple: false, shareRule: 'split' };
export const DEFAULT_GROUP_SEATS_SETTINGS = { allowMultiSeat: true, maxSeats: 6 };
export function defaultGroupServicePayment(serviceId) {
    return { serviceId, onlinePrepaymentEnabled: false, membershipBookingEnabled: false };
}
let ResourcesService = class ResourcesService {
    constructor(prisma, audit) {
        this.prisma = prisma;
        this.audit = audit;
    }
    // ─────────── «Разделять запись с услугами, использующими разные ресурсы» (F-16-016) ───────────
    async getSplitByResource(businessId) {
        const row = await this.prisma.businessSetting.findUnique({ where: { businessId_area: { businessId, area: 'resources' } } });
        const data = row?.data;
        return data?.splitByResource ?? true;
    }
    async setSplitByResource(businessId, value) {
        await this.prisma.businessSetting.upsert({
            where: { businessId_area: { businessId, area: 'resources' } },
            create: { businessId, area: 'resources', data: { splitByResource: value } },
            update: { data: { splitByResource: value }, version: { increment: 1 } },
        });
        return value;
    }
    // ─────────── ресурсы (F-16-001…026) ───────────
    async list(businessId) {
        const rows = await this.prisma.resource.findMany({ where: { businessId }, orderBy: [{ createdAt: 'asc' }] });
        return rows.map(resourceView);
    }
    async get(businessId, id) {
        const row = await this.prisma.resource.findFirst({ where: { id, businessId } });
        if (!row)
            throw new ApiError('not_found', 'Resource not found');
        return resourceView(row);
    }
    /** Новый ресурс сразу получает первый экземпляр (F-16-003/004) */
    async create(ctx, businessId, input) {
        if (!input.name.ru?.trim())
            throw new ApiError('bad_name', 'Name required');
        const location = await this.prisma.location.findFirst({ where: { id: input.locationId, businessId, deletedAt: null } });
        if (!location)
            throw new ApiError('not_found', 'Location not found');
        const id = newId('resource');
        await this.prisma.$transaction(async (tx) => {
            await tx.resource.create({
                data: {
                    id,
                    businessId,
                    locationId: input.locationId,
                    name: input.name,
                    kind: input.kind,
                    instances: [{ id: `${id}_1`, name: '1' }],
                    serviceIds: input.serviceIds,
                    description: input.description?.trim() || null,
                    createdBy: ctx.member.staffId,
                    updatedBy: ctx.member.staffId,
                },
            });
            await this.audit.record(tx, ctx, { action: 'create', entityType: 'resource', entityId: id, businessId, after: { name: input.name } });
        });
        return this.get(businessId, id);
    }
    async update(ctx, businessId, id, patch) {
        const before = await this.prisma.resource.findFirst({ where: { id, businessId } });
        if (!before)
            throw new ApiError('not_found', 'Resource not found');
        const data = { updatedBy: ctx.member.staffId, version: { increment: 1 } };
        if (patch.name !== undefined) {
            if (!patch.name.ru?.trim())
                throw new ApiError('bad_name', 'Name required');
            data.name = patch.name;
        }
        if (patch.kind !== undefined)
            data.kind = patch.kind;
        if (patch.serviceIds !== undefined)
            data.serviceIds = patch.serviceIds;
        if (patch.description !== undefined)
            data.description = patch.description.trim() || null;
        if (patch.active !== undefined)
            data.active = patch.active;
        await this.prisma.$transaction(async (tx) => {
            await tx.resource.update({ where: { id }, data: data });
            const after = await tx.resource.findUniqueOrThrow({ where: { id } });
            await this.audit.record(tx, ctx, { action: 'update', entityType: 'resource', entityId: id, businessId, before: { name: before.name }, after: { name: after.name } });
        });
        return this.get(businessId, id);
    }
    /** Сколько будущих записей и событий держат этот ресурс (занятость resource_busy, этап 7) — предупреждение перед удалением */
    async countFutureUsage(businessId, id) {
        const rows = await this.prisma.resourceBusy.findMany({ where: { businessId, resourceId: id, active: true, startAt: { gt: new Date() } }, select: { sourceId: true } });
        return new Set(rows.map((r) => r.sourceId)).size;
    }
    async delete(ctx, businessId, id) {
        const row = await this.prisma.resource.findFirst({ where: { id, businessId } });
        if (!row)
            throw new ApiError('not_found', 'Resource not found');
        const view = resourceView(row);
        await this.prisma.$transaction(async (tx) => {
            await tx.resource.delete({ where: { id } });
            await this.audit.record(tx, ctx, { action: 'delete', entityType: 'resource', entityId: id, businessId, before: { name: row.name }, after: null });
        });
        return view;
    }
    /** Восстановить тем же id (F-00-061 — «Отменить», у Resource нет deletedAt) */
    async restore(ctx, businessId, input) {
        const exists = await this.prisma.resource.findUnique({ where: { id: input.resource.id } });
        if (exists)
            throw new ApiError('conflict', 'Already exists');
        await this.prisma.$transaction(async (tx) => {
            await tx.resource.create({
                data: {
                    id: input.resource.id,
                    businessId,
                    locationId: input.resource.locationId,
                    name: input.resource.name,
                    kind: input.resource.kind,
                    instances: input.resource.instances,
                    serviceIds: input.resource.serviceIds,
                    description: input.description?.trim() || null,
                    createdBy: ctx.member.staffId,
                    updatedBy: ctx.member.staffId,
                },
            });
            await this.audit.record(tx, ctx, { action: 'restore', entityType: 'resource', entityId: input.resource.id, businessId, before: null, after: { name: input.resource.name } });
        });
        return this.get(businessId, input.resource.id);
    }
    // ─────────── экземпляры (F-16-004…007) ───────────
    async addInstance(businessId, id, name) {
        const resource = await this.prisma.resource.findFirst({ where: { id, businessId } });
        if (!resource)
            throw new ApiError('not_found', 'Resource not found');
        const instances = Array.isArray(resource.instances) ? resource.instances : [];
        const n = instances.length + 1;
        const next = [...instances, { id: newId('resourceInstance'), name: name.trim() || String(n) }];
        await this.prisma.resource.update({ where: { id }, data: { instances: next, version: { increment: 1 } } });
        return this.get(businessId, id);
    }
    async renameInstance(businessId, id, instanceId, name) {
        const resource = await this.prisma.resource.findFirst({ where: { id, businessId } });
        if (!resource)
            throw new ApiError('not_found', 'Resource not found');
        const instances = Array.isArray(resource.instances) ? resource.instances : [];
        const next = instances.map((i) => (i.id === instanceId ? { ...i, name: name.trim() || i.name } : i));
        await this.prisma.resource.update({ where: { id }, data: { instances: next, version: { increment: 1 } } });
        return this.get(businessId, id);
    }
    async removeInstance(businessId, id, instanceId) {
        const resource = await this.prisma.resource.findFirst({ where: { id, businessId } });
        if (!resource)
            throw new ApiError('not_found', 'Resource not found');
        const instances = Array.isArray(resource.instances) ? resource.instances : [];
        if (instances.length <= 1)
            throw new ApiError('last_instance', 'Cannot remove the last instance');
        const next = instances.filter((i) => i.id !== instanceId);
        await this.prisma.resource.update({ where: { id }, data: { instances: next, version: { increment: 1 } } });
        return this.get(businessId, id);
    }
    // ─────────── привязка ресурс ↔ услуга (F-16-006/007) ───────────
    async setServices(businessId, id, serviceIds) {
        const resource = await this.prisma.resource.findFirst({ where: { id, businessId } });
        if (!resource)
            throw new ApiError('not_found', 'Resource not found');
        await this.prisma.resource.update({ where: { id }, data: { serviceIds, version: { increment: 1 } } });
        return this.get(businessId, id);
    }
    async listForService(businessId, serviceId) {
        const rows = await this.prisma.resource.findMany({ where: { businessId } });
        return rows.filter((r) => (Array.isArray(r.serviceIds) ? r.serviceIds : []).includes(serviceId)).map(resourceView);
    }
    async toggleService(businessId, id, serviceId, linked) {
        const resource = await this.prisma.resource.findFirst({ where: { id, businessId } });
        if (!resource)
            throw new ApiError('not_found', 'Resource not found');
        const current = new Set(Array.isArray(resource.serviceIds) ? resource.serviceIds : []);
        if (linked)
            current.add(serviceId);
        else
            current.delete(serviceId);
        await this.prisma.resource.update({ where: { id }, data: { serviceIds: [...current], version: { increment: 1 } } });
        return this.get(businessId, id);
    }
    // ─────────── журнал изменений (F-16-171) — из общего audit_events ───────────
    async changelog(businessId) {
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
            entity: r.entityType,
            entityId: r.entityId,
            action: r.action,
            actorName: r.actorName,
            at: r.at.toISOString(),
            summary: summaryOf(diffName(r.diff), r.entityId),
        }));
    }
    // ─────────── stage 21: настройки-списки (JSON-блоб, см. пояснение выше конструктора) ───────────
    async settings(businessId) {
        const row = await this.prisma.businessSetting.findUnique({ where: { businessId_area: { businessId, area: 'resources' } } });
        return row?.data ?? {};
    }
    async patchSettings(businessId, recipe) {
        const current = await this.settings(businessId);
        recipe(current);
        await this.prisma.businessSetting.upsert({
            where: { businessId_area: { businessId, area: 'resources' } },
            create: { businessId, area: 'resources', data: current },
            update: { data: current, version: { increment: 1 } },
        });
        return current;
    }
    async getAssistantSettings(businessId) {
        return (await this.settings(businessId)).assistantSettings ?? DEFAULT_ASSISTANT_SETTINGS;
    }
    async saveAssistantSettings(businessId, patch) {
        const s = await this.patchSettings(businessId, (s) => {
            s.assistantSettings = { ...(s.assistantSettings ?? DEFAULT_ASSISTANT_SETTINGS), ...patch };
        });
        return s.assistantSettings;
    }
    async listAssistantStaff(businessId) {
        const [eligible, staff] = await Promise.all([
            this.settings(businessId).then((s) => s.staffAssistantEligible ?? {}),
            this.prisma.staff.findMany({ where: { businessId, deletedAt: null }, select: { id: true, name: true } }),
        ]);
        return staff.map((s) => ({ id: s.id, name: s.name, eligible: eligible[s.id] ?? false }));
    }
    async setStaffAssistantEligible(businessId, staffId, value) {
        await this.patchSettings(businessId, (s) => {
            s.staffAssistantEligible = { ...(s.staffAssistantEligible ?? {}), [staffId]: value };
        });
        return value;
    }
    /** F-09-044/F-16-137/139: помощник без графика, не занимает платное место подписки (см. resources.ts фронта) */
    async createAssistant(ctx, businessId, locationId, name, phone) {
        const location = await this.prisma.location.findFirst({ where: { id: locationId, businessId, deletedAt: null } });
        if (!location)
            throw new ApiError('not_found', 'Location not found');
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
                    createdBy: ctx.member.staffId,
                    updatedBy: ctx.member.staffId,
                },
            });
            await tx.staffLocation.create({ data: { staffId: id, locationId } });
        });
        await this.setStaffAssistantEligible(businessId, id, true);
        const created = await this.prisma.staff.findUniqueOrThrow({ where: { id }, include: { locations: true } });
        return staffView(created);
    }
    async getStaffResourcesRights(businessId, staffId) {
        return (await this.settings(businessId)).staffRights?.[staffId];
    }
    async setStaffResourcesRights(businessId, staffId, rights) {
        const s = await this.patchSettings(businessId, (s) => {
            s.staffRights = { ...(s.staffRights ?? {}), [staffId]: { ...(s.staffRights?.[staffId] ?? {}), ...rights } };
        });
        return s.staffRights[staffId];
    }
    async getGroupSeatsSettings(businessId) {
        return (await this.settings(businessId)).groupSeatsSettings ?? DEFAULT_GROUP_SEATS_SETTINGS;
    }
    async saveGroupSeatsSettings(businessId, patch) {
        await this.patchSettings(businessId, (s) => {
            s.groupSeatsSettings = patch;
        });
        return patch;
    }
    async listEventTemplates(businessId) {
        return (await this.settings(businessId)).eventTemplates ?? [];
    }
    async saveEventTemplate(businessId, input) {
        const template = { id: newId('recurrenceTemplate'), businessId, name: input.name.trim(), freq: input.freq, weekIntervalWeeks: input.weekIntervalWeeks };
        await this.patchSettings(businessId, (s) => {
            s.eventTemplates = [...(s.eventTemplates ?? []), template];
        });
        return template;
    }
    async listEventCategories(businessId) {
        return (await this.settings(businessId)).eventCategories ?? [];
    }
    async createEventCategory(businessId, name, colorIndex) {
        const category = { id: newId('bookingCategory'), businessId, name: name.trim(), colorIndex };
        await this.patchSettings(businessId, (s) => {
            s.eventCategories = [...(s.eventCategories ?? []), category];
        });
        return category;
    }
    async updateEventCategory(businessId, id, patch) {
        let updated;
        await this.patchSettings(businessId, (s) => {
            const list = s.eventCategories ?? [];
            const found = list.find((c) => c.id === id);
            if (!found)
                throw new ApiError('not_found', 'Category not found');
            found.name = patch.name.trim();
            found.colorIndex = patch.colorIndex;
            updated = found;
            s.eventCategories = list;
        });
        return updated;
    }
    async deleteEventCategory(businessId, id) {
        await this.patchSettings(businessId, (s) => {
            s.eventCategories = (s.eventCategories ?? []).filter((c) => c.id !== id);
        });
    }
    async getGroupServicePayment(businessId, serviceId) {
        return (await this.settings(businessId)).groupServicePayment?.[serviceId] ?? defaultGroupServicePayment(serviceId);
    }
    async setGroupServicePayment(businessId, serviceId, patch) {
        const s = await this.patchSettings(businessId, (s) => {
            const current = s.groupServicePayment?.[serviceId] ?? defaultGroupServicePayment(serviceId);
            s.groupServicePayment = { ...(s.groupServicePayment ?? {}), [serviceId]: { ...current, ...patch } };
        });
        return s.groupServicePayment[serviceId];
    }
    /** Пояс первой локации бизнеса (упрощение как GroupEventsService.tzOfBusiness — resources.ts фронта тоже
     * не спрашивает locationId у pickFreeResourceInstances/listResourceOptions, PLAN §4.1 «по умолчанию Asia/Yerevan») */
    async tzOfBusiness(businessId) {
        const loc = await this.prisma.location.findFirst({ where: { businessId, deletedAt: null }, select: { tz: true } });
        return loc?.tz ?? 'Asia/Yerevan';
    }
    // ─────────── stage 21: подбор свободного экземпляра ресурса (F-16-011…013) — из resource_busy, не из мока ───────────
    // Сервер уже держит настоящую занятость по экземпляру в resource_busy (occupy.ts, этап 6/7): своя копия
    // instanceBusy/pickFreeInstances мока здесь не нужна — считаем напрямую по таблице, это и точнее (живые
    // данные), и проще (никакого «собери занятость записей+событий вручную», как в src/domain/resources.ts).
    async instancesBusyMap(businessId, resourceIds, start, end, excludeBookingId) {
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
        const byResource = new Map();
        for (const r of rows) {
            const e = byResource.get(r.resourceId) ?? { pinned: new Set(), loose: 0 };
            if (r.instanceId)
                e.pinned.add(r.instanceId);
            else
                e.loose += 1;
            byResource.set(r.resourceId, e);
        }
        const busyByResource = new Map();
        const resources = await this.prisma.resource.findMany({ where: { id: { in: resourceIds } }, select: { id: true, instances: true } });
        for (const res of resources) {
            const instances = arr(res.instances).map((i) => i.id);
            const e = byResource.get(res.id) ?? { pinned: new Set(), loose: 0 };
            const busy = new Set(e.pinned);
            // Занятость без привязки к конкретному экземпляру («любой свободный») — считаем занятыми первые
            // непомеченные экземпляры по счётчику, чтобы никогда не занизить фактическую загрузку ресурса.
            let remaining = e.loose;
            for (const id of instances) {
                if (remaining <= 0)
                    break;
                if (busy.has(id))
                    continue;
                busy.add(id);
                remaining -= 1;
            }
            busyByResource.set(res.id, busy);
        }
        return busyByResource;
    }
    /** F-16-011/012: по одному свободному экземпляру каждого ресурса услуги; чего-то не хватает — undefined */
    async pickFreeInstances(businessId, serviceIds, start, durationMin, excludeBookingId) {
        const resources = await this.prisma.resource.findMany({ where: { businessId, active: true, deletedAt: null } });
        const relevant = resources.filter((r) => arr(r.serviceIds).some((id) => serviceIds.includes(id)));
        if (!relevant.length)
            return [];
        const end = new Date(start.getTime() + durationMin * 60_000);
        const busyByResource = await this.instancesBusyMap(businessId, relevant.map((r) => r.id), start, end, excludeBookingId);
        const picked = [];
        for (const r of relevant) {
            const instances = arr(r.instances).map((i) => i.id);
            const free = instances.find((id) => !busyByResource.get(r.id)?.has(id));
            if (!free)
                return undefined;
            picked.push(free);
        }
        return picked;
    }
    /** F-16-013: экземпляры, выбранные вручную, все ещё свободны? Экземпляр может принадлежать любому активному
     * ресурсу бизнеса — считаем занятость по всем сразу, id экземпляра уникален в пределах бизнеса. */
    async checkInstancesFree(businessId, instanceIds, start, durationMin, excludeBookingId) {
        if (!instanceIds.length)
            return true;
        const end = new Date(start.getTime() + durationMin * 60_000);
        const all = await this.prisma.resource.findMany({ where: { businessId, active: true, deletedAt: null }, select: { id: true } });
        const busyByResource = await this.instancesBusyMap(businessId, all.map((r) => r.id), start, end, excludeBookingId);
        const busy = new Set();
        for (const set of busyByResource.values())
            for (const id of set)
                busy.add(id);
        return instanceIds.every((id) => !busy.has(id));
    }
    /** F-16-013: все активные ресурсы локации с отметкой занятых сейчас экземпляров (окно записи) */
    async listResourceOptions(businessId, start, durationMin, excludeBookingId) {
        const resources = await this.prisma.resource.findMany({ where: { businessId, active: true, deletedAt: null } });
        const end = new Date(start.getTime() + durationMin * 60_000);
        const busyByResource = await this.instancesBusyMap(businessId, resources.map((r) => r.id), start, end, excludeBookingId);
        return resources.map((r) => ({
            resource: resourceView(r),
            instances: arr(r.instances).map((i) => ({ id: i.id, name: i.name, busy: busyByResource.get(r.id)?.has(i.id) ?? false })),
        }));
    }
};
ResourcesService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [PrismaService,
        AuditService])
], ResourcesService);
export { ResourcesService };
function diffName(diff) {
    const d = diff;
    const name = d?.name?.[1] ?? d?.name?.[0];
    return name;
}
//# sourceMappingURL=resources.service.js.map