import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { RequestContext } from '../../common/http/context.js';
import { Biz, BizAny, Ctx } from '../../common/http/guards.js';
import { ZodBody } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { ClientPromoService, storyScopeOf } from './client-promo.service.js';
import { boostBody, hotSlotBody, newsPostBody, purchaseStoryBody } from './client-promo.schemas.js';

/** Этап 21 (сдача, попытка 6): сторис/новости/продвижение из кабинета — /v1/biz/{b}/promo/* */
@ApiTags('client-promo')
@Controller('v1/biz/:businessId/promo')
export class ClientPromoBizController {
  constructor(private readonly svc: ClientPromoService) {}

  /** С billing.manage — все сторис бизнеса, иначе — только свои (решение владельца 01.10.2026) */
  @Get('stories')
  @Biz()
  stories(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string) {
    return this.svc.listBusinessStories(businessId, storyScopeOf(ctx));
  }

  @Get('stories/slots')
  @Biz()
  slots() {
    return this.svc.slotsInfo();
  }

  // Мастер публикует свои сторис без billing.manage (экран «Сторис» — journal.view, как AppGate мока)
  @Post('stories')
  @BizAny('billing.manage', 'journal.view')
  @ZodBody(purchaseStoryBody)
  purchase(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(purchaseStoryBody)) body: z.infer<typeof purchaseStoryBody>) {
    return this.svc.purchaseStory(ctx, businessId, body);
  }

  @Delete('stories/:id')
  @BizAny('billing.manage', 'journal.view')
  @HttpCode(200)
  async deleteStory(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('id') id: string) {
    await this.svc.deleteStory(ctx, businessId, id);
    return { ok: true };
  }

  @Get('news')
  @Biz()
  news(@Param('businessId') businessId: string) {
    return this.svc.listNews(businessId);
  }

  @Get('news/week')
  @Biz()
  newsWeek(@Param('businessId') businessId: string) {
    return this.svc.newsWeekStatus(businessId);
  }

  // Новости подписчикам — notify.mailings (как createNewsPost мока, AppGate «Новости»)
  @Post('news')
  @Biz('notify.mailings')
  @ZodBody(newsPostBody)
  createNews(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(newsPostBody)) body: z.infer<typeof newsPostBody>) {
    return this.svc.createNews(ctx, businessId, body);
  }

  @Get('settings')
  @Biz()
  promotion(@Param('businessId') businessId: string) {
    return this.svc.getPromotion(businessId);
  }

  // client-2-fix (как setHotSlotDiscount мока): скидка «горящего окна» в продвижении — billing.manage
  @Put('hot-slot')
  @Biz('billing.manage')
  @ZodBody(hotSlotBody)
  hotSlot(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(hotSlotBody)) body: z.infer<typeof hotSlotBody>) {
    return this.svc.setHotSlotDiscount(ctx, businessId, body.percent).then(() => ({ ok: true }));
  }

  @Post('boost')
  @Biz('billing.manage')
  @ZodBody(boostBody)
  boost(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(boostBody)) body: z.infer<typeof boostBody>) {
    return this.svc.purchaseBoost(ctx, businessId, body.kind).then(() => ({ ok: true }));
  }
}

/** Сторис для приложения клиента — видят все (F-00-159), вход не обязателен */
@ApiTags('client-promo')
@Controller('v1/public/stories')
export class ClientPromoPublicController {
  constructor(private readonly svc: ClientPromoService) {}

  @Get('home')
  home(@Ctx() ctx: RequestContext) {
    return this.svc.listHomeStories(ctx.session && !ctx.session.platform ? ctx.session.userId : undefined);
  }

  /** Занято мест сейчас / всего (F-00-160) — видно и кабинету перед покупкой */
  @Get('slots')
  slotsPublic() {
    return this.svc.slotsInfo();
  }

  @Get('business/:businessId')
  byBusiness(@Param('businessId') businessId: string) {
    return this.svc.listBusinessPromoStories(businessId);
  }

  @Get(':id')
  one(@Param('id') id: string) {
    return this.svc.getStory(id);
  }

  @Post(':id/view')
  view(@Param('id') id: string) {
    return this.svc.recordView(id).then(() => ({ ok: true }));
  }

  @Post(':id/click')
  click(@Param('id') id: string) {
    return this.svc.recordClick(id).then(() => ({ ok: true }));
  }
}
