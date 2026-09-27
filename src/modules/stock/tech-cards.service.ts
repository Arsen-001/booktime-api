import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { newId } from '../../common/ids/ids.js';
import { PrismaService } from '../../common/prisma.service.js';
import type { TechCardBody } from './stock.schemas.js';

interface TechCardLineJson {
  goodId: string;
  warehouseId: string;
  qtyWriteoff: number;
}

interface BookingServiceLineJson {
  serviceId: string;
  staffId: string;
  qty: number;
}

function techCardView(r: { id: string; businessId: string; locationId: string; serviceId: string; staffId: string; lines: unknown; version: number; createdAt: Date; updatedAt: Date }) {
  return { id: r.id, businessId: r.businessId, locationId: r.locationId, serviceId: r.serviceId, staffId: r.staffId, lines: (r.lines as TechCardLineJson[]) ?? [], version: r.version, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt?.toISOString() };
}

function textRu(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && 'ru' in v) return String((v as { ru?: unknown }).ru ?? '');
  return '';
}

/**
 * Технологические карты (F-08-036…045, F-08-136) — у каждого мастера своя. Автосписание/откат расходников
 * по «Пришёл»/«Не пришёл» (F-08-041/042, ⭐ F-00-136) — `deductForBooking`/`revertForBooking`, вызывается
 * `BookingsService.changeStatus` (этап 7) best-effort, тем же приёмом, что и пересчёт лояльности этапа 11
 * (`JournalModule` импортирует `StockModule`, не наоборот — нет цикла).
 */
