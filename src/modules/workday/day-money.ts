import type { PrismaService } from '../../common/prisma.service.js';

export interface DayMoneyRaw {
  cash: bigint;
  card: bigint;
  transfer: bigint;
  other: bigint;
  refunds: bigint;
  expense: bigint;
}

/**
 * Деньги кассы за день — операции всех касс бизнеса датой этого дня (как «Касса за день» finance): приход по способам,
 * возвраты и прочие расходы. Поправки пересчёта ящика (открытие/закрытие смены) — не выручка и не расход дня: они в
 * блоке смены. Общий расчёт «Итогов дня» (WorkdayService.dayClose) и уведомления владельцу «День закрыт»
 * (notify/day-close-notice.ts) — мок фронта: dayMoneyOf в src/domain/journalWorkday.ts.
 */
export async function dayMoneyOf(prisma: PrismaService, businessId: string, day: { from: Date; to: Date }): Promise<DayMoneyRaw> {
  const money: DayMoneyRaw = { cash: 0n, card: 0n, transfer: 0n, other: 0n, refunds: 0n, expense: 0n };
  const refundItem = await prisma.paymentItem.findFirst({ where: { businessId, systemKey: 'refund' }, select: { id: true } });
  const ops = await prisma.finOp.findMany({
    where: { businessId, cancelled: false, date: { gte: day.from, lt: day.to }, kind: { in: ['income', 'expense'] } },
    select: { id: true, kind: true, amount: true, method: true, itemId: true },
  });
  const shifts = await prisma.cashShift.findMany({
    where: { businessId, OR: [{ openedAt: { gte: day.from, lt: day.to } }, { closedAt: { gte: day.from, lt: day.to } }] },
    select: { adjustmentOperationIds: true },
  });
  const adjustments = new Set(shifts.flatMap((sh) => (sh.adjustmentOperationIds as string[] | null) ?? []));
  for (const op of ops) {
    if (adjustments.has(op.id)) continue;
    if (op.kind === 'income') {
      const m = (['cash', 'card', 'transfer'].includes(op.method) ? op.method : 'other') as 'cash' | 'card' | 'transfer' | 'other';
      money[m] += op.amount;
    } else if (refundItem && op.itemId === refundItem.id) money.refunds += op.amount;
    else money.expense += op.amount;
  }
  return money;
}
