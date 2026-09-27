var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
import { Body, Controller, Delete, Get, Injectable, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuditService } from '../../common/audit/audit.service.js';
import { ApiError } from '../../common/errors/api-error.js';
import { Authed, Ctx } from '../../common/http/guards.js';
import { ZodBody } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { newId } from '../../common/ids/ids.js';
import { money, moneyToJson } from '../../common/money/money.js';
import { PrismaService } from '../../common/prisma.service.js';
import { NetworkAccessService } from './network-access.service.js';
import { businessIdsBody, migrateGoodsBody, networkFieldBody, networkGoodsCategoryBody, networkGoodsProductBody, networkPositionBody, networkServiceBody, networkServiceCategoryBody, } from './network.schemas.js';
const J = (v) => v;
const norm = (s) => s.trim().toLowerCase();
const nameKeyOf = (name) => norm(name?.ru ?? '');
/**
 * Сетевые каталоги (F-11-079…118, docs/backend/02 §15). Услуги и товары сети — ПО ИМЕНИ, как в моке (b03
 * domain/network.ts): группа — это несколько Service (или Product, через networkGroupId — этап 13) с одинаковым
 * именем в разных Business сети; своя строка хранит только то, чего у Service/ServiceCategory нет (подразделение,
 * запрет цены/описания). Должности — Position.networkId, уже заведён этапом 3. Поля — своя таблица NetworkField.
 * Слияние дублей (F-11-093/119), Excel/CSV, «панель расходников» — не строены (см. docs/PROGRESS.md).
 */
