import { Injectable } from '@nestjs/common';
import { moneyToJson } from '../../common/money/money.js';
import { PrismaService } from '../../common/prisma.service.js';
import { utcToLocal, utcToLocalDate } from '../../common/time/time.js';
import type { ReportRange } from './reports-common.js';

/**
 * «Товары» в отчётах (F-12-057…062, docs/backend/02 §16), этап 21 «network+reports». Порт мока один в один
 * (`src/api/reports.ts`: `qtyAtDate`, `stockGoodsAndCategories`, `inCategorySubtree`, `costPriceAt` — те же
 * формулы, читаем прямо `stock_op_lines`/`stock_ops`/`products`/`product_categories`, не второй раз считаем
 * остатки где-то ещё). Отменённые документы (`cancelledAt`) не считаются, как и всюду в стеке (§4.2 соседей).
 *
 * Отдельный, самодостаточный сервис (не расширяет `StockExtService` лейна «finance+stock», который в это же
 * время правит те же файлы модуля `stock` — PLAN §9 «помощники», изоляция по файлам) — своя маленькая копия
 * `loadOps`, не общая. Дороже на ~20 строк, безопаснее на конфликт правок.
 */
interface OpLine {
  goodId: string;
  qtySale: number;
  unitPrice: number;
  costTotal: number;
}
interface Op {
  date: string;
  type: string;
  warehouseId: string;
  toWarehouseId?: string;
  lines: OpLine[];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function dram(n: number): number {
  return Math.round(n);
}

@Injectable()
export class ReportsStockService {
  constructor(private readonly prisma: PrismaService) {}

  private async loadOps(businessId: string, locationId: string): Promise<Op[]> {
    const docs = await this.prisma.stockOp.findMany({ where: { businessId, locationId, cancelledAt: null } });
    if (!docs.length) return [];
    const lines = await this.prisma.stockOpLine.findMany({ where: { opId: { in: docs.map((d) => d.id) } } });
    const byOp = new Map<string, OpLine[]>();
    for (const l of lines) {
      const list = byOp.get(l.opId) ?? [];
      list.push({ goodId: l.goodId, qtySale: l.qtySale, unitPrice: moneyToJson(l.unitPrice), costTotal: moneyToJson(l.costTotal) });
      byOp.set(l.opId, list);
    }
    return docs.map((d) => ({ date: utcToLocal(d.date), type: d.type, warehouseId: d.warehouseId, toWarehouseId: d.toWarehouseId ?? undefined, lines: byOp.get(d.id) ?? [] }));
  }

  private async goodsAndCategories(businessId: string, locationId: string) {
    const goods = await this.prisma.product.findMany({ where: { businessId, locationId } });
    const categories = await this.prisma.stockCategory.findMany({ where: { businessId, locationId } });
    return { goods, categories };
  }

  private inSubtree(categories: { id: string; parentId: string | null }[], rootId: string, id: string): boolean {
    if (id === rootId) return true;
    const cat = categories.find((c) => c.id === id);
    if (!cat?.parentId) return false;
    return this.inSubtree(categories, rootId, cat.parentId);
  }

  private categoryName(categories: { id: string; name: string }[], categoryId: string): string {
    return categories.find((c) => c.id === categoryId)?.name ?? '';
  }

  /** F-12-057/120: остаток на дату включительно, по складу или по всем (перемещение нейтрально при warehouseId=undefined) */
  private qtyAtDate(ops: Op[], goodId: string, atDate: string, warehouseId?: string): number {
    let qty = 0;
    for (const op of ops) {
      if (op.date.slice(0, 10) > atDate) continue;
      for (const line of op.lines) {
        if (line.goodId !== goodId) continue;
        if (!warehouseId || op.warehouseId === warehouseId) qty += line.qtySale;
        if (op.type === 'move' && op.toWarehouseId && (!warehouseId || op.toWarehouseId === warehouseId)) qty += Math.abs(line.qtySale);
      }
    }
    return qty;
  }

