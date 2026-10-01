import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { ApiError } from '../../common/errors/api-error.js';
import { newId } from '../../common/ids/ids.js';
import { PrismaService } from '../../common/prisma.service.js';
import { AvailabilityService } from '../availability/availability.service.js';
import { StockCatalogService } from '../stock/stock-catalog.service.js';
import { bookedDuration, type ServiceLine } from './rules.js';

/**
 * ⭐ Допродажа при записи (решение владельца, 01.10.2026). В карточке услуги владелец выбирает «Сопутствующие услуги
 * и товары» (Service.extra.upsell = { serviceIds, productIds } — тот же JSON, что ServiceExtra фронта, без новой
 * колонки). Клиент при онлайн-записи видит их одним блоком и добавляет в одно касание:
 *  - услуга — продлевает запись у того же мастера; предлагается, только если мастер её делает и продлённое время
 *    свободно (окна сервера, тот же расчёт, что у самой записи); строка записи помечается upsellOf;
 *  - товар — строка «товары визита» (extras.goodsLines, upsellOf), оплачивается на визите обычной продажей склада
 *    (syncVisitGoodsSale после оплаты) — второго потока продажи нет. Предлагается, только если на складе продаж
 *    филиала есть остаток сверх уже отложенного к будущим неоплаченным записям («отложено» = такие строки).
 * Сервер сам проверяет, что добавка из списка услуги, мастер её делает, время свободно, и ставит цену — клиенту не
 * верим ни в длительности, ни в цене.
 */

type Tx = Prisma.TransactionClient;
type Db = PrismaService | Tx;

const arr = <T = string>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const CANCELLED = ['cancelled_by_client', 'cancelled_by_master', 'no_show'];

export interface UpsellConfig {
  serviceIds: string[];
  productIds: string[];
}

/** Сопутствующие из Service.extra (нет поля — пусто) */
export function upsellConfigOf(extra: unknown): UpsellConfig {
  const u = (extra && typeof extra === 'object' ? (extra as { upsell?: Partial<UpsellConfig> }).upsell : undefined) ?? {};
  return { serviceIds: arr<string>(u.serviceIds).filter((x) => typeof x === 'string'), productIds: arr<string>(u.productIds).filter((x) => typeof x === 'string') };
}

export interface UpsellServiceOffer {
  serviceId: string;
  parentServiceId: string;
  name: unknown;
  durationMin: number;
  durationMax?: number;
  priceMin: number;
  priceMax?: number;
}

export interface UpsellProductOffer {
  productId: string;
  parentServiceId: string;
  name: Record<string, string>;
  price: number;
  /** Сколько можно взять (остаток на складе продаж − отложено к будущим записям) */
  left: number;
}

export interface UpsellOffersQuery {
  staffId: string;
  /** Услуги записи (основные), к которым ищем сопутствующие */
  serviceIds: string[];
  /** 'YYYY-MM-DDTHH:mm' — начало записи у этого мастера */
  start: string;
  /** Уже добавленные клиентом сопутствующие услуги — продлённое время считается с ними */
  added?: string[];
  locationId?: string;
}

export interface AddOnsInput {
  serviceIds?: string[];
  productIds?: string[];
}

