import { Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service.js';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { newId } from '../../common/ids/ids.js';
import { moneyToJson } from '../../common/money/money.js';
import { PrismaService } from '../../common/prisma.service.js';
import type {
  CategoryBody,
  CategoryPatchBody,
  EquipmentBody,
  GoodBody,
  GoodPatchBody,
  ReminderBody,
  StockSettingsPatchBody,
  WarehouseBody,
  WarehousePatchBody,
} from './stock.schemas.js';

const toDate = (d: string) => new Date(`${d}T00:00:00.000Z`);
const toDateOpt = (d: string | null | undefined) => (d === undefined ? undefined : d === null ? null : toDate(d));
const dateStr = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : undefined);

export const EXPIRY_WARNING_DAYS_DEFAULT = 14;

function warehouseView(r: { id: string; businessId: string; locationId: string; name: string; type: string; comment: string | null; order: number; ownerStaffId: string | null; version: number; createdAt: Date }) {
  return { id: r.id, businessId: r.businessId, locationId: r.locationId, name: r.name, type: r.type as 'writeoff' | 'sale', comment: r.comment ?? undefined, order: r.order, ownerStaffId: r.ownerStaffId ?? undefined, version: r.version, createdAt: r.createdAt.toISOString() };
}

function categoryView(r: { id: string; businessId: string; locationId: string; name: string; parentId: string | null; sku: string | null; comment: string | null; archived: boolean; version: number; createdAt: Date }) {
  return { id: r.id, businessId: r.businessId, locationId: r.locationId, name: r.name, parentId: r.parentId ?? undefined, sku: r.sku ?? undefined, comment: r.comment ?? undefined, archived: r.archived, version: r.version, createdAt: r.createdAt.toISOString() };
}