  /** F-12-120: себестоимость на дату строки — последний приход НА эту дату, иначе текущая `Product.costPrice` */
  private async costPriceAt(businessId: string, goodId: string, atDate: string): Promise<number> {
    const incomes = await this.prisma.stockOp.findMany({ where: { businessId, type: 'income', cancelledAt: null, date: { lte: new Date(`${atDate}T23:59:59.999Z`) } }, orderBy: { date: 'desc' }, select: { id: true, date: true } });
    for (const op of incomes) {
      if (utcToLocal(op.date).slice(0, 10) > atDate) continue;
      const line = await this.prisma.stockOpLine.findFirst({ where: { opId: op.id, goodId } });
      if (line) return moneyToJson(line.unitPrice);
    }
    const g = await this.prisma.product.findFirst({ where: { id: goodId, businessId }, select: { costPrice: true } });
    return g ? moneyToJson(g.costPrice) : 0;
  }

  // ─────────────────────────── F-12-057: «Остатки товаров» ───────────────────────────

  async balance(
    businessId: string,
    locationId: string,
    filters: { atDate: string; warehouseId?: string; categoryId?: string; onlyCritical?: boolean; zeroFilter?: 'all' | 'onlyZero' | 'withoutZero'; search?: string },
    canViewCost: boolean,
    allowedWarehouseIds: string[] | undefined,
  ) {
    const { goods, categories } = await this.goodsAndCategories(businessId, locationId);
    let ops = await this.loadOps(businessId, locationId);
    if (allowedWarehouseIds) {
      const allowed = new Set(allowedWarehouseIds);
      ops = ops.filter((o) => allowed.has(o.warehouseId) || (o.toWarehouseId && allowed.has(o.toWarehouseId)));
    }
    let items = goods;
    if (filters.categoryId) items = items.filter((g) => this.inSubtree(categories, filters.categoryId!, g.categoryId));
    if (filters.search?.trim()) {
      const s = filters.search.trim().toLowerCase();
      items = items.filter((g) => g.name.toLowerCase().includes(s) || g.sku?.toLowerCase().includes(s) || g.barcode?.includes(s));
    }
    const rows = await Promise.all(
      items.map(async (g) => {
        const qtySale = round2(this.qtyAtDate(ops, g.id, filters.atDate, filters.warehouseId));
        const cost = await this.costPriceAt(businessId, g.id, filters.atDate);
        const salePrice = moneyToJson(g.salePrice);
        const markup = salePrice - cost;
        const markupPct = cost > 0 ? Math.round((markup / cost) * 1000) / 10 : 0;
        return {
          goodId: g.id,
          sku: g.sku ?? undefined,
          goodName: g.name,
          categoryName: this.categoryName(categories, g.categoryId),
          qtySale,
          saleUnit: g.saleUnit,
          qtyWriteoff: round2(qtySale * g.unitRatio),
          writeoffUnit: g.writeoffUnit,
          costPrice: canViewCost ? cost : undefined,
          markup: canViewCost ? dram(markup) : undefined,
          markupPct: canViewCost ? markupPct : undefined,
          price: salePrice,
          totalCost: canViewCost ? dram(cost * qtySale) : undefined,
          totalValue: dram(salePrice * qtySale),
          _critical: g.criticalStock,
        };
      }),
    );
    let out = rows;
    if (filters.onlyCritical) out = out.filter((r) => r._critical > 0 && r.qtySale <= r._critical);
    if (filters.zeroFilter === 'onlyZero') out = out.filter((r) => r.qtySale === 0);
    if (filters.zeroFilter === 'withoutZero') out = out.filter((r) => r.qtySale !== 0);
    return out.map(({ _critical, ...r }) => r);
  }

  // ─────────────────────────── F-12-058: «Заказ товаров» ───────────────────────────

  async order(businessId: string, locationId: string, categoryId?: string, onlyCritical?: boolean) {
    const { goods, categories } = await this.goodsAndCategories(businessId, locationId);
    const ops = await this.loadOps(businessId, locationId);
    const t = utcToLocalDate(new Date());
    let rows = goods
      .filter((g) => !g.archived && g.desiredStock > 0)
      .map((g) => ({ g, stockQty: this.qtyAtDate(ops, g.id, t) }))
      .filter(({ g, stockQty }) => stockQty < g.desiredStock)
      .map(({ g, stockQty }) => ({
        goodId: g.id,
        sku: g.sku ?? undefined,
        goodName: g.name,
        categoryName: this.categoryName(categories, g.categoryId),
        stock: round2(stockQty),
        criticalStock: g.criticalStock,
        desiredStock: g.desiredStock,
        shortage: round2(g.desiredStock - stockQty),
        unit: g.saleUnit,
      }));
    if (categoryId) rows = rows.filter((r) => { const g = goods.find((x) => x.id === r.goodId)!; return this.inSubtree(categories, categoryId, g.categoryId); });
    if (onlyCritical) rows = rows.filter((r) => r.criticalStock > 0 && r.stock <= r.criticalStock);
    return rows;
  }

