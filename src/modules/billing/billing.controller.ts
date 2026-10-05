import { Body, Controller, Get, Param, Post, Put, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext, RequestWithContext } from '../../common/http/context.js';
import { Biz, Ctx } from '../../common/http/guards.js';
import { ZodBody } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { Idempotent } from '../../common/idempotency/idempotency.js';
import { BillingService } from './billing.service.js';
import {
  autoRenewBody,
  buyCoinsBody,
  cardBody,
  coinEntriesQuery,
  docsEmailBody,
  invoicesQuery,
  monthsQuery,
  payBody,
  photoSlotBody,
  previewBody,
  spendBody,
} from './billing.schemas.js';

/**
 * Подписка и монеты бизнеса — /v1/biz/{b}/billing, /coins, /photo-slots (docs/backend/02 §18).
 * Читать подписку может любой сотрудник (полоса «заканчивается» видна всем), платить и менять — billing.manage.
 */
@ApiTags('billing')
@Controller('v1/biz/:businessId')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('billing')
  @Biz()
  @ApiOperation({ summary: 'Подписка: статус, срок, бесплатно до, скидка кода, тариф (F-00-012…025)' })
  view(@Param('businessId') businessId: string) {
    return this.billing.view(businessId);
  }

  @Get('billing/quote')
  @Biz()
  @ApiOperation({ summary: 'Расчёт за 1/3/6/12 месяцев со скидкой кода (F-15-033/041/062)' })
  quote(@Param('businessId') businessId: string, @Query(new Zod(monthsQuery)) q: z.infer<typeof monthsQuery>) {
    return this.billing.quote(businessId, q.months);
  }

  @Get('billing/seats')
  @Biz()
  seats(@Param('businessId') businessId: string) {
    return this.billing.seats(businessId);
  }

  @Post('billing/preview')
  @Biz()
  @ApiOperation({ summary: 'Сумма до/после при добавлении или увольнении (F-15-051)' })
  @ZodBody(previewBody)
  preview(@Param('businessId') businessId: string, @Body(new Zod(previewBody)) body: z.infer<typeof previewBody>) {
    return this.billing.preview(businessId, body);
  }

  @Get('billing/warnings')
  @Biz()
  warnings(@Param('businessId') businessId: string) {
    return this.billing.warnings(businessId);
  }

  @Post('billing/pay')
  @Biz('billing.manage')
  @Idempotent()
  @ApiOperation({ summary: 'Оплатить: карта/Idram/Telcell или счёт для фирмы (F-15-083/084); провайдер не подключён — 503 payments_unavailable (кроме счёта)' })
  @ZodBody(payBody)
  pay(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(payBody)) body: z.infer<typeof payBody>) {
    return this.billing.pay(ctx, businessId, body);
  }

  @Put('billing/autorenew')
  @Biz('billing.manage')
  @ZodBody(autoRenewBody)
  autorenew(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(autoRenewBody)) body: z.infer<typeof autoRenewBody>) {
    return this.billing.setAutoRenew(ctx, businessId, body.autoRenew);
  }

  @Put('billing/card')
  @Biz('billing.manage')
  @ZodBody(cardBody)
  card(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(cardBody)) body: z.infer<typeof cardBody>) {
    return this.billing.setCard(ctx, businessId, body);
  }

  @Put('billing/docs-email')
  @Biz('billing.manage')
  @ZodBody(docsEmailBody)
  docsEmail(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(docsEmailBody)) body: z.infer<typeof docsEmailBody>) {
    return this.billing.setDocsEmail(ctx, businessId, body.value);
  }

  @Get('billing/charges')
  @Biz('billing.manage')
  charges(@Param('businessId') businessId: string) {
    return this.billing.charges(businessId);
  }

  @Get('billing/invoices')
  @Biz('billing.manage')
  invoices(@Param('businessId') businessId: string, @Query(new Zod(invoicesQuery)) q: z.infer<typeof invoicesQuery>) {
    return this.billing.invoices(businessId, q.purpose);
  }

  @Get('billing/invoices/:invoiceId')
  @Biz('billing.manage')
  invoice(@Param('businessId') businessId: string, @Param('invoiceId') invoiceId: string) {
    return this.billing.invoice(businessId, invoiceId);
  }

  @Get('billing/price-rules')
  @Biz()
  priceRules() {
    return this.billing.priceRules();
  }

  // ─────────── монеты ───────────

  @Get('coins')
  @Biz()
  coins(@Param('businessId') businessId: string) {
    return this.billing.coins(businessId);
  }

  @Get('coins/entries')
  @Biz()
  entries(@Param('businessId') businessId: string, @Query(new Zod(coinEntriesQuery)) q: z.infer<typeof coinEntriesQuery>) {
    return this.billing.coinEntries(businessId, { area: q.area, kinds: q.kinds?.split(',').filter(Boolean) });
  }

  @Get('coins/packages')
  @Biz()
  packages() {
    return this.billing.packages();
  }

  @Post('coins/buy')
  @Biz('billing.manage')
  @Idempotent()
  @ApiOperation({ summary: 'Купить пакет монет (F-00-026, В-15); провайдер не подключён — 503 payments_unavailable' })
  @ZodBody(buyCoinsBody)
  buy(@Ctx() ctx: RequestContext, @Req() req: RequestWithContext, @Param('businessId') businessId: string, @Body(new Zod(buyCoinsBody)) body: z.infer<typeof buyCoinsBody>) {
    return this.billing.buyCoins(ctx, businessId, body.packageId, req.header('idempotency-key') ?? undefined);
  }

  @Post('coins/spend')
  @Biz()
  @Idempotent()
  @ApiOperation({ summary: 'Потратить монеты (раздел-покупатель: сторис, новость сверх лимита…); не хватает → 402 insufficient_coins' })
  @ZodBody(spendBody)
  spend(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(spendBody)) body: z.infer<typeof spendBody>) {
    return this.billing.spend(ctx, businessId, body);
  }

  @Post('photo-slots')
  @Biz()
  @Idempotent()
  @ApiOperation({ summary: 'Место под фото сверх 6 за монеты (F-00-086)' })
  @ZodBody(photoSlotBody)
  photoSlot(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(photoSlotBody)) body: z.infer<typeof photoSlotBody>) {
    // Себе — сам мастер; другому — только владелец/кто платит (02 §18: «сам мастер / владелец»)
    if (body.staffId !== ctx.member!.staffId && !ctx.member!.permissions.has('billing.manage')) throw new ApiError('forbidden', 'Only own photo slot');
    return this.billing.buyPhotoSlot(ctx, businessId, body.staffId);
  }
}
