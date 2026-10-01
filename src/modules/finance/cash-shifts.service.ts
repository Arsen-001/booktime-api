import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { newId } from '../../common/ids/ids.js';
import { moneyToJson } from '../../common/money/money.js';
import { PrismaService } from '../../common/prisma.service.js';
import { utcToLocal } from '../../common/time/time.js';
import { recordDayCloseNotice } from '../notify/day-close-notice.js';
import { FinanceCatalogService } from './finance-catalog.service.js';

type Money = bigint;
type ShiftRow = Prisma.CashShiftGetPayload<object>;
type OpRow = { id: string; kind: string; amount: bigint; method: string; itemId: string; cancelled: boolean; date: Date; createdAt: Date };

/**
 * Кассовая смена наличной кассы и Z-отчёт (fin-review Ф1) — этап 21, лейн «finance+stock». Портировано с мока
 * `src/api/finance.ts` (openCashShift/closeCashShift/listCashShifts, domain buildZReport/cashDiscrepancy): кассир
 * пересчитывает ящик на открытии и закрытии, расхождение с учётом пишется отдельной операцией «Прочий доход/расход»,
 * чтобы остаток кассы сошёлся с пересчётом. «Одна открытая смена на кассу» держит уникальный `open_key`.
 */
@Injectable()
export class CashShiftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly catalog: FinanceCatalogService,
  ) {}

  private async cashAccount(businessId: string, accountId: string) {
    const acc = await this.prisma.cashRegister.findFirst({ where: { id: accountId, businessId } });
    if (!acc) throw new ApiError('not_found', 'account_not_found');
    return acc;
  }

  private async accountOps(accountId: string): Promise<OpRow[]> {
    return this.prisma.finOp.findMany({ where: { accountId }, select: { id: true, kind: true, amount: true, method: true, itemId: true, cancelled: true, date: true, createdAt: true }, orderBy: { date: 'asc' } });
  }

  private balanceOf(opening: Money, ops: OpRow[]): Money {
    return ops.filter((o) => !o.cancelled).reduce((s, o) => s + (o.kind === 'income' || o.kind === 'transfer_in' ? o.amount : -o.amount), opening);
  }

  /** Z-отчёт — domain/finance.ts buildZReport мока, в bigint */
  private zReport(openingBalance: Money, ops: OpRow[], refundItemId: string | undefined) {
    let income = 0n,
      expense = 0n,
      refunds = 0n,
      transfersIn = 0n,
      transfersOut = 0n,
      count = 0;
    const byMethod: Record<'cash' | 'card' | 'transfer' | 'other', Money> = { cash: 0n, card: 0n, transfer: 0n, other: 0n };
    for (const op of ops) {
      if (op.cancelled) continue;
      count += 1;
      if (op.kind === 'income') {
        income += op.amount;
        const m = (['cash', 'card', 'transfer'].includes(op.method) ? op.method : 'other') as keyof typeof byMethod;
        byMethod[m] += op.amount;
      } else if (op.kind === 'expense') {
        expense += op.amount;
        if (refundItemId && op.itemId === refundItemId) refunds += op.amount;
      } else if (op.kind === 'transfer_in') transfersIn += op.amount;
      else transfersOut += op.amount;
    }
    return {
      openingBalance: moneyToJson(openingBalance),
      income: moneyToJson(income),
      expense: moneyToJson(expense),
      refunds: moneyToJson(refunds),
      transfersIn: moneyToJson(transfersIn),
      transfersOut: moneyToJson(transfersOut),
      incomeByMethod: { cash: moneyToJson(byMethod.cash), card: moneyToJson(byMethod.card), transfer: moneyToJson(byMethod.transfer), other: moneyToJson(byMethod.other) },
      operationsCount: count,
      expected: moneyToJson(openingBalance + income - expense + transfersIn - transfersOut),
    };
  }

  private async view(shift: ShiftRow) {
    const account = await this.prisma.cashRegister.findUnique({ where: { id: shift.accountId } });
    const ops = await this.accountOps(shift.accountId);
    const refundItem = await this.prisma.paymentItem.findFirst({ where: { businessId: shift.businessId, systemKey: 'refund' }, select: { id: true } });
    const adjustments = new Set((shift.adjustmentOperationIds as string[] | null) ?? []);
    const until = shift.closedAt ?? new Date(8.64e15);
    // Смена — то, что ПРОВЕЛИ за смену (createdAt), а не дата операции: приход «задним числом» во время смены тоже в
    // ящике, и Z «Должно быть» совпадает с «По учёту» при закрытии (F-07-001, qa/full-test-0930, как мок)
    const inShift = ops.filter((o) => o.createdAt >= shift.openedAt && o.createdAt <= until && !adjustments.has(o.id));
    const report = this.zReport(shift.openingCash, inShift, refundItem?.id);
    const expectedNow = account ? moneyToJson(this.balanceOf(account.openingBalance, ops)) : report.expected;
    return {
      shift: {
        id: shift.id,
        businessId: shift.businessId,
        accountId: shift.accountId,
        status: shift.status as 'open' | 'closed',
        openedAt: utcToLocal(shift.openedAt),
        openedBy: shift.openedBy,
        openingCash: moneyToJson(shift.openingCash),
        expectedAtOpen: moneyToJson(shift.expectedAtOpen),
        closedAt: shift.closedAt ? utcToLocal(shift.closedAt) : undefined,
        closedBy: shift.closedBy ?? undefined,
        countedCash: shift.countedCash !== null ? moneyToJson(shift.countedCash) : undefined,
        expectedAtClose: shift.expectedAtClose !== null ? moneyToJson(shift.expectedAtClose) : undefined,
        adjustmentOperationIds: [...adjustments],
        comment: shift.comment ?? undefined,
      },
      report,
      discrepancy: shift.countedCash !== null && shift.expectedAtClose !== null ? moneyToJson(shift.countedCash - shift.expectedAtClose) : undefined,
      expectedNow,
    };
  }

  /** Смены кассы — открытая первой, дальше новые сверху */
  async list(businessId: string, accountId: string) {
    const rows = await this.prisma.cashShift.findMany({ where: { businessId, accountId } });
    rows.sort((a, b) => (a.status !== b.status ? (a.status === 'open' ? -1 : 1) : b.openedAt.getTime() - a.openedAt.getTime()));
    const out = [];
    for (const r of rows) out.push(await this.view(r));
    return out;
  }

  /** Поправка на расхождение ящика с учётом: излишек — «Прочий доход», недостача — «Прочий расход» */
  private async adjustment(tx: Prisma.TransactionClient, ctx: RequestContext, account: { id: string; businessId: string; locationId: string }, diff: Money, comment: string, at: Date): Promise<string | undefined> {
    if (diff === 0n) return undefined;
    const itemId = await this.catalog.systemItemId(account.businessId, diff > 0n ? 'otherIncome' : 'otherExpense');
    const id = newId('finOp');
    const by = ctx.member!.staffId;
    await tx.finOp.create({
      data: {
        id,
        businessId: account.businessId,
        locationId: account.locationId,
        accountId: account.id,
        itemId,
        kind: diff > 0n ? 'income' : 'expense',
        amount: diff > 0n ? diff : -diff,
        date: at,
        method: 'cash',
        partyType: 'none',
        comment,
        source: 'manual',
        history: [{ at: at.toISOString(), by, action: 'created' }] as Prisma.InputJsonValue,
        createdBy: by,
        updatedBy: by,
      },
    });
    return id;
  }

  async open(ctx: RequestContext, businessId: string, accountId: string, openingCash: number, comment?: string) {
    const account = await this.cashAccount(businessId, accountId);
    if (account.kind !== 'cash') throw new ApiError('not_cash_account', 'Only a cash register has shifts');
    if (!(openingCash >= 0)) throw new ApiError('invalid_amount', 'Amount must not be negative');
    if (await this.prisma.cashShift.findUnique({ where: { openKey: accountId } })) throw new ApiError('shift_already_open', 'Shift already open');
    const counted = BigInt(Math.round(openingCash));
    const expected = this.balanceOf(account.openingBalance, await this.accountOps(accountId));
    const at = new Date();
    const id = newId('cashShift');
    try {
      await this.prisma.$transaction(async (tx) => {
        const adj = await this.adjustment(tx, ctx, account, counted - expected, 'Расхождение при открытии смены', at);
        await tx.cashShift.create({
          data: { id, businessId, accountId, status: 'open', openKey: accountId, openedAt: at, openedBy: ctx.member!.staffId, openingCash: counted, expectedAtOpen: expected, adjustmentOperationIds: (adj ? [adj] : []) as Prisma.InputJsonValue, comment: comment?.trim() || null },
        });
        await this.audit.record(tx, ctx, { action: 'open', entityType: 'cashShift', entityId: id, businessId, before: null, after: { accountId, openingCash: moneyToJson(counted), expected: moneyToJson(expected) } });
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') throw new ApiError('shift_already_open', 'Shift already open');
      throw e;
    }
    return this.view(await this.prisma.cashShift.findUniqueOrThrow({ where: { id } }));
  }

  async close(ctx: RequestContext, businessId: string, shiftId: string, countedCash: number, comment?: string) {
    const shift = await this.prisma.cashShift.findFirst({ where: { id: shiftId, businessId } });
    if (!shift || shift.status !== 'open') throw new ApiError('shift_not_open', 'Shift is not open');
    const account = await this.cashAccount(businessId, shift.accountId);
    if (!(countedCash >= 0)) throw new ApiError('invalid_amount', 'Amount must not be negative');
    const counted = BigInt(Math.round(countedCash));
    const expected = this.balanceOf(account.openingBalance, await this.accountOps(shift.accountId));
    const at = new Date();
    await this.prisma.$transaction(async (tx) => {
      const adj = await this.adjustment(tx, ctx, account, counted - expected, 'Расхождение при закрытии смены', at);
      const ids = [...((shift.adjustmentOperationIds as string[] | null) ?? []), ...(adj ? [adj] : [])];
      const nextComment = [shift.comment, comment?.trim()].filter(Boolean).join(' · ') || null;
      const done = await tx.cashShift.updateMany({
        where: { id: shift.id, status: 'open' },
        data: { status: 'closed', openKey: null, closedAt: at, closedBy: ctx.member!.staffId, countedCash: counted, expectedAtClose: expected, adjustmentOperationIds: ids as Prisma.InputJsonValue, comment: nextComment },
      });
      if (done.count !== 1) throw new ApiError('shift_not_open', 'Shift is not open');
      await this.audit.record(tx, ctx, { action: 'close', entityType: 'cashShift', entityId: shift.id, businessId, before: { status: 'open' }, after: { countedCash: moneyToJson(counted), expected: moneyToJson(expected) } });
    });
    // ⭐ «День закрыт» владельцу в колокольчик (01.10.2026): снимок итога дня; тот же день без изменений — не дублирует
    await recordDayCloseNotice(this.prisma, businessId, ctx.member!.staffId, at);
    return this.view(await this.prisma.cashShift.findUniqueOrThrow({ where: { id: shift.id } }));
  }
}