@Injectable()
export class TechCardsService {
  private readonly logger = new Logger(TechCardsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** F-08-036…045: строка карточки с именами (услуга/мастер/товар/склад) — как `toTechCardRow` мока */
  private async toRow(card: { id: string; businessId: string; locationId: string; serviceId: string; staffId: string; lines: unknown; version: number; createdAt: Date; updatedAt: Date }) {
    const base = techCardView(card);
    const [service, staff] = await Promise.all([
      this.prisma.service.findUnique({ where: { id: base.serviceId }, select: { name: true } }),
      this.prisma.staff.findUnique({ where: { id: base.staffId }, select: { name: true } }),
    ]);
    const goodIds = base.lines.map((l) => l.goodId);
    const warehouseIds = base.lines.map((l) => l.warehouseId);
    const [goods, warehouses] = await Promise.all([
      goodIds.length ? this.prisma.product.findMany({ where: { id: { in: goodIds } }, select: { id: true, name: true, writeoffUnit: true } }) : Promise.resolve([]),
      warehouseIds.length ? this.prisma.warehouse.findMany({ where: { id: { in: warehouseIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
    ]);
    return {
      ...base,
      serviceName: textRu(service?.name),
      staffName: staff?.name ?? '',
      lineDetails: base.lines.map((l) => ({
        ...l,
        goodName: goods.find((g) => g.id === l.goodId)?.name ?? '',
        // Код единицы (не готовая метка): фронт сам зовёт unitById(...).short.ru — тот же справочник,
        // что и во всём разделе, чтобы не дублировать таблицу единиц на сервере.
        writeoffUnitCode: goods.find((g) => g.id === l.goodId)?.writeoffUnit ?? 'pcs',
        warehouseName: warehouses.find((w) => w.id === l.warehouseId)?.name ?? '',
      })),
    };
  }

  async list(businessId: string, locationId: string, serviceId?: string, staffId?: string) {
    const rows = await this.prisma.techCard.findMany({ where: { businessId, locationId, serviceId, staffId } });
    return Promise.all(rows.map((r) => this.toRow(r)));
  }

  async listForService(businessId: string, serviceId: string) {
    const rows = await this.prisma.techCard.findMany({ where: { businessId, serviceId } });
    return Promise.all(rows.map((r) => this.toRow(r)));
  }

  async get(businessId: string, id: string) {
    const row = await this.prisma.techCard.findFirst({ where: { id, businessId } });
    return row ? this.toRow(row) : undefined;
  }

  async getForServiceStaff(businessId: string, serviceId: string, staffId: string) {
    const row = await this.prisma.techCard.findUnique({ where: { businessId_serviceId_staffId: { businessId, serviceId, staffId } } });
    return row ? this.toRow(row) : undefined;
  }

  /** F-08-039: одна техкарта на пару (услуга, мастер) — «upsert», как форма экрана и предполагает */
  async upsert(ctx: RequestContext, body: TechCardBody) {
    const businessId = ctx.member!.businessId;
    const existing = await this.prisma.techCard.findUnique({ where: { businessId_serviceId_staffId: { businessId, serviceId: body.serviceId, staffId: body.staffId } } });
    const id = existing?.id ?? newId('techCard');
    await this.prisma.techCard.upsert({
      where: { businessId_serviceId_staffId: { businessId, serviceId: body.serviceId, staffId: body.staffId } },
      create: { id, businessId, locationId: body.locationId, serviceId: body.serviceId, staffId: body.staffId, lines: body.lines as unknown as Prisma.InputJsonValue, createdBy: ctx.member!.staffId, updatedBy: ctx.member!.staffId },
      update: { lines: body.lines as unknown as Prisma.InputJsonValue, updatedBy: ctx.member!.staffId, version: { increment: 1 } },
    });
    return this.get(businessId, id);
  }

  async remove(businessId: string, id: string) {
    const row = await this.prisma.techCard.findFirst({ where: { id, businessId } });
    if (!row) throw new ApiError('not_found', 'Tech card not found');
    await this.prisma.techCard.delete({ where: { id } });
  }

  // ─────────────────────────── Автосписание визита (F-08-041/042, ⭐ F-00-136) ───────────────────────────

  /**
   * «Клиент пришёл» → списать расходники по норме каждой строки услуги, у которой есть техкарта этого
   * мастера. Идемпотентно: если у брони уже есть непогашенный автосписанный документ — не повторяет.
   * Один документ на (склад, услуга-строка): у разных строк техкарты может быть разный склад, поэтому
   * группируем по warehouseId — F-08-037 разрешает списывать с разных складов одним визитом.
   */
  async deductForBooking(businessId: string, bookingId: string, staffId: string, services: BookingServiceLineJson[]): Promise<void> {
    try {
      const already = await this.prisma.stockOp.count({ where: { businessId, bookingId, autoWriteoff: true, cancelledAt: null, cancelledByDocId: null } });
      if (already > 0) return;
      const byWarehouse = new Map<string, { goodId: string; qtySale: number; unitPrice: bigint }[]>();
      for (const line of services) {
        const card = await this.prisma.techCard.findUnique({ where: { businessId_serviceId_staffId: { businessId, serviceId: line.serviceId, staffId: line.staffId ?? staffId } } });
        if (!card) continue;
        for (const tcLine of ((card.lines as unknown as TechCardLineJson[]) ?? [])) {
          const good = await this.prisma.product.findUnique({ where: { id: tcLine.goodId } });
          if (!good) continue;
          const qtySale = (tcLine.qtyWriteoff * (line.qty || 1)) / (good.unitRatio || 1);
          const list = byWarehouse.get(tcLine.warehouseId) ?? [];
          list.push({ goodId: tcLine.goodId, qtySale, unitPrice: good.costPrice });
          byWarehouse.set(tcLine.warehouseId, list);
        }
      }
      if (!byWarehouse.size) return;
      const locationRow = await this.prisma.booking.findUnique({ where: { id: bookingId }, select: { locationId: true } });
      for (const [warehouseId, lines] of byWarehouse) {
        const number = await this.nextNumberSafe(businessId);
        const opId = newId('stockOp');
        await this.prisma.$transaction(async (tx) => {
          await tx.stockOp.create({ data: { id: opId, businessId, locationId: locationRow?.locationId ?? '', number, type: 'writeoffService', date: new Date(), warehouseId, staffId, bookingId, autoWriteoff: true, reason: 'norm', comment: 'Автосписание по норме техкарты', createdBy: 'system', updatedBy: 'system' } });
          await tx.stockOpLine.createMany({ data: lines.map((l) => ({ id: newId('stockOpLine'), opId, businessId, goodId: l.goodId, qtySale: -Math.abs(l.qtySale), unitPrice: l.unitPrice, costTotal: -BigInt(Math.round(l.qtySale * Number(l.unitPrice))) })) });
        });
      }
    } catch (e) {
      // Best-effort, как пересчёт лояльности этапа 11 (recalcOne.catch): консультант не должен ронять смену статуса записи.
      this.logger.warn(`deductForBooking failed for booking ${bookingId}: ${(e as Error).message}`);
    }
  }

  /** «Не пришёл» / откат статуса «Пришёл» — разворачивает автосписанные документы этой брони (аналог cancelMove) */
  async revertForBooking(businessId: string, bookingId: string): Promise<void> {
    try {
      const docs = await this.prisma.stockOp.findMany({ where: { businessId, bookingId, autoWriteoff: true, cancelledAt: null, cancelledByDocId: null } });
      for (const doc of docs) {
        const lines = await this.prisma.stockOpLine.findMany({ where: { opId: doc.id } });
        const number = await this.nextNumberSafe(businessId);
        const reverseId = newId('stockOp');
        await this.prisma.$transaction(async (tx) => {
          await tx.stockOp.create({ data: { id: reverseId, businessId, locationId: doc.locationId, number, type: 'writeoffService', date: new Date(), warehouseId: doc.warehouseId, staffId: doc.staffId, bookingId: doc.bookingId, cancelsDocId: doc.id, comment: `Откат автосписания № ${doc.number}`, createdBy: 'system', updatedBy: 'system' } });
          await tx.stockOpLine.createMany({ data: lines.map((l) => ({ id: newId('stockOpLine'), opId: reverseId, businessId, goodId: l.goodId, qtySale: -l.qtySale, unitPrice: l.unitPrice, costTotal: -l.costTotal })) });
          await tx.stockOp.update({ where: { id: doc.id }, data: { cancelledByDocId: reverseId } });
        });
      }
    } catch (e) {
      this.logger.warn(`revertForBooking failed for booking ${bookingId}: ${(e as Error).message}`);
    }
  }

  private async nextNumberSafe(businessId: string): Promise<string> {
    const max = await this.prisma.stockOp.aggregate({ where: { businessId }, _max: { number: true } });
    const n = Number(max._max.number ?? 100000);
    return String((Number.isFinite(n) ? n : 100000) + 1);
  }
}
