var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
import { Inject, Injectable } from '@nestjs/common';
import { PAYMENTS } from '../../adapters/adapters.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { ApiError } from '../../common/errors/api-error.js';
import { newId } from '../../common/ids/ids.js';
import { moneyToJson } from '../../common/money/money.js';
import { PrismaService } from '../../common/prisma.service.js';
import { utcToLocal, utcToLocalDate } from '../../common/time/time.js';
import { loadPrices } from './billing-prices.js';
import { computeSeats } from './billing-seats.js';
import { coinBalance, coinMoveView, grantCoins, spendCoins } from './coins.js';
import { chargeSubscription, daysUntil, ensureSubscription, invoiceView, nextInvoiceNumber, payerSnapshot, quoteFor, subscriptionView, } from './subscription.js';
/** Подписка, счета, монеты бизнеса (docs/backend/02 §18, 06 §2–3) */
let BillingService = class BillingService {
    constructor(prisma, audit, payments) {
        this.prisma = prisma;
        this.audit = audit;
        this.payments = payments;
    }
    // ─────────── подписка ───────────
    view(businessId) {
        return subscriptionView(this.prisma, businessId);
    }
    quote(businessId, months) {
        return quoteFor(this.prisma, businessId, months);
    }
    async seats(businessId) {
        return (await computeSeats(this.prisma, businessId, await loadPrices(this.prisma))).seats;
    }
    /** Как изменится сумма при добавлении/увольнении (F-15-051, F-00-013) */
    async preview(businessId, delta) {
        const prices = await loadPrices(this.prisma);
        const s = await computeSeats(this.prisma, businessId, prices);
        if (s.kind === 'individual')
            return { before: s.monthlyTotal, after: s.monthlyTotal };
        const realMasters = s.seats.filter((x) => x.paid && (x.reasonKey === 'master' || x.reasonKey === 'ownerAsMaster')).length + (delta.masters ?? 0);
        const admins = s.seats.filter((x) => x.role === 'admin').length + (delta.admins ?? 0);
        const after = Math.max(realMasters, prices.minPaidMasters) * prices.masterSeat + Math.max(admins - 1, 0) * prices.adminExtraSeat;
        return { before: s.monthlyTotal, after };
    }
    /** Полоса «заканчивается через 7/3/1 день» и «заморожено» (F-00-023, F-15-058/064) */
    async warnings(businessId) {
        const sub = await ensureSubscription(this.prisma, businessId);
        if (sub.status === 'frozen' || sub.status === 'left')
            return [{ level: 'danger', daysLeft: 0, messageKey: 'billing.warning.frozen' }];
        const daysLeft = daysUntil(sub.paidUntil);
        if (daysLeft > 7 && sub.status !== 'grace')
            return [];
        const level = daysLeft <= 1 || sub.status === 'grace' ? 'danger' : daysLeft <= 3 ? 'warning' : 'info';
        return [{ level: level, daysLeft: Math.max(daysLeft, 0), messageKey: 'billing.warning.endingSoon' }];
    }
    async pay(ctx, businessId, input) {
        const res = await chargeSubscription(this.prisma, this.payments, { businessId, months: input.months, method: input.method, trigger: 'manual', by: ctx.member.staffId });
        await this.prisma.$transaction((tx) => this.audit.record(tx, ctx, { action: 'pay', entityType: 'subscription', entityId: businessId, businessId, after: { months: input.months, method: input.method, status: res.status } }));
        return { invoiceId: res.invoiceId, status: res.status };
    }
    async setAutoRenew(ctx, businessId, autoRenew) {
        await ensureSubscription(this.prisma, businessId);
        await this.prisma.$transaction(async (tx) => {
            const before = await tx.subscription.findUniqueOrThrow({ where: { businessId } });
            await tx.subscription.update({ where: { businessId }, data: { autoRenew, updatedBy: ctx.member.staffId, version: { increment: 1 } } });
            await this.audit.record(tx, ctx, { action: 'update', entityType: 'subscription', entityId: businessId, businessId, before: { autoRenew: before.autoRenew }, after: { autoRenew } });
        });
        return this.view(businessId);
    }
    async setDocsEmail(ctx, businessId, value) {
        await ensureSubscription(this.prisma, businessId);
        await this.prisma.subscription.update({ where: { businessId }, data: { paymentDocsEmail: value, updatedBy: ctx.member.staffId, version: { increment: 1 } } });
        return this.view(businessId);
    }
    /**
     * Сохранить способ оплаты для автопродления (F-15-082). Провайдер не выбран (D8) — токенизации карты нет,
     * заглушка кладёт ссылку-маску; настоящий адаптер вернёт токен после 3-D Secure.
     */
    async setCard(ctx, businessId, input) {
        await ensureSubscription(this.prisma, businessId);
        const label = input.label?.trim() || (input.method === 'card' ? '•• 4242' : input.method === 'idram' ? 'Idram' : 'Telcell');
        await this.prisma.$transaction(async (tx) => {
            const card = await tx.savedCard.create({ data: { id: newId('savedCard'), businessId, provider: this.payments.kind, method: input.method, token: `fake_${newId('savedCard')}`, label } });
            await tx.subscription.update({ where: { businessId }, data: { savedCardId: card.id, updatedBy: ctx.member.staffId, version: { increment: 1 } } });
            await this.audit.record(tx, ctx, { action: 'update', entityType: 'subscription', entityId: businessId, businessId, after: { savedCard: label } });
        });
        return this.view(businessId);
    }
    /** История лицензии (F-15-072): списания + бесплатные дни */
    async charges(businessId) {
        const [charges, grants] = await Promise.all([
            this.prisma.subscriptionCharge.findMany({ where: { businessId, NOT: { method: 'invoice', status: 'pending' } }, orderBy: { attemptedAt: 'desc' }, take: 200 }),
            this.prisma.freePeriodGrant.findMany({ where: { businessId }, orderBy: { at: 'desc' }, take: 50 }),
        ]);
        const rows = [
            ...charges.map((c) => ({
                id: c.id,
                businessId,
                date: utcToLocal(c.paidAt ?? c.attemptedAt),
                periodMonths: c.months,
                amount: moneyToJson(c.amount),
                method: (c.discountPct > 0 ? 'promo' : c.method === 'platform' ? 'platform' : 'card'),
                status: (c.status === 'paid' ? 'success' : c.status === 'failed' ? 'failed' : 'pending'),
                invoiceId: c.invoiceId ?? undefined,
            })),
            ...grants.map((g) => ({
                id: g.id,
                businessId,
                date: utcToLocal(g.at),
                periodMonths: Math.max(1, Math.round(g.days / 30)),
                amount: 0,
                method: 'freeMonth',
                status: 'success',
                invoiceId: undefined,
            })),
        ];
        return rows.sort((a, b) => b.date.localeCompare(a.date));
    }
    async invoices(businessId, purpose) {
        const rows = await this.prisma.billingInvoice.findMany({ where: { businessId, ...(purpose ? { purpose } : {}) }, orderBy: { createdAt: 'desc' }, take: 300 });
        return rows.map(invoiceView);
    }
    async invoice(businessId, id) {
        const row = await this.prisma.billingInvoice.findFirst({ where: { id, businessId } });
        if (!row)
            throw new ApiError('not_found', 'Invoice not found');
        return invoiceView(row);
    }
    async priceRules() {
        const today = utcToLocalDate(new Date());
        const rows = await this.prisma.priceRuleChange.findMany({ orderBy: { effectiveFrom: 'asc' } });
        return rows.map((r) => ({
            id: r.id,
            effectiveFrom: r.effectiveFrom,
            announcedAt: r.announcedAt,
            descriptionKey: r.descriptionKey,
            oldPrice: moneyToJson(r.oldPrice),
            newPrice: moneyToJson(r.newPrice),
            upcoming: r.effectiveFrom > today || undefined,
        }));
    }
    // ─────────── монеты (06 §2, В-15) ───────────
    async coins(businessId) {
        return { balance: await coinBalance(this.prisma, businessId) };
    }
    async coinEntries(businessId, filter) {
        const rows = await this.prisma.coinEntry.findMany({
            where: { businessId, ...(filter.area ? { area: filter.area } : {}), ...(filter.kinds?.length ? { kind: { in: filter.kinds } } : {}) },
            orderBy: { at: 'desc' },
            take: 500,
        });
        return rows.map(coinMoveView);
    }
    async packages() {
        const rows = await this.prisma.coinPackage.findMany({ where: { active: true }, orderBy: { sort: 'asc' } });
        return rows.map((p) => ({ id: p.id, coins: p.coins, price: moneyToJson(p.price), bonusPercent: p.bonusPercent || undefined, popular: p.popular || undefined }));
    }
    /**
     * Купить пакет (F-00-026): оплата провайдером (заглушка — сразу), затем в одной транзакции счёт «монеты»
     * и приход в журнал. Idempotency-Key — ключ движения: повтор того же запроса не начислит дважды.
     */
    async buyCoins(ctx, businessId, packageId, idempotencyKey) {
        const pkg = await this.prisma.coinPackage.findFirst({ where: { id: packageId, active: true } });
        if (!pkg)
            throw new ApiError('not_found', 'Package not found');
        if (idempotencyKey) {
            const done = await this.prisma.coinEntry.findUnique({ where: { idempotencyKey: `buy:${idempotencyKey}` } });
            if (done)
                return coinMoveView(done);
        }
        const ref = newId('billingInvoice');
        const pay = await this.payments.charge({ amount: pkg.price, purpose: `coins ${pkg.id}`, businessId, idempotencyKey: ref });
        if (pay.status === 'failed')
            throw new ApiError('payment_failed', 'Payment declined');
        const amount = Math.round(pkg.coins * (1 + pkg.bonusPercent / 100));
        const entry = await this.prisma.$transaction(async (tx) => {
            await tx.billingInvoice.create({
                data: {
                    id: ref,
                    businessId,
                    number: await nextInvoiceNumber(tx),
                    purpose: 'coins',
                    amount: pkg.price,
                    status: pay.status === 'succeeded' ? 'paid' : 'unpaid',
                    method: 'card',
                    payer: await payerSnapshot(tx, businessId),
                    refId: pkg.id,
                    paidAt: pay.status === 'succeeded' ? new Date() : null,
                },
            });
            const e = await grantCoins(tx, { businessId, amount, reason: 'purchase', area: 'settings', refId: ref, by: ctx.member.staffId, price: pkg.price, idempotencyKey: idempotencyKey ? `buy:${idempotencyKey}` : null }, 'topup');
            await this.audit.record(tx, ctx, { action: 'buy', entityType: 'coins', entityId: e.id, businessId, after: { packageId, coins: amount, price: moneyToJson(pkg.price) } });
            return e;
        });
        return coinMoveView(entry);
    }
    /** Трата монет разделом (сторис, новость сверх лимита…; F-00-027) — фактическая цена пишется в строку */
    async spend(ctx, businessId, input) {
        const e = await this.prisma.$transaction((tx) => spendCoins(tx, { businessId, amount: input.amount, reason: input.reason, area: input.area, refId: input.refId, by: ctx.member.staffId }));
        return coinMoveView(e);
    }
    /** Место под фото сверх 6 (F-00-086) — цена из таблицы (В-15: 50 монет, навсегда) */
    async buyPhotoSlot(ctx, businessId, staffId) {
        const staff = await this.prisma.staff.findFirst({ where: { id: staffId, businessId, deletedAt: null } });
        if (!staff)
            throw new ApiError('staff_not_found', 'Staff not found');
        const { photoSlotCoins } = await loadPrices(this.prisma);
        const e = await this.prisma.$transaction(async (tx) => {
            const entry = await spendCoins(tx, { businessId, amount: photoSlotCoins, reason: 'servicesPhotoSlot', area: 'services', refId: staffId, by: ctx.member.staffId });
            const row = await tx.businessSetting.findUnique({ where: { businessId_area: { businessId, area: 'services.photoSlots' } } });
            const data = (row?.data ?? {});
            data[staffId] = (data[staffId] ?? 0) + 1;
            await tx.businessSetting.upsert({
                where: { businessId_area: { businessId, area: 'services.photoSlots' } },
                create: { businessId, area: 'services.photoSlots', data: data, updatedBy: ctx.member.staffId },
                update: { data: data, updatedBy: ctx.member.staffId, version: { increment: 1 } },
            });
            return entry;
        });
        return { move: coinMoveView(e), price: photoSlotCoins };
    }
    // ─────────── наша панель ───────────
    async grantCoinsByPlatform(platformUserId, input) {
        const biz = await this.prisma.business.findUnique({ where: { id: input.businessId }, select: { id: true } });
        if (!biz)
            throw new ApiError('not_found', 'Business not found');
        const e = await this.prisma.$transaction((tx) => grantCoins(tx, { businessId: input.businessId, amount: input.amount, reason: input.reason, area: 'platform', by: platformUserId }, 'gift'));
        return coinMoveView(e);
    }
};
BillingService = __decorate([
    Injectable(),
    __param(2, Inject(PAYMENTS)),
    __metadata("design:paramtypes", [PrismaService,
        AuditService, Object])
], BillingService);
export { BillingService };
//# sourceMappingURL=billing.service.js.map