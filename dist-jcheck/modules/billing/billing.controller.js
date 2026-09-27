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
import { Body, Controller, Get, Param, Post, Put, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiError } from '../../common/errors/api-error.js';
import { Biz, Ctx } from '../../common/http/guards.js';
import { ZodBody } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { Idempotent } from '../../common/idempotency/idempotency.js';
import { BillingService } from './billing.service.js';
import { autoRenewBody, buyCoinsBody, cardBody, coinEntriesQuery, docsEmailBody, invoicesQuery, monthsQuery, payBody, photoSlotBody, previewBody, spendBody, } from './billing.schemas.js';
/**
 * Подписка и монеты бизнеса — /v1/biz/{b}/billing, /coins, /photo-slots (docs/backend/02 §18).
 * Читать подписку может любой сотрудник (полоса «заканчивается» видна всем), платить и менять — billing.manage.
 */
let BillingController = class BillingController {
    constructor(billing) {
        this.billing = billing;
    }
    view(businessId) {
        return this.billing.view(businessId);
    }
    quote(businessId, q) {
        return this.billing.quote(businessId, q.months);
    }
    seats(businessId) {
        return this.billing.seats(businessId);
    }
    preview(businessId, body) {
        return this.billing.preview(businessId, body);
    }
    warnings(businessId) {
        return this.billing.warnings(businessId);
    }
    pay(ctx, businessId, body) {
        return this.billing.pay(ctx, businessId, body);
    }
    autorenew(ctx, businessId, body) {
        return this.billing.setAutoRenew(ctx, businessId, body.autoRenew);
    }
    card(ctx, businessId, body) {
        return this.billing.setCard(ctx, businessId, body);
    }
    docsEmail(ctx, businessId, body) {
        return this.billing.setDocsEmail(ctx, businessId, body.value);
    }
    charges(businessId) {
        return this.billing.charges(businessId);
    }
    invoices(businessId, q) {
        return this.billing.invoices(businessId, q.purpose);
    }
    invoice(businessId, invoiceId) {
        return this.billing.invoice(businessId, invoiceId);
    }
    priceRules() {
        return this.billing.priceRules();
    }
    // ─────────── монеты ───────────
    coins(businessId) {
        return this.billing.coins(businessId);
    }
    entries(businessId, q) {
        return this.billing.coinEntries(businessId, { area: q.area, kinds: q.kinds?.split(',').filter(Boolean) });
    }
    packages() {
        return this.billing.packages();
    }
    buy(ctx, req, businessId, body) {
        return this.billing.buyCoins(ctx, businessId, body.packageId, req.header('idempotency-key') ?? undefined);
    }
    spend(ctx, businessId, body) {
        return this.billing.spend(ctx, businessId, body);
    }
    photoSlot(ctx, businessId, body) {
        // Себе — сам мастер; другому — только владелец/кто платит (02 §18: «сам мастер / владелец»)
        if (body.staffId !== ctx.member.staffId && !ctx.member.permissions.has('billing.manage'))
            throw new ApiError('forbidden', 'Only own photo slot');
        return this.billing.buyPhotoSlot(ctx, businessId, body.staffId);
    }
};
__decorate([
    Get('billing'),
    Biz(),
    ApiOperation({ summary: 'Подписка: статус, срок, бесплатно до, скидка кода, тариф (F-00-012…025)' }),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], BillingController.prototype, "view", null);
__decorate([
    Get('billing/quote'),
    Biz(),
    ApiOperation({ summary: 'Расчёт за 1/3/6/12 месяцев со скидкой кода (F-15-033/041/062)' }),
    __param(0, Param('businessId')),
    __param(1, Query(new Zod(monthsQuery))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], BillingController.prototype, "quote", null);
__decorate([
    Get('billing/seats'),
    Biz(),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], BillingController.prototype, "seats", null);
__decorate([
    Post('billing/preview'),
    Biz(),
    ApiOperation({ summary: 'Сумма до/после при добавлении или увольнении (F-15-051)' }),
    ZodBody(previewBody),
    __param(0, Param('businessId')),
    __param(1, Body(new Zod(previewBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], BillingController.prototype, "preview", null);
__decorate([
    Get('billing/warnings'),
    Biz(),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], BillingController.prototype, "warnings", null);
__decorate([
    Post('billing/pay'),
    Biz('billing.manage'),
    Idempotent(),
    ApiOperation({ summary: 'Оплатить: карта/Idram/Telcell (заглушка провайдера) или счёт для фирмы (F-15-083/084)' }),
    ZodBody(payBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(payBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], BillingController.prototype, "pay", null);
__decorate([
    Put('billing/autorenew'),
    Biz('billing.manage'),
    ZodBody(autoRenewBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(autoRenewBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], BillingController.prototype, "autorenew", null);
__decorate([
    Put('billing/card'),
    Biz('billing.manage'),
    ZodBody(cardBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(cardBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], BillingController.prototype, "card", null);
__decorate([
    Put('billing/docs-email'),
    Biz('billing.manage'),
    ZodBody(docsEmailBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(docsEmailBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], BillingController.prototype, "docsEmail", null);
__decorate([
    Get('billing/charges'),
    Biz('billing.manage'),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], BillingController.prototype, "charges", null);
__decorate([
    Get('billing/invoices'),
    Biz('billing.manage'),
    __param(0, Param('businessId')),
    __param(1, Query(new Zod(invoicesQuery))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], BillingController.prototype, "invoices", null);
__decorate([
    Get('billing/invoices/:invoiceId'),
    Biz('billing.manage'),
    __param(0, Param('businessId')),
    __param(1, Param('invoiceId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], BillingController.prototype, "invoice", null);
__decorate([
    Get('billing/price-rules'),
    Biz(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], BillingController.prototype, "priceRules", null);
__decorate([
    Get('coins'),
    Biz(),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], BillingController.prototype, "coins", null);
__decorate([
    Get('coins/entries'),
    Biz(),
    __param(0, Param('businessId')),
    __param(1, Query(new Zod(coinEntriesQuery))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], BillingController.prototype, "entries", null);
__decorate([
    Get('coins/packages'),
    Biz(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], BillingController.prototype, "packages", null);
__decorate([
    Post('coins/buy'),
    Biz('billing.manage'),
    Idempotent(),
    ApiOperation({ summary: 'Купить пакет монет (F-00-026, В-15)' }),
    ZodBody(buyCoinsBody),
    __param(0, Ctx()),
    __param(1, Req()),
    __param(2, Param('businessId')),
    __param(3, Body(new Zod(buyCoinsBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, String, Object]),
    __metadata("design:returntype", void 0)
], BillingController.prototype, "buy", null);
__decorate([
    Post('coins/spend'),
    Biz(),
    Idempotent(),
    ApiOperation({ summary: 'Потратить монеты (раздел-покупатель: сторис, новость сверх лимита…); не хватает → 402 insufficient_coins' }),
    ZodBody(spendBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(spendBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], BillingController.prototype, "spend", null);
__decorate([
    Post('photo-slots'),
    Biz(),
    Idempotent(),
    ApiOperation({ summary: 'Место под фото сверх 6 за монеты (F-00-086)' }),
    ZodBody(photoSlotBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(photoSlotBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], BillingController.prototype, "photoSlot", null);
BillingController = __decorate([
    ApiTags('billing'),
    Controller('v1/biz/:businessId'),
    __metadata("design:paramtypes", [BillingService])
], BillingController);
export { BillingController };
//# sourceMappingURL=billing.controller.js.map