  // ─────────────────────────── F-12-059: «Анализ продаж товаров» ───────────────────────────

  async salesAnalysis(businessId: string, locationId: string, range: ReportRange, categoryId?: string, staffId?: string) {
    const { goods, categories } = await this.goodsAndCategories(businessId, locationId);
    const docs = await this.prisma.stockOp.findMany({ where: { businessId, locationId, type: 'sale', cancelledAt: null, ...(staffId ? { staffId } : {}) } });
    const inRangeDocs = docs.filter((d) => { const local = utcToLocal(d.date).slice(0, 10); return local >= range.from && local <= range.to; });
    const lines = inRangeDocs.length ? await this.prisma.stockOpLine.findMany({ where: { opId: { in: inRangeDocs.map((d) => d.id) } } }) : [];
    const byGood = new Map<string, { qty: number; costTotal: number; totalValue: number }>();
    for (const line of lines) {
      const good = goods.find((g) => g.id === line.goodId);
      if (!good) continue;
      if (categoryId && !this.inSubtree(categories, categoryId, good.categoryId)) continue;
      const qty = Math.abs(line.qtySale);
      const acc = byGood.get(line.goodId) ?? { qty: 0, costTotal: 0, totalValue: 0 };
      acc.qty += qty;
      acc.costTotal += Math.abs(moneyToJson(line.costTotal));
      acc.totalValue += qty * moneyToJson(line.unitPrice);
      byGood.set(line.goodId, acc);
    }
    const rows = [...byGood.entries()]
      .map(([goodId, acc]) => {
        const good = goods.find((g) => g.id === goodId)!;
        const markup = acc.totalValue - acc.costTotal;
        return {
          goodId,
          sku: good.sku ?? undefined,
          barcode: good.barcode ?? undefined,
          goodName: good.name,
          categoryName: this.categoryName(categories, good.categoryId),
          qty: round2(acc.qty),
          costTotal: dram(acc.costTotal),
          markup: dram(markup),
          markupPct: acc.costTotal > 0 ? Math.round((markup / acc.costTotal) * 1000) / 10 : 0,
          totalValue: dram(acc.totalValue),
        };
      })
      .sort((a, b) => b.totalValue - a.totalValue);
    return { rows, totalCost: rows.reduce((s, r) => s + r.costTotal, 0), totalMarkup: rows.reduce((s, r) => s + r.markup, 0) };
  }

  // ─────────────────────────── F-12-060: «Анализ расхода материалов» ───────────────────────────