let NetworkCatalogService = class NetworkCatalogService {
    constructor(prisma, access, audit) {
        this.prisma = prisma;
        this.access = access;
        this.audit = audit;
    }
    // ───────────────────────── Услуги / категории (F-11-079…093) ─────────────────────────
    async listServiceCategories(ctx, networkId) {
        const { network } = await this.access.require(ctx, networkId, 'services');
        if (!network.businessIds.length)
            return [];
        const rows = await this.prisma.serviceCategory.findMany({ where: { businessId: { in: network.businessIds } } });
        const links = await this.prisma.networkServiceCategoryLink.findMany({ where: { networkId } });
        const linkByKey = new Map(links.map((l) => [l.key, l]));
        const byKey = new Map();
        for (const r of rows) {
            const key = nameKeyOf(r.name);
            if (!key)
                continue;
            const g = byKey.get(key);
            if (!g)
                byKey.set(key, { key, name: r.name, businessIds: [r.businessId] });
            else
                g.businessIds.push(r.businessId);
        }
        return [...byKey.values()].map((g) => ({ ...g, servicesCount: 0, subdivisionId: linkByKey.get(g.key)?.subdivisionId ?? undefined, onlineName: linkByKey.get(g.key)?.onlineName ?? undefined }));
    }
    async getServiceCategory(ctx, networkId, key) {
        const { network } = await this.access.require(ctx, networkId, 'services');
        const rows = await this.prisma.serviceCategory.findMany({ where: { businessId: { in: network.businessIds } } });
        const matching = rows.filter((r) => nameKeyOf(r.name) === key);
        if (!matching.length)
            throw new ApiError('not_found', 'Category not found');
        const link = await this.prisma.networkServiceCategoryLink.findUnique({ where: { networkId_key: { networkId, key } } });
        return { key, name: matching[0].name, onlineName: link?.onlineName ?? undefined, subdivisionId: link?.subdivisionId ?? undefined, businessIds: matching.map((r) => r.businessId) };
    }
    async saveServiceCategory(ctx, networkId, input) {
        const { network } = await this.access.require(ctx, networkId, 'services');
        const name = input.name.ru?.trim();
        if (!name)
            throw new ApiError('bad_name', 'Name required');
        const scope = input.businessIds.filter((id) => network.businessIds.includes(id));
        if (!scope.length)
            throw new ApiError('validation', 'no locations');
        const all = await this.prisma.serviceCategory.findMany({ where: { businessId: { in: network.businessIds } } });
        const existing = input.key ? all.filter((c) => nameKeyOf(c.name) === input.key) : [];
        const existingByBiz = new Map(existing.map((c) => [c.businessId, c]));
        let newKey = input.key ?? nameKeyOf(input.name);
        await this.prisma.$transaction(async (tx) => {
            for (const businessId of scope) {
                const found = existingByBiz.get(businessId);
                if (found) {
                    await tx.serviceCategory.update({ where: { id: found.id }, data: { name: J(input.name), version: { increment: 1 } } });
                }
                else {
                    const count = await tx.serviceCategory.count({ where: { businessId } });
                    await tx.serviceCategory.create({ data: { id: newId('serviceCategory'), businessId, name: J(input.name), sortOrder: count, createdBy: ctx.session.userId, updatedBy: ctx.session.userId } });
                }
            }
            for (const c of existing)
                if (!scope.includes(c.businessId))
                    await tx.serviceCategory.delete({ where: { id: c.id } });
            newKey = nameKeyOf(input.name);
            await tx.networkServiceCategoryLink.upsert({
                where: { networkId_key: { networkId, key: newKey } },
                create: { networkId, key: newKey, subdivisionId: input.subdivisionId, onlineName: input.onlineName?.ru },
                update: { subdivisionId: input.subdivisionId, onlineName: input.onlineName?.ru },
            });
            await this.audit.record(tx, ctx, { action: input.key ? 'update' : 'create', entityType: 'networkServiceCategory', entityId: newKey, networkId, after: { name: input.name, businessIds: scope } });
        });
        return { key: newKey };
    }
    async getService(ctx, networkId, key) {
        const { network } = await this.access.require(ctx, networkId, 'services');
        const rows = await this.prisma.service.findMany({ where: { businessId: { in: network.businessIds } } });
        const matching = rows.filter((r) => nameKeyOf(r.name) === key);
        if (!matching.length)
            throw new ApiError('not_found', 'Service not found');
        const lock = await this.prisma.networkServiceLock.findUnique({ where: { networkId_key: { networkId, key } } });
        const s = matching[0];
        return {
            key,
            name: s.name,
            priceMin: moneyToJson(s.priceMin),
            priceMax: s.priceMax != null ? moneyToJson(s.priceMax) : undefined,
            durationMin: s.durationMin,
            kind: s.kind,
            businessIds: matching.map((r) => r.businessId),
            priceLocked: lock?.priceLocked ?? false,
            descriptionLocked: lock?.descriptionLocked ?? false,
            onlineName: lock?.onlineName ?? undefined,
        };
    }
    async saveService(ctx, networkId, input) {
        const { network } = await this.access.require(ctx, networkId, 'services');
        const name = input.name.ru?.trim();
        if (!name)
            throw new ApiError('bad_name', 'Name required');
        if (input.priceMax != null && input.priceMax < input.priceMin)
            throw new ApiError('validation', 'price range');
        const scope = input.businessIds.filter((id) => network.businessIds.includes(id));
        if (!scope.length)
            throw new ApiError('validation', 'no locations');
        const allServices = await this.prisma.service.findMany({ where: { businessId: { in: network.businessIds } } });
        const existing = input.key ? allServices.filter((s) => nameKeyOf(s.name) === input.key) : [];
        const existingByBiz = new Map(existing.map((s) => [s.businessId, s]));
        const allCategories = await this.prisma.serviceCategory.findMany({ where: { businessId: { in: network.businessIds } } });
        const businesses = await this.prisma.business.findMany({ where: { id: { in: scope } }, select: { id: true, sphereIds: true } });
        const sphereByBiz = new Map(businesses.map((b) => [b.id, b.sphereIds[0] ?? 'beauty']));
        let newKey = input.key ?? nameKeyOf(input.name);
        await this.prisma.$transaction(async (tx) => {
            for (const businessId of scope) {
                const category = allCategories.find((c) => c.businessId === businessId && nameKeyOf(c.name) === input.categoryKey);
                if (!category)
                    continue; // категория ещё не раздана в этот филиал (как в моке — пропускаем)
                const patch = {
                    name: J(input.name),
                    description: J(input.description),
                    categoryId: category.id,
                    kind: input.kind,
                    durationMin: input.durationMin,
                    priceMin: money(input.priceMin),
                    priceMax: input.priceMax != null ? money(input.priceMax) : null,
                    capacity: input.kind === 'group' ? (input.capacity ?? null) : null,
                };
                const found = existingByBiz.get(businessId);
                if (found) {
                    await tx.service.update({ where: { id: found.id }, data: { ...patch, version: { increment: 1 } } });
                }
                else {
                    const count = await tx.service.count({ where: { businessId } });
                    await tx.service.create({
                        data: { id: newId('service'), businessId, sphereId: sphereByBiz.get(businessId) ?? 'beauty', photos: [], materials: [], staffIds: [], workplaces: ['salon'], onlineBookable: true, active: true, order: count, createdBy: ctx.session.userId, updatedBy: ctx.session.userId, ...patch },
                    });
                }
            }
            for (const s of existing)
                if (!scope.includes(s.businessId))
                    await tx.service.delete({ where: { id: s.id } });
            newKey = nameKeyOf(input.name);
            await tx.networkServiceLock.upsert({
                where: { networkId_key: { networkId, key: newKey } },
                create: { networkId, key: newKey, priceLocked: input.priceLocked, descriptionLocked: input.descriptionLocked, onlineName: input.onlineName?.ru },
                update: { priceLocked: input.priceLocked, descriptionLocked: input.descriptionLocked, onlineName: input.onlineName?.ru },
            });
            await this.audit.record(tx, ctx, { action: input.key ? 'update' : 'create', entityType: 'networkService', entityId: newKey, networkId, after: { name: input.name, priceMin: input.priceMin, businessIds: scope } });
        });
        return { key: newKey };
    }
    /** F-11-090: состав филиалов услуги становится РОВНО businessIds — где нет, копия; где есть, но не отмечено, удаление */
    async syncServiceToLocations(ctx, networkId, key, businessIds) {
        const { network } = await this.access.require(ctx, networkId, 'services');
        const scope = businessIds.filter((id) => network.businessIds.includes(id));
        const rows = await this.prisma.service.findMany({ where: { businessId: { in: network.businessIds } } });
        const matching = rows.filter((r) => nameKeyOf(r.name) === key);
        if (!matching.length)
            throw new ApiError('not_found', 'Service not found');
        const source = matching[0];
        const sourceCategory = await this.prisma.serviceCategory.findUnique({ where: { id: source.categoryId ?? '' } });
        const removedFrom = [];
        const addedTo = [];
        await this.prisma.$transaction(async (tx) => {
            for (const r of matching)
                if (!scope.includes(r.businessId)) {
                    await tx.service.delete({ where: { id: r.id } });
                    removedFrom.push(r.businessId);
                }
            const sourceCategoryKey = sourceCategory ? nameKeyOf(sourceCategory.name) : '';
            for (const businessId of scope) {
                if (matching.some((r) => r.businessId === businessId))
                    continue;
                const targetCategories = await tx.serviceCategory.findMany({ where: { businessId } });
                let category = sourceCategoryKey ? (targetCategories.find((c) => nameKeyOf(c.name) === sourceCategoryKey) ?? null) : null;
                if (!category) {
                    const count = await tx.serviceCategory.count({ where: { businessId } });
                    category = await tx.serviceCategory.create({ data: { id: newId('serviceCategory'), businessId, name: sourceCategory ? sourceCategory.name : J({ ru: 'Без категории' }), sortOrder: count, createdBy: ctx.session.userId, updatedBy: ctx.session.userId } });
                }
                const count = await tx.service.count({ where: { businessId } });
                await tx.service.create({
                    data: {
                        id: newId('service'), businessId, categoryId: category.id, sphereId: source.sphereId, name: source.name, description: source.description ?? undefined,
                        kind: source.kind, durationMin: source.durationMin, durationMax: source.durationMax, priceMin: source.priceMin, priceMax: source.priceMax, photos: [], materials: [], staffIds: [],
                        workplaces: source.workplaces, onlineBookable: source.onlineBookable, active: true, order: count, capacity: source.capacity, createdBy: ctx.session.userId, updatedBy: ctx.session.userId,
                    },
                });
                addedTo.push(businessId);
            }
            await this.audit.record(tx, ctx, { action: 'update', entityType: 'networkService', entityId: key, networkId, after: { removedFrom, addedTo } });
        });
        return { removedFrom, addedTo };
    }
    // ───────────────────────── Товары / категории (F-11-111…118) ─────────────────────────
    async listGoodsCategories(ctx, networkId) {
        await this.access.require(ctx, networkId, 'goods');
        return this.prisma.networkGoodsCategoryLink.findMany({ where: { networkId }, orderBy: { createdAt: 'asc' } });
    }
    async saveGoodsCategory(ctx, networkId, input) {
        const { network } = await this.access.require(ctx, networkId, 'goods');
        const name = input.name.trim();
        if (!name)
            throw new ApiError('bad_name', 'Name required');
        const scope = input.businessIds.filter((id) => network.businessIds.includes(id));
        const saved = await this.prisma.$transaction(async (tx) => {
            const row = input.id
                ? await tx.networkGoodsCategoryLink.update({ where: { id: input.id }, data: { name, parentId: input.parentId } })
                : await tx.networkGoodsCategoryLink.create({ data: { id: newId('networkGoodsCategoryLink'), networkId, name, parentId: input.parentId } });
            for (const businessId of scope) {
                const loc = await tx.location.findFirst({ where: { businessId, deletedAt: null }, orderBy: { sortOrder: 'asc' } });
                if (!loc)
                    continue;
                const existingCat = await tx.stockCategory.findFirst({ where: { businessId, name } });
                if (!existingCat)
                    await tx.stockCategory.create({ data: { id: newId('stockCategory'), businessId, locationId: loc.id, name } });
            }
            await this.audit.record(tx, ctx, { action: input.id ? 'update' : 'create', entityType: 'networkGoodsCategory', entityId: row.id, networkId, after: { name, businessIds: scope } });
            return row;
        });
        return saved;
    }
    async getGoodsProduct(ctx, networkId, groupId) {
        const { network } = await this.access.require(ctx, networkId, 'goods');
        const rows = await this.prisma.product.findMany({ where: { businessId: { in: network.businessIds }, OR: [{ networkGroupId: groupId }, { id: groupId }] } });
        if (!rows.length)
            throw new ApiError('not_found', 'Good not found');
        const source = rows.find((r) => r.isNetworkSource) ?? rows[0];
        return { key: source.id, name: source.name, salePrice: moneyToJson(source.salePrice), costPrice: moneyToJson(source.costPrice), businessIds: rows.map((r) => r.businessId) };
    }
    /** F-11-113: создать сетевой товар в первом филиале и раздать по остальным; F-08-135 — networkGroupId/isNetworkSource */
    async saveGoodsProduct(ctx, networkId, input) {
        const { network } = await this.access.require(ctx, networkId, 'goods');
        const name = input.name.trim();
        if (!name)
            throw new ApiError('bad_name', 'Name required');
        const scope = input.businessIds.filter((id) => network.businessIds.includes(id));
        if (!scope.length)
            throw new ApiError('validation', 'no locations');
        if (input.groupId) {
            const existing = await this.prisma.product.findUnique({ where: { id: input.groupId } });
            if (!existing)
                throw new ApiError('not_found', 'Good not found');
            await this.prisma.product.update({ where: { id: existing.id }, data: { name, salePrice: money(input.salePrice), costPrice: money(input.costPrice), comment: input.comment, isNetworkSource: true, networkGroupId: existing.networkGroupId ?? existing.id, version: { increment: 1 } } });
            const groupId = existing.networkGroupId ?? existing.id;
            const already = await this.prisma.product.findMany({ where: { networkGroupId: groupId }, select: { businessId: true } });
            const missing = scope.filter((id) => id !== existing.businessId && !already.some((a) => a.businessId === id));
            for (const businessId of missing)
                await this.copyGoodToBusiness(ctx, existing.id, businessId);
            return this.getGoodsProduct(ctx, networkId, groupId);
        }
        const firstBusinessId = scope[0];
        const loc = await this.prisma.location.findFirst({ where: { businessId: firstBusinessId, deletedAt: null }, orderBy: { sortOrder: 'asc' } });
        if (!loc)
            throw new ApiError('validation', 'no location');
        const id = newId('product');
        await this.prisma.product.create({ data: { id, businessId: firstBusinessId, locationId: loc.id, categoryId: input.categoryId, name, saleUnit: 'pcs', writeoffUnit: 'pcs', salePrice: money(input.salePrice), costPrice: money(input.costPrice), comment: input.comment, isNetworkSource: true, networkGroupId: id, createdBy: ctx.session.userId, updatedBy: ctx.session.userId } });
        for (const businessId of scope.slice(1))
            await this.copyGoodToBusiness(ctx, id, businessId);
        return this.getGoodsProduct(ctx, networkId, id);
    }
    /** Копия товара в филиал (F-08-130/135) — категория по совпадению имени, иначе первая категория филиала */
    async copyGoodToBusiness(ctx, sourceGoodId, targetBusinessId) {
        const source = await this.prisma.product.findUniqueOrThrow({ where: { id: sourceGoodId } });
        const groupId = source.networkGroupId ?? source.id;
        const exists = await this.prisma.product.findFirst({ where: { businessId: targetBusinessId, networkGroupId: groupId } });
        if (exists)
            return exists;
        const loc = await this.prisma.location.findFirst({ where: { businessId: targetBusinessId, deletedAt: null }, orderBy: { sortOrder: 'asc' } });
        if (!loc)
            return null;
        const sourceCategory = source.categoryId ? await this.prisma.stockCategory.findUnique({ where: { id: source.categoryId } }) : null;
        let category = sourceCategory ? await this.prisma.stockCategory.findFirst({ where: { businessId: targetBusinessId, locationId: loc.id, name: sourceCategory.name } }) : null;
        if (!category)
            category = await this.prisma.stockCategory.findFirst({ where: { businessId: targetBusinessId, locationId: loc.id } });
        if (!category)
            category = await this.prisma.stockCategory.create({ data: { id: newId('stockCategory'), businessId: targetBusinessId, locationId: loc.id, name: 'Без категории' } });
        await this.prisma.$transaction(async (tx) => {
            if (!source.isNetworkSource)
                await tx.product.update({ where: { id: source.id }, data: { isNetworkSource: true, networkGroupId: groupId } });
            await tx.product.create({
                data: { id: newId('product'), businessId: targetBusinessId, locationId: loc.id, categoryId: category.id, name: source.name, receiptName: source.receiptName, sku: source.sku, barcode: null, saleUnit: source.saleUnit, writeoffUnit: source.writeoffUnit, unitRatio: source.unitRatio, salePrice: source.salePrice, costPrice: source.costPrice, taxSystem: source.taxSystem, taxRate: source.taxRate, comment: source.comment, networkGroupId: groupId, isNetworkSource: false, createdBy: ctx.session.userId, updatedBy: ctx.session.userId },
            });
            await this.audit.record(tx, ctx, { action: 'create', entityType: 'product', entityId: source.id, businessId: targetBusinessId, after: { name: source.name, networked: true } });
        });
        return this.prisma.product.findFirst({ where: { businessId: targetBusinessId, networkGroupId: groupId } });
    }
    /** F-11-116: миграция товаров филиала в сеть — раздача по остальным (F-08-135) */
    async migrateGoodsToNetwork(ctx, networkId, input) {
        const { network } = await this.access.require(ctx, networkId, 'migrations');
        if (!network.businessIds.includes(input.fromBusinessId))
            throw new ApiError('validation', 'business not in network');
        const targets = network.businessIds.filter((id) => id !== input.fromBusinessId);
        const source = await this.prisma.product.findMany({ where: { businessId: input.fromBusinessId, archived: false, ...(input.goodIds === 'all' ? {} : { id: { in: input.goodIds } }) } });
        let moved = 0;
        for (const g of source) {
            if (!targets.length)
                continue;
            for (const t of targets)
                await this.copyGoodToBusiness(ctx, g.id, t);
            moved += 1;
        }
        return { moved };
    }
    // ───────────────────────── Должности сети — Position.networkId (этап 3) ─────────────────────────
    async listPositions(ctx, networkId) {
        await this.access.require(ctx, networkId, 'staff');
        const rows = await this.prisma.position.findMany({ where: { networkId }, orderBy: { sortOrder: 'asc' } });
        return rows.map((p) => ({ id: p.id, name: p.name.ru, description: p.description ?? undefined, version: p.version }));
    }
    async savePosition(ctx, networkId, id, input) {
        await this.access.require(ctx, networkId, 'staff');
        const name = input.name.trim();
        if (!name)
            throw new ApiError('bad_name', 'Name required');
        if (id) {
            const p = await this.prisma.position.findFirst({ where: { id, networkId } });
            if (!p)
                throw new ApiError('not_found', 'Position not found');
            await this.prisma.position.update({ where: { id }, data: { name: J({ ru: name }), nameNorm: norm(name), description: input.description, version: { increment: 1 } } });
            return { id, name, description: input.description };
        }
        const count = await this.prisma.position.count({ where: { networkId } });
        const created = await this.prisma.position.create({ data: { id: newId('position'), networkId, name: J({ ru: name }), nameNorm: norm(name), description: input.description, sortOrder: count, createdBy: ctx.session.userId, updatedBy: ctx.session.userId } });
        return { id: created.id, name, description: input.description };
    }
    async deletePosition(ctx, networkId, id) {
        await this.access.require(ctx, networkId, 'staff');
        const p = await this.prisma.position.findFirst({ where: { id, networkId } });
        if (!p)
            return;
        await this.prisma.position.delete({ where: { id } });
    }
    // ───────────────────────── Сотрудники сети — сводный список, только чтение ─────────────────────────
    async listStaff(ctx, networkId) {
        const { network } = await this.access.require(ctx, networkId, 'staff');
        if (!network.businessIds.length)
            return [];
        const rows = await this.prisma.staff.findMany({ where: { businessId: { in: network.businessIds }, deletedAt: null, status: { not: 'fired' } }, include: { business: { select: { name: true } } }, orderBy: { name: 'asc' } });
        return rows.map((s) => ({ id: s.id, businessId: s.businessId, businessName: s.business.name, name: s.name, phone: s.phone, role: s.role, position: s.position?.ru ?? undefined }));
    }
    // ───────────────────────── Поля записи/клиента сети (F-11-126…134) ─────────────────────────
    async listFields(ctx, networkId, kind) {
        await this.access.require(ctx, networkId, 'fields');
        const rows = await this.prisma.networkField.findMany({ where: { networkId, ...(kind ? { kind } : {}) }, orderBy: { createdAt: 'asc' } });
        return rows.map(fieldOut);
    }
    async saveField(ctx, networkId, id, input) {
        const { network } = await this.access.require(ctx, networkId, 'fields');
        const name = input.name.trim();
        if (!name)
            throw new ApiError('validation', 'name required');
        const businessIds = network.businessIds.length === 1 ? [...network.businessIds] : input.businessIds;
        if (!businessIds.length)
            throw new ApiError('validation', 'locations_required');
        const showInWidget = input.dataType === 'datetime' ? false : input.showInWidget;
        const listOptions = input.dataType === 'list' ? input.listOptions.map((o) => o.trim()).filter(Boolean) : [];
        const data = { name, dataType: input.dataType, apiKey: input.apiKey.trim(), listOptions, editableByUser: input.editableByUser, showInAdmin: input.showInAdmin, alwaysShowInBookingWindow: input.alwaysShowInBookingWindow, requiredOnCreate: input.requiredOnCreate, requiredOnArrived: input.requiredOnArrived, alwaysShowInClientCard: input.alwaysShowInClientCard, showInWidget, requiredInWidget: showInWidget ? input.requiredInWidget : false, businessIds };
        const dup = await this.prisma.networkField.findFirst({ where: { networkId, kind: input.kind, apiKey: data.apiKey, ...(id ? { id: { not: id } } : {}) } });
        if (dup)
            throw new ApiError('validation', 'api_key_taken');
        if (id) {
            const existing = await this.prisma.networkField.findFirst({ where: { id, networkId } });
            if (!existing)
                throw new ApiError('not_found', 'Field not found');
            const row = await this.prisma.networkField.update({ where: { id }, data: { ...data, version: { increment: 1 } } });
            return fieldOut(row);
        }
        const row = await this.prisma.networkField.create({ data: { id: newId('networkField'), networkId, kind: input.kind, ...data, createdBy: ctx.session.userId, updatedBy: ctx.session.userId } });
        return fieldOut(row);
    }
    async deleteField(ctx, networkId, id) {
        await this.access.require(ctx, networkId, 'fields');
        const row = await this.prisma.networkField.findFirst({ where: { id, networkId } });
        if (!row)
            throw new ApiError('not_found', 'Field not found');
        await this.prisma.networkField.delete({ where: { id } });
    }
};
NetworkCatalogService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [PrismaService,
        NetworkAccessService,
        AuditService])
], NetworkCatalogService);
export { NetworkCatalogService };
function fieldOut(f) {
    return { ...f, listOptions: Array.isArray(f.listOptions) ? f.listOptions : [], businessIds: Array.isArray(f.businessIds) ? f.businessIds : [], createdAt: f.createdAt.toISOString() };
}
let NetworkCatalogController = class NetworkCatalogController {
    constructor(svc) {
        this.svc = svc;
    }
    listServiceCategories(ctx, n) {
        return this.svc.listServiceCategories(ctx, n);
    }
    getServiceCategory(ctx, n, key) {
        return this.svc.getServiceCategory(ctx, n, key);
    }
    saveServiceCategory(ctx, n, body) {
        return this.svc.saveServiceCategory(ctx, n, body);
    }
    getService(ctx, n, key) {
        return this.svc.getService(ctx, n, key);
    }
    saveService(ctx, n, body) {
        return this.svc.saveService(ctx, n, body);
    }
    sync(ctx, n, key, body) {
        return this.svc.syncServiceToLocations(ctx, n, key, body.businessIds);
    }
    listGoodsCategories(ctx, n) {
        return this.svc.listGoodsCategories(ctx, n);
    }
    saveGoodsCategory(ctx, n, body) {
        return this.svc.saveGoodsCategory(ctx, n, body);
    }
    getGoodsProduct(ctx, n, id) {
        return this.svc.getGoodsProduct(ctx, n, id);
    }
    saveGoods(ctx, n, body) {
        return this.svc.saveGoodsProduct(ctx, n, body);
    }
    migrateGoods(ctx, n, body) {
        return this.svc.migrateGoodsToNetwork(ctx, n, body);
    }
    listPositions(ctx, n) {
        return this.svc.listPositions(ctx, n);
    }
    addPosition(ctx, n, body) {
        return this.svc.savePosition(ctx, n, undefined, body);
    }
    renamePosition(ctx, n, id, body) {
        return this.svc.savePosition(ctx, n, id, body);
    }
    async deletePosition(ctx, n, id) {
        await this.svc.deletePosition(ctx, n, id);
        return { ok: true };
    }
    listStaff(ctx, n) {
        return this.svc.listStaff(ctx, n);
    }
    listFields(ctx, n) {
        return this.svc.listFields(ctx, n);
    }
    addField(ctx, n, body) {
        return this.svc.saveField(ctx, n, undefined, body);
    }
    editField(ctx, n, id, body) {
        return this.svc.saveField(ctx, n, id, body);
    }
    async deleteField(ctx, n, id) {
        await this.svc.deleteField(ctx, n, id);
        return { ok: true };
    }
};
__decorate([
    Get('service-categories'),
    __param(0, Ctx()),
    __param(1, Param('networkId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], NetworkCatalogController.prototype, "listServiceCategories", null);
__decorate([
    Get('service-categories/:key'),
    __param(0, Ctx()),
    __param(1, Param('networkId')),
    __param(2, Param('key')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String]),
    __metadata("design:returntype", void 0)
], NetworkCatalogController.prototype, "getServiceCategory", null);
__decorate([
    Post('service-categories'),
    ApiOperation({ summary: 'Сохранить сетевую категорию услуг (F-11-080)' }),
    ZodBody(networkServiceCategoryBody),
    __param(0, Ctx()),
    __param(1, Param('networkId')),
    __param(2, Body(new Zod(networkServiceCategoryBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], NetworkCatalogController.prototype, "saveServiceCategory", null);
__decorate([
    Get('services/:key'),
    __param(0, Ctx()),
    __param(1, Param('networkId')),
    __param(2, Param('key')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String]),
    __metadata("design:returntype", void 0)
], NetworkCatalogController.prototype, "getService", null);
__decorate([
    Post('services'),
    ApiOperation({ summary: 'Сохранить сетевую услугу (F-11-081…083)' }),
    ZodBody(networkServiceBody),
    __param(0, Ctx()),
    __param(1, Param('networkId')),
    __param(2, Body(new Zod(networkServiceBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], NetworkCatalogController.prototype, "saveService", null);
__decorate([
    Post('services/:key/sync'),
    ApiOperation({ summary: 'Синхронизировать услугу по филиалам (F-11-090)' }),
    ZodBody(businessIdsBody),
    __param(0, Ctx()),
    __param(1, Param('networkId')),
    __param(2, Param('key')),
    __param(3, Body(new Zod(businessIdsBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object]),
    __metadata("design:returntype", void 0)
], NetworkCatalogController.prototype, "sync", null);
__decorate([
    Get('goods-categories'),
    __param(0, Ctx()),
    __param(1, Param('networkId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], NetworkCatalogController.prototype, "listGoodsCategories", null);
__decorate([
    Post('goods-categories'),
    ZodBody(networkGoodsCategoryBody),
    __param(0, Ctx()),
    __param(1, Param('networkId')),
    __param(2, Body(new Zod(networkGoodsCategoryBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], NetworkCatalogController.prototype, "saveGoodsCategory", null);
__decorate([
    Get('goods/:groupId'),
    __param(0, Ctx()),
    __param(1, Param('networkId')),
    __param(2, Param('groupId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String]),
    __metadata("design:returntype", void 0)
], NetworkCatalogController.prototype, "getGoodsProduct", null);
__decorate([
    Post('goods'),
    ApiOperation({ summary: 'Сохранить сетевой товар (F-11-113)' }),
    ZodBody(networkGoodsProductBody),
    __param(0, Ctx()),
    __param(1, Param('networkId')),
    __param(2, Body(new Zod(networkGoodsProductBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], NetworkCatalogController.prototype, "saveGoods", null);
__decorate([
    Post('goods/migrate'),
    ApiOperation({ summary: 'Миграция товаров филиала в сеть (F-11-116)' }),
    ZodBody(migrateGoodsBody),
    __param(0, Ctx()),
    __param(1, Param('networkId')),
    __param(2, Body(new Zod(migrateGoodsBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], NetworkCatalogController.prototype, "migrateGoods", null);
__decorate([
    Get('positions'),
    __param(0, Ctx()),
    __param(1, Param('networkId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], NetworkCatalogController.prototype, "listPositions", null);
__decorate([
    Post('positions'),
    ZodBody(networkPositionBody),
    __param(0, Ctx()),
    __param(1, Param('networkId')),
    __param(2, Body(new Zod(networkPositionBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], NetworkCatalogController.prototype, "addPosition", null);
__decorate([
    Patch('positions/:id'),
    ZodBody(networkPositionBody),
    __param(0, Ctx()),
    __param(1, Param('networkId')),
    __param(2, Param('id')),
    __param(3, Body(new Zod(networkPositionBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object]),
    __metadata("design:returntype", void 0)
], NetworkCatalogController.prototype, "renamePosition", null);
__decorate([
    Delete('positions/:id'),
    __param(0, Ctx()),
    __param(1, Param('networkId')),
    __param(2, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String]),
    __metadata("design:returntype", Promise)
], NetworkCatalogController.prototype, "deletePosition", null);
__decorate([
    Get('staff'),
    ApiOperation({ summary: 'Сводный список сотрудников сети, только чтение' }),
    __param(0, Ctx()),
    __param(1, Param('networkId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], NetworkCatalogController.prototype, "listStaff", null);
__decorate([
    Get('fields'),
    __param(0, Ctx()),
    __param(1, Param('networkId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], NetworkCatalogController.prototype, "listFields", null);
__decorate([
    Post('fields'),
    ApiOperation({ summary: 'Поле записи/клиента сети (F-11-126…134)' }),
    ZodBody(networkFieldBody),
    __param(0, Ctx()),
    __param(1, Param('networkId')),
    __param(2, Body(new Zod(networkFieldBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], NetworkCatalogController.prototype, "addField", null);
__decorate([
    Patch('fields/:id'),
    ZodBody(networkFieldBody),
    __param(0, Ctx()),
    __param(1, Param('networkId')),
    __param(2, Param('id')),
    __param(3, Body(new Zod(networkFieldBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object]),
    __metadata("design:returntype", void 0)
], NetworkCatalogController.prototype, "editField", null);
__decorate([
    Delete('fields/:id'),
    __param(0, Ctx()),
    __param(1, Param('networkId')),
    __param(2, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String]),
    __metadata("design:returntype", Promise)
], NetworkCatalogController.prototype, "deleteField", null);
NetworkCatalogController = __decorate([
    ApiTags('network'),
    Controller('v1/net/:networkId'),
    Authed(),
    __metadata("design:paramtypes", [NetworkCatalogService])
], NetworkCatalogController);
export { NetworkCatalogController };
//# sourceMappingURL=network-catalog.controller.js.map