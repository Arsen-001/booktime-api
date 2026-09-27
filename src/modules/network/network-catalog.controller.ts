import { Body, Controller, Delete, Get, Injectable, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuditService } from '../../common/audit/audit.service.js';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { Authed, Ctx } from '../../common/http/guards.js';
import { ZodBody, ZodOk } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { newId } from '../../common/ids/ids.js';
import { money, moneyToJson } from '../../common/money/money.js';
import { PrismaService } from '../../common/prisma.service.js';
import { networkView } from '../businesses/views.js';
import { NetworkAccessService } from './network-access.service.js';
import {
  businessIdsBody,
  migrateGoodsBody,
  networkFieldBody,
  networkGoodsCategoryBody,
  networkGoodsProductBody,
  networkPositionBody,
  networkServiceBody,
  networkServiceCategoryBody,
} from './network.schemas.js';

type LocalizedText = { ru: string; hy?: string; en?: string };
const J = (v: unknown) => v as import('../../generated/prisma/client.js').Prisma.InputJsonValue;
const norm = (s: string) => s.trim().toLowerCase();
const nameKeyOf = (name: unknown) => norm((name as LocalizedText | null)?.ru ?? '');

/**
 * Сетевые каталоги (F-11-079…118, docs/backend/02 §15). Услуги и товары сети — ПО ИМЕНИ, как в моке (b03
 * domain/network.ts): группа — это несколько Service (или Product, через networkGroupId — этап 13) с одинаковым
 * именем в разных Business сети; своя строка хранит только то, чего у Service/ServiceCategory нет (подразделение,
 * запрет цены/описания). Должности — Position.networkId, уже заведён этапом 3. Поля — своя таблица NetworkField.
 * Слияние дублей (F-11-093/119), Excel/CSV, «панель расходников» — не строены (см. docs/PROGRESS.md).
 */
