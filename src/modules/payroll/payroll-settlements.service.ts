import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { newId } from '../../common/ids/ids.js';
import { PrismaService } from '../../common/prisma.service.js';
import { FinanceCatalogService } from '../finance/finance-catalog.service.js';
import { PayrollComputeService } from './payroll-compute.service.js';
import { canMarkPaid, isStatementLocked, newDaysRange, nextApprovalStatus, roundMoney, settlementBalance, type SettlementEntryKind, type StatementApprovalStatus } from './payroll-engine.js';
import type { PayoutBody, SettlementEntryBody, SettlementSheetBody } from './payroll.schemas.js';
import { isLocalDate, isLocalDateTime, localDayRangeUtc, localToUtc, utcToLocalDate } from '../../common/time/time.js';

/** Граница периода из запроса: день → начало/конец дня по Еревану; 'YYYY-MM-DDTHH:mm' → этот момент по Еревану */
function localBound(v: string, side: 'from' | 'to'): Date {
  if (isLocalDate(v)) return side === 'from' ? localDayRangeUtc(v).from : new Date(localDayRangeUtc(v).to.getTime() - 1);
  if (isLocalDateTime(v)) return localToUtc(v);
  return new Date(v);
}

function entryView(r: { id: string; businessId: string; locationId: string | null; staffId: string; kind: string; amount: bigint; label: string; comment: string | null; periodFrom: Date | null; periodTo: Date | null; operationId: string | null; status: string | null; createdAt: Date; createdBy: string | null }) {
  return {
    id: r.id,
    businessId: r.businessId,
    staffId: r.staffId,
    kind: r.kind as SettlementEntryKind,
    amount: Number(r.amount),
    label: r.label,
    comment: r.comment ?? undefined,
    // Период ведомости — дни (в базе полночь UTC дня); отдаём как мок: «с начала первого дня по конец последнего» по
    // Еревану, без пояса. Было мгновение UTC — «Расчёт за день» не узнавал свою ведомость и предлагал начислить зарплату
    // за день ещё раз (проход 17.11)
    periodFrom: r.periodFrom ? `${r.periodFrom.toISOString().slice(0, 10)}T00:00` : undefined,
    periodTo: r.periodTo ? `${r.periodTo.toISOString().slice(0, 10)}T23:59` : undefined,
    operationId: r.operationId ?? undefined,
    status: (r.status as 'draft' | 'accrued' | null) ?? undefined,
    createdAt: r.createdAt.toISOString(),
    createdBy: r.createdBy ?? undefined,
  };
}

/**
 * Взаиморасчёты с сотрудником (F-07-159…162/F-09-066…080) — ведомость/премия/штраф/выплата. Владелец сущности —
 * этот раздел (не finance): finance's SettlementEntry мока была демо-заглушкой на этап 14 (комментарий
 * createSettlementSheet мока: «полные схемы расчёта… не построен»), поэтому сумма ведомости здесь — РЕАЛЬНЫЙ
 * расчёт движка (`computeStatement`), а не наивная сумма `booking.total` визитов (решено по ходу, PLAN §9).
 */