type ProductRow = {
  id: string;
  businessId: string;
  locationId: string;
  categoryId: string;
  name: string;
  receiptName: string | null;
  sku: string | null;
  barcode: string | null;
  markingCode: string | null;
  saleUnit: string;
  writeoffUnit: string;
  unitRatio: number;
  massNetG: number | null;
  massGrossG: number | null;
  salePrice: bigint;
  costPrice: bigint;
  taxSystem: string;
  taxRate: string;
  criticalStock: number;
  desiredStock: number;
  brand: string | null;
  shade: string | null;
  shadeColorIndex: number | null;
  expiryDate: Date | null;
  purchaseDate: Date | null;
  shelfLifeAfterOpenDays: number | null;
  showToClients: boolean;
  clientName: unknown;
  networkGroupId: string | null;
  isNetworkSource: boolean;
  comment: string | null;
  archived: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export function goodView(g: ProductRow) {
  return {
    id: g.id,
    businessId: g.businessId,
    locationId: g.locationId,
    categoryId: g.categoryId,
    name: g.name,
    receiptName: g.receiptName ?? undefined,
    sku: g.sku ?? undefined,
    barcode: g.barcode ?? undefined,
    markingCode: g.markingCode ?? undefined,
    saleUnit: g.saleUnit,
    writeoffUnit: g.writeoffUnit,
    unitRatio: g.unitRatio,
    massNetG: g.massNetG ?? undefined,
    massGrossG: g.massGrossG ?? undefined,
    salePrice: moneyToJson(g.salePrice),
    costPrice: moneyToJson(g.costPrice),
    taxSystem: g.taxSystem as 'default' | 'general',
    taxRate: g.taxRate as 'default' | 'rate20' | 'none',
    criticalStock: g.criticalStock,
    desiredStock: g.desiredStock,
    brand: g.brand ?? undefined,
    shade: g.shade ?? undefined,
    shadeColorIndex: g.shadeColorIndex ?? undefined,
    expiryDate: dateStr(g.expiryDate),
    purchaseDate: dateStr(g.purchaseDate),
    shelfLifeAfterOpenDays: g.shelfLifeAfterOpenDays ?? undefined,
    showToClients: g.showToClients,
    clientName: (g.clientName as Record<string, string> | null) ?? undefined,
    networkGroupId: g.networkGroupId ?? undefined,
    isNetworkSource: g.isNetworkSource,
    comment: g.comment ?? undefined,
    archived: g.archived,
    version: g.version,
    createdAt: g.createdAt.toISOString(),
    updatedAt: g.updatedAt?.toISOString(),
  };
}

/** F-00-140/b04: свежий / скоро истечёт / просрочен, по настраиваемому окну (StockSettings.expiryWarningDays) */
export function expiryFlag(expiryDate: string | undefined, today: string, warningDays: number): 'ok' | 'expiring' | 'expired' {
  if (!expiryDate) return 'ok';
  if (expiryDate < today) return 'expired';
  const days = (Date.parse(expiryDate) - Date.parse(today)) / 86_400_000;
  return days <= warningDays ? 'expiring' : 'ok';
}

function equipmentView(r: { id: string; businessId: string; locationId: string; name: string; category: string | null; purchaseDate: Date; warrantyUntil: Date | null; serviceIntervalMonths: number | null; lastServiceDate: Date | null; replaceReminderDate: Date | null; comment: string | null; archived: boolean; createdAt: Date }) {
  return {
    id: r.id,
    businessId: r.businessId,
    locationId: r.locationId,
    name: r.name,
    category: r.category ?? undefined,
    purchaseDate: dateStr(r.purchaseDate)!,
    warrantyUntil: dateStr(r.warrantyUntil),
    serviceIntervalMonths: r.serviceIntervalMonths ?? undefined,
    lastServiceDate: dateStr(r.lastServiceDate),
    replaceReminderDate: dateStr(r.replaceReminderDate),
    comment: r.comment ?? undefined,
    archived: r.archived,
    createdAt: r.createdAt.toISOString(),
  };
}

function reminderView(r: { id: string; businessId: string; locationId: string; staffId: string | null; text: string; date: Date; done: boolean; createdAt: Date }) {
  return { id: r.id, businessId: r.businessId, locationId: r.locationId, staffId: r.staffId ?? undefined, text: r.text, date: dateStr(r.date)!, done: r.done, createdAt: r.createdAt.toISOString() };
}

function settingsView(r: { businessId: string; costMethod: string; forbidOnShortage: boolean; expiryWarningDays: number; adsOptIn: boolean }) {
  return { businessId: r.businessId, costMethod: r.costMethod as 'lastPurchase' | 'average' | 'fromGoodSettings', forbidOnShortage: r.forbidOnShortage, expiryWarningDays: r.expiryWarningDays, adsOptIn: r.adsOptIn };
}

/**
 * Каталог склада (docs/backend/02-api.md §13, PLAN §6 №13): склады, категории, товары, оборудование,
 * напоминания, настройки. Остатки считаются здесь же (`computeLevels`) — агрегация по `stock_op_lines`,
 * как `computeLevels` мока (из истории документов, не отдельной мутируемой таблицей остатков): проще
 * держать в одной правде с документами и не гонять два места записи под одной транзакцией.
 */
@Injectable()
export class StockCatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Заводит склад «Расходники»/«Товары» на филиал без склада (F-08-009) — лениво, как ensureDefaults finance (этап 12) */
  async ensureDefaultWarehouses(businessId: string, locationId: string): Promise<void> {
    const has = await this.prisma.warehouse.count({ where: { businessId, locationId } });
    if (has > 0) return;
    await this.prisma.warehouse.createMany({
      data: [
        { id: newId('warehouse'), businessId, locationId, name: 'Расходники', type: 'writeoff', comment: 'Для учёта расходных материалов', order: 0, createdBy: 'system', updatedBy: 'system' },
        { id: newId('warehouse'), businessId, locationId, name: 'Товары', type: 'sale', comment: 'Для учёта продаж в магазине', order: 1, createdBy: 'system', updatedBy: 'system' },
      ],
    });
  }

  private async ensureRootCategory(businessId: string, locationId: string): Promise<void> {
    const has = await this.prisma.stockCategory.count({ where: { businessId, locationId } });
    if (has > 0) return;
    await this.prisma.stockCategory.create({ data: { id: newId('stockCategory'), businessId, locationId, name: 'Основные товары', createdBy: 'system', updatedBy: 'system' } });
  }

  async ensureSettings(businessId: string) {
    const row = await this.prisma.stockSettings.findUnique({ where: { businessId } });
    if (row) return row;
    // upsert, не create: два первых чтения раздела параллельно (каталог + настройки) ловили duplicate key → 500 (этап 21)
    return this.prisma.stockSettings.upsert({ where: { businessId }, create: { businessId }, update: {} });
  }

  // ─────────────────────────── Остатки ───────────────────────────

  /**
   * Остаток товара по каждому складу, в единицах продажи — сумма qtySale (+ приёмник move) по всем документам.
   * Два запроса без Prisma-`@relation` (схема этого проекта их почти не использует, FK — простые поля):
   * сперва документы бизнеса без отмены, потом их строки по товару.
   */
  async computeLevels(businessId: string, goodId: string): Promise<{ warehouseId: string; qty: number }[]> {
    const lines = await this.prisma.stockOpLine.findMany({ where: { businessId, goodId }, select: { qtySale: true, opId: true } });
    if (!lines.length) return [];
    const ops = await this.prisma.stockOp.findMany({ where: { id: { in: [...new Set(lines.map((l) => l.opId))] }, cancelledAt: null }, select: { id: true, warehouseId: true, toWarehouseId: true, type: true } });
    const opById = new Map(ops.map((o) => [o.id, o]));
    const byWarehouse = new Map<string, number>();
    for (const l of lines) {
      const op = opById.get(l.opId);
      if (!op) continue;
      byWarehouse.set(op.warehouseId, (byWarehouse.get(op.warehouseId) ?? 0) + l.qtySale);
      if (op.type === 'move' && op.toWarehouseId) {
        byWarehouse.set(op.toWarehouseId, (byWarehouse.get(op.toWarehouseId) ?? 0) + Math.abs(l.qtySale));
      }
    }
    return Array.from(byWarehouse.entries())
      .map(([warehouseId, qty]) => ({ warehouseId, qty: Math.round(qty * 1000) / 1000 }))
      .filter((l) => l.qty !== 0);
  }

  async totalStock(businessId: string, goodId: string): Promise<number> {
    return (await this.computeLevels(businessId, goodId)).reduce((s, l) => s + l.qty, 0);
  }

  async goodStockAt(businessId: string, goodId: string, warehouseId: string): Promise<number> {
    return (await this.computeLevels(businessId, goodId)).find((l) => l.warehouseId === warehouseId)?.qty ?? 0;
  }

  // ─────────────────────────── Склады (F-08-004…009) ───────────────────────────

  /** F-08-005…009: сколько товаров с ненулевым остатком лежит на каждом складе */
  async listWarehouses(businessId: string, locationId: string) {
    await this.ensureDefaultWarehouses(businessId, locationId);
    const rows = await this.prisma.warehouse.findMany({ where: { businessId, locationId }, orderBy: { order: 'asc' } });
    const goods = await this.prisma.product.findMany({ where: { businessId, locationId, archived: false }, select: { id: true } });
    const counts = new Map<string, number>();
    for (const g of goods) {
      const levels = await this.computeLevels(businessId, g.id);
      for (const l of levels) counts.set(l.warehouseId, (counts.get(l.warehouseId) ?? 0) + 1);
    }
    return rows.map((w) => ({ ...warehouseView(w), goodsCount: counts.get(w.id) ?? 0 }));
  }

  async getWarehouse(businessId: string, id: string) {
    const row = await this.prisma.warehouse.findFirst({ where: { id, businessId } });
    return row ? warehouseView(row) : undefined;
  }

  async createWarehouse(ctx: RequestContext, body: WarehouseBody) {
    const businessId = ctx.member!.businessId;
    const max = await this.prisma.warehouse.aggregate({ where: { businessId, locationId: body.locationId }, _max: { order: true } });
    const id = newId('warehouse');
    await this.prisma.$transaction(async (tx) => {
      await tx.warehouse.create({ data: { id, businessId, locationId: body.locationId, name: body.name, type: body.type, comment: body.comment, order: (max._max.order ?? -1) + 1, createdBy: ctx.member!.staffId, updatedBy: ctx.member!.staffId } });
      await this.audit.record(tx, ctx, { action: 'create', entityType: 'stockWarehouse', entityId: id, businessId, after: { name: body.name } });
    });
    return this.getWarehouse(businessId, id);
  }

  async updateWarehouse(ctx: RequestContext, id: string, patch: WarehousePatchBody) {
    const businessId = ctx.member!.businessId;
    const row = await this.prisma.warehouse.findFirst({ where: { id, businessId } });
    if (!row) throw new ApiError('not_found', 'Warehouse not found');
    const data: Record<string, unknown> = { updatedBy: ctx.member!.staffId, version: { increment: 1 } };
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.type !== undefined) data.type = patch.type;
    if (patch.locationId !== undefined) data.locationId = patch.locationId;
    if (patch.comment !== undefined) data.comment = patch.comment;
    await this.prisma.$transaction(async (tx) => {
      await tx.warehouse.update({ where: { id }, data });
      await this.audit.record(tx, ctx, { action: 'update', entityType: 'stockWarehouse', entityId: id, businessId, before: { name: row.name }, after: { name: patch.name ?? row.name } });
    });
    return this.getWarehouse(businessId, id);
  }

  /** F-08-008: удалить нельзя склад с остатком и последний склад филиала */
  async removeWarehouse(businessId: string, id: string) {
    const row = await this.prisma.warehouse.findFirst({ where: { id, businessId } });
    if (!row) throw new ApiError('not_found', 'Warehouse not found');
    const others = await this.prisma.warehouse.count({ where: { businessId, locationId: row.locationId } });
    if (others <= 1) throw new ApiError('last_warehouse', 'Cannot delete the only warehouse');
    const goods = await this.prisma.product.findMany({ where: { businessId, locationId: row.locationId }, select: { id: true } });
    for (const g of goods) {
      const level = await this.goodStockAt(businessId, g.id, id);
      if (level !== 0) throw new ApiError('warehouse_has_stock', 'Warehouse has stock');
    }
    await this.prisma.warehouse.delete({ where: { id } });
  }

  async reorderWarehouses(businessId: string, locationId: string, orderedIds: string[]) {
    await this.prisma.$transaction(orderedIds.map((id, i) => this.prisma.warehouse.updateMany({ where: { id, businessId, locationId }, data: { order: i } })));
  }

  // ─────────────────────────── Категории (F-08-010…014) ───────────────────────────

  async listCategoriesFlat(businessId: string, locationId: string, includeArchived = false) {
    await this.ensureRootCategory(businessId, locationId);
    return (
      await this.prisma.stockCategory.findMany({ where: { businessId, locationId, ...(includeArchived ? {} : { archived: false }) }, orderBy: { createdAt: 'asc' } })
    ).map(categoryView);
  }

  private inSubtree(categories: { id: string; parentId: string | null }[], rootId: string, id: string): boolean {
    if (id === rootId) return true;
    const cat = categories.find((c) => c.id === id);
    if (!cat?.parentId) return false;
    return this.inSubtree(categories, rootId, cat.parentId);
  }

  async listCategoryTree(businessId: string, locationId: string) {
    await this.ensureRootCategory(businessId, locationId);
    const own = await this.prisma.stockCategory.findMany({ where: { businessId, locationId, archived: false }, orderBy: { createdAt: 'asc' } });
    const goods = await this.prisma.product.findMany({ where: { businessId, locationId, archived: false }, select: { categoryId: true } });
    const build = (parentId: string | undefined): unknown[] =>
      own
        .filter((c) => (c.parentId ?? undefined) === parentId)
        .map((c) => ({ ...categoryView(c), goodsCount: goods.filter((g) => g.categoryId === c.id).length, children: build(c.id) }));
    return build(undefined);
  }

  async createCategory(ctx: RequestContext, body: CategoryBody) {
    const businessId = ctx.member!.businessId;
    if (body.parentId) {
      const parent = await this.prisma.stockCategory.findFirst({ where: { id: body.parentId, businessId } });
      if (!parent) throw new ApiError('not_found', 'Parent category not found');
    }
    const id = newId('stockCategory');
    await this.prisma.$transaction(async (tx) => {
      await tx.stockCategory.create({ data: { id, businessId, locationId: body.locationId, name: body.name, parentId: body.parentId, sku: body.sku, comment: body.comment, createdBy: ctx.member!.staffId, updatedBy: ctx.member!.staffId } });
      await this.audit.record(tx, ctx, { action: 'create', entityType: 'stockCategory', entityId: id, businessId, after: { name: body.name } });
    });
    return categoryView(await this.prisma.stockCategory.findUniqueOrThrow({ where: { id } }));
  }

  async updateCategory(ctx: RequestContext, id: string, patch: CategoryPatchBody) {
    const businessId = ctx.member!.businessId;
    const row = await this.prisma.stockCategory.findFirst({ where: { id, businessId } });
    if (!row) throw new ApiError('not_found', 'Category not found');
    if (patch.parentId === id) throw new ApiError('validation', 'Category cannot be its own parent');
    const data: Record<string, unknown> = { updatedBy: ctx.member!.staffId, version: { increment: 1 } };
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.parentId !== undefined) data.parentId = patch.parentId;
    if (patch.sku !== undefined) data.sku = patch.sku;
    if (patch.comment !== undefined) data.comment = patch.comment;
    await this.prisma.$transaction(async (tx) => {
      await tx.stockCategory.update({ where: { id }, data });
      await this.audit.record(tx, ctx, { action: 'update', entityType: 'stockCategory', entityId: id, businessId, before: { name: row.name }, after: { name: patch.name ?? row.name } });
    });
    return categoryView(await this.prisma.stockCategory.findUniqueOrThrow({ where: { id } }));
  }

  /** F-08-012: нельзя архивировать последнюю категорию филиала или категорию с активными подкатегориями/товарами */
  async archiveCategory(ctx: RequestContext, id: string) {
    const businessId = ctx.member!.businessId;
    const cat = await this.prisma.stockCategory.findFirst({ where: { id, businessId } });
    if (!cat) throw new ApiError('not_found', 'Category not found');
    const siblings = await this.prisma.stockCategory.count({ where: { businessId, locationId: cat.locationId, archived: false } });
    if (siblings <= 1) throw new ApiError('last_category', 'Cannot archive the only category');
    const hasChildren = await this.prisma.stockCategory.count({ where: { parentId: id, archived: false } });
    const hasGoods = await this.prisma.product.count({ where: { categoryId: id, archived: false } });
    if (hasChildren > 0 || hasGoods > 0) throw new ApiError('category_not_empty', 'Category has children or products');
    await this.prisma.$transaction(async (tx) => {
      await tx.stockCategory.update({ where: { id }, data: { archived: true, version: { increment: 1 }, updatedBy: ctx.member!.staffId } });
      await this.audit.record(tx, ctx, { action: 'archive', entityType: 'stockCategory', entityId: id, businessId, before: { archived: false }, after: { archived: true } });
    });
  }

  /** F-08-013: не восстановить, пока родитель в архиве */
  async restoreCategory(ctx: RequestContext, id: string) {
    const businessId = ctx.member!.businessId;
    const cat = await this.prisma.stockCategory.findFirst({ where: { id, businessId } });
    if (!cat) throw new ApiError('not_found', 'Category not found');
    if (cat.parentId) {
      const parent = await this.prisma.stockCategory.findUnique({ where: { id: cat.parentId } });
      if (!parent || parent.archived) throw new ApiError('parent_archived', 'Parent category is archived');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.stockCategory.update({ where: { id }, data: { archived: false, version: { increment: 1 }, updatedBy: ctx.member!.staffId } });
      await this.audit.record(tx, ctx, { action: 'restore', entityType: 'stockCategory', entityId: id, businessId, before: { archived: true }, after: { archived: false } });
    });
  }

  async restoreCategories(ctx: RequestContext, ids: string[]) {
    const businessId = ctx.member!.businessId;
    const restored: string[] = [];
    const skipped: string[] = [];
    for (const id of ids) {
      const cat = await this.prisma.stockCategory.findFirst({ where: { id, businessId } });
      if (!cat) continue;
      const parentOk = !cat.parentId || !(await this.prisma.stockCategory.findUnique({ where: { id: cat.parentId } }))?.archived;
      if (parentOk) restored.push(id);
      else skipped.push(id);
    }
    if (restored.length) {
      await this.prisma.$transaction(async (tx) => {
        await tx.stockCategory.updateMany({ where: { id: { in: restored } }, data: { archived: false, version: { increment: 1 }, updatedBy: ctx.member!.staffId } });
        await this.audit.record(tx, ctx, { action: 'restore', entityType: 'stockCategory', entityId: restored[0]!, businessId, after: { restoredCount: restored.length } });
      });
    }
    return { restored, skipped };
  }

  /** F-08-014: нельзя удалить категорию с товарами; последнюю категорию удалить нельзя */
  async removeCategory(businessId: string, id: string) {
    const cat = await this.prisma.stockCategory.findFirst({ where: { id, businessId } });
    if (!cat) throw new ApiError('not_found', 'Category not found');
    const siblings = await this.prisma.stockCategory.count({ where: { businessId, locationId: cat.locationId } });
    if (siblings <= 1) throw new ApiError('last_category', 'Cannot delete the only category');
    const hasGoods = await this.prisma.product.count({ where: { categoryId: id } });
    if (hasGoods > 0) throw new ApiError('category_not_empty', 'Category has products');
    await this.prisma.stockCategory.delete({ where: { id } });
  }

  // ─────────────────────────── Товары (F-08-015…027, F-00-134/140/144) ───────────────────────────

  private async assertBarcodeFree(businessId: string, barcode: string | undefined, excludeId?: string) {
    if (!barcode) return;
    const dupe = await this.prisma.product.findFirst({ where: { businessId, barcode, id: excludeId ? { not: excludeId } : undefined } });
    if (dupe) throw new ApiError('barcode_in_use', 'Barcode already in use');
  }

  async listGoods(businessId: string, locationId: string, params: { categoryId?: string; search?: string; includeArchived?: boolean; page?: number; pageSize?: number }) {
    const settings = await this.ensureSettings(businessId);
    const categories = await this.prisma.stockCategory.findMany({ where: { businessId, locationId } });
    const where: Record<string, unknown> = { businessId, locationId, ...(params.includeArchived ? {} : { archived: false }) };
    if (params.search?.trim()) {
      const q = params.search.trim();
      where.OR = [{ name: { contains: q } }, { barcode: { contains: q } }, { sku: { contains: q } }];
    }
    const all = await this.prisma.product.findMany({ where, orderBy: { createdAt: 'desc' } });
    const filtered = params.categoryId ? all.filter((g) => this.inSubtree(categories, params.categoryId!, g.categoryId)) : all;
    const total = filtered.length;
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 25;
    const slice = filtered.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize);
    const today = new Date().toISOString().slice(0, 10);
    const items = await Promise.all(
      slice.map(async (g) => {
        const stock = await this.totalStock(businessId, g.id);
        const view = goodView(g);
        return { ...view, categoryName: categories.find((c) => c.id === g.categoryId)?.name ?? '', totalStock: stock, belowCritical: g.criticalStock > 0 && stock <= g.criticalStock, expiry: expiryFlag(view.expiryDate, today, settings.expiryWarningDays) };
      }),
    );
    return { items, total };
  }

  async searchGoods(businessId: string, locationId: string, query: string, limit = 20) {
    const q = query.trim();
    const rows = await this.prisma.product.findMany({
      where: { businessId, locationId, archived: false, ...(q ? { OR: [{ name: { contains: q } }, { barcode: { contains: q } }, { sku: { contains: q } }] } : {}) },
      take: limit,
    });
    const categories = await this.prisma.stockCategory.findMany({ where: { businessId, locationId } });
    const settings = await this.ensureSettings(businessId);
    const today = new Date().toISOString().slice(0, 10);
    return Promise.all(
      rows.map(async (g) => {
        const stock = await this.totalStock(businessId, g.id);
        const view = goodView(g);
        return { ...view, categoryName: categories.find((c) => c.id === g.categoryId)?.name ?? '', totalStock: stock, belowCritical: g.criticalStock > 0 && stock <= g.criticalStock, expiry: expiryFlag(view.expiryDate, today, settings.expiryWarningDays) };
      }),
    );
  }

  async getGood(businessId: string, id: string) {
    const g = await this.prisma.product.findFirst({ where: { id, businessId } });
    if (!g) return undefined;
    const categories = await this.prisma.stockCategory.findMany({ where: { businessId, locationId: g.locationId } });
    const settings = await this.ensureSettings(businessId);
    const stock = await this.totalStock(businessId, id);
    const levels = await this.computeLevels(businessId, id);
    const view = goodView(g);
    const today = new Date().toISOString().slice(0, 10);
    return { ...view, categoryName: categories.find((c) => c.id === g.categoryId)?.name ?? '', totalStock: stock, belowCritical: g.criticalStock > 0 && stock <= g.criticalStock, expiry: expiryFlag(view.expiryDate, today, settings.expiryWarningDays), levels };
  }

  async createGood(ctx: RequestContext, body: GoodBody) {
    const businessId = ctx.member!.businessId;
    await this.assertBarcodeFree(businessId, body.barcode);
    const id = newId('product');
    await this.prisma.$transaction(async (tx) => {
      await tx.product.create({
        data: {
          id,
          businessId,
          locationId: body.locationId,
          categoryId: body.categoryId,
          name: body.name,
          receiptName: body.receiptName,
          sku: body.sku,
          barcode: body.barcode,
          markingCode: body.markingCode,
          saleUnit: body.saleUnit,
          writeoffUnit: body.writeoffUnit,
          unitRatio: body.unitRatio,
          massNetG: body.massNetG,
          massGrossG: body.massGrossG,
          salePrice: BigInt(body.salePrice),
          costPrice: BigInt(body.costPrice),
          taxSystem: body.taxSystem,
          taxRate: body.taxRate,
          criticalStock: body.criticalStock,
          desiredStock: body.desiredStock,
          brand: body.brand,
          shade: body.shade,
          shadeColorIndex: body.shadeColorIndex,
          expiryDate: toDateOpt(body.expiryDate),
          purchaseDate: toDateOpt(body.purchaseDate),
          shelfLifeAfterOpenDays: body.shelfLifeAfterOpenDays,
          showToClients: body.showToClients,
          clientName: body.clientName,
          comment: body.comment,
          createdBy: ctx.member!.staffId,
          updatedBy: ctx.member!.staffId,
        },
      });
      await this.audit.record(tx, ctx, { action: 'create', entityType: 'stockGood', entityId: id, businessId, after: { name: body.name } });
    });
    return this.getGood(businessId, id);
  }

  async updateGood(ctx: RequestContext, id: string, patch: GoodPatchBody) {
    const businessId = ctx.member!.businessId;
    const row = await this.prisma.product.findFirst({ where: { id, businessId } });
    if (!row) throw new ApiError('not_found', 'Good not found');
    if (patch.barcode !== undefined) await this.assertBarcodeFree(businessId, patch.barcode, id);
    const data: Record<string, unknown> = { updatedBy: ctx.member!.staffId, version: { increment: 1 } };
    const map: [keyof GoodPatchBody, string][] = [
      ['categoryId', 'categoryId'], ['name', 'name'], ['receiptName', 'receiptName'], ['sku', 'sku'], ['barcode', 'barcode'], ['markingCode', 'markingCode'],
      ['saleUnit', 'saleUnit'], ['writeoffUnit', 'writeoffUnit'], ['unitRatio', 'unitRatio'], ['massNetG', 'massNetG'], ['massGrossG', 'massGrossG'],
      ['taxSystem', 'taxSystem'], ['taxRate', 'taxRate'], ['criticalStock', 'criticalStock'], ['desiredStock', 'desiredStock'], ['brand', 'brand'],
      ['shade', 'shade'], ['shadeColorIndex', 'shadeColorIndex'], ['shelfLifeAfterOpenDays', 'shelfLifeAfterOpenDays'], ['showToClients', 'showToClients'],
      ['clientName', 'clientName'], ['comment', 'comment'],
    ];
    for (const [key, field] of map) {
      const v = patch[key];
      if (v !== undefined) data[field] = v;
    }
    if (patch.salePrice !== undefined) data.salePrice = BigInt(patch.salePrice);
    if (patch.costPrice !== undefined) data.costPrice = BigInt(patch.costPrice);
    if (patch.expiryDate !== undefined) data.expiryDate = toDateOpt(patch.expiryDate);
    if (patch.purchaseDate !== undefined) data.purchaseDate = toDateOpt(patch.purchaseDate);
    const changed: string[] = [];
    if (patch.salePrice !== undefined && BigInt(patch.salePrice) !== row.salePrice) changed.push('цена продажи');
    if (patch.costPrice !== undefined && BigInt(patch.costPrice) !== row.costPrice) changed.push('себестоимость');
    await this.prisma.$transaction(async (tx) => {
      await tx.product.update({ where: { id }, data });
      await this.audit.record(tx, ctx, { action: 'update', entityType: 'stockGood', entityId: id, businessId, before: { name: row.name }, after: { name: patch.name ?? row.name, changed } });
    });
    return this.getGood(businessId, id);
  }

  private async usedInTechCard(goodId: string): Promise<boolean> {
    const cards = await this.prisma.techCard.findMany({ select: { lines: true } });
    return cards.some((c) => Array.isArray(c.lines) && (c.lines as { goodId: string }[]).some((l) => l.goodId === goodId));
  }

  /** F-08-028: товар в чьей-то техкарте — не архивируется молча, бросает `good_in_use` */
  async archiveGood(ctx: RequestContext, id: string) {
    const businessId = ctx.member!.businessId;
    const good = await this.prisma.product.findFirst({ where: { id, businessId } });
    if (!good) throw new ApiError('not_found', 'Good not found');
    if (await this.usedInTechCard(id)) throw new ApiError('good_in_use', 'Good is used in a tech card');
    await this.prisma.$transaction(async (tx) => {
      await tx.product.update({ where: { id }, data: { archived: true, version: { increment: 1 }, updatedBy: ctx.member!.staffId } });
      await this.audit.record(tx, ctx, { action: 'archive', entityType: 'stockGood', entityId: id, businessId, before: { archived: false }, after: { archived: true } });
    });
  }

  async archiveGoods(ctx: RequestContext, ids: string[]) {
    const businessId = ctx.member!.businessId;
    const skipped: string[] = [];
    const archived: string[] = [];
    for (const id of ids) {
      if (await this.usedInTechCard(id)) skipped.push(id);
      else archived.push(id);
    }
    if (archived.length) {
      await this.prisma.$transaction(async (tx) => {
        await tx.product.updateMany({ where: { id: { in: archived }, businessId }, data: { archived: true, version: { increment: 1 }, updatedBy: ctx.member!.staffId } });
        await this.audit.record(tx, ctx, { action: 'archive', entityType: 'stockGood', entityId: archived[0]!, businessId, after: { archivedCount: archived.length } });
      });
    }
    return { archived, skipped };
  }

  async quickUpdateGoods(ctx: RequestContext, ids: string[], patch: { salePrice?: number; criticalStock?: number; desiredStock?: number }) {
    const businessId = ctx.member!.businessId;
    const data: Record<string, unknown> = { updatedBy: ctx.member!.staffId, version: { increment: 1 } };
    if (patch.salePrice !== undefined) data.salePrice = BigInt(patch.salePrice);
    if (patch.criticalStock !== undefined) data.criticalStock = patch.criticalStock;
    if (patch.desiredStock !== undefined) data.desiredStock = patch.desiredStock;
    await this.prisma.product.updateMany({ where: { id: { in: ids }, businessId }, data });
  }

  async restoreGood(ctx: RequestContext, id: string) {
    const businessId = ctx.member!.businessId;
    const good = await this.prisma.product.findFirst({ where: { id, businessId } });
    if (!good) throw new ApiError('not_found', 'Good not found');
    const category = await this.prisma.stockCategory.findUnique({ where: { id: good.categoryId } });
    if (category?.archived) throw new ApiError('category_archived', 'Category is archived');
    const nameTaken = await this.prisma.product.count({ where: { businessId, locationId: good.locationId, archived: false, name: good.name, id: { not: id } } });
    await this.prisma.product.update({ where: { id }, data: { archived: false, version: { increment: 1 }, updatedBy: ctx.member!.staffId, name: nameTaken > 0 && !good.name.endsWith('[Восстановлено]') ? `${good.name} [Восстановлено]` : good.name } });
  }

  async restoreGoods(ctx: RequestContext, ids: string[], markRestored = false) {
    const businessId = ctx.member!.businessId;
    const restored: string[] = [];
    const skipped: string[] = [];
    for (const id of ids) {
      const good = await this.prisma.product.findFirst({ where: { id, businessId } });
      if (!good) continue;
      const category = await this.prisma.stockCategory.findUnique({ where: { id: good.categoryId } });
      if (category?.archived) {
        skipped.push(id);
        continue;
      }
      const nameTaken = await this.prisma.product.count({ where: { businessId, locationId: good.locationId, archived: false, name: good.name, id: { not: id } } });
      await this.prisma.product.update({ where: { id }, data: { archived: false, version: { increment: 1 }, updatedBy: ctx.member!.staffId, name: (markRestored || nameTaken > 0) && !good.name.endsWith('[Восстановлено]') ? `${good.name} [Восстановлено]` : good.name } });
      restored.push(id);
    }
    return { restored, skipped };
  }

  /** F-08-030: удаление необратимо; товар в чьей-то техкарте — только архивируется */
  async removeGood(businessId: string, id: string) {
    const good = await this.prisma.product.findFirst({ where: { id, businessId } });
    if (!good) throw new ApiError('not_found', 'Good not found');
    if (await this.usedInTechCard(id)) throw new ApiError('good_in_use', 'Good is used in a tech card');
    await this.prisma.product.delete({ where: { id } });
  }

  /** ⭐ F-00-137: товары ниже критичного остатка — «пора заказывать» */
  async listOrderCandidates(businessId: string, locationId: string) {
    const goods = await this.prisma.product.findMany({ where: { businessId, locationId, archived: false, criticalStock: { gt: 0 } } });
    const rows = await Promise.all(
      goods.map(async (g) => {
        const stock = await this.totalStock(businessId, g.id);
        return { good: g, stock };
      }),
    );
    return rows
      .filter(({ good, stock }) => stock <= good.criticalStock)
      .map(({ good, stock }) => ({
        goodId: good.id,
        name: good.name,
        sku: good.sku ?? undefined,
        unit: good.saleUnit,
        totalStock: stock,
        criticalStock: good.criticalStock,
        desiredStock: good.desiredStock,
        toOrder: Math.max(good.desiredStock - stock, good.criticalStock > 0 ? 1 : 0),
      }));
  }

  buildOrderWhatsAppUrl(phone: string, items: { name: string; sku?: string; toOrder: number; unit: string }[]): string {
    const digits = phone.replace(/\D/g, '');
    const lines = items.map((i) => `• ${i.name}${i.sku ? ` (${i.sku})` : ''} — ${i.toOrder} ${i.unit}`);
    const text = ['Здравствуйте! Хотим заказать:', ...lines].join('\n');
    return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
  }

  // ─────────────────────────── История изменений (⭐ F-00-040) ───────────────────────────

  async listEntityHistory(businessId: string, entityType: string, entityId: string) {
    const rows = await this.prisma.auditEvent.findMany({ where: { businessId, entityType, entityId }, orderBy: { at: 'desc' } });
    return rows.map((r) => ({ id: r.id, businessId: r.businessId, entityType: r.entityType, entityId: r.entityId, staffName: r.actorName, at: r.at.toISOString(), summary: this.summaryOf(r.action, r.diff as Record<string, [unknown, unknown]> | null) }));
  }

  private summaryOf(action: string, diff: Record<string, [unknown, unknown]> | null): string {
    if (action === 'create') return 'Создано';
    if (action === 'archive') return 'Отправлено в архив';
    if (action === 'restore') return 'Восстановлено из архива';
    if (action === 'delete') return 'Удалено';
    if (diff) {
      const keys = Object.keys(diff);
      if (keys.length) return `Изменено: ${keys.join(', ')}`;
    }
    return 'Изменено';
  }

  // ─────────────────────────── Оборудование (⭐ F-00-141) ───────────────────────────

  async listEquipment(businessId: string, locationId: string, includeArchived = false) {
    return (
      await this.prisma.equipment.findMany({ where: { businessId, locationId, ...(includeArchived ? {} : { archived: false }) }, orderBy: { createdAt: 'desc' } })
    ).map(equipmentView);
  }

  async getEquipment(businessId: string, id: string) {
    const row = await this.prisma.equipment.findFirst({ where: { id, businessId } });
    return row ? equipmentView(row) : undefined;
  }

  async createEquipment(ctx: RequestContext, body: EquipmentBody) {
    const businessId = ctx.member!.businessId;
    const id = newId('equipment');
    await this.prisma.equipment.create({
      data: {
        id,
        businessId,
        locationId: body.locationId,
        name: body.name,
        category: body.category,
        purchaseDate: toDate(body.purchaseDate),
        warrantyUntil: toDateOpt(body.warrantyUntil),
        serviceIntervalMonths: body.serviceIntervalMonths,
        lastServiceDate: toDateOpt(body.lastServiceDate),
        replaceReminderDate: toDateOpt(body.replaceReminderDate),
        comment: body.comment,
        createdBy: ctx.member!.staffId,
        updatedBy: ctx.member!.staffId,
      },
    });
    return equipmentView(await this.prisma.equipment.findUniqueOrThrow({ where: { id } }));
  }

  async updateEquipment(ctx: RequestContext, id: string, patch: Partial<EquipmentBody>) {
    const businessId = ctx.member!.businessId;
    const row = await this.prisma.equipment.findFirst({ where: { id, businessId } });
    if (!row) throw new ApiError('not_found', 'Equipment not found');
    const data: Record<string, unknown> = { updatedBy: ctx.member!.staffId, version: { increment: 1 } };
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.category !== undefined) data.category = patch.category;
    if (patch.purchaseDate !== undefined) data.purchaseDate = toDate(patch.purchaseDate);
    if (patch.warrantyUntil !== undefined) data.warrantyUntil = toDateOpt(patch.warrantyUntil);
    if (patch.serviceIntervalMonths !== undefined) data.serviceIntervalMonths = patch.serviceIntervalMonths;
    if (patch.lastServiceDate !== undefined) data.lastServiceDate = toDateOpt(patch.lastServiceDate);
    if (patch.replaceReminderDate !== undefined) data.replaceReminderDate = toDateOpt(patch.replaceReminderDate);
    if (patch.comment !== undefined) data.comment = patch.comment;
    await this.prisma.equipment.update({ where: { id }, data });
    return equipmentView(await this.prisma.equipment.findUniqueOrThrow({ where: { id } }));
  }

  async archiveEquipment(businessId: string, id: string) {
    const row = await this.prisma.equipment.findFirst({ where: { id, businessId } });
    if (!row) throw new ApiError('not_found', 'Equipment not found');
    await this.prisma.equipment.update({ where: { id }, data: { archived: true, version: { increment: 1 } } });
  }

  async removeEquipment(businessId: string, id: string) {
    const row = await this.prisma.equipment.findFirst({ where: { id, businessId } });
    if (!row) throw new ApiError('not_found', 'Equipment not found');
    await this.prisma.equipment.delete({ where: { id } });
  }

  // ─────────────────────────── Напоминания (⭐ F-00-142) ───────────────────────────

  async listReminders(businessId: string, locationId: string) {
    return (await this.prisma.stockReminder.findMany({ where: { businessId, locationId }, orderBy: { date: 'asc' } })).map(reminderView);
  }

  async createReminder(ctx: RequestContext, body: ReminderBody) {
    const businessId = ctx.member!.businessId;
    const id = newId('stockReminder');
    await this.prisma.stockReminder.create({ data: { id, businessId, locationId: body.locationId, staffId: body.staffId, text: body.text, date: toDate(body.date), createdBy: ctx.member!.staffId } });
    return reminderView(await this.prisma.stockReminder.findUniqueOrThrow({ where: { id } }));
  }

  async toggleReminder(businessId: string, id: string, done: boolean) {
    const row = await this.prisma.stockReminder.findFirst({ where: { id, businessId } });
    if (!row) throw new ApiError('not_found', 'Reminder not found');
    await this.prisma.stockReminder.update({ where: { id }, data: { done } });
  }

  async removeReminder(businessId: string, id: string) {
    const row = await this.prisma.stockReminder.findFirst({ where: { id, businessId } });
    if (!row) throw new ApiError('not_found', 'Reminder not found');
    await this.prisma.stockReminder.delete({ where: { id } });
  }

  // ─────────────────────────── Настройки (F-08-096…100) ───────────────────────────

  async getSettings(businessId: string) {
    return settingsView(await this.ensureSettings(businessId));
  }

  async updateSettings(ctx: RequestContext, patch: StockSettingsPatchBody) {
    const businessId = ctx.member!.businessId;
    await this.ensureSettings(businessId);
    const data: Record<string, unknown> = { updatedBy: ctx.member!.staffId };
    if (patch.costMethod !== undefined) data.costMethod = patch.costMethod;
    if (patch.forbidOnShortage !== undefined) data.forbidOnShortage = patch.forbidOnShortage;
    if (patch.expiryWarningDays !== undefined) data.expiryWarningDays = patch.expiryWarningDays;
    if (patch.adsOptIn !== undefined) data.adsOptIn = patch.adsOptIn;
    await this.prisma.stockSettings.update({ where: { businessId }, data });
    return this.getSettings(businessId);
  }
}
