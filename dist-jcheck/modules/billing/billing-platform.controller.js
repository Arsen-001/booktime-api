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
import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiError } from '../../common/errors/api-error.js';
import { Ctx, Platform } from '../../common/http/guards.js';
import { ZodBody } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { PrismaService } from '../../common/prisma.service.js';
import { DEFAULT_PRICES, loadPrices, PRICE_NOTES } from './billing-prices.js';
import { calculateForPlan } from './billing-seats.js';
import { BillingService } from './billing.service.js';
import { freeMonthsBody, grantCoinsBody, planQuery, pricesBody, promoCheckQuery, promoCreateBody } from './billing.schemas.js';
import { checkPromo, createPromo, promoViews } from './promo.js';
import { grantFreeDays, markInvoicePaid } from './subscription.js';
/**
 * Наша панель: промокоды, бесплатные месяцы, цены, монеты-подарки, оплата счёта для фирмы (02 §19 — часть,
 * которая принадлежит деньгам; очередь проверки и остальное — этап 19).
 */
let BillingPlatformController = class BillingPlatformController {
    constructor(prisma, billing) {
        this.prisma = prisma;
        this.billing = billing;
    }
    async listPromo() {
        const rows = await this.prisma.promoCode.findMany({ orderBy: { createdAt: 'desc' }, take: 500 });
        return promoViews(this.prisma, rows);
    }
    async createPromo(ctx, body) {
        const row = await createPromo(this.prisma, body, ctx.session.userId);
        return (await promoViews(this.prisma, [row]))[0];
    }
    async check(q) {
        const r = await checkPromo(this.prisma, q.code, q.businessId);
        return r.ok ? { ok: true, promo: (await promoViews(this.prisma, [r.promo]))[0] } : r;
    }
    async revoke(id) {
        const n = await this.prisma.promoCode.updateMany({ where: { id }, data: { revokedAt: new Date() } });
        if (!n.count)
            throw new ApiError('not_found', 'Promo not found');
    }
    async restore(id) {
        const n = await this.prisma.promoCode.updateMany({ where: { id }, data: { revokedAt: null } });
        if (!n.count)
            throw new ApiError('not_found', 'Promo not found');
    }
    async freeMonths(ctx, body) {
        const biz = await this.prisma.business.findUnique({ where: { id: body.businessId }, select: { id: true } });
        if (!biz)
            throw new ApiError('not_found', 'Business not found');
        await this.prisma.$transaction((tx) => grantFreeDays(tx, { ...body, by: ctx.session.userId }));
        return this.billing.view(body.businessId);
    }
    grantCoins(ctx, body) {
        return this.billing.grantCoinsByPlatform(ctx.session.userId, body);
    }
    async invoicePaid(invoiceId) {
        await markInvoicePaid(this.prisma, invoiceId);
    }
    async prices() {
        const values = await loadPrices(this.prisma);
        return Object.keys(DEFAULT_PRICES).map((key) => ({ key, value: values[key], note: PRICE_NOTES[key] }));
    }
    async setPrices(ctx, body) {
        const keys = Object.keys(body.values).filter((k) => k in DEFAULT_PRICES);
        if (!keys.length)
            throw new ApiError('validation', 'No known price keys');
        await this.prisma.$transaction(keys.map((key) => this.prisma.platformPrice.upsert({
            where: { key },
            create: { key, value: BigInt(body.values[key]), note: PRICE_NOTES[key], updatedBy: ctx.session.userId },
            update: { value: BigInt(body.values[key]), updatedBy: ctx.session.userId },
        })));
        return this.prices();
    }
};
__decorate([
    Get('promo-codes'),
    Platform(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], BillingPlatformController.prototype, "listPromo", null);
__decorate([
    Post('promo-codes'),
    Platform(),
    ApiOperation({ summary: 'Создать промокод (F-00-178, В-13: ступени 10/15/25 %, 30 дней)' }),
    ZodBody(promoCreateBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(promoCreateBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], BillingPlatformController.prototype, "createPromo", null);
__decorate([
    Get('promo-codes/check'),
    Platform(),
    __param(0, Query(new Zod(promoCheckQuery))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], BillingPlatformController.prototype, "check", null);
__decorate([
    Post('promo-codes/:id/revoke'),
    Platform(),
    HttpCode(204),
    __param(0, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], BillingPlatformController.prototype, "revoke", null);
__decorate([
    Post('promo-codes/:id/restore'),
    Platform(),
    HttpCode(204),
    __param(0, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], BillingPlatformController.prototype, "restore", null);
__decorate([
    Post('free-months'),
    Platform(),
    ApiOperation({ summary: 'Бесплатные дни бизнесу (F-00-019: подключили на визите; первому — first)' }),
    ZodBody(freeMonthsBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(freeMonthsBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], BillingPlatformController.prototype, "freeMonths", null);
__decorate([
    Post('coins/grant'),
    Platform(),
    ApiOperation({ summary: 'Подарок монетами: первому, по промокоду, за приведённый салон (06 §2.1)' }),
    ZodBody(grantCoinsBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(grantCoinsBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], BillingPlatformController.prototype, "grantCoins", null);
__decorate([
    Post('invoices/:invoiceId/paid'),
    Platform(),
    HttpCode(204),
    ApiOperation({ summary: 'Оплата по счёту для фирмы пришла — продлить срок (F-15-084)' }),
    __param(0, Param('invoiceId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], BillingPlatformController.prototype, "invoicePaid", null);
__decorate([
    Get('prices'),
    Platform(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], BillingPlatformController.prototype, "prices", null);
__decorate([
    Put('prices'),
    Platform(),
    ApiOperation({ summary: 'Цены платформы (В-01: пересмотр после показа салонам). Меняют только новые покупки' }),
    ZodBody(pricesBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(pricesBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], BillingPlatformController.prototype, "setPrices", null);
BillingPlatformController = __decorate([
    ApiTags('platform-billing'),
    Controller('v1/platform'),
    __metadata("design:paramtypes", [PrismaService,
        BillingService])
], BillingPlatformController);
export { BillingPlatformController };
/** Публичный калькулятор цены до регистрации (F-15-178) — те же цены из таблицы */
let PublicPricingController = class PublicPricingController {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async pricing() {
        const p = await loadPrices(this.prisma);
        const packages = await this.prisma.coinPackage.findMany({ where: { active: true }, orderBy: { sort: 'asc' } });
        return {
            individual: p.individual,
            masterSeat: p.masterSeat,
            adminExtraSeat: p.adminExtraSeat,
            minPaidMasters: p.minPaidMasters,
            coinPrice: p.coinPrice,
            packages: packages.map((x) => ({ id: x.id, coins: x.coins, price: Number(x.price), bonusPercent: x.bonusPercent || undefined, popular: x.popular || undefined })),
        };
    }
    async plan(q) {
        return calculateForPlan(await loadPrices(this.prisma), q);
    }
};
__decorate([
    Get(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], PublicPricingController.prototype, "pricing", null);
__decorate([
    Get('plan'),
    __param(0, Query(new Zod(planQuery))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], PublicPricingController.prototype, "plan", null);
PublicPricingController = __decorate([
    ApiTags('billing'),
    Controller('v1/public/pricing'),
    __metadata("design:paramtypes", [PrismaService])
], PublicPricingController);
export { PublicPricingController };
//# sourceMappingURL=billing-platform.controller.js.map