  async usageAnalysis(businessId: string, locationId: string, range: ReportRange, categoryId?: string) {
    const { goods, categories } = await this.goodsAndCategories(businessId, locationId);
    const writeoffDocs = await this.prisma.stockOp.findMany({ where: { businessId, locationId, type: 'writeoffService', cancelledAt: null } });
    const inRangeDocs = writeoffDocs.filter((d) => { const local = utcToLocal(d.date).slice(0, 10); return local >= range.from && local <= range.to; });
    const actualLines = inRangeDocs.length ? await this.prisma.stockOpLine.findMany({ where: { opId: { in: inRangeDocs.map((d) => d.id) } } }) : [];
    const actualByGood = new Map<string, { qty: number; cost: number }>();
    for (const line of actualLines) {
      const acc = actualByGood.get(line.goodId) ?? { qty: 0, cost: 0 };
      acc.qty += Math.abs(line.qtySale);
      acc.cost += Math.abs(moneyToJson(line.costTotal));
      actualByGood.set(line.goodId, acc);
    }
    // F-12-060 (проверка 1): расчёт = число оказанных за период услуг с техкартами × норма
    const bookings = await this.prisma.booking.findMany({ where: { businessId, locationId, deletedAt: null, status: 'arrived' }, select: { startAt: true, services: true, staffId: true } });
    const arrived = bookings.filter((b) => { const local = utcToLocal(b.startAt).slice(0, 10); return local >= range.from && local <= range.to; });
    const serviceIds = [...new Set(arrived.flatMap((b) => (b.services as { serviceId: string }[]).map((l) => l.serviceId)))];
    const cards = serviceIds.length ? await this.prisma.techCard.findMany({ where: { businessId, serviceId: { in: serviceIds } } }) : [];
    const calcByGood = new Map<string, { qty: number; cost: number }>();
    for (const b of arrived) {
      for (const line of b.services as { serviceId: string; staffId?: string }[]) {
        const staffId = line.staffId ?? b.staffId;
        const card = cards.find((c) => c.serviceId === line.serviceId && c.staffId === staffId);
        for (const tl of (card?.lines as { goodId: string; qtyWriteoff: number }[] | undefined) ?? []) {
          const good = goods.find((g) => g.id === tl.goodId);
          if (!good) continue;
          const qtyInSaleUnits = tl.qtyWriteoff / (good.unitRatio || 1);
          const cost = (await this.costPriceAt(businessId, tl.goodId, utcToLocal(b.startAt).slice(0, 10))) * qtyInSaleUnits;
          const acc = calcByGood.get(tl.goodId) ?? { qty: 0, cost: 0 };
          acc.qty += qtyInSaleUnits;
          acc.cost += cost;
          calcByGood.set(tl.goodId, acc);
        }
      }
    }
    const goodIds = new Set<string>([...actualByGood.keys(), ...calcByGood.keys()]);
    let rows = [...goodIds].map((goodId) => {
      const good = goods.find((g) => g.id === goodId);
      const actual = actualByGood.get(goodId) ?? { qty: 0, cost: 0 };
      const calc = calcByGood.get(goodId) ?? { qty: 0, cost: 0 };
      return {
        goodId,
        sku: good?.sku ?? undefined,
        barcode: good?.barcode ?? undefined,
        categoryName: good ? this.categoryName(categories, good.categoryId) : '',
        goodName: good?.name ?? '',
        actualQty: round2(actual.qty),
        actualCost: dram(actual.cost),
        calcQty: round2(calc.qty),
        calcCost: dram(calc.cost),
        diffQty: round2(actual.qty - calc.qty),
        diffCost: dram(actual.cost) - dram(calc.cost),
      };
    });
    if (categoryId) rows = rows.filter((r) => { const g = goods.find((x) => x.id === r.goodId); return g && this.inSubtree(categories, categoryId, g.categoryId); });
    return rows;
  }

  // ─────────────────────────── F-12-061: «Анализ списания товаров» ───────────────────────────

  async writeOff(businessId: string, locationId: string, filters: { range: ReportRange; warehouseId?: string; categoryId?: string; unitMode?: 'sale' | 'writeoff'; countMoves?: boolean }) {
    const { goods, categories } = await this.goodsAndCategories(businessId, locationId);
    const { range, warehouseId, categoryId, unitMode = 'sale', countMoves = false } = filters;
    const ops = await this.loadOps(businessId, locationId);
    const dayBefore = new Date(new Date(`${range.from}T00:00:00.000Z`).getTime() - 86_400_000).toISOString().slice(0, 10);
    let items = goods;
    if (categoryId) items = items.filter((g) => this.inSubtree(categories, categoryId, g.categoryId));
    const rows = await Promise.all(
      items.map(async (g) => {
        const unitFactor = unitMode === 'writeoff' ? g.unitRatio || 1 : 1;
        const startQty = this.qtyAtDate(ops, g.id, dayBefore, warehouseId);
        const endQty = this.qtyAtDate(ops, g.id, range.to, warehouseId);
        let inQty = 0;
        let inValue = 0;
        let outQty = 0;
        let outValue = 0;
        for (const op of ops) {
          const d = op.date.slice(0, 10);
          if (d < range.from || d > range.to) continue;
          for (const line of op.lines) {
            if (line.goodId !== g.id) continue;
            const qty = Math.abs(line.qtySale);
            const value = Math.abs(line.costTotal);
            if (op.type === 'income') {
              if (!warehouseId || op.warehouseId === warehouseId) {
                inQty += qty;
                inValue += value;
              }
            } else if (op.type === 'move') {
              if (!countMoves || !warehouseId) continue;
              if (op.toWarehouseId === warehouseId) {
                inQty += qty;
                inValue += value;
              } else if (op.warehouseId === warehouseId) {
                outQty += qty;
                outValue += value;
              }
            } else if (!warehouseId || op.warehouseId === warehouseId) {
              outQty += qty;
              outValue += value;
            }
          }
        }
        const startCost = await this.costPriceAt(businessId, g.id, dayBefore);
        const endCost = await this.costPriceAt(businessId, g.id, range.to);
        return {
          goodId: g.id,
          sku: g.sku ?? undefined,
          barcode: g.barcode ?? undefined,
          goodName: g.name,
          startQty: round2(startQty * unitFactor),
          startValue: dram(startCost * startQty),
          inQty: round2(inQty * unitFactor),
          inValue: dram(inValue),
          outQty: round2(outQty * unitFactor),
          outValue: dram(outValue),
          endQty: round2(endQty * unitFactor),
          endValue: dram(endCost * endQty),
        };
      }),
    );
    return { rows, totalOutValue: rows.reduce((s, r) => s + r.outValue, 0) };
  }

