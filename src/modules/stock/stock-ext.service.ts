import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { newId } from '../../common/ids/ids.js';
import { moneyToJson } from '../../common/money/money.js';
import { PrismaService } from '../../common/prisma.service.js';
import { utcToLocal, utcToLocalDate } from '../../common/time/time.js';
import { expiryFlag, goodView } from './stock-catalog.service.js';
import { StockOpsService } from './stock-ops.service.js';

/**
 * Этап 21, лейн «finance+stock»: то, что фасад `src/api/stock.ts` в режиме api ещё считал в браузере —
 * журнал операций построчно с «остатком после», движение за период, расход против нормы техкарт, покупки
 * клиента, расходники визита (панель + ручная правка), чек продажи, быстрое управление/Excel/удаление архива,
 * сетевое копирование, права раздела + история, ценники, напоминания-сводка, материалы/палитра клиента,
 * предложение поставщика. Логика — порт мока один в один (те же фильтры, сортировки, округления), только
 * над таблицами сервера; отменённые документы (`cancelledAt`) не считаются, как и в `computeLevels` этапа 13.
 */

const round6 = (q: number) => Math.round(q * 1e6) / 1e6;
const applyDiscount = (price: number, pct?: number | null) => (pct ? Math.round(price * (1 - pct / 100)) : price);

interface OpLine {
  goodId: string;
  qtySale: number;
  unitPrice: number;
  discountPct?: number;
  costTotal: number;
}
interface Op {
  id: string;
  locationId: string;
  number: string;
  type: string;
  date: string;
  warehouseId: string;
  toWarehouseId?: string;
  counterpartyName?: string;
  clientId?: string;
  staffId?: string;
  serviceId?: string;
  bookingId?: string;
  paid: boolean;
  comment?: string;
  inventoryId?: string;
  cancelsDocId?: string;
  autoWriteoff: boolean;
  extraLines?: { price: number }[];
  lines: OpLine[];
}

export interface StockPermissionsJson {
  [key: string]: unknown;
}

function textRu(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && 'ru' in v) return String((v as { ru?: unknown }).ru ?? '');
  return '';
}