@Injectable()
export class NetworkCatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: NetworkAccessService,
    private readonly audit: AuditService,
  ) {}

  // ───────────────────────── Услуги / категории (F-11-079…093) ─────────────────────────

  async listServiceCategories(ctx: RequestContext, networkId: string) {
    const { network } = await this.access.require(ctx, networkId, 'services');
    if (!network.businessIds.length) return [];
    const rows = await this.prisma.serviceCategory.findMany({ where: { businessId: { in: network.businessIds } } });
    const links = await this.prisma.networkServiceCategoryLink.findMany({ where: { networkId } });
    const linkByKey = new Map(links.map((l) => [l.key, l]));
    const byKey = new Map<string, { key: string; name: LocalizedText; businessIds: string[] }>();
    for (const r of rows) {
      const key = nameKeyOf(r.name);
      if (!key) continue;
      const g = byKey.get(key);
      if (!g) byKey.set(key, { key, name: r.name as LocalizedText, businessIds: [r.businessId] });
      else g.businessIds.push(r.businessId);
    }
    return [...byKey.values()].map((g) => ({ ...g, servicesCount: 0, subdivisionId: linkByKey.get(g.key)?.subdivisionId ?? undefined, onlineName: linkByKey.get(g.key)?.onlineName ?? undefined }));
  }

  async getServiceCategory(ctx: RequestContext, networkId: string, key: string) {
    const { network } = await this.access.require(ctx, networkId, 'services');
    const rows = await this.prisma.serviceCategory.findMany({ where: { businessId: { in: network.businessIds } } });
    const matching = rows.filter((r) => nameKeyOf(r.name) === key);
    if (!matching.length) throw new ApiError('not_found', 'Category not found');
    const link = await this.prisma.networkServiceCategoryLink.findUnique({ where: { networkId_key: { networkId, key } } });
    return { key, name: matching[0]!.name as LocalizedText, onlineName: link?.onlineName ?? undefined, subdivisionId: link?.subdivisionId ?? undefined, businessIds: matching.map((r) => r.businessId) };
  }

  async saveServiceCategory(ctx: RequestContext, networkId: string, input: z.infer<typeof networkServiceCategoryBody>) {
    const { network } = await this.access.require(ctx, networkId, 'services');
    const name = input.name.ru?.trim();
    if (!name) throw new ApiError('bad_name', 'Name required');
    const scope = input.businessIds.filter((id) => network.businessIds.includes(id));
    if (!scope.length) throw new ApiError('validation', 'no locations');
    const all = await this.prisma.serviceCategory.findMany({ where: { businessId: { in: network.businessIds } } });
    const existing = input.key ? all.filter((c) => nameKeyOf(c.name) === input.key) : [];
    const existingByBiz = new Map(existing.map((c) => [c.businessId, c]));
    let newKey = input.key ?? nameKeyOf(input.name);
    await this.prisma.$transaction(async (tx) => {
      for (const businessId of scope) {
        const found = existingByBiz.get(businessId);
        if (found) {
          await tx.serviceCategory.update({ where: { id: found.id }, data: { name: J(input.name), version: { increment: 1 } } });
        } else {
          const count = await tx.serviceCategory.count({ where: { businessId } });
          await tx.serviceCategory.create({ data: { id: newId('serviceCategory'), businessId, name: J(input.name), sortOrder: count, createdBy: ctx.session!.userId, updatedBy: ctx.session!.userId } });
        }
      }
      for (const c of existing) if (!scope.includes(c.businessId)) await tx.serviceCategory.delete({ where: { id: c.id } });
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

  async getService(ctx: RequestContext, networkId: string, key: string) {
    const { network } = await this.access.require(ctx, networkId, 'services');
    const rows = await this.prisma.service.findMany({ where: { businessId: { in: network.businessIds } } });
    const matching = rows.filter((r) => nameKeyOf(r.name) === key);
    if (!matching.length) throw new ApiError('not_found', 'Service not found');
    const lock = await this.prisma.networkServiceLock.findUnique({ where: { networkId_key: { networkId, key } } });
    const s = matching[0]!;
    return {
      key,
      name: s.name as LocalizedText,
      priceMin: moneyToJson(s.priceMin),
      priceMax: s.priceMax != null ? moneyToJson(s.priceMax) : undefined,
      durationMin: s.durationMin,
      kind: s.kind as 'individual' | 'group',
      businessIds: matching.map((r) => r.businessId),
      priceLocked: lock?.priceLocked ?? false,
      descriptionLocked: lock?.descriptionLocked ?? false,
      onlineName: lock?.onlineName ?? undefined,
    };
  }

  async saveService(ctx: RequestContext, networkId: string, input: z.infer<typeof networkServiceBody>) {
    const { network } = await this.access.require(ctx, networkId, 'services');
    const name = input.name.ru?.trim();
    if (!name) throw new ApiError('bad_name', 'Name required');
    if (input.priceMax != null && input.priceMax < input.priceMin) throw new ApiError('validation', 'price range');
    const scope = input.businessIds.filter((id) => network.businessIds.includes(id));
    if (!scope.length) throw new ApiError('validation', 'no locations');
    const allServices = await this.prisma.service.findMany({ where: { businessId: { in: network.businessIds } } });
    const existing = input.key ? allServices.filter((s) => nameKeyOf(s.name) === input.key) : [];
    const existingByBiz = new Map(existing.map((s) => [s.businessId, s]));
    const allCategories = await this.prisma.serviceCategory.findMany({ where: { businessId: { in: network.businessIds } } });
    const businesses = await this.prisma.business.findMany({ where: { id: { in: scope } }, select: { id: true, sphereIds: true } });
    const sphereByBiz = new Map(businesses.map((b) => [b.id, (b.sphereIds as string[])[0] ?? 'beauty']));
    let newKey = input.key ?? nameKeyOf(input.name);
    await this.prisma.$transaction(async (tx) => {
      for (const businessId of scope) {
        const category = allCategories.find((c) => c.businessId === businessId && nameKeyOf(c.name) === input.categoryKey);
        if (!category) continue; // категория ещё не раздана в этот филиал (как в моке — пропускаем)
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
        } else {
          const count = await tx.service.count({ where: { businessId } });
          await tx.service.create({
            data: { id: newId('service'), businessId, sphereId: sphereByBiz.get(businessId) ?? 'beauty', photos: [], materials: [], staffIds: [], workplaces: ['salon'], onlineBookable: true, active: true, order: count, createdBy: ctx.session!.userId, updatedBy: ctx.session!.userId, ...patch },
          });
        }
      }
      for (const s of existing) if (!scope.includes(s.businessId)) await tx.service.delete({ where: { id: s.id } });
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
  async syncServiceToLocations(ctx: RequestContext, networkId: string, key: string, businessIds: string[]) {
    const { network } = await this.access.require(ctx, networkId, 'services');
    const scope = businessIds.filter((id) => network.businessIds.includes(id));
    const rows = await this.prisma.service.findMany({ where: { businessId: { in: network.businessIds } } });
    const matching = rows.filter((r) => nameKeyOf(r.name) === key);
    if (!matching.length) throw new ApiError('not_found', 'Service not found');
    const source = matching[0]!;
    const sourceCategory = await this.prisma.serviceCategory.findUnique({ where: { id: source.categoryId ?? '' } });
    const removedFrom: string[] = [];
    const addedTo: string[] = [];
    await this.prisma.$transaction(async (tx) => {
      for (const r of matching) if (!scope.includes(r.businessId)) { await tx.service.delete({ where: { id: r.id } }); removedFrom.push(r.businessId); }
      const sourceCategoryKey = sourceCategory ? nameKeyOf(sourceCategory.name) : '';
      for (const businessId of scope) {
        if (matching.some((r) => r.businessId === businessId)) continue;
        const targetCategories = await tx.serviceCategory.findMany({ where: { businessId } });
        let category = sourceCategoryKey ? (targetCategories.find((c) => nameKeyOf(c.name) === sourceCategoryKey) ?? null) : null;
        if (!category) {
          const count = await tx.serviceCategory.count({ where: { businessId } });
          category = await tx.serviceCategory.create({ data: { id: newId('serviceCategory'), businessId, name: sourceCategory ? (sourceCategory.name as object) : J({ ru: 'Без категории' }), sortOrder: count, createdBy: ctx.session!.userId, updatedBy: ctx.session!.userId } });
        }
        const count = await tx.service.count({ where: { businessId } });
        await tx.service.create({
          data: {
            id: newId('service'), businessId, categoryId: category.id, sphereId: source.sphereId, name: source.name as object, description: source.description ?? undefined,
            kind: source.kind, durationMin: source.durationMin, durationMax: source.durationMax, priceMin: source.priceMin, priceMax: source.priceMax, photos: [], materials: [], staffIds: [],
            workplaces: source.workplaces as object, onlineBookable: source.onlineBookable, active: true, order: count, capacity: source.capacity, createdBy: ctx.session!.userId, updatedBy: ctx.session!.userId,
          },
        });
        addedTo.push(businessId);
      }
      await this.audit.record(tx, ctx, { action: 'update', entityType: 'networkService', entityId: key, networkId, after: { removedFrom, addedTo } });
    });
    return { removedFrom, addedTo };
  }

  // ───────────────────────── Товары / категории (F-11-111…118) ─────────────────────────

  async listGoodsCategories(ctx: RequestContext, networkId: string) {
    await this.access.require(ctx, networkId, 'goods');
    return this.prisma.networkGoodsCategoryLink.findMany({ where: { networkId }, orderBy: { createdAt: 'asc' } });
  }

  async saveGoodsCategory(ctx: RequestContext, networkId: string, input: z.infer<typeof networkGoodsCategoryBody>) {
    const { network } = await this.access.require(ctx, networkId, 'goods');
    const name = input.name.trim();
    if (!name) throw new ApiError('bad_name', 'Name required');
    const scope = input.businessIds.filter((id) => network.businessIds.includes(id));
    const saved = await this.prisma.$transaction(async (tx) => {
      const row = input.id
        ? await tx.networkGoodsCategoryLink.update({ where: { id: input.id }, data: { name, parentId: input.parentId } })
        : await tx.networkGoodsCategoryLink.create({ data: { id: newId('networkGoodsCategoryLink'), networkId, name, parentId: input.parentId } });
      for (const businessId of scope) {
        const loc = await tx.location.findFirst({ where: { businessId, deletedAt: null }, orderBy: { sortOrder: 'asc' } });
        if (!loc) continue;
        const existingCat = await tx.stockCategory.findFirst({ where: { businessId, name } });
        if (!existingCat) await tx.stockCategory.create({ data: { id: newId('stockCategory'), businessId, locationId: loc.id, name } });
      }
      await this.audit.record(tx, ctx, { action: input.id ? 'update' : 'create', entityType: 'networkGoodsCategory', entityId: row.id, networkId, after: { name, businessIds: scope } });
      return row;
    });
    return saved;
  }

  async getGoodsProduct(ctx: RequestContext, networkId: string, groupId: string) {
    const { network } = await this.access.require(ctx, networkId, 'goods');
    const rows = await this.prisma.product.findMany({ where: { businessId: { in: network.businessIds }, OR: [{ networkGroupId: groupId }, { id: groupId }] } });
    if (!rows.length) throw new ApiError('not_found', 'Good not found');
    const source = rows.find((r) => r.isNetworkSource) ?? rows[0]!;
    return { key: source.id, name: source.name, salePrice: moneyToJson(source.salePrice), costPrice: moneyToJson(source.costPrice), businessIds: rows.map((r) => r.businessId) };
  }

  /** F-11-113: создать сетевой товар в первом филиале и раздать по остальным; F-08-135 — networkGroupId/isNetworkSource */
  async saveGoodsProduct(ctx: RequestContext, networkId: string, input: z.infer<typeof networkGoodsProductBody>) {
    const { network } = await this.access.require(ctx, networkId, 'goods');
    const name = input.name.trim();
    if (!name) throw new ApiError('bad_name', 'Name required');
    const scope = input.businessIds.filter((id) => network.businessIds.includes(id));
    if (!scope.length) throw new ApiError('validation', 'no locations');
    if (input.groupId) {
      const existing = await this.prisma.product.findUnique({ where: { id: input.groupId } });
      if (!existing) throw new ApiError('not_found', 'Good not found');
      await this.prisma.product.update({ where: { id: existing.id }, data: { name, salePrice: money(input.salePrice), costPrice: money(input.costPrice), comment: input.comment, isNetworkSource: true, networkGroupId: existing.networkGroupId ?? existing.id, version: { increment: 1 } } });
      const groupId = existing.networkGroupId ?? existing.id;
      const already = await this.prisma.product.findMany({ where: { networkGroupId: groupId }, select: { businessId: true } });
      const missing = scope.filter((id) => id !== existing.businessId && !already.some((a) => a.businessId === id));
      for (const businessId of missing) await this.copyGoodToBusiness(ctx, existing.id, businessId);
      return this.getGoodsProduct(ctx, networkId, groupId);
    }
    const firstBusinessId = scope[0]!;
    const loc = await this.prisma.location.findFirst({ where: { businessId: firstBusinessId, deletedAt: null }, orderBy: { sortOrder: 'asc' } });
    if (!loc) throw new ApiError('validation', 'no location');
    const id = newId('product');
    await this.prisma.product.create({ data: { id, businessId: firstBusinessId, locationId: loc.id, categoryId: input.categoryId, name, saleUnit: 'pcs', writeoffUnit: 'pcs', salePrice: money(input.salePrice), costPrice: money(input.costPrice), comment: input.comment, isNetworkSource: true, networkGroupId: id, createdBy: ctx.session!.userId, updatedBy: ctx.session!.userId } });
    for (const businessId of scope.slice(1)) await this.copyGoodToBusiness(ctx, id, businessId);
    return this.getGoodsProduct(ctx, networkId, id);
  }

  /** Копия товара в филиал (F-08-130/135) — категория по совпадению имени, иначе первая категория филиала */
  private async copyGoodToBusiness(ctx: RequestContext, sourceGoodId: string, targetBusinessId: string) {
    const source = await this.prisma.product.findUniqueOrThrow({ where: { id: sourceGoodId } });
    const groupId = source.networkGroupId ?? source.id;
    const exists = await this.prisma.product.findFirst({ where: { businessId: targetBusinessId, networkGroupId: groupId } });
    if (exists) return exists;
    const loc = await this.prisma.location.findFirst({ where: { businessId: targetBusinessId, deletedAt: null }, orderBy: { sortOrder: 'asc' } });
    if (!loc) return null;
    const sourceCategory = source.categoryId ? await this.prisma.stockCategory.findUnique({ where: { id: source.categoryId } }) : null;
    let category = sourceCategory ? await this.prisma.stockCategory.findFirst({ where: { businessId: targetBusinessId, locationId: loc.id, name: sourceCategory.name } }) : null;
    if (!category) category = await this.prisma.stockCategory.findFirst({ where: { businessId: targetBusinessId, locationId: loc.id } });
    if (!category) category = await this.prisma.stockCategory.create({ data: { id: newId('stockCategory'), businessId: targetBusinessId, locationId: loc.id, name: 'Без категории' } });
    await this.prisma.$transaction(async (tx) => {
      if (!source.isNetworkSource) await tx.product.update({ where: { id: source.id }, data: { isNetworkSource: true, networkGroupId: groupId } });
      await tx.product.create({
        data: { id: newId('product'), businessId: targetBusinessId, locationId: loc.id, categoryId: category!.id, name: source.name, receiptName: source.receiptName, sku: source.sku, barcode: null, saleUnit: source.saleUnit, writeoffUnit: source.writeoffUnit, unitRatio: source.unitRatio, salePrice: source.salePrice, costPrice: source.costPrice, taxSystem: source.taxSystem, taxRate: source.taxRate, comment: source.comment, networkGroupId: groupId, isNetworkSource: false, createdBy: ctx.session!.userId, updatedBy: ctx.session!.userId },
      });
      await this.audit.record(tx, ctx, { action: 'create', entityType: 'product', entityId: source.id, businessId: targetBusinessId, after: { name: source.name, networked: true } });
    });
    return this.prisma.product.findFirst({ where: { businessId: targetBusinessId, networkGroupId: groupId } });
  }

  /** F-11-116: миграция товаров филиала в сеть — раздача по остальным (F-08-135) */
  async migrateGoodsToNetwork(ctx: RequestContext, networkId: string, input: z.infer<typeof migrateGoodsBody>) {
    const { network } = await this.access.require(ctx, networkId, 'migrations');
    if (!network.businessIds.includes(input.fromBusinessId)) throw new ApiError('validation', 'business not in network');
    const targets = network.businessIds.filter((id) => id !== input.fromBusinessId);
    const source = await this.prisma.product.findMany({ where: { businessId: input.fromBusinessId, archived: false, ...(input.goodIds === 'all' ? {} : { id: { in: input.goodIds } }) } });
    let moved = 0;
    for (const g of source) {
      if (!targets.length) continue;
      for (const t of targets) await this.copyGoodToBusiness(ctx, g.id, t);
      moved += 1;
    }
    return { moved };
  }

  // ───────────────────────── Должности сети — Position.networkId (этап 3) ─────────────────────────

  async listPositions(ctx: RequestContext, networkId: string) {
    await this.access.require(ctx, networkId, 'staff');
    const rows = await this.prisma.position.findMany({ where: { networkId }, orderBy: { sortOrder: 'asc' } });
    return rows.map((p) => ({ id: p.id, name: (p.name as LocalizedText).ru, description: p.description ?? undefined, version: p.version }));
  }

  async savePosition(ctx: RequestContext, networkId: string, id: string | undefined, input: z.infer<typeof networkPositionBody>) {
    await this.access.require(ctx, networkId, 'staff');
    const name = input.name.trim();
    if (!name) throw new ApiError('bad_name', 'Name required');
    if (id) {
      const p = await this.prisma.position.findFirst({ where: { id, networkId } });
      if (!p) throw new ApiError('not_found', 'Position not found');
      await this.prisma.position.update({ where: { id }, data: { name: J({ ru: name }), nameNorm: norm(name), description: input.description, version: { increment: 1 } } });
      return { id, name, description: input.description };
    }
    const count = await this.prisma.position.count({ where: { networkId } });
    const created = await this.prisma.position.create({ data: { id: newId('position'), networkId, name: J({ ru: name }), nameNorm: norm(name), description: input.description, sortOrder: count, createdBy: ctx.session!.userId, updatedBy: ctx.session!.userId } });
    return { id: created.id, name, description: input.description };
  }

  async deletePosition(ctx: RequestContext, networkId: string, id: string) {
    await this.access.require(ctx, networkId, 'staff');
    const p = await this.prisma.position.findFirst({ where: { id, networkId } });
    if (!p) return;
    await this.prisma.position.delete({ where: { id } });
  }

  // ───────────────────────── Сотрудники сети — сводный список, только чтение ─────────────────────────

  async listStaff(ctx: RequestContext, networkId: string) {
    const { network } = await this.access.require(ctx, networkId, 'staff');
    if (!network.businessIds.length) return [];
    const rows = await this.prisma.staff.findMany({ where: { businessId: { in: network.businessIds }, deletedAt: null, status: { not: 'fired' } }, include: { business: { select: { name: true } } }, orderBy: { name: 'asc' } });
    return rows.map((s) => ({ id: s.id, businessId: s.businessId, businessName: s.business.name, name: s.name, phone: s.phone, role: s.role, position: (s.position as LocalizedText | null)?.ru ?? undefined }));
  }

  // ───────────────────────── Поля записи/клиента сети (F-11-126…134) ─────────────────────────

  async listFields(ctx: RequestContext, networkId: string, kind?: 'booking' | 'client') {
    await this.access.require(ctx, networkId, 'fields');
    const rows = await this.prisma.networkField.findMany({ where: { networkId, ...(kind ? { kind } : {}) }, orderBy: { createdAt: 'asc' } });
    return rows.map(fieldOut);
  }

  async saveField(ctx: RequestContext, networkId: string, id: string | undefined, input: z.infer<typeof networkFieldBody>) {
    const { network } = await this.access.require(ctx, networkId, 'fields');
    const name = input.name.trim();
    if (!name) throw new ApiError('validation', 'name required');
    const businessIds = network.businessIds.length === 1 ? [...network.businessIds] : input.businessIds;
    if (!businessIds.length) throw new ApiError('validation', 'locations_required');
    const showInWidget = input.dataType === 'datetime' ? false : input.showInWidget;
    const listOptions = input.dataType === 'list' ? input.listOptions.map((o) => o.trim()).filter(Boolean) : [];
    const data = { name, dataType: input.dataType, apiKey: input.apiKey.trim(), listOptions, editableByUser: input.editableByUser, showInAdmin: input.showInAdmin, alwaysShowInBookingWindow: input.alwaysShowInBookingWindow, requiredOnCreate: input.requiredOnCreate, requiredOnArrived: input.requiredOnArrived, alwaysShowInClientCard: input.alwaysShowInClientCard, showInWidget, requiredInWidget: showInWidget ? input.requiredInWidget : false, businessIds };
    const dup = await this.prisma.networkField.findFirst({ where: { networkId, kind: input.kind, apiKey: data.apiKey, ...(id ? { id: { not: id } } : {}) } });
    if (dup) throw new ApiError('validation', 'api_key_taken');
    if (id) {
      const existing = await this.prisma.networkField.findFirst({ where: { id, networkId } });
      if (!existing) throw new ApiError('not_found', 'Field not found');
      const row = await this.prisma.networkField.update({ where: { id }, data: { ...data, version: { increment: 1 } } });
      return fieldOut(row);
    }
    const row = await this.prisma.networkField.create({ data: { id: newId('networkField'), networkId, kind: input.kind, ...data, createdBy: ctx.session!.userId, updatedBy: ctx.session!.userId } });
    return fieldOut(row);
  }

  async deleteField(ctx: RequestContext, networkId: string, id: string) {
    await this.access.require(ctx, networkId, 'fields');
    const row = await this.prisma.networkField.findFirst({ where: { id, networkId } });
    if (!row) throw new ApiError('not_found', 'Field not found');
    await this.prisma.networkField.delete({ where: { id } });
  }

  /**
   * Этап 21 «network+reports»: `src/api/network.ts::listMyNetworks` — сеть ЭТОГО бизнеса, если есть, БЕЗ
   * гейта на владельца сети (в отличие от `NetworkService.own()`/`view()` модуля `businesses`, который этот
   * файл сознательно не импортирует — риск цикла `network` ↔ `businesses`, PLAN §9 «не переписывать чужой
   * рабочий срез»; повторяет `networkView()` напрямую, та же чистая функция). Зовёт любой сотрудник кабинета
   * (переключатель сети, «Данные сети» окна записи), не только владелец. Business.networkId один — 0 или 1
   * элемент, мок несёт массив «на будущее».
   */
  async myNetwork(businessId: string) {
    const biz = await this.prisma.business.findUnique({ where: { id: businessId }, select: { networkId: true } });
    if (!biz?.networkId) return [];
    const n = await this.prisma.network.findUnique({ where: { id: biz.networkId }, include: { businesses: { select: { id: true }, where: { leftAt: null }, orderBy: { createdAt: 'asc' } } } });
    if (!n || n.deletedAt) return [];
    return [{ ...networkView(n, n.businesses.map((b) => b.id)), deleted: Boolean(n.deletedAt) }];
  }

  /**
   * Этап 21 «network+reports»: `src/api/network.ts::listPriceLockedServiceIds` — обратная сторона
   * `NetworkServiceLock.priceLocked` (F-11-082) для экрана «Услуги» ФИЛИАЛА (не панели сети — `network-business.controller.ts`,
   * гейт обычный `services.view`, не `NetworkAccessService`). Ключ — тот же `nameKeyOf`, что у самого лока
   * выше (НЕ мокового `serviceKeyOf`, который не приводит регистр — иначе свои же локи не совпали бы).
   * «≥2 тёзок в сети» повторяет мок 1:1: одиночная услуга с тем же именем не считается сетевой, лок на неё не действует.
   */
  async listPriceLockedServiceIdsForBusiness(businessId: string): Promise<string[]> {
    const biz = await this.prisma.business.findUnique({ where: { id: businessId }, select: { networkId: true } });
    if (!biz?.networkId) return [];
    const locks = await this.prisma.networkServiceLock.findMany({ where: { networkId: biz.networkId, priceLocked: true }, select: { key: true } });
    if (!locks.length) return [];
    const lockedKeys = new Set(locks.map((l) => l.key));
    const network = await this.prisma.network.findUnique({ where: { id: biz.networkId }, include: { businesses: { where: { leftAt: null }, select: { id: true } } } });
    const networkBusinessIds = network?.businesses.map((b) => b.id) ?? [];
    if (!networkBusinessIds.length) return [];
    const services = await this.prisma.service.findMany({ where: { businessId: { in: networkBusinessIds } }, select: { id: true, businessId: true, name: true } });
    const siblingCount = new Map<string, number>();
    for (const s of services) {
      const key = nameKeyOf(s.name);
      siblingCount.set(key, (siblingCount.get(key) ?? 0) + 1);
    }
    return services.filter((s) => s.businessId === businessId && lockedKeys.has(nameKeyOf(s.name)) && (siblingCount.get(nameKeyOf(s.name)) ?? 0) >= 2).map((s) => s.id);
  }
}

function fieldOut(f: { id: string; networkId: string; kind: string; name: string; dataType: string; apiKey: string; listOptions: unknown; editableByUser: boolean; showInAdmin: boolean; alwaysShowInBookingWindow: boolean; requiredOnCreate: boolean; requiredOnArrived: boolean; alwaysShowInClientCard: boolean; showInWidget: boolean; requiredInWidget: boolean; businessIds: unknown; createdAt: Date }) {
  return { ...f, listOptions: Array.isArray(f.listOptions) ? f.listOptions : [], businessIds: Array.isArray(f.businessIds) ? f.businessIds : [], createdAt: f.createdAt.toISOString() };
}

@ApiTags('network')
@Controller('v1/net/:networkId')
@Authed()
export class NetworkCatalogController {
  constructor(private readonly svc: NetworkCatalogService) {}

  @Get('service-categories')
  listServiceCategories(@Ctx() ctx: RequestContext, @Param('networkId') n: string) {
    return this.svc.listServiceCategories(ctx, n);
  }

  @Get('service-categories/:key')
  getServiceCategory(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Param('key') key: string) {
    return this.svc.getServiceCategory(ctx, n, key);
  }

  @Post('service-categories')
  @ApiOperation({ summary: 'Сохранить сетевую категорию услуг (F-11-080)' })
  @ZodBody(networkServiceCategoryBody)
  saveServiceCategory(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Body(new Zod(networkServiceCategoryBody)) body: z.infer<typeof networkServiceCategoryBody>) {
    return this.svc.saveServiceCategory(ctx, n, body);
  }

  @Get('services/:key')
  getService(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Param('key') key: string) {
    return this.svc.getService(ctx, n, key);
  }

  @Post('services')
  @ApiOperation({ summary: 'Сохранить сетевую услугу (F-11-081…083)' })
  @ZodBody(networkServiceBody)
  saveService(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Body(new Zod(networkServiceBody)) body: z.infer<typeof networkServiceBody>) {
    return this.svc.saveService(ctx, n, body);
  }

  @Post('services/:key/sync')
  @ApiOperation({ summary: 'Синхронизировать услугу по филиалам (F-11-090)' })
  @ZodBody(businessIdsBody)
  sync(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Param('key') key: string, @Body(new Zod(businessIdsBody)) body: z.infer<typeof businessIdsBody>) {
    return this.svc.syncServiceToLocations(ctx, n, key, body.businessIds);
  }

  @Get('goods-categories')
  listGoodsCategories(@Ctx() ctx: RequestContext, @Param('networkId') n: string) {
    return this.svc.listGoodsCategories(ctx, n);
  }

  @Post('goods-categories')
  @ZodBody(networkGoodsCategoryBody)
  saveGoodsCategory(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Body(new Zod(networkGoodsCategoryBody)) body: z.infer<typeof networkGoodsCategoryBody>) {
    return this.svc.saveGoodsCategory(ctx, n, body);
  }

  @Get('goods/:groupId')
  getGoodsProduct(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Param('groupId') id: string) {
    return this.svc.getGoodsProduct(ctx, n, id);
  }

  @Post('goods')
  @ApiOperation({ summary: 'Сохранить сетевой товар (F-11-113)' })
  @ZodBody(networkGoodsProductBody)
  saveGoods(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Body(new Zod(networkGoodsProductBody)) body: z.infer<typeof networkGoodsProductBody>) {
    return this.svc.saveGoodsProduct(ctx, n, body);
  }

  @Post('goods/migrate')
  @ApiOperation({ summary: 'Миграция товаров филиала в сеть (F-11-116)' })
  @ZodBody(migrateGoodsBody)
  migrateGoods(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Body(new Zod(migrateGoodsBody)) body: z.infer<typeof migrateGoodsBody>) {
    return this.svc.migrateGoodsToNetwork(ctx, n, body);
  }

  @Get('positions')
  listPositions(@Ctx() ctx: RequestContext, @Param('networkId') n: string) {
    return this.svc.listPositions(ctx, n);
  }

  @Post('positions')
  @ZodBody(networkPositionBody)
  addPosition(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Body(new Zod(networkPositionBody)) body: z.infer<typeof networkPositionBody>) {
    return this.svc.savePosition(ctx, n, undefined, body);
  }

  @Patch('positions/:id')
  @ZodBody(networkPositionBody)
  renamePosition(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Param('id') id: string, @Body(new Zod(networkPositionBody)) body: z.infer<typeof networkPositionBody>) {
    return this.svc.savePosition(ctx, n, id, body);
  }

  @Delete('positions/:id')
  async deletePosition(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Param('id') id: string) {
    await this.svc.deletePosition(ctx, n, id);
    return { ok: true as const };
  }

  @Get('staff')
  @ApiOperation({ summary: 'Сводный список сотрудников сети, только чтение' })
  listStaff(@Ctx() ctx: RequestContext, @Param('networkId') n: string) {
    return this.svc.listStaff(ctx, n);
  }

  @Get('fields')
  listFields(@Ctx() ctx: RequestContext, @Param('networkId') n: string) {
    return this.svc.listFields(ctx, n);
  }

  @Post('fields')
  @ApiOperation({ summary: 'Поле записи/клиента сети (F-11-126…134)' })
  @ZodBody(networkFieldBody)
  addField(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Body(new Zod(networkFieldBody)) body: z.infer<typeof networkFieldBody>) {
    return this.svc.saveField(ctx, n, undefined, body);
  }

  @Patch('fields/:id')
  @ZodBody(networkFieldBody)
  editField(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Param('id') id: string, @Body(new Zod(networkFieldBody)) body: z.infer<typeof networkFieldBody>) {
    return this.svc.saveField(ctx, n, id, body);
  }

  @Delete('fields/:id')
  async deleteField(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Param('id') id: string) {
    await this.svc.deleteField(ctx, n, id);
    return { ok: true as const };
  }
}
