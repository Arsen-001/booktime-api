import type { PrismaService } from '../../common/prisma.service.js';
import { inRange, localDateAt, tzMapOf, wideUtcBounds, type LocationTz, type ReportRange } from './reports-common.js';

/**
 * ⭐ Решение владельца 01.10.2026 (F-12-006, F-12-125; порт receivedMoneyMock фронта, src/api/reports.ts): выручка
 * аналитики — деньги, которые правда получены, те же, что в «Кассе за день» и «Финансовом отчёте».
 * - Услуги — приходы «Оплата услуги» (в том числе предоплата переводом и оплата участника группы: своя операция,
 *   визит берёт только остаток — считается один раз) минус возвраты клиенту по визиту.
 * - Товары — оплаченные продажи склада (без оплаты лояльностью) и приходы «Продажа товара» без документа склада.
 * - Не выручка: скидка, оплата абонементом/сертификатом/со счёта клиента (операций не создают), продажи абонементов и
 *   сертификатов, пополнения счетов, штрафы (F-12-012).
 * Сумма «по цене записи» — отдельной строкой «Записано на сумму» (booked/bookedAmount/grandBooked).
 */
export interface ReceivedMoney {
  kind: 'services' | 'products';
  /** Местная дата в поясе филиала */
  date: string;
  amount: number;
  /** Штук товара (у прихода «Продажа товара» без документа склада — 1) */
  qty: number;
  staffId?: string;
  clientId?: string;
  bookingId?: string;
  /** Чек товара: документ склада или операция кассы */
  saleId?: string;
}

export async function receivedMoney(prisma: PrismaService, businessId: string, locations: LocationTz[], range: ReportRange): Promise<ReceivedMoney[]> {
  const tzMap = tzMapOf(locations);
  const locationIds = locations.map((l) => l.id);
  const { from, to } = wideUtcBounds(range);
  const items = await prisma.paymentItem.findMany({ where: { businessId, systemKey: { in: ['servicePayment', 'refund', 'goodsSale'] } }, select: { id: true, systemKey: true } });
  const itemId = (key: string) => items.find((i) => i.systemKey === key)?.id ?? '—';
  const [servicePayment, refund, goodsSale] = [itemId('servicePayment'), itemId('refund'), itemId('goodsSale')];
  const [ops, sales] = await Promise.all([
    prisma.finOp.findMany({
      where: { businessId, cancelled: false, locationId: { in: locationIds }, date: { gte: from, lt: to }, itemId: { in: [servicePayment, refund, goodsSale] } },
      select: { id: true, kind: true, itemId: true, amount: true, date: true, locationId: true, source: true, refId: true, partyType: true, partyId: true },
    }),
    prisma.stockOp.findMany({
      where: { businessId, type: 'sale', paid: true, cancelledAt: null, locationId: { in: locationIds }, date: { gte: from, lt: to }, NOT: { paymentMethod: 'loyalty' } },
      select: { id: true, date: true, locationId: true, staffId: true, clientId: true, bookingId: true, financeOperationId: true },
    }),
  ]);
  const opsWithStockDoc = new Set(
    (await prisma.stockOp.findMany({ where: { businessId, financeOperationId: { in: ops.map((o) => o.id) } }, select: { financeOperationId: true } })).map((s) => s.financeOperationId!),
  );
  const refIds = [...new Set(ops.map((o) => o.refId).filter((x): x is string => Boolean(x)))];
  const bookings = refIds.length ? await prisma.booking.findMany({ where: { businessId, id: { in: refIds } }, select: { id: true, staffId: true, clientId: true } }) : [];
  const bookingById = new Map(bookings.map((b) => [b.id, b] as const));
  const out: ReceivedMoney[] = [];
  for (const o of ops) {
    const date = localDateAt(o.date, o.locationId, tzMap);
    if (!inRange(date, range)) continue;
    const booking = o.refId ? bookingById.get(o.refId) : undefined;
    const base = { date, bookingId: booking?.id, staffId: booking?.staffId, clientId: booking?.clientId ?? (o.partyType === 'client' ? (o.partyId ?? undefined) : undefined) };
    const amount = Number(o.amount);
    if (o.kind === 'income' && o.itemId === servicePayment) out.push({ ...base, kind: 'services', amount, qty: 0 });
    else if (o.kind === 'expense' && o.itemId === refund && o.source === 'booking' && booking) out.push({ ...base, kind: 'services', amount: -amount, qty: 0 });
    else if (o.kind === 'income' && o.itemId === goodsSale && !opsWithStockDoc.has(o.id)) out.push({ ...base, kind: 'products', amount, qty: 1, saleId: o.id });
  }
  if (sales.length) {
    const lines = await prisma.stockOpLine.findMany({ where: { opId: { in: sales.map((s) => s.id) } }, select: { opId: true, qtySale: true, unitPrice: true, sellerId: true } });
    for (const s of sales) {
      const date = localDateAt(s.date, s.locationId, tzMap);
      if (!inRange(date, range)) continue;
      for (const l of lines) {
        if (l.opId !== s.id) continue;
        const qty = Math.abs(l.qtySale);
        out.push({ kind: 'products', date, amount: qty * Number(l.unitPrice), qty, staffId: l.sellerId ?? s.staffId ?? undefined, clientId: s.clientId ?? undefined, bookingId: s.bookingId ?? undefined, saleId: s.id });
      }
    }
  }
  return out;
}

export function sumMoney(items: readonly ReceivedMoney[]): number {
  return items.reduce((s, m) => s + m.amount, 0);
}