@Injectable()
export class StockExtService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly ops: StockOpsService,
  ) {}

  // ─────────────────────────── Загрузка документов ───────────────────────────

  private async loadOps(where: Prisma.StockOpWhereInput): Promise<Op[]> {
    const docs = await this.prisma.stockOp.findMany({ where: { ...where, cancelledAt: null } });
    if (!docs.length) return [];
    const lines = await this.prisma.stockOpLine.findMany({ where: { opId: { in: docs.map((d) => d.id) } } });
    const byOp = new Map<string, OpLine[]>();
    for (const l of lines) {
      const list = byOp.get(l.opId) ?? [];
      list.push({ goodId: l.goodId, qtySale: l.qtySale, unitPrice: moneyToJson(l.unitPrice), discountPct: l.discountPct ?? undefined, costTotal: moneyToJson(l.costTotal) });
      byOp.set(l.opId, list);
    }
    return docs.map((d) => ({
      id: d.id,
      locationId: d.locationId,
      number: d.number,
      type: d.type,
      date: utcToLocal(d.date),
      warehouseId: d.warehouseId,
      toWarehouseId: d.toWarehouseId ?? undefined,
      counterpartyName: d.counterpartyName ?? undefined,
      clientId: d.clientId ?? undefined,
      staffId: d.staffId ?? undefined,
      serviceId: d.serviceId ?? undefined,
      bookingId: d.bookingId ?? undefined,
      paid: d.paid,
      comment: d.comment ?? undefined,
      inventoryId: d.inventoryId ?? undefined,
      cancelsDocId: d.cancelsDocId ?? undefined,
      autoWriteoff: d.autoWriteoff,
      extraLines: (d.extraLines as { price: number }[] | null) ?? undefined,
      lines: byOp.get(d.id) ?? [],
    }));
  }

  private async levelsByGood(businessId: string): Promise<Map<string, number>> {
    const ops = await this.loadOps({ businessId });
    const total = new Map<string, number>();
    for (const op of ops) {
      for (const l of op.lines) {
        total.set(l.goodId, (total.get(l.goodId) ?? 0) + l.qtySale);
        if (op.type === 'move' && op.toWarehouseId) total.set(l.goodId, (total.get(l.goodId) ?? 0) + Math.abs(l.qtySale));
      }
    }
    return total;
  }

  private async expiryWarningDays(businessId: string): Promise<number> {
    const s = await this.prisma.stockSettings.findUnique({ where: { businessId } });
    return s?.expiryWarningDays ?? 14;
  }

  // ─────────────────────────── Журнал операций построчно (F-08-046…048) ───────────────────────────

  async listOperationRows(businessId: string, locationId: string, f: Record<string, string | undefined>) {
    const all = await this.loadOps({ businessId });
    const goods = await this.prisma.product.findMany({ where: { businessId, locationId } });
    const allGoods = await this.prisma.product.findMany({ where: { businessId }, select: { id: true, costPrice: true } });
    const warehouses = await this.prisma.warehouse.findMany({ where: { businessId, locationId } });
    const docs = all
      .filter((op) => op.locationId === locationId)
      .filter((op) => (f.type ? op.type === f.type : true))
      .filter((op) => (f.warehouseId ? op.warehouseId === f.warehouseId || op.toWarehouseId === f.warehouseId : true))
      .filter((op) => (f.dateFrom ? op.date >= f.dateFrom : true))
      .filter((op) => (f.dateTo ? op.date <= f.dateTo + 'T23:59' : true))
      .filter((op) => (f.docNumber ? op.number.includes(f.docNumber.trim()) : true))
      .filter((op) => (f.paid === 'paid' ? op.paid : f.paid === 'unpaid' ? !op.paid : true))
      .filter((op) => (f.serviceId ? op.serviceId === f.serviceId : true))
      .filter((op) => (f.counterparty ? (op.counterpartyName ?? '').toLowerCase().includes(f.counterparty.toLowerCase()) : true));
    const clientIds = [...new Set(docs.map((d) => d.clientId).filter((x): x is string => !!x))];
    const clients = clientIds.length ? await this.prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, name: true, phone: true } }) : [];

    const costById = new Map(allGoods.map((g) => [g.id, moneyToJson(g.costPrice)]));
    const running = new Map<string, number>();
    const stockAfter = new Map<string, number>();
    const lastIncome = new Map<string, number>();
    const unitCostAt = new Map<string, number>();
    [...all]
      .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
      .forEach((op) => {
        op.lines.forEach((l) => {
          if (op.type === 'income' && !op.inventoryId && !op.cancelsDocId) lastIncome.set(l.goodId, applyDiscount(l.unitPrice, l.discountPct));
          unitCostAt.set(`${op.id}__${l.goodId}`, lastIncome.get(l.goodId) ?? costById.get(l.goodId) ?? 0);
          const key = `${l.goodId}__${op.warehouseId}`;
          const next = (running.get(key) ?? 0) + l.qtySale;
          running.set(key, next);
          stockAfter.set(`${op.id}__${l.goodId}`, next);
          if (op.type === 'move' && op.toWarehouseId) {
            const toKey = `${l.goodId}__${op.toWarehouseId}`;
            running.set(toKey, (running.get(toKey) ?? 0) + Math.abs(l.qtySale));
          }
        });
      });

    let rows: Record<string, unknown>[] = [];
    docs.forEach((op) => {
      const warehouse = warehouses.find((w) => w.id === op.warehouseId);
      const toWarehouse = op.toWarehouseId ? warehouses.find((w) => w.id === op.toWarehouseId) : undefined;
      const client = op.clientId ? clients.find((c) => c.id === op.clientId) : undefined;
      op.lines.forEach((line) => {
        const good = goods.find((g) => g.id === line.goodId);
        if (!good) return;
        if (f.goodId && good.id !== f.goodId) return;
        if (f.search?.trim()) {
          const q = f.search.trim().toLowerCase();
          if (!good.name.toLowerCase().includes(q) && !good.sku?.toLowerCase().includes(q)) return;
        }
        if (f.clientSearch?.trim()) {
          const q = f.clientSearch.trim().toLowerCase();
          if (!(client && (client.name.toLowerCase().includes(q) || client.phone.includes(q)))) return;
        }
        rows.push({
          docId: op.id,
          number: op.number,
          type: op.type,
          date: op.date,
          warehouseId: op.warehouseId,
          warehouseName: warehouse?.name ?? '',
          toWarehouseName: toWarehouse?.name,
          counterpartyOrClient: client?.name ?? op.counterpartyName ?? '',
          comment: op.comment,
          goodId: good.id,
          goodName: good.name,
          qtySale: line.qtySale,
          saleUnit: good.saleUnit,
          costTotal: line.costTotal,
          costValue: Math.round(Math.abs(line.qtySale) * (unitCostAt.get(`${op.id}__${good.id}`) ?? moneyToJson(good.costPrice))),
          stockAfter: round6(stockAfter.get(`${op.id}__${good.id}`) ?? 0),
          clientId: op.clientId,
          bookingId: op.bookingId,
          paid: op.paid,
        });
      });
    });
    rows = rows.sort((a, b) => String(b.date).localeCompare(String(a.date)) || Number(b.number) - Number(a.number));
    const total = rows.length;
    const page = f.page ? Number(f.page) : 1;
    const pageSize = f.pageSize ? Number(f.pageSize) : 25;
    const start = (page - 1) * pageSize;
    return { items: rows.slice(start, start + pageSize), total };
  }

  // ─────────────────────────── Ск14: движение за период, расход против нормы ───────────────────────────

  async movementReport(businessId: string, locationId: string, dateFrom: string, dateTo: string, warehouseId?: string) {
    const to = `${dateTo}T23:59`;
    const ops = (await this.loadOps({ businessId, locationId })).filter((op) => op.date <= to);
    const acc = new Map<string, { start: number; income: number; out: number }>();
    for (const op of ops) {
      const before = op.date < dateFrom;
      for (const l of op.lines) {
        const entry = acc.get(l.goodId) ?? { start: 0, income: 0, out: 0 };
        acc.set(l.goodId, entry);
        const legs =
          op.type === 'move' && op.toWarehouseId
            ? [
                { warehouseId: op.warehouseId, qty: -Math.abs(l.qtySale) },
                { warehouseId: op.toWarehouseId, qty: Math.abs(l.qtySale) },
              ]
            : [{ warehouseId: op.warehouseId, qty: l.qtySale }];
        for (const leg of legs) {
          if (warehouseId && leg.warehouseId !== warehouseId) continue;
          if (!warehouseId && op.type === 'move') continue;
          if (before) entry.start += leg.qty;
          else if (leg.qty > 0) entry.income += leg.qty;
          else entry.out += -leg.qty;
        }
      }
    }
    const goods = await this.prisma.product.findMany({ where: { businessId, locationId } });
    return goods
      .filter((g) => acc.has(g.id))
      .map((g) => {
        const e = acc.get(g.id)!;
        const startQty = round6(e.start);
        const incomeQty = round6(e.income);
        const outQty = round6(e.out);
        const endQty = round6(startQty + incomeQty - outQty);
        return { goodId: g.id, name: g.name, sku: g.sku ?? undefined, unit: g.saleUnit, startQty, incomeQty, outQty, endQty, endValue: Math.round(endQty * moneyToJson(g.costPrice)) };
      })
      .filter((r) => r.startQty !== 0 || r.incomeQty !== 0 || r.outQty !== 0)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async consumablesAnalysis(businessId: string, locationId: string, dateFrom: string, dateTo: string) {
    const to = `${dateTo}T23:59`;
    const inRange = (date: string) => date >= dateFrom && date <= to;
    const cards = await this.prisma.techCard.findMany({ where: { businessId } });
    const bookings = await this.prisma.booking.findMany({ where: { businessId, locationId, deletedAt: null, status: 'arrived' }, select: { startAt: true, services: true, staffId: true } });
    const norm = new Map<string, number>();
    for (const b of bookings) {
      if (!inRange(utcToLocal(b.startAt))) continue;
      for (const line of (b.services as { serviceId: string; staffId?: string; qty?: number }[]) ?? []) {
        const card = cards.find((c) => c.serviceId === line.serviceId && c.staffId === (line.staffId ?? b.staffId));
        for (const tl of (card?.lines as { goodId: string; qtyWriteoff: number }[] | undefined) ?? []) norm.set(tl.goodId, (norm.get(tl.goodId) ?? 0) + tl.qtyWriteoff * (line.qty ?? 1));
      }
    }
    const goods = await this.prisma.product.findMany({ where: { businessId } });
    const actual = new Map<string, { qty: number; cost: number }>();
    for (const op of await this.loadOps({ businessId, locationId, type: 'writeoffService' })) {
      if (!inRange(op.date)) continue;
      for (const l of op.lines) {
        const good = goods.find((g) => g.id === l.goodId);
        const ratio = good?.unitRatio || 1;
        const entry = actual.get(l.goodId) ?? { qty: 0, cost: 0 };
        entry.qty += Math.abs(l.qtySale) * ratio;
        entry.cost += Math.abs(l.costTotal);
        actual.set(l.goodId, entry);
      }
    }
    const ids = new Set([...norm.keys(), ...actual.keys()]);
    return Array.from(ids)
      .map((goodId) => {
        const good = goods.find((g) => g.id === goodId);
        const normQty = round6(norm.get(goodId) ?? 0);
        const actualQty = round6(actual.get(goodId)?.qty ?? 0);
        return { goodId, name: good?.name ?? '', writeoffUnit: good?.writeoffUnit ?? 'pcs', normQty, actualQty, diffQty: round6(actualQty - normQty), actualCost: Math.round(actual.get(goodId)?.cost ?? 0) };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // ─────────────────────────── Покупки клиента (F-08-151) ───────────────────────────

  async clientPurchaseSummary(businessId: string, clientId: string) {
    const ops = await this.loadOps({ businessId, type: 'sale', clientId });
    const goods = await this.prisma.product.findMany({ where: { businessId }, select: { id: true, name: true } });
    const rows: Record<string, unknown>[] = [];
    const bookingIds = new Set<string>();
    for (const op of ops) {
      if (op.bookingId) bookingIds.add(op.bookingId);
      for (const line of op.lines) {
        const good = goods.find((g) => g.id === line.goodId);
        if (!good) continue;
        rows.push({ docId: op.id, bookingId: op.bookingId, standalone: !op.bookingId, date: op.date, goodName: good.name, qty: Math.abs(line.qtySale), unitPrice: line.unitPrice, discountPct: line.discountPct, total: Math.abs(line.costTotal), paid: op.paid });
      }
    }
    rows.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const totalSold = rows.reduce((s, r) => s + (r.total as number), 0);
    const totalPaid = rows.filter((r) => r.paid).reduce((s, r) => s + (r.total as number), 0);
    return { totalSold, totalPaid, visitCount: bookingIds.size, rows };
  }

  async searchClients(businessId: string, query: string) {
    const q = query.trim();
    const list = await this.prisma.client.findMany({
      where: { businessId, deletedAt: null, ...(q ? { OR: [{ name: { contains: q } }, { phone: { contains: q } }] } : {}) },
      select: { id: true, name: true, phone: true },
      take: 25,
      orderBy: { name: 'asc' },
    });
    return list;
  }

  // ─────────────────────────── Техкарта пакета (F-08-040) ───────────────────────────

  async packageTechCardLines(businessId: string, packageServiceId: string, staffId: string) {
    const pkg = await this.prisma.service.findFirst({ where: { id: packageServiceId, businessId }, select: { servicePackage: true } });
    const includedIds = ((pkg?.servicePackage as { items?: { serviceId: string }[] } | null)?.items ?? []).map((i) => i.serviceId);
    if (!includedIds.length) return [];
    const cards = await this.prisma.techCard.findMany({ where: { businessId, staffId, serviceId: { in: includedIds } } });
    const byGood = new Map<string, { qtyWriteoff: number; warehouseId: string }>();
    for (const sid of includedIds) {
      const card = cards.find((c) => c.serviceId === sid);
      for (const l of (card?.lines as { goodId: string; warehouseId: string; qtyWriteoff: number }[] | undefined) ?? []) {
        const acc = byGood.get(l.goodId);
        byGood.set(l.goodId, { qtyWriteoff: (acc?.qtyWriteoff ?? 0) + l.qtyWriteoff, warehouseId: acc?.warehouseId ?? l.warehouseId });
      }
    }
    const goods = await this.prisma.product.findMany({ where: { id: { in: [...byGood.keys()] } } });
    const warehouses = await this.prisma.warehouse.findMany({ where: { businessId } });
    return Array.from(byGood.entries()).map(([goodId, { qtyWriteoff, warehouseId }]) => {
      const good = goods.find((g) => g.id === goodId);
      return { goodId, warehouseId, qtyWriteoff, goodName: good?.name ?? '', writeoffUnitCode: good?.writeoffUnit ?? 'pcs', warehouseName: warehouses.find((w) => w.id === warehouseId)?.name ?? '' };
    });
  }

  // ─────────────────────────── Расходники визита (F-08-041…045, F-08-117) ───────────────────────────

  /** Живой документ автосписания визита: не отменён, не развёрнут откатом «Не пришёл» (TechCardsService.revertForBooking) */
  private liveAutoDoc(businessId: string, bookingId: string) {
    return this.prisma.stockOp.findFirst({ where: { businessId, bookingId, autoWriteoff: true, cancelledAt: null, cancelledByDocId: null }, orderBy: { createdAt: 'asc' } });
  }

  async bookingConsumables(businessId: string, bookingId: string) {
    const booking = await this.prisma.booking.findFirst({ where: { id: bookingId, businessId }, select: { status: true, deletedAt: true } });
    const arrived = Boolean(booking && !booking.deletedAt && booking.status === 'arrived');
    const doc = await this.liveAutoDoc(businessId, bookingId);
    if (!doc) return { lines: [], arrived };
    const lines = await this.prisma.stockOpLine.findMany({ where: { opId: doc.id } });
    const goods = await this.prisma.product.findMany({ where: { id: { in: lines.map((l) => l.goodId) } } });
    return {
      arrived,
      docId: doc.id,
      lines: lines.map((l) => {
        const good = goods.find((g) => g.id === l.goodId);
        return {
          goodId: l.goodId,
          qtySale: l.qtySale,
          unitPrice: moneyToJson(l.unitPrice),
          discountPct: l.discountPct ?? undefined,
          costTotal: moneyToJson(l.costTotal),
          goodName: good?.name ?? '',
          writeoffUnitCode: good?.writeoffUnit ?? 'pcs',
          qtyWriteoff: round6(Math.abs(l.qtySale) * (good?.unitRatio || 1)),
        };
      }),
    };
  }

  async bookingConsumablesByService(businessId: string, bookingId: string) {
    const booking = await this.prisma.booking.findFirst({ where: { id: bookingId, businessId }, select: { services: true, staffId: true } });
    if (!booking) return [];
    const lines = (booking.services as { serviceId: string; staffId?: string; qty?: number }[]) ?? [];
    const services = await this.prisma.service.findMany({ where: { id: { in: lines.map((l) => l.serviceId) } }, select: { id: true, name: true } });
    const cards = await this.prisma.techCard.findMany({ where: { businessId, serviceId: { in: lines.map((l) => l.serviceId) } } });
    const goodIds = cards.flatMap((c) => ((c.lines as { goodId: string }[]) ?? []).map((l) => l.goodId));
    const goods = goodIds.length ? await this.prisma.product.findMany({ where: { id: { in: goodIds } } }) : [];
    return lines.map((line, lineIndex) => {
      const staffId = line.staffId ?? booking.staffId;
      const card = cards.find((c) => c.serviceId === line.serviceId && c.staffId === staffId);
      const g = ((card?.lines as { goodId: string; qtyWriteoff: number }[] | undefined) ?? []).map((tl) => {
        const good = goods.find((x) => x.id === tl.goodId);
        return { goodId: tl.goodId, goodName: good?.name ?? '', qtyWriteoff: tl.qtyWriteoff * (line.qty ?? 1), writeoffUnitCode: good?.writeoffUnit ?? 'pcs' };
      });
      return { serviceId: line.serviceId, serviceName: textRu(services.find((s) => s.id === line.serviceId)?.name), staffId, lineIndex, goods: g };
    });
  }

  /** F-08-043/F-08-117: добавить/увеличить строку расходника визита поверх нормы (визит должен быть «Пришёл») */
  async addBookingConsumable(ctx: RequestContext, bookingId: string, locationId: string, goodId: string, qtyWriteoff: number) {
    const businessId = ctx.member!.businessId;
    if (!(qtyWriteoff > 0)) throw new ApiError('invalid_qty', 'Quantity must be positive');
    const booking = await this.prisma.booking.findFirst({ where: { id: bookingId, businessId } });
    if (!booking || booking.deletedAt || booking.status !== 'arrived') throw new ApiError('not_arrived', 'Client has not arrived');
    const good = await this.prisma.product.findFirst({ where: { id: goodId, businessId } });
    if (!good) throw new ApiError('not_found', 'Good not found');
    const warehouse = await this.prisma.warehouse.findFirst({ where: { businessId, locationId, type: 'writeoff' }, orderBy: { order: 'asc' } });
    if (!warehouse) throw new ApiError('validation', 'No writeoff warehouse');
    const qtySale = round6(good.unitRatio ? qtyWriteoff / good.unitRatio : qtyWriteoff);
    const cost = Number(good.costPrice);
    let doc = await this.liveAutoDoc(businessId, bookingId);
    const number = doc ? doc.number : await this.ops.nextNumber(businessId);
    await this.prisma.$transaction(async (tx) => {
      if (!doc) {
        doc = await tx.stockOp.create({
          data: { id: newId('stockOp'), businessId, locationId, number, type: 'writeoffService', date: booking.startAt, warehouseId: warehouse.id, reason: 'manual', staffId: booking.staffId, clientId: booking.clientId, bookingId, autoWriteoff: true, paid: true, createdBy: ctx.member!.staffId, updatedBy: ctx.member!.staffId },
        });
      }
      const existing = await tx.stockOpLine.findFirst({ where: { opId: doc.id, goodId } });
      if (existing) {
        const q = round6(existing.qtySale - qtySale);
        await tx.stockOpLine.update({ where: { id: existing.id }, data: { qtySale: q, costTotal: -BigInt(Math.round(Math.abs(q) * cost)) } });
      } else {
        await tx.stockOpLine.create({ data: { id: newId('stockOpLine'), opId: doc.id, businessId, goodId, qtySale: -qtySale, unitPrice: good.costPrice, costTotal: -BigInt(Math.round(qtySale * cost)) } });
      }
      await tx.stockOp.update({ where: { id: doc.id }, data: { updatedBy: ctx.member!.staffId, version: { increment: 1 } } });
      await this.audit.record(tx, ctx, { action: 'update', entityType: 'stockOperation', entityId: doc.id, before: {}, after: { consumable: `${good.name} +${qtyWriteoff}` } });
    });
  }

  /** Ск13: итоговое количество расходника визита в единицах списания; 0 — убрать строку */
  async setBookingConsumableQty(ctx: RequestContext, bookingId: string, goodId: string, qtyWriteoff: number) {
    const businessId = ctx.member!.businessId;
    if (!(qtyWriteoff >= 0)) throw new ApiError('invalid_qty', 'Quantity must be >= 0');
    const good = await this.prisma.product.findFirst({ where: { id: goodId, businessId } });
    if (!good) throw new ApiError('not_found', 'Good not found');
    const doc = await this.liveAutoDoc(businessId, bookingId);
    if (!doc) return;
    const qtySale = round6(good.unitRatio ? qtyWriteoff / good.unitRatio : qtyWriteoff);
    const cost = Number(good.costPrice);
    await this.prisma.$transaction(async (tx) => {
      const line = await tx.stockOpLine.findFirst({ where: { opId: doc.id, goodId } });
      if (qtySale === 0) {
        if (line) await tx.stockOpLine.delete({ where: { id: line.id } });
      } else if (line) {
        await tx.stockOpLine.update({ where: { id: line.id }, data: { qtySale: -qtySale, costTotal: -BigInt(Math.round(qtySale * cost)) } });
      } else {
        await tx.stockOpLine.create({ data: { id: newId('stockOpLine'), opId: doc.id, businessId, goodId, qtySale: -qtySale, unitPrice: good.costPrice, costTotal: -BigInt(Math.round(qtySale * cost)) } });
      }
      await tx.stockOp.update({ where: { id: doc.id }, data: { updatedBy: ctx.member!.staffId, version: { increment: 1 } } });
    });
  }

  // ─────────────────────────── Чек продажи (F-08-072) ───────────────────────────

  async receiptData(businessId: string, docId: string) {
    const doc = await this.ops.getDoc(businessId, docId);
    if (!doc) return undefined;
    const [business, client, staff, goods] = await Promise.all([
      this.prisma.business.findUnique({ where: { id: businessId }, select: { name: true, brandName: true } }),
      doc.clientId ? this.prisma.client.findUnique({ where: { id: doc.clientId }, select: { name: true, phone: true } }) : Promise.resolve(null),
      doc.staffId ? this.prisma.staff.findUnique({ where: { id: doc.staffId }, select: { name: true } }) : Promise.resolve(null),
      this.prisma.product.findMany({ where: { id: { in: doc.lines.map((l) => l.goodId) } }, select: { id: true, name: true, receiptName: true, saleUnit: true } }),
    ]);
    const linesTotal = doc.lines.reduce((s, l) => s + Math.abs(l.costTotal), 0);
    const extraTotal = ((doc.extraLines as { price?: number }[] | undefined) ?? []).reduce((s, e) => s + (e.price ?? 0), 0);
    return {
      doc: {
        ...doc,
        date: utcToLocal(new Date(doc.date)),
        lineDetails: doc.lines.map((l) => {
          const g = goods.find((x) => x.id === l.goodId);
          return { ...l, goodName: g?.receiptName?.trim() || g?.name || '', saleUnit: g?.saleUnit ?? 'pcs' };
        }),
      },
      businessName: business?.brandName?.trim() || business?.name || '',
      clientName: client?.name,
      clientPhone: client?.phone,
      staffName: staff?.name ?? '',
      total: linesTotal + extraTotal,
    };
  }

  // ─────────────────────────── Быстрое управление, удаление архива, импорт (F-08-029…034) ───────────────────────────

  async saveMassEdit(ctx: RequestContext, rows: { id: string; sku?: string; barcode?: string; salePrice: number; costPrice: number; massNetG?: number; massGrossG?: number }[]) {
    const businessId = ctx.member!.businessId;
    let changed = 0;
    await this.prisma.$transaction(async (tx) => {
      for (const row of rows) {
        const g = await tx.product.findFirst({ where: { id: row.id, businessId } });
        if (!g) continue;
        const next = { sku: row.sku || null, barcode: row.barcode || null, salePrice: BigInt(Math.round(row.salePrice)), costPrice: BigInt(Math.round(row.costPrice)), massNetG: row.massNetG ?? null, massGrossG: row.massGrossG ?? null };
        const isChanged = g.sku !== next.sku || g.barcode !== next.barcode || g.salePrice !== next.salePrice || g.costPrice !== next.costPrice || g.massNetG !== next.massNetG || g.massGrossG !== next.massGrossG;
        if (!isChanged) continue;
        await tx.product.update({ where: { id: g.id }, data: { ...next, updatedBy: ctx.member!.staffId, version: { increment: 1 } } });
        await this.audit.record(tx, ctx, { action: 'update', entityType: 'stockGood', entityId: g.id, before: { sku: g.sku, barcode: g.barcode, salePrice: Number(g.salePrice), costPrice: Number(g.costPrice), massNetG: g.massNetG, massGrossG: g.massGrossG }, after: { ...next, salePrice: Number(next.salePrice), costPrice: Number(next.costPrice) } });
        changed += 1;
      }
    });
    return { changed };
  }

  /** F-08-029: удалить архивные товары насовсем; товар из чьей-то техкарты молча пропускается (как мок) */
  async deleteGoods(ctx: RequestContext, ids: string[]) {
    const businessId = ctx.member!.businessId;
    const cards = await this.prisma.techCard.findMany({ where: { businessId }, select: { lines: true } });
    const inUse = new Set(cards.flatMap((c) => ((c.lines as { goodId: string }[]) ?? []).map((l) => l.goodId)));
    const deletable = ids.filter((id) => !inUse.has(id));
    await this.prisma.$transaction(async (tx) => {
      for (const id of deletable) {
        const g = await tx.product.findFirst({ where: { id, businessId } });
        if (!g) continue;
        await tx.product.delete({ where: { id } });
        await this.audit.record(tx, ctx, { action: 'delete', entityType: 'stockGood', entityId: id, before: { name: g.name }, after: null });
      }
    });
    return { deleted: deletable, skipped: ids.filter((id) => inUse.has(id)) };
  }

  /** F-08-033/034: строки уже разобраны фасадом из CSV (тот же разбор, что мок); сервер ищет существующий и заводит/обновляет */
  async importGoods(ctx: RequestContext, locationId: string, categoryId: string, rows: { row: number; name: string; patch: Record<string, unknown> }[]) {
    const businessId = ctx.member!.businessId;
    const category = await this.prisma.stockCategory.findFirst({ where: { id: categoryId, businessId, locationId } });
    if (!category) throw new ApiError('not_found', 'Category not found');
    if (rows.length > 500) throw new ApiError('too_many_rows', 'Too many rows');
    const results: { row: number; name: string; status: 'created' | 'updated' | 'skipped'; reason?: string }[] = [];
    await this.prisma.$transaction(
      async (tx) => {
        for (const r of rows) {
          if (!r.name) {
            results.push({ row: r.row, name: '', status: 'skipped', reason: 'Пустое название' });
            continue;
          }
          const p = r.patch;
          const sku = (p.sku as string | undefined) || undefined;
          const barcode = (p.barcode as string | undefined) || undefined;
          const existing = await tx.product.findFirst({
            where: { businessId, locationId, archived: false, OR: [...(sku ? [{ sku }] : []), ...(barcode ? [{ barcode }] : []), ...(!sku && !barcode ? [{ name: r.name }] : [])] },
          });
          const data = {
            name: r.name,
            receiptName: (p.receiptName as string | undefined) ?? null,
            sku: sku ?? null,
            barcode: barcode ?? null,
            saleUnit: String(p.saleUnit ?? 'pcs'),
            writeoffUnit: String(p.writeoffUnit ?? 'pcs'),
            unitRatio: Number(p.unitRatio) || 1,
            salePrice: BigInt(Math.round(Number(p.salePrice) || 0)),
            costPrice: BigInt(Math.round(Number(p.costPrice) || 0)),
            criticalStock: Number(p.criticalStock) || 0,
            desiredStock: Number(p.desiredStock) || 0,
            brand: (p.brand as string | undefined) ?? null,
            shade: (p.shade as string | undefined) ?? null,
            expiryDate: typeof p.expiryDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.expiryDate) ? new Date(`${p.expiryDate}T00:00:00.000Z`) : null,
            showToClients: Boolean(p.showToClients),
            updatedBy: ctx.member!.staffId,
          };
          if (existing) {
            await tx.product.update({ where: { id: existing.id }, data: { ...data, version: { increment: 1 } } });
            results.push({ row: r.row, name: r.name, status: 'updated' });
          } else {
            await tx.product.create({ data: { ...data, id: newId('product'), businessId, locationId, categoryId, createdBy: ctx.member!.staffId } });
            results.push({ row: r.row, name: r.name, status: 'created' });
          }
        }
      },
      { timeout: 60_000 },
    );
    return results;
  }

  // ─────────────────────────── Сетевое копирование (F-08-130, F-08-135) ───────────────────────────

  async copyGoodNetworked(ctx: RequestContext, goodId: string, targetLocationIds: string[]) {
    const businessId = ctx.member!.businessId;
    const src = await this.prisma.product.findFirst({ where: { id: goodId, businessId } });
    if (!src) throw new ApiError('not_found', 'Good not found');
    const groupId = src.networkGroupId ?? src.id;
    const created: ReturnType<typeof goodView>[] = [];
    await this.prisma.$transaction(async (tx) => {
      await tx.product.update({ where: { id: src.id }, data: { networkGroupId: groupId, isNetworkSource: true } });
      for (const locationId of targetLocationIds) {
        const cats = await tx.stockCategory.findMany({ where: { businessId, locationId }, orderBy: { createdAt: 'asc' } });
        const target = cats.find((c) => c.name === src.name) ?? cats.find((c) => c.name === 'Основные товары') ?? cats[0];
        if (!target) continue;
        const existing = await tx.product.findFirst({ where: { businessId, locationId, networkGroupId: groupId } });
        if (existing) continue;
        const { id: _id, createdAt: _c, updatedAt: _u, version: _v, clientName, ...rest } = src;
        const row = await tx.product.create({
          data: { ...rest, clientName: (clientName ?? undefined) as Prisma.InputJsonValue | undefined, id: newId('product'), locationId, categoryId: target.id, networkGroupId: groupId, isNetworkSource: false, createdBy: ctx.member!.staffId, updatedBy: ctx.member!.staffId },
        });
        created.push(goodView(row));
      }
      await this.audit.record(tx, ctx, { action: 'update', entityType: 'stockGood', entityId: goodId, before: {}, after: { copiedTo: targetLocationIds.length } });
    });
    return created;
  }

  // ─────────────────────────── Права раздела + история (F-08-109…118, F-08-149) ───────────────────────────

  private async permsMap(db: Prisma.TransactionClient | PrismaService, businessId: string): Promise<Record<string, StockPermissionsJson>> {
    const row = await db.businessSetting.findUnique({ where: { businessId_area: { businessId, area: 'stock.permissions' } } });
    return (row?.data as Record<string, StockPermissionsJson> | undefined) ?? {};
  }

  async getPermissions(businessId: string, staffId: string) {
    return { stored: (await this.permsMap(this.prisma, businessId))[staffId] ?? null };
  }

  /** mode: set — слить патч с текущим; replace — поставить как есть (шаблон роли, копия) */
  async putPermissions(ctx: RequestContext, staffId: string, perms: StockPermissionsJson, mode: 'set' | 'replace', summary: string, base: StockPermissionsJson) {
    const businessId = ctx.member!.businessId;
    let next: StockPermissionsJson = perms;
    await this.prisma.$transaction(async (tx) => {
      const map = await this.permsMap(tx, businessId);
      next = mode === 'set' ? { ...(map[staffId] ?? base), ...perms } : perms;
      const data = { ...map, [staffId]: next } as Prisma.InputJsonValue;
      await tx.businessSetting.upsert({
        where: { businessId_area: { businessId, area: 'stock.permissions' } },
        create: { businessId, area: 'stock.permissions', data, updatedBy: ctx.member!.staffId },
        update: { data, updatedBy: ctx.member!.staffId, version: { increment: 1 } },
      });
      await this.audit.record(tx, ctx, { action: 'permissions', entityType: 'stockPermissions', entityId: staffId, before: null, after: { summary } });
    });
    return next;
  }

  async staffName(businessId: string, staffId: string): Promise<string> {
    return (await this.prisma.staff.findFirst({ where: { id: staffId, businessId }, select: { name: true } }))?.name ?? staffId;
  }

  async permissionHistory(businessId: string, staffId: string) {
    const rows = await this.prisma.auditEvent.findMany({ where: { businessId, entityType: 'stockPermissions', entityId: staffId }, orderBy: { at: 'desc' } });
    return rows.map((r) => {
      const diff = r.diff as Record<string, [unknown, unknown]> | null;
      return { id: r.id, businessId, entityType: 'permissions', entityId: staffId, staffName: r.actorName, at: utcToLocal(r.at), summary: String(diff?.summary?.[1] ?? 'Изменено') };
    });
  }

  // ─────────────────────────── Ценники (F-08-093…095) ───────────────────────────

  async getPriceTagLayout(businessId: string) {
    const row = await this.prisma.businessSetting.findUnique({ where: { businessId_area: { businessId, area: 'stock.priceTag' } } });
    return { stored: (row?.data as Record<string, unknown> | undefined) ?? null };
  }

  async updatePriceTagLayout(ctx: RequestContext, patch: Record<string, unknown>, base: Record<string, unknown>) {
    const businessId = ctx.member!.businessId;
    const current = (await this.getPriceTagLayout(businessId)).stored ?? base;
    const next = { ...current, ...patch, businessId };
    await this.prisma.businessSetting.upsert({
      where: { businessId_area: { businessId, area: 'stock.priceTag' } },
      create: { businessId, area: 'stock.priceTag', data: next as Prisma.InputJsonValue, updatedBy: ctx.member!.staffId },
      update: { data: next as Prisma.InputJsonValue, updatedBy: ctx.member!.staffId, version: { increment: 1 } },
    });
    return next;
  }

  // ─────────────────────────── Напоминания-сводка, материалы и палитра клиента (F-00-142…144) ───────────────────────────

  async remindersSummary(businessId: string, locationId: string, staffId?: string) {
    const warningDays = await this.expiryWarningDays(businessId);
    const goods = await this.prisma.product.findMany({ where: { businessId, locationId, archived: false } });
    const levels = await this.levelsByGood(businessId);
    const now = utcToLocalDate(new Date());
    const out: { id: string; kind: string; title: string; date?: string; goodId?: string; equipmentId?: string; staffId?: string; severity: 'info' | 'warning' | 'danger' }[] = [];
    for (const g of goods) {
      const stock = round6(levels.get(g.id) ?? 0);
      if (g.criticalStock > 0 && stock <= g.criticalStock) out.push({ id: `low_${g.id}`, kind: 'lowStock', title: g.name, goodId: g.id, severity: 'danger' });
      const exp = g.expiryDate ? g.expiryDate.toISOString().slice(0, 10) : undefined;
      const flag = expiryFlag(exp, now, warningDays);
      if (flag === 'expired') out.push({ id: `exp_${g.id}`, kind: 'expired', title: g.name, date: exp, goodId: g.id, severity: 'danger' });
      else if (flag === 'expiring') out.push({ id: `expwarn_${g.id}`, kind: 'expiring', title: g.name, date: exp, goodId: g.id, severity: 'warning' });
    }
    const equipment = await this.prisma.equipment.findMany({ where: { businessId, locationId, archived: false } });
    for (const e of equipment) {
      const d = e.replaceReminderDate ? e.replaceReminderDate.toISOString().slice(0, 10) : undefined;
      if (d && d <= now) out.push({ id: `eqrepl_${e.id}`, kind: 'equipmentReplace', title: e.name, date: d, equipmentId: e.id, severity: 'warning' });
    }
    const custom = await this.prisma.stockReminder.findMany({ where: { businessId, locationId, done: false, ...(staffId ? { staffId } : {}) } });
    for (const r of custom) out.push({ id: r.id, kind: 'custom', title: r.text, date: r.date.toISOString().slice(0, 10), staffId: r.staffId ?? undefined, severity: 'info' });
    return out.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
  }

  async clientMaterials(businessId: string, locationId: string) {
    const goods = await this.prisma.product.findMany({ where: { businessId, locationId, archived: false, showToClients: true } });
    return goods.map((g) => ({ id: g.id, name: (g.clientName as Record<string, string> | null)?.ru || g.name, brand: g.brand ?? undefined }));
  }

  async clientPalette(businessId: string, locationId: string) {
    const goods = await this.prisma.product.findMany({ where: { businessId, locationId, archived: false, shade: { not: null } } });
    const levels = await this.levelsByGood(businessId);
    const now = utcToLocalDate(new Date());
    return goods
      .filter((g) => !!g.shade)
      .filter((g) => expiryFlag(g.expiryDate ? g.expiryDate.toISOString().slice(0, 10) : undefined, now, 14) !== 'expired')
      .filter((g) => round6(levels.get(g.id) ?? 0) > 0)
      .map((g) => ({ id: g.id, name: g.name, brand: g.brand ?? undefined, shade: g.shade!, colorIndex: g.shadeColorIndex ?? undefined }));
  }

  // ─────────────────────────── Предложение поставщика (F-00-165, В-26) ───────────────────────────

  async supplierOffer(businessId: string, productName: string) {
    const settings = await this.prisma.stockSettings.findUnique({ where: { businessId } });
    if (!settings?.adsOptIn) return null;
    const t = utcToLocalDate(new Date());
    const name = productName.toLowerCase();
    const ads = await this.prisma.ad.findMany({ where: { placementId: 'pl_stock', paused: false, startDate: { lte: t }, endDate: { gte: t } }, orderBy: { createdAt: 'asc' } });
    const ad = ads.find((a) => ((a.productKeywords as string[] | null) ?? []).some((k) => name.includes(String(k).toLowerCase())));
    if (!ad) return null;
    return { id: ad.id, title: ad.title, text: ad.text ?? undefined, imageUrl: ad.imageUrl ?? undefined, ctaUrl: ad.ctaUrl ?? undefined, advertiser: { name: ad.advertiserName, contact: ad.advertiserContact } };
  }

  /** F-08-098/100: себестоимость на дату — цена последнего прихода на/до даты, иначе из карточки */
  async costPriceAt(businessId: string, goodId: string, atDate: string) {
    const ops = (await this.loadOps({ businessId, type: 'income' })).filter((op) => op.date <= atDate).sort((a, b) => b.date.localeCompare(a.date));
    for (const op of ops) {
      const line = op.lines.find((l) => l.goodId === goodId);
      if (line) return { value: line.unitPrice };
    }
    const g = await this.prisma.product.findFirst({ where: { id: goodId, businessId }, select: { costPrice: true } });
    return { value: g ? moneyToJson(g.costPrice) : 0 };
  }
}
