import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { Ctx, Platform } from '../../common/http/guards.js';
import { ZodBody } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { PrismaService } from '../../common/prisma.service.js';
import { DEFAULT_PRICES, loadPrices, PRICE_NOTES, type PriceKey } from './billing-prices.js';
import { calculateForPlan } from './billing-seats.js';
import { BillingService } from './billing.service.js';
import { freeMonthsBody, grantCoinsBody, planQuery, pricesBody, promoCheckQuery, promoCreateBody } from './billing.schemas.js';
import { checkPromo, createPromo, promoViews } from './promo.js';
import { grantFreeDays, markInvoicePaid } from './subscription.js';

/**
 * Наша панель: промокоды, бесплатные месяцы, цены, монеты-подарки, оплата счёта для фирмы (02 §19 — часть,
 * которая принадлежит деньгам; очередь проверки и остальное — этап 19).
 */
@ApiTags('platform-billing')
@Controller('v1/platform')
export class BillingPlatformController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
  ) {}

  @Get('promo-codes')
  @Platform()
  async listPromo() {
    const rows = await this.prisma.promoCode.findMany({ orderBy: { createdAt: 'desc' }, take: 500 });
    return promoViews(this.prisma, rows);
  }

  @Post('promo-codes')
  @Platform()
  @ApiOperation({ summary: 'Создать промокод (F-00-178, В-13: ступени 10/15/25 %, 30 дней)' })
  @ZodBody(promoCreateBody)
  async createPromo(@Ctx() ctx: RequestContext, @Body(new Zod(promoCreateBody)) body: z.infer<typeof promoCreateBody>) {
    const row = await createPromo(this.prisma, body, ctx.session!.userId);
    return (await promoViews(this.prisma, [row]))[0];
  }

  @Get('promo-codes/check')
  @Platform()
  async check(@Query(new Zod(promoCheckQuery)) q: z.infer<typeof promoCheckQuery>) {
    const r = await checkPromo(this.prisma, q.code, q.businessId);
    return r.ok ? { ok: true as const, promo: (await promoViews(this.prisma, [r.promo]))[0] } : r;
  }

  @Post('promo-codes/:id/revoke')
  @Platform()
  @HttpCode(204)
  async revoke(@Param('id') id: string) {
    const n = await this.prisma.promoCode.updateMany({ where: { id }, data: { revokedAt: new Date() } });
    if (!n.count) throw new ApiError('not_found', 'Promo not found');
  }

  @Post('promo-codes/:id/restore')
  @Platform()
  @HttpCode(204)
  async restore(@Param('id') id: string) {
    const n = await this.prisma.promoCode.updateMany({ where: { id }, data: { revokedAt: null } });
    if (!n.count) throw new ApiError('not_found', 'Promo not found');
  }

  @Post('free-months')
  @Platform()
  @ApiOperation({ summary: 'Бесплатные дни бизнесу (F-00-019: подключили на визите; первому — first)' })
  @ZodBody(freeMonthsBody)
  async freeMonths(@Ctx() ctx: RequestContext, @Body(new Zod(freeMonthsBody)) body: z.infer<typeof freeMonthsBody>) {
    const biz = await this.prisma.business.findUnique({ where: { id: body.businessId }, select: { id: true } });
    if (!biz) throw new ApiError('not_found', 'Business not found');
    await this.prisma.$transaction((tx) => grantFreeDays(tx, { ...body, by: ctx.session!.userId }));
    return this.billing.view(body.businessId);
  }

  @Post('coins/grant')
  @Platform()
  @ApiOperation({ summary: 'Подарок монетами: первому, по промокоду, за приведённый салон (06 §2.1)' })
  @ZodBody(grantCoinsBody)
  grantCoins(@Ctx() ctx: RequestContext, @Body(new Zod(grantCoinsBody)) body: z.infer<typeof grantCoinsBody>) {
    return this.billing.grantCoinsByPlatform(ctx.session!.userId, body);
  }

  @Post('invoices/:invoiceId/paid')
  @Platform()
  @HttpCode(204)
  @ApiOperation({ summary: 'Оплата по счёту для фирмы пришла — продлить срок (F-15-084)' })
  async invoicePaid(@Param('invoiceId') invoiceId: string) {
    await markInvoicePaid(this.prisma, invoiceId);
  }

  @Get('prices')
  @Platform()
  async prices() {
    const values = await loadPrices(this.prisma);
    return (Object.keys(DEFAULT_PRICES) as PriceKey[]).map((key) => ({ key, value: values[key], note: PRICE_NOTES[key] }));
  }

  @Put('prices')
  @Platform()
  @ApiOperation({ summary: 'Цены платформы (В-01: пересмотр после показа салонам). Меняют только новые покупки' })
  @ZodBody(pricesBody)
  async setPrices(@Ctx() ctx: RequestContext, @Body(new Zod(pricesBody)) body: z.infer<typeof pricesBody>) {
    const keys = Object.keys(body.values).filter((k): k is PriceKey => k in DEFAULT_PRICES);
    if (!keys.length) throw new ApiError('validation', 'No known price keys');
    await this.prisma.$transaction(
      keys.map((key) =>
        this.prisma.platformPrice.upsert({
          where: { key },
          create: { key, value: BigInt(body.values[key]!), note: PRICE_NOTES[key], updatedBy: ctx.session!.userId },
          update: { value: BigInt(body.values[key]!), updatedBy: ctx.session!.userId },
        }),
      ),
    );
    return this.prices();
  }
}

/** Публичный калькулятор цены до регистрации (F-15-178) — те же цены из таблицы */
@ApiTags('billing')
@Controller('v1/public/pricing')
export class PublicPricingController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
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

  @Get('plan')
  async plan(@Query(new Zod(planQuery)) q: z.infer<typeof planQuery>) {
    return calculateForPlan(await loadPrices(this.prisma), q);
  }
}