@Injectable()
export class PayrollSettlementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly compute: PayrollComputeService,
    private readonly financeCatalog: FinanceCatalogService,
  ) {}

  /** Дни ведомости 'YYYY-MM-DD' (в базе — полночь UTC дня) */
  private static sheetDays(r: { periodFrom: Date | null; periodTo: Date | null }) {
    return r.periodFrom && r.periodTo ? { from: r.periodFrom.toISOString().slice(0, 10), to: r.periodTo.toISOString().slice(0, 10) } : null;
  }

  /**
   * Ответ 26: одобренные ведомости сотрудника (approved…paid) — их дни закрыты для премий, штрафов и удаления.
   * Отдаёт дни каждой закрытой ведомости.
   */
  private async lockedSheets(db: Prisma.TransactionClient | PrismaService, businessId: string, staffId: string) {
    const sheets = await db.payrollSettlementEntry.findMany({ where: { businessId, staffId, kind: 'sheet' }, select: { id: true, periodFrom: true, periodTo: true } });
    if (!sheets.length) return [];
    const approvals = await db.payrollStatementApproval.findMany({ where: { sheetId: { in: sheets.map((x) => x.id) } }, select: { sheetId: true, status: true } });
    const locked = new Set(approvals.filter((a) => isStatementLocked(a.status)).map((a) => a.sheetId));
    return sheets.filter((x) => locked.has(x.id)).map((x) => ({ id: x.id, days: PayrollSettlementsService.sheetDays(x) }));
  }

  /** Премия/штраф с датой `at` попадает в закрытую ведомость? (день — по Еревану, как экран ведомости) */
  private async assertDayOpen(db: Prisma.TransactionClient | PrismaService, businessId: string, staffId: string, at: Date) {
    const day = utcToLocalDate(at);
    const hit = (await this.lockedSheets(db, businessId, staffId)).find((x) => x.days && x.days.from <= day && day <= x.days.to);
    if (hit) throw new ApiError('statement_locked', 'Statement approved — return it for review to edit', { sheetId: hit.id });
  }

  async list(businessId: string, staffId: string, periodFrom?: string, periodTo?: string) {
    const staff = await this.prisma.staff.findFirst({ where: { id: staffId, businessId } });
    if (!staff) throw new ApiError('not_found', 'Staff not found');
    const rows = await this.prisma.payrollSettlementEntry.findMany({
      // Границы — местное время Еревана ('YYYY-MM-DDTHH:mm' или день), не пояс машины сервера
      where: { businessId, staffId, ...(periodFrom && periodTo ? { createdAt: { gte: localBound(periodFrom, 'from'), lte: localBound(periodTo, 'to') } } : {}) },
      orderBy: { createdAt: 'asc' },
    });
    // Статус согласования ведомости (F-09-100) — сотруднику в «Моя зарплата → Выплаты»: «Подписать» у своей
    // ведомости, отправленной ему (без payroll.view он не открывает экран ведомости — проход 17.11)
    const sheetIds = rows.filter((r) => r.kind === 'sheet').map((r) => r.id);
    const approvals = sheetIds.length ? await this.prisma.payrollStatementApproval.findMany({ where: { sheetId: { in: sheetIds } }, select: { sheetId: true, status: true } }) : [];
    const statusOf = new Map(approvals.map((a) => [a.sheetId, a.status]));
    return rows.map((r) => ({ ...entryView(r), ...(statusOf.has(r.id) ? { approvalStatus: statusOf.get(r.id) as StatementApprovalStatus } : {}) }));
  }

  async balance(businessId: string, staffId: string) {
    const rows = await this.prisma.payrollSettlementEntry.findMany({ where: { businessId, staffId } });
    return roundMoney(settlementBalance(rows.map((r) => ({ kind: r.kind as SettlementEntryKind, amount: Number(r.amount), status: r.status }))));
  }

  async staffBalance(businessId: string, staffId: string) {
    const rows = await this.prisma.payrollSettlementEntry.findMany({ where: { businessId, staffId } });
    const earned = roundMoney(rows.filter((r) => r.kind !== 'payout' && r.status !== 'draft').reduce((s, r) => s + Number(r.amount), 0));
    const paid = roundMoney(rows.filter((r) => r.kind === 'payout').reduce((s, r) => s + Number(r.amount), 0));
    return { earned, paid, remaining: await this.balance(businessId, staffId) };
  }

  /**
   * F-09-069: `draft: true` — «Сохранить как черновик» (не входит в баланс, доступен «Начислить» позже),
   * иначе — «Сохранить и начислить». Сумма — computeStatement (движок), не сумма визитов.
   */
  async createSheet(ctx: RequestContext, body: SettlementSheetBody) {
    const businessId = ctx.member!.businessId;
    const staff = await this.prisma.staff.findFirst({ where: { id: body.staffId, businessId } });
    if (!staff) throw new ApiError('not_found', 'Staff not found');
    // Ответ 27: дни, уже начисленные другой ведомостью, второй раз не начисляем — предлагаем только новые дни
    const existing = await this.prisma.payrollSettlementEntry.findMany({ where: { businessId, staffId: body.staffId, kind: 'sheet' }, select: { periodFrom: true, periodTo: true } });
    const taken = existing.map((r) => PayrollSettlementsService.sheetDays(r)).filter((x): x is { from: string; to: string } => Boolean(x));
    if (taken.some((x) => x.from <= body.periodTo && body.periodFrom <= x.to)) {
      const fresh = newDaysRange(taken, body.periodFrom, body.periodTo);
      throw new ApiError('period_overlaps', 'Some days are already in another statement', fresh ? { newFrom: fresh.from, newTo: fresh.to } : {});
    }
    const locationId = await this.sheetLocation(businessId, body.staffId, body.locationId);
    const statement = await this.compute.computeStatement(businessId, locationId, body.staffId, body.periodFrom, body.periodTo);
    const id = newId('payrollSettlementEntry');
    const from = new Date(`${body.periodFrom}T00:00:00.000Z`);
    const to = new Date(`${body.periodTo}T00:00:00.000Z`);
    // Подпись — как у мока: «17.11.2026–17.11.2026»
    const label = `${body.periodFrom.split('-').reverse().join('.')}–${body.periodTo.split('-').reverse().join('.')}`;
    await this.prisma.$transaction(async (tx) => {
      await tx.payrollSettlementEntry.create({
        data: { id, businessId, locationId, staffId: body.staffId, kind: 'sheet', amount: BigInt(statement.sheetAmount), label, comment: body.comment, periodFrom: from, periodTo: to, status: body.draft ? 'draft' : 'accrued', createdBy: ctx.member!.staffId },
      });
      await this.audit.record(tx, ctx, { action: 'create', entityType: 'payrollSettlementSheet', entityId: id, businessId, after: { staffId: body.staffId, amount: statement.sheetAmount, draft: Boolean(body.draft) } });
    });
    return entryView(await this.prisma.payrollSettlementEntry.findUniqueOrThrow({ where: { id } }));
  }

  /**
   * Филиал ведомости: присланный, если он этого салона; иначе — филиал самого сотрудника, иначе — первый филиал салона.
   * Хвосты 17.11: «Расчёт зарплат сети» для другого филиала присылал филиал открытого кабинета (сотрудника не было в
   * зеркале браузера) — ведомость Астхик (Шенгавит) отвечала 404 «Location not found» и молча пропускалась.
   */
  private async sheetLocation(businessId: string, staffId: string, locationId: string): Promise<string> {
    if (await this.prisma.location.findFirst({ where: { id: locationId, businessId, deletedAt: null }, select: { id: true } })) return locationId;
    const own = await this.prisma.staffLocation.findFirst({ where: { staffId, location: { businessId, deletedAt: null } }, select: { locationId: true } });
    if (own) return own.locationId;
    const first = await this.prisma.location.findFirst({ where: { businessId, deletedAt: null }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }], select: { id: true } });
    if (!first) throw new ApiError('not_found', 'Location not found');
    return first.id;
  }

  /** F-09-069: черновик ведомости → начисленная (входит в баланс с этого момента) */
  async accrueSheet(ctx: RequestContext, id: string) {
    const businessId = ctx.member!.businessId;
    const row = await this.prisma.payrollSettlementEntry.findFirst({ where: { id, businessId, kind: 'sheet' } });
    if (!row) throw new ApiError('not_found', 'Sheet not found');
    if (row.status !== 'draft') throw new ApiError('sheet_not_draft', 'Sheet already accrued');
    await this.prisma.$transaction(async (tx) => {
      await tx.payrollSettlementEntry.update({ where: { id }, data: { status: 'accrued' } });
      await this.audit.record(tx, ctx, { action: 'update', entityType: 'payrollSettlementSheet', entityId: id, businessId, before: { status: 'draft' }, after: { status: 'accrued' } });
    });
    return entryView(await this.prisma.payrollSettlementEntry.findUniqueOrThrow({ where: { id } }));
  }

  /** Премия / штраф / внеочередное начисление (F-07-161) */
  async createEntry(ctx: RequestContext, body: SettlementEntryBody) {
    const businessId = ctx.member!.businessId;
    const staff = await this.prisma.staff.findFirst({ where: { id: body.staffId, businessId } });
    if (!staff) throw new ApiError('not_found', 'Staff not found');
    await this.assertDayOpen(this.prisma, businessId, body.staffId, new Date());
    const id = newId('payrollSettlementEntry');
    await this.prisma.$transaction(async (tx) => {
      await tx.payrollSettlementEntry.create({ data: { id, businessId, staffId: body.staffId, kind: body.kind, amount: BigInt(Math.round(Math.abs(body.amount))), label: body.label, comment: body.comment, createdBy: ctx.member!.staffId } });
      await this.audit.record(tx, ctx, { action: 'create', entityType: 'payrollSettlementEntry', entityId: id, businessId, after: { staffId: body.staffId, kind: body.kind, amount: body.amount } });
    });
    return entryView(await this.prisma.payrollSettlementEntry.findUniqueOrThrow({ where: { id } }));
  }

  /** Удалить ведомость/премию/штраф/внеочередное — payout удалить нельзя (F-07-159) */
  async deleteEntry(ctx: RequestContext, id: string) {
    const businessId = ctx.member!.businessId;
    const row = await this.prisma.payrollSettlementEntry.findFirst({ where: { id, businessId } });
    if (!row) throw new ApiError('not_found', 'Entry not found');
    if (row.kind === 'payout') throw new ApiError('in_use', 'Payout cannot be deleted');
    // Ответ 26: одобренную ведомость и премии/штрафы в её днях не удаляем — сначала «Вернуть на проверку»
    if (row.kind === 'sheet') {
      const approval = await this.prisma.payrollStatementApproval.findUnique({ where: { sheetId: id }, select: { status: true } });
      if (isStatementLocked(approval?.status)) throw new ApiError('statement_locked', 'Statement approved — return it for review to edit', { sheetId: id });
    } else {
      await this.assertDayOpen(this.prisma, businessId, row.staffId, row.createdAt);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.payrollStatementApproval.deleteMany({ where: { sheetId: id } });
      await tx.payrollSettlementEntry.delete({ where: { id } });
      await this.audit.record(tx, ctx, { action: 'delete', entityType: 'payrollSettlementEntry', entityId: id, businessId, before: { staffId: row.staffId, kind: row.kind }, after: null });
    });
  }

  /** «Выдать зарплату» (F-07-160) — расходная FinOp «Зарплата персонала» + строка выплаты во взаиморасчётах.
   * F-09-100: пока включено согласование, «выплачено» нельзя без подписи сотрудника — canMarkPaid проверяет
   * approval-статус САМОЙ СВЕЖЕЙ ведомости сотрудника (нет ведомости — согласование не блокирует, В-05 подход
   * «работающая функция важнее строгости», ведомость необязательна для премий/штрафов). */
  async payout(ctx: RequestContext, body: PayoutBody) {
    const businessId = ctx.member!.businessId;
    const [staff, account, settings] = await Promise.all([
      this.prisma.staff.findFirst({ where: { id: body.staffId, businessId } }),
      this.prisma.cashRegister.findFirst({ where: { id: body.accountId, businessId } }),
      this.prisma.payrollSettings.findUnique({ where: { locationId: body.locationId } }),
    ]);
    if (!staff) throw new ApiError('not_found', 'Staff not found');
    if (!account) throw new ApiError('not_found', 'Account not found');
    let signedSheetId: string | undefined;
    if (settings?.statementApprovalEnabled) {
      // Ответ 28: «Отметить выплаченным» платит по своей ведомости (sheetId), иначе — по самой свежей
      const latestSheet = body.sheetId
        ? await this.prisma.payrollSettlementEntry.findFirst({ where: { id: body.sheetId, businessId, staffId: body.staffId, kind: 'sheet' } })
        : await this.prisma.payrollSettlementEntry.findFirst({ where: { businessId, staffId: body.staffId, kind: 'sheet' }, orderBy: { createdAt: 'desc' } });
      if (latestSheet) {
        const approval = await this.prisma.payrollStatementApproval.findUnique({ where: { sheetId: latestSheet.id } });
        const status = (approval?.status as StatementApprovalStatus) ?? 'pendingReview';
        if (!canMarkPaid(status, true)) throw new ApiError('cannot_pay', 'Statement not signed yet');
        if (status === 'signed') signedSheetId = latestSheet.id;
      }
    }
    const itemId = await this.financeCatalog.systemItemId(businessId, 'staffPayroll');
    const opId = newId('finOp');
    const entryId = newId('payrollSettlementEntry');
    const amount = BigInt(Math.round(body.amount));
    const now = new Date();
    // Окно «Выплатить» (ответ 28): способ и момент выплаты — как выбрали; без них — наличные и сейчас
    const paidAt = body.date ? localToUtc(body.date) : now;
    // Из наличного ящика нельзя выдать больше, чем в нём лежит (как мок payoutSalary, payroll-review З5)
    if (account.kind === 'cash') {
      const ops = await this.prisma.finOp.findMany({ where: { accountId: account.id, cancelled: false }, select: { kind: true, amount: true } });
      const cash = ops.reduce((sum, o) => sum + (o.kind === 'income' || o.kind === 'transfer_in' ? o.amount : -o.amount), account.openingBalance);
      if (amount > cash) throw new ApiError('insufficient_funds', String(cash > 0n ? cash : 0n));
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.finOp.create({
        data: {
          id: opId,
          businessId,
          locationId: body.locationId,
          accountId: body.accountId,
          itemId,
          kind: 'expense',
          amount,
          date: paidAt,
          method: body.method ?? (account.kind === 'cash' ? 'cash' : 'transfer'),
          partyType: 'staff',
          partyId: body.staffId,
          partyName: staff.name,
          comment: body.comment,
          source: 'payroll',
          history: [{ at: now.toISOString(), by: ctx.member!.staffId, action: 'created' }] as Prisma.InputJsonValue,
          createdBy: ctx.member!.staffId,
          updatedBy: ctx.member!.staffId,
        },
      });
      await tx.payrollSettlementEntry.create({ data: { id: entryId, businessId, locationId: body.locationId, staffId: body.staffId, kind: 'payout', amount, label: 'Выплата зарплаты', comment: body.comment, operationId: opId, createdBy: ctx.member!.staffId } });
      await this.audit.record(tx, ctx, { action: 'create', entityType: 'payrollPayout', entityId: entryId, businessId, after: { staffId: body.staffId, amount: body.amount } });
      // F-09-100: выплата по подписанной ведомости сама переводит её в «выплачено» — отдельного шага «пометить
      // выплаченной» экран не просит (кнопка «Выплатить» и есть эта отметка).
      if (signedSheetId) {
        const approval = await tx.payrollStatementApproval.findUnique({ where: { sheetId: signedSheetId } });
        if (approval) {
          const history = [...(approval.history as { status: StatementApprovalStatus; at: string; by?: string }[]), { status: 'paid' as StatementApprovalStatus, at: now.toISOString(), by: ctx.member!.staffId }];
          await tx.payrollStatementApproval.update({ where: { sheetId: signedSheetId }, data: { status: 'paid', history: history as unknown as Prisma.InputJsonValue } });
        }
      }
    });
    return entryView(await this.prisma.payrollSettlementEntry.findUniqueOrThrow({ where: { id: entryId } }));
  }

  // ─────────────────────────── Согласование ведомости (F-09-100) ───────────────────────────

  async getApproval(businessId: string, sheetId: string) {
    const row = await this.prisma.payrollStatementApproval.findFirst({ where: { sheetId, businessId } });
    if (!row) return undefined;
    return { sheetId: row.sheetId, status: row.status as StatementApprovalStatus, history: row.history as { status: StatementApprovalStatus; at: string; by?: string }[] };
  }

  async advanceApproval(ctx: RequestContext, sheetId: string) {
    const businessId = ctx.member!.businessId;
    const sheet = await this.prisma.payrollSettlementEntry.findFirst({ where: { id: sheetId, businessId, kind: 'sheet' } });
    if (!sheet) throw new ApiError('not_found', 'Sheet not found');
    const current = (await this.getApproval(businessId, sheetId)) ?? { sheetId, status: 'pendingReview' as StatementApprovalStatus, history: [] };
    const next = nextApprovalStatus(current.status);
    if (!next) throw new ApiError('validation', 'Already at final status');
    // Ответ 28: «Выплачено» ставит только сама выплата (окно «Выплатить» → касса и сумма), без денег — нельзя
    if (next === 'paid') throw new ApiError('cannot_pay', 'Mark paid only by a payout');
    const history = [...current.history, { status: next, at: new Date().toISOString(), by: ctx.member!.staffId }];
    await this.prisma.payrollStatementApproval.upsert({
      where: { sheetId },
      create: { sheetId, businessId, status: next, history: history as Prisma.InputJsonValue },
      update: { status: next, history: history as Prisma.InputJsonValue },
    });
    return { sheetId, status: next, history };
  }

  /** Ответ 26: «Вернуть на проверку» — одобренная ведомость снова открыта для правок (статус pendingReview) */
  async reopenApproval(ctx: RequestContext, sheetId: string) {
    const businessId = ctx.member!.businessId;
    const current = await this.getApproval(businessId, sheetId);
    if (!current || !isStatementLocked(current.status)) throw new ApiError('validation', 'Statement is not approved');
    const history = [...current.history, { status: 'pendingReview' as StatementApprovalStatus, at: new Date().toISOString(), by: ctx.member!.staffId }];
    await this.prisma.$transaction(async (tx) => {
      await tx.payrollStatementApproval.update({ where: { sheetId }, data: { status: 'pendingReview', history: history as Prisma.InputJsonValue } });
      await this.audit.record(tx, ctx, { action: 'update', entityType: 'payrollStatementApproval', entityId: sheetId, businessId, before: { status: current.status }, after: { status: 'pendingReview' } });
    });
    return { sheetId, status: 'pendingReview' as StatementApprovalStatus, history };
  }

  /** F-09-100: сотрудник подписывает свою ведомость */
  async signApproval(businessId: string, sheetId: string, staffId: string) {
    // Подписывает только сам сотрудник — свою ведомость (раньше подписать мог любой с payroll.view)
    const sheet = await this.prisma.payrollSettlementEntry.findFirst({ where: { id: sheetId, businessId, kind: 'sheet' }, select: { staffId: true } });
    if (!sheet) throw new ApiError('not_found', 'Sheet not found');
    if (sheet.staffId !== staffId) throw new ApiError('forbidden', 'Only the employee signs own statement');
    const current = await this.getApproval(businessId, sheetId);
    if (!current || current.status !== 'sentToStaff') throw new ApiError('validation', 'Statement not ready to sign');
    const history = [...current.history, { status: 'signed' as StatementApprovalStatus, at: new Date().toISOString(), by: staffId }];
    await this.prisma.payrollStatementApproval.update({ where: { sheetId }, data: { status: 'signed', history: history as Prisma.InputJsonValue } });
    return { sheetId, status: 'signed' as StatementApprovalStatus, history };
  }

  // ─────────────────────────── Аналитика ФОТ (F-09-101) ───────────────────────────

  async fundAnalytics(businessId: string, locationId: string, from: string, to: string) {
    const period = await this.compute.computePeriod(businessId, locationId, from, to);
    const turnover = roundMoney(period.rows.reduce((s, r) => s + r.servicesAmount, 0));
    const fund = roundMoney(period.rows.reduce((s, r) => s + r.salary, 0));
    const fundSharePct = turnover > 0 ? roundMoney((fund / turnover) * 100) : 0;
    const staffWithPayout = period.rows.filter((r) => r.salary > 0);
    const avgPayout = staffWithPayout.length ? roundMoney(fund / staffWithPayout.length) : 0;
    const topAccruals = [...period.rows].sort((a, b) => b.salary - a.salary).slice(0, 5).map((r) => ({ staffId: r.staffId, amount: r.salary }));

    const settings = await this.prisma.payrollSettings.findUnique({ where: { locationId } });
    const staffRows = await this.prisma.staffLocation.findMany({ where: { locationId }, select: { staffId: true } });
    const activeStaff = await this.prisma.staff.findMany({ where: { id: { in: staffRows.map((s) => s.staffId) }, businessId, status: { notIn: ['fired', 'disabled'] } }, select: { id: true } });
    const schemedIds = new Set((await this.prisma.payrollScheme.findMany({ where: { staffId: { in: activeStaff.map((s) => s.id) } }, select: { staffId: true } })).map((s) => s.staffId));
    const noSchemeCount = activeStaff.filter((s) => !schemedIds.has(s.id)).length;

    const risks: { key: 'noScheme' | 'unsignedStatement' | 'unmarkedPayout'; count: number }[] = [];
    if (noSchemeCount > 0) risks.push({ key: 'noScheme', count: noSchemeCount });
    if (settings?.statementApprovalEnabled) {
      const sheets = await this.prisma.payrollSettlementEntry.findMany({ where: { businessId, kind: 'sheet', staffId: { in: activeStaff.map((s) => s.id) }, createdAt: { gte: new Date(from), lte: new Date(`${to}T23:59:59.999Z`) } } });
      const approvals = await this.prisma.payrollStatementApproval.findMany({ where: { sheetId: { in: sheets.map((s) => s.id) } } });
      const approvalBySheet = new Map(approvals.map((a) => [a.sheetId, a.status as StatementApprovalStatus]));
      let unsignedCount = 0;
      let unmarkedPayoutCount = 0;
      for (const sheet of sheets) {
        const status = approvalBySheet.get(sheet.id);
        if (status !== 'signed' && status !== 'paid') unsignedCount += 1;
        else if (status === 'signed') unmarkedPayoutCount += 1;
      }
      if (unsignedCount > 0) risks.push({ key: 'unsignedStatement', count: unsignedCount });
      if (unmarkedPayoutCount > 0) risks.push({ key: 'unmarkedPayout', count: unmarkedPayoutCount });
    }

    return {
      turnover,
      fund,
      fundSharePct,
      targetPct: settings?.payrollFundTargetPct ?? 30,
      warnPct: settings?.payrollFundWarnPct ?? 40,
      overWarn: fundSharePct > (settings?.payrollFundWarnPct ?? 40),
      staffCount: staffWithPayout.length,
      avgPayout,
      topAccruals,
      risks,
    };
  }
}