  // ─────────────────────────── F-12-062: «Анализ оборачиваемости» ───────────────────────────

  private sampleWeekly(from: string, to: string): string[] {
    const out: string[] = [from];
    let cur = from;
    while (cur < to) {
      cur = new Date(new Date(`${cur}T00:00:00.000Z`).getTime() + 7 * 86_400_000).toISOString().slice(0, 10);
      if (cur >= to) break;
      out.push(cur);
    }
    out.push(to);
    return out;
  }

  async turnover(businessId: string, locationId: string, range: ReportRange, categoryId?: string, warehouseId?: string) {
    const { goods, categories } = await this.goodsAndCategories(businessId, locationId);
    const ops = await this.loadOps(businessId, locationId);
    let items = goods;
    if (categoryId) items = items.filter((g) => this.inSubtree(categories, categoryId, g.categoryId));
    const periodDays = Math.max(1, Math.round((new Date(`${range.to}T00:00:00.000Z`).getTime() - new Date(`${range.from}T00:00:00.000Z`).getTime()) / 86_400_000) + 1);
    const dayBefore = new Date(new Date(`${range.from}T00:00:00.000Z`).getTime() - 86_400_000).toISOString().slice(0, 10);
    const sampleDates = this.sampleWeekly(range.from, range.to);
    return items.map((g) => {
      const startQty = this.qtyAtDate(ops, g.id, dayBefore, warehouseId);
      const endQty = this.qtyAtDate(ops, g.id, range.to, warehouseId);
      const qtyIn = ops
        .filter((o) => o.type === 'income' && o.date.slice(0, 10) >= range.from && o.date.slice(0, 10) <= range.to && (!warehouseId || o.warehouseId === warehouseId))
        .flatMap((o) => o.lines)
        .filter((l) => l.goodId === g.id)
        .reduce((s, l) => s + l.qtySale, 0);
      const soldQty = ops
        .filter((o) => (o.type === 'sale' || o.type === 'writeoffService' || o.type === 'writeoffProduct') && o.date.slice(0, 10) >= range.from && o.date.slice(0, 10) <= range.to && (!warehouseId || o.warehouseId === warehouseId))
        .flatMap((o) => o.lines)
        .filter((l) => l.goodId === g.id)
        .reduce((s, l) => s + Math.abs(l.qtySale), 0);
      const samples = sampleDates.map((d) => this.qtyAtDate(ops, g.id, d, warehouseId));
      let avgStock: number;
      if (samples.length >= 2) {
        const inner = samples.slice(1, -1).reduce((s, z) => s + z, 0);
        avgStock = (samples[0]! / 2 + inner + samples[samples.length - 1]! / 2) / (samples.length - 1);
      } else {
        avgStock = (startQty + endQty) / 2;
      }
      const safeAvg = avgStock > 0 ? avgStock : 0;
      const turnoverTimes = safeAvg > 0 && soldQty > 0 ? soldQty / safeAvg : null;
      const turnoverDays = turnoverTimes && turnoverTimes > 0 ? Math.round(periodDays / turnoverTimes) : null;
      const avgDailySale = periodDays > 0 ? soldQty / periodDays : 0;
      const stockLevelDays = avgDailySale > 0 && endQty > 0 ? Math.round(endQty / avgDailySale) : null;
      return {
        goodId: g.id,
        sku: g.sku ?? undefined,
        goodName: g.name,
        qtyIn: round2(qtyIn),
        startQty: round2(startQty),
        endQty: round2(endQty),
        soldQty: round2(soldQty),
        avgStock: round2(safeAvg),
        turnoverDays,
        turnoverTimes: turnoverTimes !== null ? Math.round(turnoverTimes * 10) / 10 : null,
        stockLevelDays,
      };
    });
  }
}