@Injectable()
export class UpsellService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly availability: AvailabilityService,
    private readonly stock: StockCatalogService,
  ) {}

  /** Карта «кандидат → основная услуга» по списку основных (первая основная, у которой он в списке) */
  private parentMap(mains: { id: string; extra: unknown }[]): { services: Map<string, string>; products: Map<string, string> } {
    const services = new Map<string, string>();
    const products = new Map<string, string>();
    for (const m of mains) {
      const cfg = upsellConfigOf(m.extra);
      for (const id of cfg.serviceIds) if (!services.has(id)) services.set(id, m.id);
      for (const id of cfg.productIds) if (!products.has(id)) products.set(id, m.id);
    }
    return { services, products };
  }

  private performs(c: { id: string; staffIds: unknown }, staff: { id: string; serviceIds: unknown }): boolean {
    return arr(c.staffIds).includes(staff.id) || arr(staff.serviceIds).includes(c.id);
  }

  /** Остаток товаров на складах продаж филиала минус отложенное к будущим неоплаченным записям */
  private async productLeft(db: Db, businessId: string, locationId: string, productIds: string[], excludeBookingId?: string): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!productIds.length) return out;
    const saleIds = new Set((await db.warehouse.findMany({ where: { businessId, locationId, type: 'sale' }, select: { id: true } })).map((w) => w.id));
    for (const id of productIds) {
      const levels = await this.stock.computeLevels(businessId, id);
      out.set(id, levels.filter((l) => saleIds.has(l.warehouseId)).reduce((s, l) => s + l.qty, 0));
    }
    const upcoming = await db.booking.findMany({
      where: { businessId, locationId, deletedAt: null, startAt: { gte: new Date() }, paidAmount: 0n, status: { notIn: CANCELLED }, ...(excludeBookingId ? { id: { not: excludeBookingId } } : {}) },
      select: { extras: true },
      take: 2000,
    });
    for (const b of upcoming) {
      const lines = arr<{ itemId: string; qty: number; upsellOf?: string }>((b.extras as { goodsLines?: unknown } | null)?.goodsLines);
      for (const l of lines) if (l.upsellOf && out.has(l.itemId)) out.set(l.itemId, (out.get(l.itemId) ?? 0) - Math.max(1, l.qty || 1));
    }
    return out;
  }

  /** Что предложить клиенту к выбранным услугам в это время (публично: виджет, приложение, каталог) */
  async offers(q: UpsellOffersQuery): Promise<{ services: UpsellServiceOffer[]; products: UpsellProductOffer[] }> {
    const empty = { services: [], products: [] };
    if (!q.staffId || !q.serviceIds.length || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(q.start)) return empty;
    const staff = await this.prisma.staff.findFirst({
      where: { id: q.staffId, deletedAt: null },
      select: { id: true, businessId: true, serviceIds: true, locations: { select: { locationId: true } } },
    });
    if (!staff) return empty;
    const businessId = staff.businessId;
    const mains = await this.prisma.service.findMany({ where: { id: { in: q.serviceIds }, businessId, active: true } });
    if (!mains.length) return empty;
    const map = this.parentMap(mains);
    const added = (q.added ?? []).filter((id) => map.services.has(id));
    const taken = new Set([...q.serviceIds, ...added]);
    const candIds = [...map.services.keys()].filter((id) => !taken.has(id));
    const [cands, addedRows] = await Promise.all([
      candIds.length ? this.prisma.service.findMany({ where: { id: { in: candIds }, businessId, active: true, onlineBookable: true, kind: 'individual' } }) : Promise.resolve([]),
      added.length ? this.prisma.service.findMany({ where: { id: { in: added }, businessId } }) : Promise.resolve([]),
    ]);
    const base = [...mains, ...addedRows];
    const baseMin = base.reduce((s, x) => s + x.durationMin, 0);
    const baseMax = base.reduce((s, x) => s + bookedDuration(x), 0);
    const baseBuf = Math.max(0, ...base.map((x) => x.bufferAfterMin ?? 0));
    const locationId = q.locationId ?? staff.locations[0]?.locationId;
    const date = q.start.slice(0, 10);

    const services: UpsellServiceOffer[] = [];
    for (const c of cands) {
      if (c.servicePackage != null || !this.performs(c, staff)) continue;
      const min = baseMin + c.durationMin;
      const max = baseMax + bookedDuration(c);
      const slots = await this.availability.freeSlots(businessId, {
        staffId: staff.id,
        date,
        durationMin: min,
        durationMax: max > min ? max : undefined,
        bufferAfterMin: Math.max(baseBuf, c.bufferAfterMin ?? 0),
        locationId,
        serviceId: mains[0]!.id,
      });
      if (!slots.some((s) => s.start === q.start)) continue;
      services.push({
        serviceId: c.id,
        parentServiceId: map.services.get(c.id)!,
        name: c.name,
        durationMin: c.durationMin,
        ...(c.durationMax != null && c.durationMax > c.durationMin ? { durationMax: c.durationMax } : {}),
        priceMin: Number(c.priceMin),
        ...(c.priceMax != null && Number(c.priceMax) > Number(c.priceMin) ? { priceMax: Number(c.priceMax) } : {}),
      });
    }

    const products: UpsellProductOffer[] = [];
    const prodIds = [...map.products.keys()];
    if (prodIds.length && locationId) {
      const rows = await this.prisma.product.findMany({ where: { id: { in: prodIds }, businessId, locationId, archived: false } });
      const left = await this.productLeft(this.prisma, businessId, locationId, rows.map((r) => r.id));
      for (const p of rows) {
        const n = Math.floor(left.get(p.id) ?? 0);
        if (n <= 0 || Number(p.salePrice) <= 0) continue;
        const clientName = p.clientName && typeof p.clientName === 'object' ? (p.clientName as Record<string, string>) : undefined;
        products.push({ productId: p.id, parentServiceId: map.products.get(p.id)!, name: clientName?.ru ? clientName : { ru: p.name }, price: Number(p.salePrice), left: n });
      }
    }
    // Порядок — как в карточке услуги
    const order = (id: string, list: string[]) => list.indexOf(id);
    const allCfg = mains.flatMap((m) => upsellConfigOf(m.extra).serviceIds);
    const allProd = mains.flatMap((m) => upsellConfigOf(m.extra).productIds);
    services.sort((a, b) => order(a.serviceId, allCfg) - order(b.serviceId, allCfg));
    products.sort((a, b) => order(a.productId, allProd) - order(b.productId, allProd));
    return { services, products };
  }

  /**
   * Строки сопутствующих услуг для place(): каждая — из списка одной из основных услуг записи. Мастер/онлайн/время
   * проверяет сам place() (как у любой строки онлайн-записи).
   */
  async serviceLines(db: Db, businessId: string, staffId: string, mainServiceIds: string[], addOnIds: string[]): Promise<{ serviceId: string; upsellOf: string }[]> {
    const ids = [...new Set(addOnIds)].filter((id) => !mainServiceIds.includes(id));
    if (!ids.length) return [];
    const [mains, cands, staff] = await Promise.all([
      db.service.findMany({ where: { id: { in: mainServiceIds }, businessId }, select: { id: true, extra: true } }),
      db.service.findMany({ where: { id: { in: ids }, businessId }, select: { id: true, staffIds: true, active: true, onlineBookable: true } }),
      db.staff.findFirst({ where: { id: staffId, businessId }, select: { id: true, serviceIds: true } }),
    ]);
    const map = this.parentMap(mains);
    return ids.map((id) => {
      const parent = map.services.get(id);
      const c = cands.find((x) => x.id === id);
      // Не из списка услуги, выключена или мастер её не делает — честная ошибка допродажи, а не «время занято»
      if (!parent || !c || !c.active || !c.onlineBookable || !staff || !this.performs(c, staff)) throw new ApiError('upsell_unavailable', 'Add-on is not offered with this service');
      return { serviceId: id, upsellOf: parent };
    });
  }

  /** Товарные строки визита из выбранных клиентом товаров: цена склада, продавец — мастер, остаток проверен */
  async goodsLines(
    db: Db,
    args: { businessId: string; locationId: string; staffId: string; mainServiceIds: string[]; productIds: string[] },
  ): Promise<{ id: string; itemId: string; qty: number; price: number; discountPct: number; sellerId: string; upsellOf: string }[]> {
    const ids = [...new Set(args.productIds)];
    if (!ids.length) return [];
    const mains = await db.service.findMany({ where: { id: { in: args.mainServiceIds }, businessId: args.businessId }, select: { id: true, extra: true } });
    const map = this.parentMap(mains);
    const rows = await db.product.findMany({ where: { id: { in: ids }, businessId: args.businessId, locationId: args.locationId, archived: false } });
    const left = await this.productLeft(db, args.businessId, args.locationId, rows.map((r) => r.id));
    return ids.map((id) => {
      const p = rows.find((r) => r.id === id);
      const parent = map.products.get(id);
      if (!p || !parent || (left.get(id) ?? 0) < 1) throw new ApiError('upsell_unavailable', 'Product is not available');
      return { id: newId('goodsLine'), itemId: id, qty: 1, price: Number(p.salePrice), discountPct: 0, sellerId: args.staffId, upsellOf: parent };
    });
  }

  /** «Допродано»: сколько сопутствующих клиенты взяли к этой услуге за N дней (не считая отменённых записей) */
  async stats(businessId: string, serviceId: string, days = 90): Promise<{ days: number; accepted: number; services: number; products: number; revenue: number }> {
    const svc = await this.prisma.service.findFirst({ where: { id: serviceId, businessId }, select: { id: true } });
    if (!svc) throw new ApiError('not_found', 'Service not found');
    const since = new Date(Date.now() - days * 86_400_000);
    const rows = await this.prisma.booking.findMany({
      where: { businessId, deletedAt: null, startAt: { gte: since }, status: { notIn: ['cancelled_by_client', 'cancelled_by_master'] } },
      select: { services: true, extras: true },
    });
    let services = 0;
    let products = 0;
    let revenue = 0;
    for (const b of rows) {
      for (const l of arr<ServiceLine>(b.services)) if (l.upsellOf === serviceId) { services += Math.max(1, l.qty || 1); revenue += l.price * Math.max(1, l.qty || 1); }
      for (const g of arr<{ qty: number; price: number; upsellOf?: string }>((b.extras as { goodsLines?: unknown } | null)?.goodsLines)) {
        if (g.upsellOf === serviceId) { products += Math.max(1, g.qty || 1); revenue += g.price * Math.max(1, g.qty || 1); }
      }
    }
    return { days, accepted: services + products, services, products, revenue };
  }

  /** Кандидаты для карточки услуги: услуги бизнеса (индивидуальные, не пакеты) и товары склада всех филиалов */
  async candidates(businessId: string) {
    const [svcs, prods, locs] = await Promise.all([
      this.prisma.service.findMany({ where: { businessId, active: true, kind: 'individual', servicePackage: { equals: Prisma.DbNull } }, orderBy: [{ order: 'asc' }], take: 500 }),
      this.prisma.product.findMany({ where: { businessId, archived: false }, orderBy: { name: 'asc' }, take: 500 }),
      this.prisma.location.findMany({ where: { businessId, deletedAt: null }, select: { id: true, name: true } }),
    ]);
    const multi = locs.length > 1;
    return {
      services: svcs.map((x) => ({
        id: x.id,
        name: x.name,
        categoryId: x.categoryId ?? '',
        durationMin: x.durationMin,
        priceMin: Number(x.priceMin),
        ...(x.priceMax != null && Number(x.priceMax) > Number(x.priceMin) ? { priceMax: Number(x.priceMax) } : {}),
      })),
      products: prods.map((p) => ({
        id: p.id,
        name: p.name,
        price: Number(p.salePrice),
        locationId: p.locationId,
        ...(multi ? { locationName: locs.find((l) => l.id === p.locationId)?.name } : {}),
      })),
    };
  }

  /** Сопутствующие всех услуг бизнеса: { [serviceId]: { serviceIds, productIds } } (только непустые) */
  async configs(businessId: string): Promise<Record<string, UpsellConfig>> {
    const rows = await this.prisma.service.findMany({ where: { businessId, active: true, NOT: { extra: { equals: Prisma.DbNull } } }, select: { id: true, extra: true } });
    const out: Record<string, UpsellConfig> = {};
    for (const r of rows) {
      const cfg = upsellConfigOf(r.extra);
      if (cfg.serviceIds.length || cfg.productIds.length) out[r.id] = cfg;
    }
    return out;
  }
}
