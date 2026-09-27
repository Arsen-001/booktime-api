import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { Platform } from '../../common/http/guards.js';
import { RateLimit } from '../../common/rate-limit/rate-limit.js';
import { Zod } from '../../common/http/validation.js';
import { AdsService } from './ads.service.js';
import { adContextQuery, adInputBody, adListQuery, adPauseBody, stockOfferQuery } from './platform.schemas.js';

/** Наша панель: реклама (F-00-163…166, docs/backend/02 §19). */
@ApiTags('platform-ads')
@Controller('v1/platform')
export class PlatformAdsController {
  constructor(private readonly ads: AdsService) {}

  @Get('ad-placements')
  @Platform()
  placements() {
    return this.ads.listPlacements();
  }

  @Get('ads')
  @Platform()
  list(@Query(new Zod(adListQuery)) q: z.infer<typeof adListQuery>) {
    return this.ads.list(q.kind);
  }

  @Post('ads')
  @Platform()
  create(@Body(new Zod(adInputBody)) body: z.infer<typeof adInputBody>) {
    return this.ads.create(body);
  }

  @Put('ads/:id/pause')
  @Platform()
  pause(@Param('id') id: string, @Body(new Zod(adPauseBody)) body: z.infer<typeof adPauseBody>) {
    return this.ads.setPaused(id, body.paused);
  }

  @Get('ads/reach')
  @Platform()
  reach() {
    return this.ads.reach();
  }
}

/** Показ рекламы клиенту/кабинету и учёт показов/нажатий — без входа, только чтение и счётчики (P10 07-mock-only). */
@ApiTags('ads')
@Controller('v1/public/ads')
export class PublicAdsController {
  constructor(private readonly ads: AdsService) {}

  @Get()
  @RateLimit({ bucket: 'public-ads', limit: 120, windowSec: 60, by: 'ip' })
  active(@Query(new Zod(adContextQuery)) q: z.infer<typeof adContextQuery>) {
    return this.ads.getActive(q.placement, { date: q.date, businessId: q.businessId, district: q.district, sphereId: q.sphere });
  }

  @Get('stock-offer')
  @RateLimit({ bucket: 'public-ads', limit: 120, windowSec: 60, by: 'ip' })
  stockOffer(@Query(new Zod(stockOfferQuery)) q: z.infer<typeof stockOfferQuery>) {
    return this.ads.getStockOffer(q.businessId, q.product).then((r) => r ?? null);
  }

  @Post(':id/impression')
  @HttpCode(204)
  @RateLimit({ bucket: 'public-ads-track', limit: 300, windowSec: 60, by: 'ip' })
  impression(@Param('id') id: string) {
    return this.ads.trackImpression(id);
  }

  @Post(':id/click')
  @HttpCode(204)
  @RateLimit({ bucket: 'public-ads-track', limit: 300, windowSec: 60, by: 'ip' })
  click(@Param('id') id: string) {
    return this.ads.trackClick(id);
  }
}
