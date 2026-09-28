import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { RequestContext } from '../../common/http/context.js';
import { Authed, Biz, Ctx } from '../../common/http/guards.js';
import { ZodBody } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { MarketplaceService } from './marketplace.service.js';
import {
  addReviewBody,
  catalogQuery,
  createDevAppBody,
  createPromoBlockBody,
  devAppAction,
  installAction,
  partnerApplicationBody,
  registerDeveloperBody,
  setPromoBlockEnabledBody,
  subscribeCategoryBody,
  updatePromoBlockBody,
} from './marketplace.schemas.js';

const countryOf = (v?: string) => (v === 'all' ? 'all' : 'AM');

/**
 * Каталог маркетплейса интеграций (этап 21, сдача, попытка 6) — общий для всех вошедших: витрина одна на
 * платформу, данные бизнеса в ней не лежат (подключения/отзывы бизнеса — маршруты /v1/biz ниже).
 */
@ApiTags('integrations')
@Controller('v1/integrations/catalog')
export class IntegrationsCatalogController {
  constructor(private readonly market: MarketplaceService) {}

  @Get()
  @Authed()
  list(@Query(new Zod(catalogQuery)) q: z.infer<typeof catalogQuery>) {
    return this.market.listApps(q);
  }

  @Get('all')
  @Authed()
  all() {
    return this.market.catalogAll();
  }

  @Get('featured')
  @Authed()
  featured(@Query('country') country?: string) {
    return this.market.featured(countryOf(country));
  }

  @Get('category-counts')
  @Authed()
  categoryCounts(@Query('country') country?: string) {
    return this.market.categoryCounts(countryOf(country));
  }

  @Get('by-code/:code')
  @Authed()
  byCode(@Param('code') code: string) {
    return this.market.getAppByCode(code);
  }

  @Get('apps/:id')
  @Authed()
  one(@Param('id') id: string) {
    return this.market.getApp(id);
  }

  @Get('apps/:id/reviews')
  @Authed()
  reviews(@Param('id') id: string) {
    return this.market.listReviews(id);
  }
}

/** Данные бизнеса в маркетплейсе: отзывы, подписки, настройки подключений, промоблоки, кабинет разработчика */
@ApiTags('integrations')
@Controller('v1/biz/:businessId/integrations')
export class IntegrationsMarketController {
  constructor(private readonly market: MarketplaceService) {}

