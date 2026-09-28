import { Body, Controller, Delete, Get, Injectable, Param, Patch, Post, Put, Query } from '@nestjs/common';
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
import { utcToLocal, utcToLocalDate } from '../../common/time/time.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { goodView } from '../stock/stock-catalog.service.js';
import { businessView, locationView, networkView, staffView } from '../businesses/views.js';
import { NetworkAccessService } from './network-access.service.js';
import {
  businessIdsBody,
  migrateGoodsBody,
  networkFieldBody,
  networkGoodsCategoryBody,
  networkGoodsProductBody,
  networkLocationsOrderBody,
  networkOffDayTypeBody,
  networkPositionBody,
  networkPositionDefBody,
  networkServiceBody,
  networkServiceCategoryBody,
  networkStaffOrderBody,
  networkStaffQuery,
  networkSubdivisionBody,
  staffMergeBody,
  staffMigrateBody,
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

  /**
   * Этап 21 «network+reports»: `src/api/network.ts::getNetworkGoodsCategoryDetail` — карточка категории
   * (F-11-112, вкладка «Филиалы»): businessIds — те филиалы сети, где УЖЕ есть stock-категория с тем же
   * именем (мок сравнивает по `c.name === cat.name`, 1:1 здесь по колонке `StockCategory.name`).
   */
  async getGoodsCategoryDetail(ctx: RequestContext, networkId: string, id: string) {
    const { network } = await this.access.require(ctx, networkId, 'goods');
    const cat = await this.prisma.networkGoodsCategoryLink.findFirst({ where: { id, networkId } });
    if (!cat) throw new ApiError('not_found', 'Category not found');
    if (!network.businessIds.length) return { ...cat, businessIds: [] };
    const matches = await this.prisma.stockCategory.findMany({ where: { businessId: { in: network.businessIds }, name: cat.name }, select: { businessId: true } });
    return { ...cat, businessIds: matches.map((m) => m.businessId) };
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

  /**
   * Этап 21 «network+reports»: `src/api/network.ts::getNetworkGoodsProduct` ждёт полный `Good` (карточка
   * товара на фронте показывает единицы/налог/остатки полями `Good`, не только цену) — `goodView()` уже
   * построен модулем «Склад» (`stock-catalog.service.ts`) для тех же Product-строк, переиспользован как есть.
   */
  async getGoodsProduct(ctx: RequestContext, networkId: string, groupId: string) {
    const { network } = await this.access.require(ctx, networkId, 'goods');
    const rows = await this.prisma.product.findMany({ where: { businessId: { in: network.businessIds }, OR: [{ networkGroupId: groupId }, { id: groupId }] } });
    if (!rows.length) throw new ApiError('not_found', 'Good not found');
    const source = rows.find((r) => r.isNetworkSource) ?? rows[0]!;
    return { key: source.id, good: goodView(source), businessIds: rows.map((r) => r.businessId) };
  }

  /** Этап 21 «network+reports» попытка 2 (мок `searchNetworkGoods`): построчный поиск, не группировка по имени —
   * LIKE по трём полям, до 50 строк (та же граница, что мок `.slice(0, 50)`); коллация БД уже без учёта регистра
   * (utf8mb4_unicode_ci, см. миграции), второй `.toLowerCase()` не нужен. */
  async searchGoods(ctx: RequestContext, networkId: string, q: string) {
    const { network } = await this.access.require(ctx, networkId, 'goods');
    const needle = q.trim();
    const rows = await this.prisma.product.findMany({
      where: {
        businessId: { in: network.businessIds },
        archived: false,
        ...(needle ? { OR: [{ name: { contains: needle } }, { sku: { contains: needle } }, { barcode: { contains: needle } }] } : {}),
      },
      take: 50,
      orderBy: { name: 'asc' },
    });
    return rows.map(goodView);
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

  // ───────────────────────── Архив товаров сети (F-11-114/117/118), этап 21 попытка 3 ─────────────────────────

  private async goodUsedInTechCard(goodId: string): Promise<boolean> {
    const cards = await this.prisma.techCard.findMany({ select: { lines: true } });
    return cards.some((c) => Array.isArray(c.lines) && (c.lines as { goodId: string }[]).some((l) => l.goodId === goodId));
  }

  /** F-11-114 (мок `addAllGoodsToLocation`): копирует в целевой филиал каждый сетевой товар, которого там ещё нет */
  async addAllGoodsToLocation(ctx: RequestContext, networkId: string, targetBusinessId: string) {
    const { network } = await this.access.require(ctx, networkId, 'goods');
    if (!network.businessIds.includes(targetBusinessId)) throw new ApiError('validation', 'business not in network');
    const sourceGoods = await this.prisma.product.findMany({ where: { businessId: { in: network.businessIds.filter((id) => id !== targetBusinessId) }, isNetworkSource: true, archived: false } });
    const existing = await this.prisma.product.findMany({ where: { businessId: targetBusinessId }, select: { networkGroupId: true } });
    const existingGroups = new Set(existing.map((e) => e.networkGroupId).filter((v): v is string => Boolean(v)));
    let added = 0;
    for (const g of sourceGoods) {
      const groupId = g.networkGroupId ?? g.id;
      if (existingGroups.has(groupId)) continue;
      const copy = await this.copyGoodToBusiness(ctx, g.id, targetBusinessId);
      if (copy) {
        existingGroups.add(groupId);
        added += 1;
      }
    }
    return { added };
  }

  /** F-11-114/118 (мок `archiveNetworkGoods`): архивировать сетевой товар во ВСЕХ филиалах, где он есть */
  async archiveNetworkGoods(ctx: RequestContext, networkId: string, groupIds: string[]) {
    const { network } = await this.access.require(ctx, networkId, 'goods');
    for (const groupId of groupIds) {
      const rows = await this.prisma.product.findMany({ where: { businessId: { in: network.businessIds }, archived: false, OR: [{ networkGroupId: groupId }, { id: groupId }] } });
      if (!rows.length) continue;
      const archivable = (await Promise.all(rows.map(async (r) => ((await this.goodUsedInTechCard(r.id)) ? null : r)))).filter((r): r is (typeof rows)[number] => Boolean(r));
      if (!archivable.length) continue;
      await this.prisma.$transaction(async (tx) => {
        for (const r of archivable) await tx.product.update({ where: { id: r.id }, data: { archived: true, updatedBy: ctx.session!.userId, version: { increment: 1 } } });
        await tx.networkGoodsArchiveEntry.create({ data: { id: newId('networkGoodsArchiveEntry'), networkId, kind: 'good', name: archivable[0]!.name } });
        await this.audit.record(tx, ctx, { action: 'archive', entityType: 'networkGoods', entityId: groupId, networkId, after: { name: archivable[0]!.name, count: archivable.length } });
      });
    }
  }

  /** F-11-118 (мок `listNetworkGoodsArchive`): «Восстановить» доступно, только пока товар с тем же именем ещё сетевой (2+ филиала) */
  async listGoodsArchive(ctx: RequestContext, networkId: string) {
    const { network } = await this.access.require(ctx, networkId, 'goods');
    const rows = await this.prisma.networkGoodsArchiveEntry.findMany({ where: { networkId }, orderBy: { archivedAt: 'desc' } });
    if (!rows.length) return [];
    const names = [...new Set(rows.map((r) => r.name))];
    const counts = new Map<string, number>();
    if (network.businessIds.length) {
      const active = await this.prisma.product.findMany({ where: { businessId: { in: network.businessIds }, archived: false, name: { in: names } }, select: { name: true } });
      for (const a of active) counts.set(a.name, (counts.get(a.name) ?? 0) + 1);
    }
    return rows.map((r) => ({ id: r.id, networkId: r.networkId, kind: r.kind as 'category' | 'good', name: r.name, archivedAt: utcToLocal(r.archivedAt), restorable: (counts.get(r.name) ?? 0) >= 2 }));
  }

  /** F-11-118 (мок `restoreNetworkGoods`): восстановить по ИМЕНИ во всех филиалах сети + снять из архива */
  async restoreGoodsByName(ctx: RequestContext, networkId: string, name: string) {
    const { network } = await this.access.require(ctx, networkId, 'goods');
    const rows = await this.prisma.product.findMany({ where: { businessId: { in: network.businessIds }, archived: true, name } });
    await this.prisma.$transaction(async (tx) => {
      for (const r of rows) {
        const category = await tx.stockCategory.findUnique({ where: { id: r.categoryId } });
        const nameTaken = category?.archived ? false : await tx.product.count({ where: { businessId: r.businessId, locationId: r.locationId, archived: false, name: r.name, id: { not: r.id } } });
        await tx.product.update({ where: { id: r.id }, data: { archived: false, updatedBy: ctx.session!.userId, version: { increment: 1 }, name: nameTaken && !r.name.endsWith('[Восстановлено]') ? `${r.name} [Восстановлено]` : r.name } });
      }
      await tx.networkGoodsArchiveEntry.deleteMany({ where: { networkId, name } });
      await this.audit.record(tx, ctx, { action: 'restore', entityType: 'networkGoods', entityId: name, networkId, after: { count: rows.length } });
    });
  }

  /** F-11-118 (мок `deleteNetworkGoodsArchiveEntry`): убрать строку архива, товары не трогает */
  async deleteGoodsArchiveEntry(ctx: RequestContext, networkId: string, id: string) {
    await this.access.require(ctx, networkId, 'goods');
    await this.prisma.networkGoodsArchiveEntry.deleteMany({ where: { id, networkId } });
  }

  /** F-11-117 (мок `mergeGoodIntoNetworkGroup`): локальный товар филиала объединяется с сетевым (настройки — с сетевого) */
  async mergeGoodIntoNetworkGroup(ctx: RequestContext, networkId: string, localGoodId: string, networkGroupId: string) {
    const { network } = await this.access.require(ctx, networkId, 'goods');
    const local = await this.prisma.product.findFirst({ where: { id: localGoodId, businessId: { in: network.businessIds } } });
    const source = await this.prisma.product.findFirst({ where: { id: networkGroupId, businessId: { in: network.businessIds } } });
    if (!local || !source) throw new ApiError('not_found', 'Good not found');
    await this.prisma.product.update({
      where: { id: local.id },
      data: {
        name: source.name,
        saleUnit: source.saleUnit,
        writeoffUnit: source.writeoffUnit,
        unitRatio: source.unitRatio,
        taxSystem: source.taxSystem,
        taxRate: source.taxRate,
        showToClients: source.showToClients,
        clientName: source.clientName ?? undefined,
        networkGroupId: source.networkGroupId ?? source.id,
        isNetworkSource: false,
        updatedBy: ctx.session!.userId,
        version: { increment: 1 },
      },
    });
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

  /**
   * Этап 21 «network+reports»: `src/api/network.ts::listNetworkStaff` — мок фильтрует ЯВНО (по умолчанию,
   * без фильтров, отдаёт ВСЕХ, включая уволенных/удалённых — `StaffMigrationScreen` зовёт `{status:'all',
   * fired:'all'}` именно за этим, `StaffScreen` — реальными значениями из своих `Select`). Раньше маршрут
   * жёстко резал `deletedAt:null, status<>fired` — уволенных для миграции было не найти никогда. Теперь
   * фильтрация — только по явным `filters`, 1:1 с мок-веткой; `deletedAt: null` остаётся всегда (жёсткое
   * удаление строки, не бизнес-статус `disabled`). Вид строки — тот же `staffView()`, что и у обычного
   * списка сотрудников бизнеса (`services.service.ts`/`resources.service.ts`) — экран (`StaffScreen.tsx`)
   * читает `avatarUrl`/`position` (LocalizedText, не строку) через `pickText`, слепая DTO их бы не дала.
   */
  async listStaff(ctx: RequestContext, networkId: string, filters: z.infer<typeof networkStaffQuery> = {}) {
    const { network } = await this.access.require(ctx, networkId, 'staff');
    if (!network.businessIds.length) return [];
    const rows = await this.prisma.staff.findMany({ where: { businessId: { in: network.businessIds }, deletedAt: null }, include: { locations: { select: { locationId: true } } }, orderBy: { name: 'asc' } });
    const filtered = rows.filter((s) => {
      if (filters.status === 'active' && s.status !== 'active' && s.status !== 'invited') return false;
      if (filters.status === 'deleted' && s.status !== 'disabled') return false;
      if (filters.fired === 'fired' && s.status !== 'fired') return false;
      if (filters.fired === 'working' && s.status === 'fired') return false;
      if (filters.positionId && (s.position as LocalizedText | null)?.ru !== filters.positionId) return false;
      return true;
    });
    return filtered.map((s) => staffView(s));
  }

  /** Этап 21 «network+reports», попытка 3: мок `staffKeyOf` — сотрудник опознаётся по ИМЕНИ через филиалы сети */
  private staffKeyOf(name: string): string {
    return name.trim();
  }

  /**
   * F-11-102 (мок `migrateStaffToNetwork`): «Перенести всех»/одного мастера из филиала в остальные филиалы
   * сети — копия по ИМЕНИ (тот же ключ, что и весь раздел «Сотрудники сети»), не трогает исходника. Уже
   * присутствующий в целевом филиале (то же имя) пропускается — идемпотентно, как в моке.
   */
  async migrateStaff(ctx: RequestContext, networkId: string, input: z.infer<typeof staffMigrateBody>) {
    const { network } = await this.access.require(ctx, networkId, 'migrations');
    if (!network.businessIds.includes(input.fromBusinessId)) throw new ApiError('validation', 'business not in network');
    const targets = network.businessIds.filter((id) => id !== input.fromBusinessId);
    if (!targets.length) return { moved: 0 };
    const source = await this.prisma.staff.findMany({ where: { businessId: input.fromBusinessId, deletedAt: null, status: { not: 'disabled' }, ...(input.staffIds === 'all' ? {} : { id: { in: input.staffIds } }) } });
    if (!source.length) return { moved: 0 };
    const existingRows = await this.prisma.staff.findMany({ where: { businessId: { in: targets }, deletedAt: null }, select: { businessId: true, name: true } });
    const existingKeys = new Set(existingRows.map((r) => `${r.businessId}\u0000${this.staffKeyOf(r.name)}`));
    const locByBiz = new Map<string, string>();
    for (const businessId of targets) {
      const loc = await this.prisma.location.findFirst({ where: { businessId, deletedAt: null }, orderBy: { sortOrder: 'asc' }, select: { id: true } });
      if (loc) locByBiz.set(businessId, loc.id);
    }
    let moved = 0;
    const today = utcToLocalDate(new Date());
    await this.prisma.$transaction(async (tx) => {
      for (const s of source) {
        for (const businessId of targets) {
          if (existingKeys.has(`${businessId}\u0000${this.staffKeyOf(s.name)}`)) continue;
          const siblings = await tx.staff.count({ where: { businessId } });
          const locationId = locByBiz.get(businessId);
          await tx.staff.create({
            data: {
              id: newId('staff'),
              businessId,
              name: s.name,
              phone: s.phone,
              email: s.email,
              role: s.role,
              position: s.position ?? undefined,
              sphereIds: s.sphereIds as Prisma.InputJsonValue,
              avatarUrl: s.avatarUrl,
              bio: s.bio ?? undefined,
              photos: [],
              materials: [],
              workplaces: s.workplaces as Prisma.InputJsonValue,
              accepts: s.accepts,
              calendarVisibility: s.calendarVisibility,
              calendarMode: s.calendarMode,
              confirmMode: s.confirmMode,
              colorIndex: s.colorIndex,
              serviceIds: [],
              status: 'active',
              hiredAt: today,
              sortOrder: siblings,
              createdBy: ctx.session!.userId,
              updatedBy: ctx.session!.userId,
              ...(locationId ? { locations: { create: [{ locationId }] } } : {}),
            },
          });
          moved += 1;
        }
      }
      await this.audit.record(tx, ctx, { action: 'update', entityType: 'networkStaff', entityId: input.fromBusinessId, networkId, after: { moved } });
    });
    return { moved };
  }

  /**
   * F-11-103 (мок `mergeNetworkStaff`): «Объединить» дубли — все строки с ключами `keys` (кроме ведущей)
   * получают имя/должность/описание ведущей (`primaryKey`), сами строки не удаляются (как в моке — правится
   * карточка, а не список сотрудников).
   */
  async mergeStaff(ctx: RequestContext, networkId: string, input: z.infer<typeof staffMergeBody>) {
    const { network } = await this.access.require(ctx, networkId, 'migrations');
    if (!network.businessIds.length) throw new ApiError('not_found', 'Network has no locations');
    const rows = await this.prisma.staff.findMany({ where: { businessId: { in: network.businessIds }, deletedAt: null } });
    const primaryRow = rows.find((s) => this.staffKeyOf(s.name) === input.primaryKey);
    if (!primaryRow) throw new ApiError('not_found', 'Primary staff not found');
    await this.prisma.$transaction(async (tx) => {
      for (const key of input.keys) {
        if (key === input.primaryKey) continue;
        const matching = rows.filter((s) => this.staffKeyOf(s.name) === key);
        for (const r of matching) {
          await tx.staff.update({ where: { id: r.id }, data: { name: primaryRow.name, position: primaryRow.position ?? undefined, bio: primaryRow.bio ?? undefined, version: { increment: 1 } } });
        }
      }
      await this.audit.record(tx, ctx, { action: 'update', entityType: 'networkStaff', entityId: primaryRow.id, networkId, after: { mergedInto: input.primaryKey, keys: input.keys } });
    });
    return { key: this.staffKeyOf(primaryRow.name) };
  }

  // ───────────────────────── Сетевые должности, полная форма (F-11-104…106) ─────────────────────────
  // NetworkPosition фронта — НЕ то же, что Position.networkId выше (простая должность-строка): требования,
  // «только в сети», услуги должности, филиалы. Своя таблица NetworkPositionDef (этап 21, попытка 3).

  async listPositionDefs(ctx: RequestContext, networkId: string) {
    await this.access.require(ctx, networkId, 'staff');
    const rows = await this.prisma.networkPositionDef.findMany({ where: { networkId }, orderBy: { createdAt: 'asc' } });
    return rows.map(positionDefOut);
  }

  async savePositionDef(ctx: RequestContext, networkId: string, id: string | undefined, input: z.infer<typeof networkPositionDefBody>) {
    const { network } = await this.access.require(ctx, networkId, 'staff');
    const name = input.name.trim();
    if (!name) throw new ApiError('bad_name', 'Name required');
    const businessIds = input.businessIds.filter((bid) => network.businessIds.includes(bid));
    const data = {
      name,
      description: input.description,
      requirements: input.requirements,
      networkOnly: input.networkOnly,
      businessIds,
      servicesMode: input.servicesMode,
      serviceIds: input.serviceIds,
      keepPriceAndDuration: input.keepPriceAndDuration,
    };
    if (id) {
      const existing = await this.prisma.networkPositionDef.findFirst({ where: { id, networkId } });
      if (!existing) throw new ApiError('not_found', 'Position not found');
      const row = await this.prisma.networkPositionDef.update({ where: { id }, data: { ...data, updatedBy: ctx.session!.userId, version: { increment: 1 } } });
      return positionDefOut(row);
    }
    const row = await this.prisma.networkPositionDef.create({ data: { id: newId('networkPositionDef'), networkId, ...data, createdBy: ctx.session!.userId, updatedBy: ctx.session!.userId } });
    return positionDefOut(row);
  }

  async deletePositionDef(ctx: RequestContext, networkId: string, id: string) {
    await this.access.require(ctx, networkId, 'staff');
    const row = await this.prisma.networkPositionDef.findFirst({ where: { id, networkId } });
    if (!row) return;
    await this.prisma.networkPositionDef.delete({ where: { id } });
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

  // ───────────────────────── Этап 21 «network+reports»: подразделения (F-11-080) ─────────────────────────

  async listSubdivisions(ctx: RequestContext, networkId: string) {
    await this.access.require(ctx, networkId, 'subdivisions');
    const rows = await this.prisma.networkSubdivision.findMany({ where: { networkId }, orderBy: { createdAt: 'asc' } });
    return rows.map((r) => ({ id: r.id, networkId: r.networkId, name: r.name, categoryIds: Array.isArray(r.categoryIds) ? (r.categoryIds as string[]) : [] }));
  }

  async createSubdivision(ctx: RequestContext, networkId: string, input: z.infer<typeof networkSubdivisionBody>) {
    await this.access.require(ctx, networkId, 'subdivisions');
    const name = input.name.trim();
    if (!name) throw new ApiError('validation', 'name required');
    const row = await this.prisma.networkSubdivision.create({ data: { id: newId('networkSubdivision'), networkId, name, categoryIds: [], createdBy: ctx.session!.userId } });
    return { id: row.id, networkId: row.networkId, name: row.name, categoryIds: [] as string[] };
  }

  // ───────────────────────── Этап 21 «network+reports»: типы нерабочих дней сети (F-11-108) ─────────────────────────

  async listOffDayTypes(ctx: RequestContext, networkId: string) {
    await this.access.require(ctx, networkId, 'staff');
    const rows = await this.prisma.networkOffDayType.findMany({ where: { networkId }, orderBy: { createdAt: 'asc' } });
    return rows.map(offDayTypeOut);
  }

  async saveOffDayType(ctx: RequestContext, networkId: string, id: string | undefined, input: z.infer<typeof networkOffDayTypeBody>) {
    const { network } = await this.access.require(ctx, networkId, 'staff');
    const name = input.name.trim();
    if (!name) throw new ApiError('validation', 'name required');
    const businessIds = input.businessIds.filter((bid) => network.businessIds.includes(bid));
    if (id) {
      const existing = await this.prisma.networkOffDayType.findFirst({ where: { id, networkId } });
      if (!existing) throw new ApiError('not_found', 'Off-day type not found');
      const row = await this.prisma.networkOffDayType.update({ where: { id }, data: { name, comment: input.comment, colorIndex: input.colorIndex, businessIds } });
      return offDayTypeOut(row);
    }
    const row = await this.prisma.networkOffDayType.create({ data: { id: newId('networkOffDayType'), networkId, name, comment: input.comment, colorIndex: input.colorIndex, businessIds, createdBy: ctx.session!.userId } });
    return offDayTypeOut(row);
  }

  async deleteOffDayType(ctx: RequestContext, networkId: string, id: string) {
    await this.access.require(ctx, networkId, 'staff');
    const row = await this.prisma.networkOffDayType.findFirst({ where: { id, networkId } });
    if (!row) return;
    await this.prisma.networkOffDayType.delete({ where: { id } });
  }

  // ───────────────────────── Этап 21 «network+reports»: порядок сотрудников сети (F-11-100) ─────────────────────────

  async getStaffOrder(ctx: RequestContext, networkId: string): Promise<string[]> {
    await this.access.require(ctx, networkId, 'staff');
    const row = await this.prisma.networkStaffOrder.findUnique({ where: { networkId } });
    return Array.isArray(row?.orderedKeys) ? (row!.orderedKeys as string[]) : [];
  }

  async setStaffOrder(ctx: RequestContext, networkId: string, orderedKeys: string[]): Promise<void> {
    await this.access.require(ctx, networkId, 'staff');
    await this.prisma.networkStaffOrder.upsert({
      where: { networkId },
      create: { networkId, orderedKeys, updatedBy: ctx.session!.userId },
      update: { orderedKeys, updatedBy: ctx.session!.userId },
    });
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

  /**
   * Этап 21 «network+reports», попытка 3: `src/api/network.ts::listNetworkLocations` (F-11-016) — список
   * «Локации» настроек сети, в СОХРАНЁННОМ порядке. Порядка у Business/Network своего нет (мок держит его в
   * своём срезе `extras[networkId].order`) — здесь своя таблица `NetworkLocationOrder` (как `NetworkStaffOrder`
   * рядом); неизвестные/новые филиалы дописываются в конец, как в моке `orderOf()`.
   */
  async locations(ctx: RequestContext, networkId: string) {
    const { network } = await this.access.require(ctx, networkId, 'settings');
    if (!network.businessIds.length) return [];
    const orderRow = await this.prisma.networkLocationOrder.findUnique({ where: { networkId } });
    const saved = Array.isArray(orderRow?.orderedIds) ? (orderRow!.orderedIds as string[]) : [];
    const known = saved.filter((id) => network.businessIds.includes(id));
    const missing = network.businessIds.filter((id) => !known.includes(id));
    const order = [...known, ...missing];
    const businesses = await this.prisma.business.findMany({ where: { id: { in: order } } });
    const businessById = new Map(businesses.map((b) => [b.id, b]));
    const locations = await this.prisma.location.findMany({ where: { businessId: { in: order }, deletedAt: null }, orderBy: { sortOrder: 'asc' } });
    const locByBiz = new Map<string, (typeof locations)[number]>();
    for (const l of locations) if (!locByBiz.has(l.businessId)) locByBiz.set(l.businessId, l);
    const subs = await this.prisma.subscription.findMany({ where: { businessId: { in: order } } });
    const subByBiz = new Map(subs.map((s) => [s.businessId, s]));
    const mainId = network.mainBusinessId ?? network.businessIds[0];
    return order
      .map((businessId) => businessById.get(businessId))
      .filter((b): b is NonNullable<typeof b> => Boolean(b))
      .map((business) => {
        const loc = locByBiz.get(business.id);
        const sub = subByBiz.get(business.id);
        return {
          business: businessView(business, loc ? [loc.id] : []),
          location: loc ? locationView(loc) : undefined,
          isMain: mainId === business.id,
          until: sub ? utcToLocalDate(sub.paidUntil) : undefined,
        };
      });
  }

  /** F-11-016: сохранить порядок филиалов (используется «Перетащить» в настройках сети) */
  async setLocationsOrder(ctx: RequestContext, networkId: string, orderedIds: string[]) {
    const { network } = await this.access.require(ctx, networkId, 'settings');
    const filtered = orderedIds.filter((id) => network.businessIds.includes(id));
    await this.prisma.networkLocationOrder.upsert({
      where: { networkId },
      create: { networkId, orderedIds: filtered, updatedBy: ctx.session!.userId },
      update: { orderedIds: filtered, updatedBy: ctx.session!.userId },
    });
  }
}

function fieldOut(f: { id: string; networkId: string; kind: string; name: string; dataType: string; apiKey: string; listOptions: unknown; editableByUser: boolean; showInAdmin: boolean; alwaysShowInBookingWindow: boolean; requiredOnCreate: boolean; requiredOnArrived: boolean; alwaysShowInClientCard: boolean; showInWidget: boolean; requiredInWidget: boolean; businessIds: unknown; createdAt: Date }) {
  return { ...f, listOptions: Array.isArray(f.listOptions) ? f.listOptions : [], businessIds: Array.isArray(f.businessIds) ? f.businessIds : [], createdAt: f.createdAt.toISOString() };
}

/** Этап 21 «network+reports»: F-11-108, форма `NetworkOffDayType` фронта */
function offDayTypeOut(o: { id: string; networkId: string; name: string; comment: string | null; colorIndex: number; businessIds: unknown }) {
  return { id: o.id, networkId: o.networkId, name: o.name, comment: o.comment ?? undefined, colorIndex: o.colorIndex, businessIds: Array.isArray(o.businessIds) ? (o.businessIds as string[]) : [] };
}

/** Этап 21 «network+reports», попытка 3: F-11-104…106, форма `NetworkPosition` фронта (не Position.networkId) */
function positionDefOut(p: {
  id: string;
  networkId: string;
  name: string;
  description: string | null;
  requirements: unknown;
  networkOnly: boolean;
  businessIds: unknown;
  servicesMode: string;
  serviceIds: unknown;
  keepPriceAndDuration: boolean;
  createdAt: Date;
}) {
  return {
    id: p.id,
    networkId: p.networkId,
    name: p.name,
    description: p.description ?? undefined,
    requirements: Array.isArray(p.requirements) ? (p.requirements as string[]) : [],
    networkOnly: p.networkOnly,
    businessIds: Array.isArray(p.businessIds) ? (p.businessIds as string[]) : [],
    servicesMode: p.servicesMode as 'off' | 'strict',
    serviceIds: Array.isArray(p.serviceIds) ? (p.serviceIds as string[]) : [],
    keepPriceAndDuration: p.keepPriceAndDuration,
    createdAt: utcToLocal(p.createdAt),
  };
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

  @Get('goods-categories/:id')
  @ApiOperation({ summary: 'Карточка сетевой категории товаров (F-11-112)' })
  getGoodsCategoryDetail(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Param('id') id: string) {
    return this.svc.getGoodsCategoryDetail(ctx, n, id);
  }

  @Post('goods-categories')
  @ZodBody(networkGoodsCategoryBody)
  saveGoodsCategory(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Body(new Zod(networkGoodsCategoryBody)) body: z.infer<typeof networkGoodsCategoryBody>) {
    return this.svc.saveGoodsCategory(ctx, n, body);
  }

  /** Этап 21 «network+reports» попытка 2 (мок `searchNetworkGoods`): построчный поиск по имени/SKU/штрихкоду —
   * СВОЙ маршрут (не группа по имени, как остальной каталог товаров сети выше), нужен экрану выбора товара в
   * окне записи (клиент несёт услугу + расходники ЛЮБОГО филиала сети). Регистрируется ДО `goods/:groupId`,
   * иначе `:groupId` съел бы `search` как id. */
  @Get('goods/search')
  searchGoods(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Query('q') q: string = '') {
    return this.svc.searchGoods(ctx, n, q);
  }

  /** Этап 21 «network+reports», попытка 3: `goods/archive` — тоже ДО `goods/:groupId`, иначе wildcard съест `archive` */
  @Get('goods/archive')
  @ApiOperation({ summary: 'Архив товаров сети (F-11-118)' })
  listGoodsArchive(@Ctx() ctx: RequestContext, @Param('networkId') n: string) {
    return this.svc.listGoodsArchive(ctx, n);
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

  @Post('goods/add-all-to-location')
  @ApiOperation({ summary: '«Добавить все товары в локацию» (F-11-114)' })
  @ZodBody(z.object({ targetBusinessId: z.string().max(32) }))
  addAllGoodsToLocation(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Body(new Zod(z.object({ targetBusinessId: z.string().max(32) }))) body: { targetBusinessId: string }) {
    return this.svc.addAllGoodsToLocation(ctx, n, body.targetBusinessId);
  }

  @Post('goods/archive')
  @ApiOperation({ summary: 'Архивировать сетевые товары во всех филиалах (F-11-114/118)' })
  @ZodBody(z.object({ groupIds: z.array(z.string().max(32)).min(1).max(200) }))
  async archiveGoods(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Body(new Zod(z.object({ groupIds: z.array(z.string().max(32)).min(1).max(200) }))) body: { groupIds: string[] }) {
    await this.svc.archiveNetworkGoods(ctx, n, body.groupIds);
    return { ok: true as const };
  }

  @Post('goods/archive/restore')
  @ApiOperation({ summary: 'Восстановить товар из архива сети по имени (F-11-118)' })
  @ZodBody(z.object({ name: z.string().max(200) }))
  async restoreGoodsArchive(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Body(new Zod(z.object({ name: z.string().max(200) }))) body: { name: string }) {
    await this.svc.restoreGoodsByName(ctx, n, body.name);
    return { ok: true as const };
  }

  @Delete('goods/archive/:id')
  async deleteGoodsArchiveEntry(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Param('id') id: string) {
    await this.svc.deleteGoodsArchiveEntry(ctx, n, id);
    return { ok: true as const };
  }

  @Post('goods/merge')
  @ApiOperation({ summary: 'Объединить локальный товар с сетевым (F-11-117)' })
  @ZodBody(z.object({ localGoodId: z.string().max(32), networkGroupId: z.string().max(32) }))
  async mergeGoodIntoNetworkGroup(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Body(new Zod(z.object({ localGoodId: z.string().max(32), networkGroupId: z.string().max(32) }))) body: { localGoodId: string; networkGroupId: string }) {
    await this.svc.mergeGoodIntoNetworkGroup(ctx, n, body.localGoodId, body.networkGroupId);
    return { ok: true as const };
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
  @ApiOperation({ summary: 'Сводный список сотрудников сети, только чтение (F-11-097)' })
  listStaff(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Query(new Zod(networkStaffQuery)) query: z.infer<typeof networkStaffQuery>) {
    return this.svc.listStaff(ctx, n, query);
  }

  @Get('staff-order')
  @ApiOperation({ summary: 'Порядок сотрудников сети (F-11-100)' })
  getStaffOrder(@Ctx() ctx: RequestContext, @Param('networkId') n: string) {
    return this.svc.getStaffOrder(ctx, n);
  }

  @Put('staff-order')
  @ZodBody(networkStaffOrderBody)
  async setStaffOrder(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Body(new Zod(networkStaffOrderBody)) body: z.infer<typeof networkStaffOrderBody>) {
    await this.svc.setStaffOrder(ctx, n, body.orderedKeys);
    return { ok: true as const };
  }

  @Get('subdivisions')
  @ApiOperation({ summary: 'Подразделения сети (F-11-080)' })
  listSubdivisions(@Ctx() ctx: RequestContext, @Param('networkId') n: string) {
    return this.svc.listSubdivisions(ctx, n);
  }

  @Post('subdivisions')
  @ZodBody(networkSubdivisionBody)
  createSubdivision(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Body(new Zod(networkSubdivisionBody)) body: z.infer<typeof networkSubdivisionBody>) {
    return this.svc.createSubdivision(ctx, n, body);
  }

  @Get('off-day-types')
  @ApiOperation({ summary: 'Типы нерабочих дней сети (F-11-108)' })
  listOffDayTypes(@Ctx() ctx: RequestContext, @Param('networkId') n: string) {
    return this.svc.listOffDayTypes(ctx, n);
  }

  @Post('off-day-types')
  @ZodBody(networkOffDayTypeBody)
  addOffDayType(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Body(new Zod(networkOffDayTypeBody)) body: z.infer<typeof networkOffDayTypeBody>) {
    return this.svc.saveOffDayType(ctx, n, undefined, body);
  }

  @Patch('off-day-types/:id')
  @ZodBody(networkOffDayTypeBody)
  editOffDayType(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Param('id') id: string, @Body(new Zod(networkOffDayTypeBody)) body: z.infer<typeof networkOffDayTypeBody>) {
    return this.svc.saveOffDayType(ctx, n, id, body);
  }

  @Delete('off-day-types/:id')
  async deleteOffDayType(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Param('id') id: string) {
    await this.svc.deleteOffDayType(ctx, n, id);
    return { ok: true as const };
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

  // ─────────── Этап 21 «network+reports», попытка 3 ───────────

  @Get('locations')
  @ApiOperation({ summary: 'Список «Локации» настроек сети, в сохранённом порядке (F-11-016)' })
  listLocations(@Ctx() ctx: RequestContext, @Param('networkId') n: string) {
    return this.svc.locations(ctx, n);
  }

  @Put('locations/order')
  @ApiOperation({ summary: 'Сохранить порядок филиалов (F-11-017)' })
  @ZodBody(networkLocationsOrderBody)
  async setLocationsOrder(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Body(new Zod(networkLocationsOrderBody)) body: z.infer<typeof networkLocationsOrderBody>) {
    await this.svc.setLocationsOrder(ctx, n, body.orderedIds);
    return { ok: true as const };
  }

  @Post('staff/migrate')
  @ApiOperation({ summary: '«Перенести всех»/одного мастера из филиала в сеть (F-11-102)' })
  @ZodBody(staffMigrateBody)
  migrateStaff(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Body(new Zod(staffMigrateBody)) body: z.infer<typeof staffMigrateBody>) {
    return this.svc.migrateStaff(ctx, n, body);
  }

  @Post('staff/merge')
  @ApiOperation({ summary: 'Объединить дубли сотрудников сети (F-11-103)' })
  @ZodBody(staffMergeBody)
  mergeStaff(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Body(new Zod(staffMergeBody)) body: z.infer<typeof staffMergeBody>) {
    return this.svc.mergeStaff(ctx, n, body);
  }

  @Get('position-defs')
  @ApiOperation({ summary: 'Сетевые должности, полная форма (F-11-104…106)' })
  listPositionDefs(@Ctx() ctx: RequestContext, @Param('networkId') n: string) {
    return this.svc.listPositionDefs(ctx, n);
  }

  @Post('position-defs')
  @ZodBody(networkPositionDefBody)
  addPositionDef(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Body(new Zod(networkPositionDefBody)) body: z.infer<typeof networkPositionDefBody>) {
    return this.svc.savePositionDef(ctx, n, undefined, body);
  }

  @Patch('position-defs/:id')
  @ZodBody(networkPositionDefBody)
  editPositionDef(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Param('id') id: string, @Body(new Zod(networkPositionDefBody)) body: z.infer<typeof networkPositionDefBody>) {
    return this.svc.savePositionDef(ctx, n, id, body);
  }

  @Delete('position-defs/:id')
  async deletePositionDef(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Param('id') id: string) {
    await this.svc.deletePositionDef(ctx, n, id);
    return { ok: true as const };
  }
}
