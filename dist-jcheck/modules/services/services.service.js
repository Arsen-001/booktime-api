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
import { updateVersioned } from '../../common/http/version.js';
import { newId } from '../../common/ids/ids.js';
import { money, moneyToJson } from '../../common/money/money.js';
import { PrismaService } from '../../common/prisma.service.js';
import { loadPrices } from '../billing/billing-prices.js';
import { staffView } from '../businesses/views.js';
import { categoryOnlineNameView, categoryView, defaultPackageExtra, packageWithExtraView, serviceExtraView, serviceView } from './services.views.js';
/** Мест на мастера в подписке — сверх этого нужно покупать (F-00-085); сама цена — в platform_prices (photoSlotCoins) */
const PHOTO_BASE_SLOTS = 6;
/** Готовые метки материалов (F-00-089) — как MATERIAL_TAG_IDS фронта (src/domain/services.ts) */
const MATERIAL_TAG_IDS = ['hypoallergenic', 'vegan', 'unscented', 'premiumBrand', 'organic'];
const J = (v) => (v === undefined || v === null ? Prisma.DbNull : v);
/** null — «общая настройка» (shared), 0 — без перерыва (F-02-060), N — своя длительность */
function techBreakToBuffer(mode, min) {
    if (mode === 'shared')
        return null;
    if (mode === 'none')
        return 0;
    return min ?? 15;
}
let ServicesService = class ServicesService {
    constructor(prisma, audit) {
        this.prisma = prisma;
        this.audit = audit;
    }
    // ─────────── категории ───────────
    async listCategories(businessId) {
        const rows = await this.prisma.serviceCategory.findMany({ where: { businessId }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
        return rows.map(categoryView);
    }
    async getCategory(businessId, id) {
        const row = await this.prisma.serviceCategory.findFirst({ where: { id, businessId } });
        if (!row)
            throw new ApiError('not_found', 'Category not found');
        return categoryView(row);
    }
    async createCategory(ctx, businessId, input) {
        if (!input.name.ru?.trim())
            throw new ApiError('bad_name', 'Name required');
        const id = newId('serviceCategory');
        await this.prisma.$transaction(async (tx) => {
            const count = await tx.serviceCategory.count({ where: { businessId } });
            await tx.serviceCategory.create({
                data: {
                    id,
                    businessId,
                    name: input.name,
                    onlineNameEnabled: input.onlineNameEnabled,
                    onlineName: J(input.onlineName),
                    sortOrder: count,
                    createdBy: ctx.member.staffId,
                    updatedBy: ctx.member.staffId,
                },
            });
            await this.audit.record(tx, ctx, { action: 'create', entityType: 'serviceCategory', entityId: id, businessId, after: { name: input.name } });
        });
        return this.getCategory(businessId, id);
    }
    async updateCategory(ctx, businessId, id, input) {
        const before = await this.prisma.serviceCategory.findFirst({ where: { id, businessId } });
        if (!before)
            throw new ApiError('not_found', 'Category not found');
        if (!input.name.ru?.trim())
            throw new ApiError('bad_name', 'Name required');
        await this.prisma.$transaction(async (tx) => {
            await tx.serviceCategory.update({
                where: { id },
                data: {
                    name: input.name,
                    onlineNameEnabled: input.onlineNameEnabled,
                    onlineName: J(input.onlineName),
                    updatedBy: ctx.member.staffId,
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
    async categoryOnlineName(businessId, id) {
        const row = await this.prisma.serviceCategory.findFirst({ where: { id, businessId } });
        if (!row)
            throw new ApiError('not_found', 'Category not found');
        return categoryOnlineNameView(row);
    }
    async categoryDeleteImpact(businessId, id) {
        const serviceCount = await this.prisma.service.count({ where: { businessId, categoryId: id } });
        return { serviceCount };
    }
    /** Как в моке: удаляет сразу, без проверки — услуги категории остаются с «висячим» categoryId (F-16-171) */
    async deleteCategory(ctx, businessId, id) {
        const row = await this.prisma.serviceCategory.findFirst({ where: { id, businessId } });
        if (!row)
            throw new ApiError('not_found', 'Category not found');
        await this.prisma.$transaction(async (tx) => {
            await tx.serviceCategory.delete({ where: { id } });
            await this.audit.record(tx, ctx, { action: 'delete', entityType: 'serviceCategory', entityId: id, businessId, before: { name: row.name } });
        });
    }
    // ─────────── услуги ───────────
    async listServices(businessId, kind) {
        const rows = await this.prisma.service.findMany({
            where: { businessId, kind: kind ?? undefined, servicePackage: { equals: Prisma.DbNull } },
            orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
        });
        return rows.map(serviceView);
    }
    async listServiceRows(businessId) {
        const rows = await this.prisma.service.findMany({ where: { businessId, servicePackage: { equals: Prisma.DbNull } }, orderBy: [{ order: 'asc' }, { createdAt: 'asc' }] });
        const terms = await this.prisma.staffServiceTerm.findMany({ where: { serviceId: { in: rows.map((r) => r.id) } } });
        return rows.map((s) => ({
            service: serviceView(s),
            extra: serviceExtraView(s),
            staffTerms: terms.filter((t) => t.serviceId === s.id).map((t) => ({ serviceId: t.serviceId, staffId: t.staffId, price: opt(t.price), durationMin: opt(t.durationMin) })),
        }));
    }
    async getService(businessId, id) {
        const row = await this.prisma.service.findFirst({ where: { id, businessId } });
        if (!row)
            throw new ApiError('not_found', 'Service not found');
        return serviceView(row);
    }
    async nextOrder(businessId) {
        return this.prisma.service.count({ where: { businessId, servicePackage: { equals: Prisma.DbNull } } });
    }
    async createService(ctx, businessId, input) {
        if (!input.name.ru?.trim())
            throw new ApiError('bad_name', 'Name required');
        const category = await this.prisma.serviceCategory.findFirst({ where: { id: input.categoryId, businessId } });
        if (!category)
            throw new ApiError('not_found', 'Category not found');
        const id = newId('service');
        await this.prisma.$transaction(async (tx) => {
            const order = await this.nextOrder(businessId);
            await tx.service.create({
                data: {
                    id,
                    businessId,
                    categoryId: input.categoryId,
                    sphereId: input.sphereId,
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
                    materials: [],
                    staffIds: [],
                    workplaces: [],
                    onlineBookable: input.onlineBookable,
                    active: true,
                    order,
                    shadeChoice: input.shadeChoice ?? null,
                    createdBy: ctx.member.staffId,
                    updatedBy: ctx.member.staffId,
                },
            });
            await this.audit.record(tx, ctx, { action: 'create', entityType: 'service', entityId: id, businessId, after: { name: input.name, priceMin: input.priceMin } });
        });
        return this.getService(businessId, id);
    }
    async updateService(ctx, businessId, id, input, version) {
        const before = await this.prisma.service.findFirst({ where: { id, businessId } });
        if (!before)
            throw new ApiError('not_found', 'Service not found');
        if (!input.name.ru?.trim())
            throw new ApiError('bad_name', 'Name required');
        if (input.categoryId !== before.categoryId && !(await this.prisma.serviceCategory.findFirst({ where: { id: input.categoryId, businessId } }))) {
            throw new ApiError('not_found', 'Category not found');
        }
        const data = {
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
            updatedBy: ctx.member.staffId,
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
    async setActive(ctx, businessId, id, active) {
        const row = await this.prisma.service.findFirst({ where: { id, businessId } });
        if (!row)
            throw new ApiError('not_found', 'Service not found');
        await this.prisma.$transaction(async (tx) => {
            await tx.service.update({ where: { id }, data: { active, updatedBy: ctx.member.staffId, version: { increment: 1 } } });
            await this.audit.record(tx, ctx, { action: active ? 'activated' : 'deactivated', entityType: 'service', entityId: id, businessId, before: null, after: null });
        });
        return this.getService(businessId, id);
    }
    async reorder(businessId, ids) {
        await this.prisma.$transaction(ids.map((id, order) => this.prisma.service.updateMany({ where: { id, businessId }, data: { order } })));
    }
    async setTechBreak(ctx, businessId, id, mode, min) {
        const row = await this.prisma.service.findFirst({ where: { id, businessId } });
        if (!row)
            throw new ApiError('not_found', 'Service not found');
        await this.prisma.$transaction(async (tx) => {
            await tx.service.update({ where: { id }, data: { bufferAfterMin: techBreakToBuffer(mode, min), updatedBy: ctx.member.staffId, version: { increment: 1 } } });
            await this.audit.record(tx, ctx, { action: 'techBreakChanged', entityType: 'service', entityId: id, businessId, before: null, after: null });
        });
        return this.getService(businessId, id);
    }
    async techBreakExportRows(businessId) {
        const rows = await this.prisma.service.findMany({ where: { businessId, servicePackage: { equals: Prisma.DbNull } }, orderBy: [{ order: 'asc' }] });
        return rows.map((s) => ({
            id: s.id,
            name: s.name.ru ?? '',
            seconds: s.bufferAfterMin == null ? 'Default' : s.bufferAfterMin * 60,
        }));
    }
    parseTechBreakSeconds(raw) {
        const value = raw.trim();
        if (!value)
            return undefined;
        if (/^default$/i.test(value))
            return { mode: 'shared' };
        if (!/^\d+$/.test(value))
            return undefined;
        const seconds = Number(value);
        if (seconds === 0)
            return { mode: 'none' };
        if (seconds % 300 !== 0 || seconds > 3600)
            return undefined;
        return { mode: 'custom', min: seconds / 60 };
    }
    async importTechBreaks(ctx, businessId, rows) {
        const failed = [];
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
            if (applied)
                await this.audit.record(tx, ctx, { action: 'import', entityType: 'service', entityId: businessId, businessId, before: null, after: { applied, failed: failed.length } });
        });
        return { applied, failed };
    }
    async deleteImpact(businessId, id) {
        const service = await this.prisma.service.findFirst({ where: { id, businessId } });
        const staffCount = service && Array.isArray(service.staffIds) ? service.staffIds.length : 0;
        const pkgs = await this.prisma.service.findMany({ where: { businessId, NOT: { servicePackage: { equals: Prisma.DbNull } } }, select: { servicePackage: true } });
        const packagesUsing = pkgs.filter((p) => (p.servicePackage?.items ?? []).some((it) => it.serviceId === id)).length;
        // Будущие записи и групповые события с этой услугой (этап 7): активные, не удалённые, начало впереди
        const now = new Date();
        const future = await this.prisma.booking.findMany({
            where: { businessId, deletedAt: null, startAt: { gt: now }, status: { notIn: ['cancelled_by_client', 'cancelled_by_master'] } },
            select: { services: true },
        });
        const futureBookings = future.filter((b) => (b.services ?? []).some((l) => l.serviceId === id)).length;
        const futureEvents = await this.prisma.groupEvent.count({ where: { businessId, serviceId: id, status: 'scheduled', startAt: { gt: now } } });
        return { staffCount, futureBookings, futureEvents, packagesUsing };
    }
    /** Удаляет сразу (F-16-170); «Отменить» — экран хранит снимок и зовёт restoreService в те же 5 с */
    async deleteService(ctx, businessId, id) {
        const service = await this.prisma.service.findFirst({ where: { id, businessId } });
        if (!service)
            throw new ApiError('not_found', 'Service not found');
        const view = serviceView(service);
        await this.prisma.$transaction(async (tx) => {
            // Снять услугу у мастеров, которые её делают, и удалить сроки (staff_service_terms) — как в моке
            const staffIds = Array.isArray(service.staffIds) ? service.staffIds : [];
            for (const staffId of staffIds) {
                const staff = await tx.staff.findUnique({ where: { id: staffId }, select: { serviceIds: true } });
                if (staff) {
                    const ids = (Array.isArray(staff.serviceIds) ? staff.serviceIds : []).filter((x) => x !== id);
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
    async restoreService(ctx, businessId, input) {
        const exists = await this.prisma.service.findUnique({ where: { id: input.id } });
        if (exists)
            throw new ApiError('conflict', 'Already exists');
        // Категория могла исчезнуть за 5 с окна «Отменить» — снимаем её, а не падаем на внешнем ключе (F-16-171)
        const category = await this.prisma.serviceCategory.findFirst({ where: { id: input.categoryId, businessId } });
        const rec = input;
        await this.prisma.$transaction(async (tx) => {
            await tx.service.create({
                data: {
                    id: input.id,
                    businessId,
                    categoryId: category ? input.categoryId : null,
                    sphereId: input.sphereId,
                    name: input.name,
                    description: J(rec.description),
                    kind: input.kind,
                    capacity: typeof rec.capacity === 'number' ? rec.capacity : null,
                    durationMin: input.durationMin,
                    durationMax: typeof rec.durationMax === 'number' ? rec.durationMax : null,
                    priceMin: money(input.priceMin),
                    priceMax: typeof rec.priceMax === 'number' ? money(rec.priceMax) : null,
                    bufferAfterMin: typeof rec.bufferAfterMin === 'number' ? rec.bufferAfterMin : null,
                    repeatIntervalDays: typeof rec.repeatIntervalDays === 'number' ? rec.repeatIntervalDays : null,
                    photos: Array.isArray(rec.photos) ? rec.photos : [],
                    materials: Array.isArray(rec.materials) ? rec.materials : [],
                    staffIds: Array.isArray(rec.staffIds) ? rec.staffIds : [],
                    workplaces: Array.isArray(rec.workplaces) ? rec.workplaces : [],
                    onlineBookable: rec.onlineBookable !== false,
                    active: rec.active !== false,
                    order: typeof rec.order === 'number' ? Math.trunc(rec.order) : await this.nextOrder(businessId),
                    shadeChoice: typeof rec.shadeChoice === 'string' ? rec.shadeChoice : null,
                    servicePackage: J(rec.servicePackage),
                    packageExtra: J(rec.packageExtra),
                    createdBy: ctx.member.staffId,
                    updatedBy: ctx.member.staffId,
                },
            });
            await this.audit.record(tx, ctx, { action: 'restore', entityType: 'service', entityId: input.id, businessId, before: null, after: { name: input.name } });
        });
        return this.getService(businessId, input.id);
    }
    // ─────────── мастера услуги (F-10-156, F-02-058, F-16-030) ───────────
    async listServiceStaff(businessId, serviceId) {
        const service = await this.prisma.service.findFirst({ where: { id: serviceId, businessId } });
        if (!service)
            throw new ApiError('not_found', 'Service not found');
        const staffIds = Array.isArray(service.staffIds) ? service.staffIds : [];
        if (!staffIds.length)
            return [];
        const [staff, terms] = await Promise.all([
            this.prisma.staff.findMany({ where: { id: { in: staffIds }, businessId }, include: { locations: { select: { locationId: true } } } }),
            this.prisma.staffServiceTerm.findMany({ where: { serviceId, staffId: { in: staffIds } } }),
        ]);
        return staff.map((s) => ({ staff: staffView(s), term: termView(terms.find((t) => t.staffId === s.id)) }));
    }
    async assignStaffToService(ctx, businessId, serviceId, staffId) {
        const [service, staff] = await Promise.all([
            this.prisma.service.findFirst({ where: { id: serviceId, businessId } }),
            this.prisma.staff.findFirst({ where: { id: staffId, businessId } }),
        ]);
        if (!service)
            throw new ApiError('not_found', 'Service not found');
        if (!staff)
            throw new ApiError('not_found', 'Staff not found');
        await this.prisma.$transaction(async (tx) => {
            const serviceStaffIds = new Set(Array.isArray(service.staffIds) ? service.staffIds : []);
            if (!serviceStaffIds.has(staffId)) {
                serviceStaffIds.add(staffId);
                await tx.service.update({ where: { id: serviceId }, data: { staffIds: [...serviceStaffIds] } });
            }
            const staffServiceIds = new Set(Array.isArray(staff.serviceIds) ? staff.serviceIds : []);
            if (!staffServiceIds.has(serviceId)) {
                staffServiceIds.add(serviceId);
                await tx.staff.update({ where: { id: staffId }, data: { serviceIds: [...staffServiceIds] } });
            }
            await this.audit.record(tx, ctx, { action: 'staffAssigned', entityType: 'service', entityId: serviceId, businessId, before: null, after: { staffId } });
        });
    }
    async removeStaffFromService(ctx, businessId, serviceId, staffId) {
        const [service, staff] = await Promise.all([
            this.prisma.service.findFirst({ where: { id: serviceId, businessId } }),
            this.prisma.staff.findFirst({ where: { id: staffId, businessId } }),
        ]);
        if (!service)
            throw new ApiError('not_found', 'Service not found');
        if (!staff)
            throw new ApiError('not_found', 'Staff not found');
        await this.prisma.$transaction(async (tx) => {
            await tx.service.update({ where: { id: serviceId }, data: { staffIds: (Array.isArray(service.staffIds) ? service.staffIds : []).filter((x) => x !== staffId) } });
            await tx.staff.update({ where: { id: staffId }, data: { serviceIds: (Array.isArray(staff.serviceIds) ? staff.serviceIds : []).filter((x) => x !== serviceId) } });
            await tx.staffServiceTerm.deleteMany({ where: { serviceId, staffId } });
            await this.audit.record(tx, ctx, { action: 'staffRemoved', entityType: 'service', entityId: serviceId, businessId, before: null, after: { staffId } });
        });
    }
    async setStaffServiceTerm(businessId, serviceId, staffId, price, durationMin) {
        const service = await this.prisma.service.findFirst({ where: { id: serviceId, businessId } });
        if (!service)
            throw new ApiError('not_found', 'Service not found');
        const row = await this.prisma.staffServiceTerm.upsert({
            where: { staffId_serviceId: { staffId, serviceId } },
            create: { staffId, serviceId, price: price !== undefined ? money(price) : null, durationMin: durationMin ?? null },
            update: { price: price !== undefined ? money(price) : null, durationMin: durationMin ?? null },
        });
        return termView(row);
    }
    async getStaffServiceTerms(businessId, serviceId, staffId) {
        const service = await this.prisma.service.findFirst({ where: { id: serviceId, businessId } });
        if (!service)
            throw new ApiError('not_found', 'Service not found');
        const term = await this.prisma.staffServiceTerm.findUnique({ where: { staffId_serviceId: { staffId, serviceId } } });
        return {
            price: term?.price !== undefined && term?.price !== null ? moneyToJson(term.price) : moneyToJson(service.priceMin),
            priceMax: service.priceMax != null ? moneyToJson(service.priceMax) : undefined,
            durationMin: term?.durationMin ?? service.durationMin,
            durationMax: opt(service.durationMax),
        };
    }
    async listStaffServices(businessId, staffId) {
        const staff = await this.prisma.staff.findFirst({ where: { id: staffId, businessId } });
        const staffServiceIds = new Set(staff && Array.isArray(staff.serviceIds) ? staff.serviceIds : []);
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
    async listAssignableStaff(businessId, serviceId) {
        const service = await this.prisma.service.findFirst({ where: { id: serviceId, businessId } });
        const staffIds = new Set(service && Array.isArray(service.staffIds) ? service.staffIds : []);
        const staff = await this.prisma.staff.findMany({ where: { businessId, status: { not: 'fired' }, deletedAt: null }, include: { locations: { select: { locationId: true } } } });
        return staff.filter((s) => !staffIds.has(s.id)).map(staffView);
    }
    async listAssignableServices(businessId, staffId) {
        const staff = await this.prisma.staff.findFirst({ where: { id: staffId, businessId } });
        const serviceIds = new Set(staff && Array.isArray(staff.serviceIds) ? staff.serviceIds : []);
        const rows = await this.prisma.service.findMany({ where: { businessId, servicePackage: { equals: Prisma.DbNull } } });
        return rows.filter((s) => !serviceIds.has(s.id)).map(serviceView);
    }
    // ─────────── языки, чек, выбор при записи (F-03-115, F-15-141, F-07-149, F-00-094) ───────────
    async getServiceExtra(businessId, id) {
        const row = await this.prisma.service.findFirst({ where: { id, businessId } });
        if (!row)
            throw new ApiError('not_found', 'Service not found');
        return serviceExtraView(row);
    }
    async updateServiceExtra(businessId, id, patch) {
        const row = await this.prisma.service.findFirst({ where: { id, businessId } });
        if (!row)
            throw new ApiError('not_found', 'Service not found');
        const merged = { ...serviceExtraView(row), ...patch };
        await this.prisma.service.update({ where: { id }, data: { extra: merged } });
        return merged;
    }
    async getReceiptName(businessId, id) {
        const row = await this.prisma.service.findFirst({ where: { id, businessId } });
        if (!row)
            throw new ApiError('not_found', 'Service not found');
        const extra = serviceExtraView(row);
        return extra.receipt?.receiptName;
    }
    async getServiceTranslations(businessId, id) {
        const row = await this.prisma.service.findFirst({ where: { id, businessId } });
        if (!row)
            throw new ApiError('not_found', 'Service not found');
        return row.name;
    }
    // ─────────── пакеты «Комплекс» (F-16-107…135) ───────────
    async listPackages(businessId) {
        const rows = await this.prisma.service.findMany({ where: { businessId, NOT: { servicePackage: { equals: Prisma.DbNull } } }, orderBy: [{ createdAt: 'desc' }] });
        return rows.map(packageWithExtraView);
    }
    async getPackage(businessId, id) {
        const row = await this.prisma.service.findFirst({ where: { id, businessId, NOT: { servicePackage: { equals: Prisma.DbNull } } } });
        if (!row)
            throw new ApiError('not_found', 'Package not found');
        return packageWithExtraView(row);
    }
    async createPackage(ctx, businessId, input) {
        if (!input.name.ru?.trim())
            throw new ApiError('bad_name', 'Name required');
        const category = await this.prisma.serviceCategory.findFirst({ where: { id: input.categoryId, businessId } });
        if (!category)
            throw new ApiError('not_found', 'Category not found');
        const id = newId('service');
        const servicePackage = { items: [], mode: 'sequentialAny' };
        await this.prisma.$transaction(async (tx) => {
            await tx.service.create({
                data: {
                    id,
                    businessId,
                    categoryId: input.categoryId,
                    sphereId: input.sphereId,
                    name: input.name,
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
                    servicePackage: servicePackage,
                    packageExtra: defaultPackageExtra(id),
                    createdBy: ctx.member.staffId,
                    updatedBy: ctx.member.staffId,
                },
            });
            await this.audit.record(tx, ctx, { action: 'create', entityType: 'package', entityId: id, businessId, after: { name: input.name } });
        });
        return this.getPackage(businessId, id);
    }
    async savePackage(ctx, businessId, id, patch) {
        const current = await this.prisma.service.findFirst({ where: { id, businessId, NOT: { servicePackage: { equals: Prisma.DbNull } } } });
        if (!current)
            throw new ApiError('not_found', 'Package not found');
        if (patch.categoryId && !(await this.prisma.serviceCategory.findFirst({ where: { id: patch.categoryId, businessId } }))) {
            throw new ApiError('not_found', 'Category not found');
        }
        const data = {};
        if (patch.name)
            data.name = patch.name;
        if (patch.categoryId)
            data.categoryId = patch.categoryId;
        if (patch.onlineBookable !== undefined)
            data.onlineBookable = patch.onlineBookable;
        if (patch.description !== undefined)
            data.description = J(patch.description);
        if (patch.photos)
            data.photos = patch.photos;
        if (patch.items || patch.mode) {
            const current_pkg = current.servicePackage;
            data.servicePackage = { items: patch.items ?? current_pkg.items, mode: patch.mode ?? current_pkg.mode };
        }
        if (patch.extra) {
            const merged = { ...defaultPackageExtra(id), ...current.packageExtra, ...patch.extra };
            data.packageExtra = merged;
        }
        if (Object.keys(data).length) {
            await this.prisma.$transaction(async (tx) => {
                await tx.service.update({ where: { id }, data: { ...data, version: { increment: 1 } } });
                await this.audit.record(tx, ctx, { action: 'update', entityType: 'package', entityId: id, businessId, before: null, after: { name: patch.name } });
            });
        }
        return this.getPackage(businessId, id);
    }
    /** Будущие записи с этим пакетом (этап 7): строка услуги записи ссылается на пакет */
    async countFuturePackageBookings(businessId, serviceId) {
        const future = await this.prisma.booking.findMany({
            where: { businessId, deletedAt: null, startAt: { gt: new Date() }, status: { notIn: ['cancelled_by_client', 'cancelled_by_master'] } },
            select: { services: true },
        });
        return future.filter((b) => (b.services ?? []).some((l) => l.serviceId === serviceId)).length;
    }
    async deletePackage(ctx, businessId, id) {
        const row = await this.prisma.service.findFirst({ where: { id, businessId, NOT: { servicePackage: { equals: Prisma.DbNull } } } });
        if (!row)
            throw new ApiError('not_found', 'Package not found');
        await this.prisma.$transaction(async (tx) => {
            await tx.service.delete({ where: { id } });
            await this.audit.record(tx, ctx, { action: 'delete', entityType: 'package', entityId: id, businessId, before: { name: row.name }, after: null });
        });
    }
    // ─────────── стадия 21 (лейн services+rest): порядок категорий (У25) ───────────
    async reorderCategories(businessId, ids) {
        await this.prisma.$transaction(ids.map((id, order) => this.prisma.serviceCategory.updateMany({ where: { id, businessId }, data: { sortOrder: order } })));
    }
    // ─────────── фото работ мастера: свободные места (F-00-085/086), привязка фото→услуга ───────────
    async photoExtraSlots(businessId, staffId) {
        const row = await this.prisma.businessSetting.findUnique({ where: { businessId_area: { businessId, area: 'services.photoSlots' } } });
        const data = (row?.data ?? {});
        return data[staffId] ?? 0;
    }
    async getPhotoSlots(businessId, staffId) {
        const staff = await this.prisma.staff.findFirst({ where: { id: staffId, businessId } });
        if (!staff)
            throw new ApiError('staff_not_found', 'Staff not found');
        const extra = await this.photoExtraSlots(businessId, staffId);
        const { photoSlotCoins } = await loadPrices(this.prisma);
        const used = Array.isArray(staff.photos) ? staff.photos.length : 0;
        return { used, base: PHOTO_BASE_SLOTS, extra, total: PHOTO_BASE_SLOTS + extra, priceCoins: photoSlotCoins };
    }
    async getPhotoLinks(businessId, urls) {
        const row = await this.prisma.businessSetting.findUnique({ where: { businessId_area: { businessId, area: 'services.photoLinks' } } });
        const links = (row?.data ?? {});
        return Object.fromEntries(urls.map((u) => [u, links[u]]));
    }
    /** «Сохранить» на экране фото работ (У3): снимки и их привязка к услугам одной операцией (F-00-085) */
    async savePhotoProfile(ctx, businessId, staffId, photos, links) {
        const staff = await this.prisma.staff.findFirst({ where: { id: staffId, businessId } });
        if (!staff)
            throw new ApiError('staff_not_found', 'Staff not found');
        const extra = await this.photoExtraSlots(businessId, staffId);
        if (photos.length > PHOTO_BASE_SLOTS + extra)
            throw new ApiError('validation', 'Нет свободных мест');
        const before = Array.isArray(staff.photos) ? staff.photos : [];
        const updated = await this.prisma.$transaction(async (tx) => {
            const row = await tx.staff.update({
                where: { id: staffId },
                data: { photos, version: { increment: 1 }, updatedBy: ctx.member.staffId },
                include: { locations: { select: { locationId: true } } },
            });
            const linksRow = await tx.businessSetting.findUnique({ where: { businessId_area: { businessId, area: 'services.photoLinks' } } });
            const allLinks = { ...(linksRow?.data ?? {}) };
            before.filter((u) => !photos.includes(u)).forEach((u) => delete allLinks[u]);
            photos.forEach((u) => {
                if (links[u])
                    allLinks[u] = links[u];
                else
                    delete allLinks[u];
            });
            await tx.businessSetting.upsert({
                where: { businessId_area: { businessId, area: 'services.photoLinks' } },
                create: { businessId, area: 'services.photoLinks', data: allLinks, updatedBy: ctx.member.staffId },
                update: { data: allLinks, updatedBy: ctx.member.staffId, version: { increment: 1 } },
            });
            await this.audit.record(tx, ctx, {
                action: 'staffPhotosChanged',
                entityType: 'staff',
                entityId: staffId,
                businessId,
                before: { count: before.length },
                after: { count: photos.length },
            });
            return row;
        });
        return staffView(updated);
    }
    // ─────────── дипломы и сертификаты — проверяем мы (F-00-088); хранение — business_settings 'services.documents' ───────────
    async documentsOf(businessId, tx = this.prisma) {
        const row = await tx.businessSetting.findUnique({ where: { businessId_area: { businessId, area: 'services.documents' } } });
        return (row?.data ?? []);
    }
    async saveDocuments(tx, businessId, docs, updatedBy) {
        await tx.businessSetting.upsert({
            where: { businessId_area: { businessId, area: 'services.documents' } },
            create: { businessId, area: 'services.documents', data: docs, updatedBy },
            update: { data: docs, updatedBy, version: { increment: 1 } },
        });
    }
    async listStaffDocuments(businessId, staffId) {
        const docs = await this.documentsOf(businessId);
        return docs.filter((d) => d.staffId === staffId).sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
    }
    async addStaffDocument(ctx, businessId, staffId, imageUrl, fileName, moderationId) {
        const staff = await this.prisma.staff.findFirst({ where: { id: staffId, businessId } });
        if (!staff)
            throw new ApiError('staff_not_found', 'Staff not found');
        const doc = { id: newId('staffDocument'), staffId, businessId, imageUrl, fileName, uploadedAt: new Date().toISOString(), moderationId };
        await this.prisma.$transaction(async (tx) => {
            const docs = await this.documentsOf(businessId, tx);
            docs.unshift(doc);
            await this.saveDocuments(tx, businessId, docs, ctx.member.staffId);
            await this.audit.record(tx, ctx, { action: 'documentAdded', entityType: 'staff', entityId: staffId, businessId, before: null, after: { fileName } });
        });
        return doc;
    }
    async removeStaffDocument(ctx, businessId, id) {
        await this.prisma.$transaction(async (tx) => {
            const docs = (await this.documentsOf(businessId, tx)).filter((d) => d.id !== id);
            await this.saveDocuments(tx, businessId, docs, ctx.member.staffId);
        });
    }
    /** «Отменить» после удаления документа — тот же документ с тем же статусом проверки (У26) */
    async restoreStaffDocument(ctx, businessId, doc) {
        await this.prisma.$transaction(async (tx) => {
            const docs = await this.documentsOf(businessId, tx);
            if (!docs.some((d) => d.id === doc.id))
                docs.unshift(doc);
            await this.saveDocuments(tx, businessId, docs, ctx.member.staffId);
        });
    }
    // ─────────── материалы (F-00-089) и стерилизация (F-00-090) ───────────
    async getSterilization(businessId, staffId) {
        const row = await this.prisma.businessSetting.findUnique({ where: { businessId_area: { businessId, area: 'services.sterilization' } } });
        return (row?.data ?? {})[staffId];
    }
    /** «Сохранить» на экране материалов (У3): метки и стерилизация одной операцией */
    async saveMaterialsProfile(ctx, businessId, staffId, input) {
        const staff = await this.prisma.staff.findFirst({ where: { id: staffId, businessId } });
        if (!staff)
            throw new ApiError('staff_not_found', 'Staff not found');
        await this.prisma.$transaction(async (tx) => {
            await tx.staff.update({
                where: { id: staffId },
                data: { materials: [...input.materials.presetIds, ...input.materials.custom], version: { increment: 1 }, updatedBy: ctx.member.staffId },
            });
            const row = await tx.businessSetting.findUnique({ where: { businessId_area: { businessId, area: 'services.sterilization' } } });
            const all = { ...(row?.data ?? {}), [staffId]: input.sterilization };
            await tx.businessSetting.upsert({
                where: { businessId_area: { businessId, area: 'services.sterilization' } },
                create: { businessId, area: 'services.sterilization', data: all, updatedBy: ctx.member.staffId },
                update: { data: all, updatedBy: ctx.member.staffId, version: { increment: 1 } },
            });
            await this.audit.record(tx, ctx, { action: 'materialsChanged', entityType: 'staff', entityId: staffId, businessId, before: null, after: input.sterilization });
        });
    }
    /** Материалы на карточке услуги: метки мастеров услуги + товары склада «показывать клиентам» (F-00-089) */
    async getServiceMaterials(businessId, serviceId, locationIds) {
        const service = await this.prisma.service.findFirst({ where: { id: serviceId, businessId } });
        const staffIds = service && Array.isArray(service.staffIds) ? service.staffIds : [];
        const staff = staffIds.length ? await this.prisma.staff.findMany({ where: { id: { in: staffIds } } }) : [];
        const presetSet = new Set();
        const customSet = new Set();
        staff.forEach((s) => {
            (Array.isArray(s.materials) ? s.materials : []).forEach((m) => {
                if (MATERIAL_TAG_IDS.includes(m))
                    presetSet.add(m);
                else
                    customSet.add(m);
            });
        });
        const products = locationIds.length
            ? await this.prisma.product.findMany({ where: { businessId, locationId: { in: locationIds }, archived: false, showToClients: true } })
            : [];
        const stockItems = products.map((p) => ({ id: p.id, name: p.clientName?.ru || p.name, brand: opt(p.brand) }));
        return { staffLabels: [...presetSet], staffCustom: [...customSet], stockItems };
    }
    // ─────────── что есть у мастера: фото, документы, материалы (У28) ───────────
    async listStaffContentCounts(businessId) {
        const [staff, docs] = await Promise.all([
            this.prisma.staff.findMany({ where: { businessId, status: { not: 'fired' }, deletedAt: null } }),
            this.documentsOf(businessId),
        ]);
        const out = {};
        for (const s of staff) {
            out[s.id] = {
                photos: Array.isArray(s.photos) ? s.photos.length : 0,
                documents: docs.filter((d) => d.staffId === s.id).length,
                materials: Array.isArray(s.materials) ? s.materials.length : 0,
            };
        }
        return out;
    }
};
ServicesService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [PrismaService,
        AuditService])
], ServicesService);
export { ServicesService };
function opt(v) {
    return v === null || v === undefined ? undefined : v;
}
function termView(t) {
    if (!t)
        return undefined;
    return { serviceId: t.serviceId, staffId: t.staffId, price: t.price != null ? moneyToJson(t.price) : undefined, durationMin: opt(t.durationMin) };
}
//# sourceMappingURL=services.service.js.map