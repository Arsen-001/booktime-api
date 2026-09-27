var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service.js';
import { ApiError } from '../../common/errors/api-error.js';
import { newId } from '../../common/ids/ids.js';
import { PrismaService } from '../../common/prisma.service.js';
import { FinanceCatalogService } from '../finance/finance-catalog.service.js';
import { PayrollComputeService } from './payroll-compute.service.js';
import { canMarkPaid, nextApprovalStatus, roundMoney, settlementBalance } from './payroll-engine.js';
function entryView(r) {
    return {
        id: r.id,
        businessId: r.businessId,
        staffId: r.staffId,
        kind: r.kind,
        amount: Number(r.amount),
        label: r.label,
        comment: r.comment ?? undefined,
        periodFrom: r.periodFrom ? r.periodFrom.toISOString() : undefined,
        periodTo: r.periodTo ? r.periodTo.toISOString() : undefined,
        operationId: r.operationId ?? undefined,
        status: r.status ?? undefined,
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
let PayrollSettlementsService = class PayrollSettlementsService {
    constructor(prisma, audit, compute, financeCatalog) {
        this.prisma = prisma;
        this.audit = audit;
        this.compute = compute;
        this.financeCatalog = financeCatalog;
    }
    async list(businessId, staffId, periodFrom, periodTo) {
        const staff = await this.prisma.staff.findFirst({ where: { id: staffId, businessId } });
        if (!staff)
            throw new ApiError('not_found', 'Staff not found');
        const rows = await this.prisma.payrollSettlementEntry.findMany({
            where: { businessId, staffId, ...(periodFrom && periodTo ? { createdAt: { gte: new Date(periodFrom), lte: new Date(periodTo) } } : {}) },
            orderBy: { createdAt: 'asc' },
        });
        return rows.map(entryView);
    }
    async balance(businessId, staffId) {
        const rows = await this.prisma.payrollSettlementEntry.findMany({ where: { businessId, staffId } });
        return roundMoney(settlementBalance(rows.map((r) => ({ kind: r.kind, amount: Number(r.amount), status: r.status }))));
    }
    async staffBalance(businessId, staffId) {
        const rows = await this.prisma.payrollSettlementEntry.findMany({ where: { businessId, staffId } });
        const earned = roundMoney(rows.filter((r) => r.kind !== 'payout' && r.status !== 'draft').reduce((s, r) => s + Number(r.amount), 0));
        const paid = roundMoney(rows.filter((r) => r.kind === 'payout').reduce((s, r) => s + Number(r.amount), 0));
        return { earned, paid, remaining: await this.balance(businessId, staffId) };
    }
    /**
     * F-09-069: `draft: true` — «Сохранить как черновик» (не входит в баланс, доступен «Начислить» позже),
     * иначе — «Сохранить и начислить». Сумма — computeStatement (движок), не сумма визитов.
     */
    async createSheet(ctx, body) {
        const businessId = ctx.member.businessId;
        const staff = await this.prisma.staff.findFirst({ where: { id: body.staffId, businessId } });
        if (!staff)
            throw new ApiError('not_found', 'Staff not found');
        const statement = await this.compute.computeStatement(businessId, body.locationId, body.staffId, body.periodFrom, body.periodTo);
        const id = newId('payrollSettlementEntry');
        const from = new Date(`${body.periodFrom}T00:00:00.000Z`);
        const to = new Date(`${body.periodTo}T00:00:00.000Z`);
        const label = `${body.periodFrom} – ${body.periodTo}`;
        await this.prisma.$transaction(async (tx) => {
            await tx.payrollSettlementEntry.create({
                data: { id, businessId, locationId: body.locationId, staffId: body.staffId, kind: 'sheet', amount: BigInt(Math.round(statement.total)), label, comment: body.comment, periodFrom: from, periodTo: to, status: body.draft ? 'draft' : 'accrued', createdBy: ctx.member.staffId },
            });
            await this.audit.record(tx, ctx, { action: 'create', entityType: 'payrollSettlementSheet', entityId: id, businessId, after: { staffId: body.staffId, amount: statement.total, draft: Boolean(body.draft) } });
        });
        return entryView(await this.prisma.payrollSettlementEntry.findUniqueOrThrow({ where: { id } }));
    }
    /** F-09-069: черновик ведомости → начисленная (входит в баланс с этого момента) */
    async accrueSheet(ctx, id) {
        const businessId = ctx.member.businessId;
        const row = await this.prisma.payrollSettlementEntry.findFirst({ where: { id, businessId, kind: 'sheet' } });
        if (!row)
            throw new ApiError('not_found', 'Sheet not found');
        if (row.status !== 'draft')
            throw new ApiError('sheet_not_draft', 'Sheet already accrued');
        await this.prisma.$transaction(async (tx) => {
            await tx.payrollSettlementEntry.update({ where: { id }, data: { status: 'accrued' } });
            await this.audit.record(tx, ctx, { action: 'update', entityType: 'payrollSettlementSheet', entityId: id, businessId, before: { status: 'draft' }, after: { status: 'accrued' } });
        });
        return entryView(await this.prisma.payrollSettlementEntry.findUniqueOrThrow({ where: { id } }));
    }
    /** Премия / штраф / внеочередное начисление (F-07-161) */
    async createEntry(ctx, body) {
        const businessId = ctx.member.businessId;
        const staff = await this.prisma.staff.findFirst({ where: { id: body.staffId, businessId } });
        if (!staff)
            throw new ApiError('not_found', 'Staff not found');
        const id = newId('payrollSettlementEntry');
        await this.prisma.$transaction(async (tx) => {
            await tx.payrollSettlementEntry.create({ data: { id, businessId, staffId: body.staffId, kind: body.kind, amount: BigInt(Math.round(Math.abs(body.amount))), label: body.label, comment: body.comment, createdBy: ctx.member.staffId } });
            await this.audit.record(tx, ctx, { action: 'create', entityType: 'payrollSettlementEntry', entityId: id, businessId, after: { staffId: body.staffId, kind: body.kind, amount: body.amount } });
        });
        return entryView(await this.prisma.payrollSettlementEntry.findUniqueOrThrow({ where: { id } }));
    }
    /** Удалить ведомость/премию/штраф/внеочередное — payout удалить нельзя (F-07-159) */
    async deleteEntry(ctx, id) {
        const businessId = ctx.member.businessId;
        const row = await this.prisma.payrollSettlementEntry.findFirst({ where: { id, businessId } });
        if (!row)
            throw new ApiError('not_found', 'Entry not found');
        if (row.kind === 'payout')
            throw new ApiError('in_use', 'Payout cannot be deleted');
        await this.prisma.$transaction(async (tx) => {
            await tx.payrollSettlementEntry.delete({ where: { id } });
            await this.audit.record(tx, ctx, { action: 'delete', entityType: 'payrollSettlementEntry', entityId: id, businessId, before: { staffId: row.staffId, kind: row.kind }, after: null });
        });
    }
    /** «Выдать зарплату» (F-07-160) — расходная FinOp «Зарплата персонала» + строка выплаты во взаиморасчётах.
     * F-09-100: пока включено согласование, «выплачено» нельзя без подписи сотрудника — canMarkPaid проверяет
     * approval-статус САМОЙ СВЕЖЕЙ ведомости сотрудника (нет ведомости — согласование не блокирует, В-05 подход
     * «работающая функция важнее строгости», ведомость необязательна для премий/штрафов). */
    async payout(ctx, body) {
        const businessId = ctx.member.businessId;
        const [staff, account, settings] = await Promise.all([
            this.prisma.staff.findFirst({ where: { id: body.staffId, businessId } }),
            this.prisma.cashRegister.findFirst({ where: { id: body.accountId, businessId } }),
            this.prisma.payrollSettings.findUnique({ where: { locationId: body.locationId } }),
        ]);
        if (!staff)
            throw new ApiError('not_found', 'Staff not found');
        if (!account)
            throw new ApiError('not_found', 'Account not found');
        let signedSheetId;
        if (settings?.statementApprovalEnabled) {
            const latestSheet = await this.prisma.payrollSettlementEntry.findFirst({ where: { businessId, staffId: body.staffId, kind: 'sheet' }, orderBy: { createdAt: 'desc' } });
            if (latestSheet) {
                const approval = await this.prisma.payrollStatementApproval.findUnique({ where: { sheetId: latestSheet.id } });
                const status = approval?.status ?? 'pendingReview';
                if (!canMarkPaid(status, true))
                    throw new ApiError('cannot_pay', 'Statement not signed yet');
                if (status === 'signed')
                    signedSheetId = latestSheet.id;
            }
        }
        const itemId = await this.financeCatalog.systemItemId(businessId, 'staffPayroll');
        const opId = newId('finOp');
        const entryId = newId('payrollSettlementEntry');
        const amount = BigInt(Math.round(body.amount));
        const now = new Date();
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
                    date: now,
                    method: 'cash',
                    partyType: 'staff',
                    partyId: body.staffId,
                    partyName: staff.name,
                    comment: body.comment,
                    source: 'payroll',
                    history: [{ at: now.toISOString(), by: ctx.member.staffId, action: 'created' }],
                    createdBy: ctx.member.staffId,
                    updatedBy: ctx.member.staffId,
                },
            });
            await tx.payrollSettlementEntry.create({ data: { id: entryId, businessId, locationId: body.locationId, staffId: body.staffId, kind: 'payout', amount, label: 'Выплата зарплаты', comment: body.comment, operationId: opId, createdBy: ctx.member.staffId } });
            await this.audit.record(tx, ctx, { action: 'create', entityType: 'payrollPayout', entityId: entryId, businessId, after: { staffId: body.staffId, amount: body.amount } });
            // F-09-100: выплата по подписанной ведомости сама переводит её в «выплачено» — отдельного шага «пометить
            // выплаченной» экран не просит (кнопка «Выплатить» и есть эта отметка).
            if (signedSheetId) {
                const approval = await tx.payrollStatementApproval.findUnique({ where: { sheetId: signedSheetId } });
                if (approval) {
                    const history = [...approval.history, { status: 'paid', at: now.toISOString(), by: ctx.member.staffId }];
                    await tx.payrollStatementApproval.update({ where: { sheetId: signedSheetId }, data: { status: 'paid', history: history } });
                }
            }
        });
        return entryView(await this.prisma.payrollSettlementEntry.findUniqueOrThrow({ where: { id: entryId } }));
    }
    // ─────────────────────────── Согласование ведомости (F-09-100) ───────────────────────────
    async getApproval(businessId, sheetId) {
        const row = await this.prisma.payrollStatementApproval.findFirst({ where: { sheetId, businessId } });
        if (!row)
            return undefined;
        return { sheetId: row.sheetId, status: row.status, history: row.history };
    }
    async advanceApproval(ctx, sheetId) {
        const businessId = ctx.member.businessId;
        const sheet = await this.prisma.payrollSettlementEntry.findFirst({ where: { id: sheetId, businessId, kind: 'sheet' } });
        if (!sheet)
            throw new ApiError('not_found', 'Sheet not found');
        const current = (await this.getApproval(businessId, sheetId)) ?? { sheetId, status: 'pendingReview', history: [] };
        const next = nextApprovalStatus(current.status);
        if (!next)
            throw new ApiError('validation', 'Already at final status');
        const history = [...current.history, { status: next, at: new Date().toISOString(), by: ctx.member.staffId }];
        await this.prisma.payrollStatementApproval.upsert({
            where: { sheetId },
            create: { sheetId, businessId, status: next, history: history },
            update: { status: next, history: history },
        });
        return { sheetId, status: next, history };
    }
    /** F-09-100: сотрудник подписывает свою ведомость */
    async signApproval(businessId, sheetId, staffId) {
        const current = await this.getApproval(businessId, sheetId);
        if (!current || current.status !== 'sentToStaff')
            throw new ApiError('validation', 'Statement not ready to sign');
        const history = [...current.history, { status: 'signed', at: new Date().toISOString(), by: staffId }];
        await this.prisma.payrollStatementApproval.update({ where: { sheetId }, data: { status: 'signed', history: history } });
        return { sheetId, status: 'signed', history };
    }
    // ─────────────────────────── Аналитика ФОТ (F-09-101) ───────────────────────────
    async fundAnalytics(businessId, locationId, from, to) {
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
        const risks = [];
        if (noSchemeCount > 0)
            risks.push({ key: 'noScheme', count: noSchemeCount });
        if (settings?.statementApprovalEnabled) {
            const sheets = await this.prisma.payrollSettlementEntry.findMany({ where: { businessId, kind: 'sheet', staffId: { in: activeStaff.map((s) => s.id) }, createdAt: { gte: new Date(from), lte: new Date(`${to}T23:59:59.999Z`) } } });
            const approvals = await this.prisma.payrollStatementApproval.findMany({ where: { sheetId: { in: sheets.map((s) => s.id) } } });
            const approvalBySheet = new Map(approvals.map((a) => [a.sheetId, a.status]));
            let unsignedCount = 0;
            let unmarkedPayoutCount = 0;
            for (const sheet of sheets) {
                const status = approvalBySheet.get(sheet.id);
                if (status !== 'signed' && status !== 'paid')
                    unsignedCount += 1;
                else if (status === 'signed')
                    unmarkedPayoutCount += 1;
            }
            if (unsignedCount > 0)
                risks.push({ key: 'unsignedStatement', count: unsignedCount });
            if (unmarkedPayoutCount > 0)
                risks.push({ key: 'unmarkedPayout', count: unmarkedPayoutCount });
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
};
PayrollSettlementsService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [PrismaService,
        AuditService,
        PayrollComputeService,
        FinanceCatalogService])
], PayrollSettlementsService);
export { PayrollSettlementsService };
//# sourceMappingURL=payroll-settlements.service.js.map