  @Post('reviews')
  @Biz('integrations.manage')
  @ZodBody(addReviewBody)
  addReview(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(addReviewBody)) body: z.infer<typeof addReviewBody>) {
    return this.market.addReview(ctx, businessId, body);
  }

  @Get('category-subscriptions/:categoryId')
  @Biz()
  isSubscribed(@Param('businessId') businessId: string, @Param('categoryId') categoryId: string) {
    return this.market.isSubscribed(businessId, categoryId).then((subscribed) => ({ subscribed }));
  }

  @Post('category-subscriptions')
  @Biz()
  @ZodBody(subscribeCategoryBody)
  subscribe(@Param('businessId') businessId: string, @Body(new Zod(subscribeCategoryBody)) body: z.infer<typeof subscribeCategoryBody>) {
    return this.market.subscribe(businessId, body.categoryId).then(() => ({ ok: true }));
  }

  @Post('installs/:id/action')
  @Biz('integrations.manage')
  @ZodBody(installAction)
  installAction(@Param('businessId') businessId: string, @Param('id') id: string, @Body(new Zod(installAction)) body: z.infer<typeof installAction>) {
    return this.market.installAction(businessId, id, body);
  }

  // ─────────── Промоблоки (F-13-172) ───────────

  @Get('promo-blocks')
  @Biz()
  listPromo(@Param('businessId') businessId: string) {
    return this.market.listPromoBlocks(businessId);
  }

  @Post('promo-blocks')
  @Biz('integrations.manage')
  @ZodBody(createPromoBlockBody)
  createPromo(@Param('businessId') businessId: string, @Body(new Zod(createPromoBlockBody)) body: z.infer<typeof createPromoBlockBody>) {
    return this.market.createPromoBlock(businessId, body.locationId, body.draft);
  }

  @Post('promo-blocks/:id')
  @Biz('integrations.manage')
  @ZodBody(updatePromoBlockBody)
  updatePromo(@Param('businessId') businessId: string, @Param('id') id: string, @Body(new Zod(updatePromoBlockBody)) body: z.infer<typeof updatePromoBlockBody>) {
    return this.market.updatePromoBlock(businessId, id, body.draft);
  }

  @Post('promo-blocks/:id/enabled')
  @Biz('integrations.manage')
  @ZodBody(setPromoBlockEnabledBody)
  setPromoEnabled(@Param('businessId') businessId: string, @Param('id') id: string, @Body(new Zod(setPromoBlockEnabledBody)) body: z.infer<typeof setPromoBlockEnabledBody>) {
    return this.market.setPromoBlockEnabled(businessId, id, body.enabled);
  }

  @Delete('promo-blocks/:id')
  @Biz('integrations.manage')
  deletePromo(@Param('businessId') businessId: string, @Param('id') id: string) {
    return this.market.deletePromoBlock(businessId, id).then(() => ({ ok: true }));
  }

  // ─────────── Кабинет разработчика (F-13-028…048) ───────────

  @Get('developer')
  @Biz()
  developer(@Ctx() ctx: RequestContext) {
    return this.market.getDeveloper(ctx);
  }

  @Post('developer')
  @Biz('integrations.manage')
  @ZodBody(registerDeveloperBody)
  registerDeveloper(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(registerDeveloperBody)) body: z.infer<typeof registerDeveloperBody>) {
    return this.market.registerDeveloper(ctx, businessId, body);
  }

  @Get('dev-apps')
  @Biz()
  devApps(@Ctx() ctx: RequestContext) {
    return this.market.listDevApps(ctx);
  }

  @Get('dev-apps/by-code/:code')
  @Biz()
  devAppByCode(@Ctx() ctx: RequestContext, @Param('code') code: string) {
    return this.market.getDevAppByCode(ctx, code);
  }

  @Get('dev-apps/:id')
  @Biz()
  devApp(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.market.getDevApp(ctx, id);
  }

  @Post('dev-apps')
  @Biz('integrations.manage')
  @ZodBody(createDevAppBody)
  createDevApp(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(createDevAppBody)) body: z.infer<typeof createDevAppBody>) {
    return this.market.createDevApp(ctx, businessId, body);
  }

  @Post('dev-apps/:id/action')
  @Biz('integrations.manage')
  @ZodBody(devAppAction)
  devAppAction(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(devAppAction)) body: z.infer<typeof devAppAction>) {
    return this.market.devAppAction(ctx, id, body);
  }

  // ─────────── Заявка партнёру (F-13-137) ───────────

  @Get('partner-applications/:appId')
  @Biz()
  hasApplied(@Param('businessId') businessId: string, @Param('appId') appId: string) {
    return this.market.hasApplied(businessId, appId).then((applied) => ({ applied }));
  }

  @Post('partner-applications')
  @Biz('integrations.manage')
  @ZodBody(partnerApplicationBody)
  apply(@Param('businessId') businessId: string, @Body(new Zod(partnerApplicationBody)) body: z.infer<typeof partnerApplicationBody>) {
    return this.market.apply(businessId, body.appId);
  }

  // ─────────── Демо без обмена ───────────

  @Get('demo-incoming-call')
  @Biz()
  demoIncomingCall(@Param('businessId') businessId: string) {
    return this.market.demoIncomingCall(businessId);
  }

  @Get('who-to-call')
  @Biz()
  whoToCall(@Param('businessId') businessId: string, @Query('locationId') locationId: string) {
    return this.market.whoToCall(businessId, locationId ?? '');
  }

  @Get('identifiers')
  @Biz()
  identifiers(@Param('businessId') businessId: string) {
    return this.market.identifiers(businessId);
  }
}
