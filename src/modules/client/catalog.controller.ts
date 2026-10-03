import { Body, Controller, Get, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { RequestContext } from '../../common/http/context.js';
import { Ctx } from '../../common/http/guards.js';
import { ZodBody } from '../../common/http/openapi.js';
import { RateLimit } from '../../common/rate-limit/rate-limit.js';
import { Zod } from '../../common/http/validation.js';
import { CatalogService } from './catalog.service.js';
import { SITEMAP_TTL_SEC, SitemapService } from './sitemap.service.js';
import { callbackBody, demandBody } from './client.schemas.js';

const num = z.coerce.number().optional();
const intOpt = z.coerce.number().int().positive().optional();

/**
 * Раздел «client», без входа (docs/backend/02 §2.1, PLAN §6 №9): каталог «кто когда свободен», карточка
 * мастера/места, дни/окна для потока записи, оттенок, срок отмены, «не нашли», «попросить перезвонить».
 */
@ApiTags('client')
@Controller('v1/public')
export class PublicCatalogController {
  constructor(
    private readonly svc: CatalogService,
    private readonly sitemaps: SitemapService,
  ) {}

  @Get('sitemap')
  @RateLimit({ bucket: 'public-sitemap', limit: 30, windowSec: 60, by: 'ip' })
  @ApiOperation({ summary: 'Лёгкий список для sitemap.xml: бизнесы (slug, сферы, районы, фото, дата) и мастера салонов — без окон, кэш 10 мин' })
  async sitemap(@Res({ passthrough: true }) res: Response) {
    const out = await this.sitemaps.sitemap();
    // Только удачный ответ: ошибку (база недоступна) кэшировать CDN и Next не должны
    res.setHeader('Cache-Control', `public, max-age=${SITEMAP_TTL_SEC}, s-maxage=${SITEMAP_TTL_SEC}, stale-while-revalidate=3600`);
    return out;
  }

  @Get('catalog')
  @RateLimit({ bucket: 'public-catalog', limit: 120, windowSec: 60, by: 'ip' })
  @ApiOperation({ summary: 'Каталог мастеров с ближайшими окнами (F-00-108…112)' })
  catalog(
    @Query('search') search: string | undefined,
    @Query('sphere') sphereId: string | undefined,
    @Query('district') district: string | undefined,
    @Query('workplace') workplace: string | undefined,
    @Query('accepts') accepts: string | undefined,
    @Query('material') material: string | undefined,
    @Query('freeToday') freeTodayRaw: string | undefined,
    @Query('freeTomorrow') freeTomorrowRaw: string | undefined,
    @Query('lat', new Zod(num)) lat: number | undefined,
    @Query('lng', new Zod(num)) lng: number | undefined,
    @Query('businessId') businessId: string | undefined,
    @Query('limit', new Zod(intOpt)) limit: number | undefined,
  ) {
    // 'false'/'0' → выкл: z.coerce.boolean() трактует ЛЮБУЮ непустую строку как true (Boolean('false') === true) —
    // та же ловушка, что уже обходят includeDeleted/freedOnly журнала своим === 'true' || === '1'.
    const truthy = (v: string | undefined) => v === 'true' || v === '1';
    const freeToday = freeTodayRaw === undefined ? undefined : truthy(freeTodayRaw);
    const freeTomorrow = freeTomorrowRaw === undefined ? undefined : truthy(freeTomorrowRaw);
    return this.svc.catalog({ search, sphereId, district, workplace, accepts, material, freeToday, freeTomorrow, lat, lng, businessId, limit });
  }

  @Get('masters/:staffId')
  @RateLimit({ bucket: 'public-master-card', limit: 300, windowSec: 60, by: 'ip' })
  @ApiOperation({ summary: 'Карточка мастера (F-00-123)' })
  masterCard(@Ctx() ctx: RequestContext, @Param('staffId') staffId: string, @Query('service') service?: string) {
    return this.svc.masterCard(staffId, ctx.session && !ctx.session.platform ? ctx.session.userId : undefined, typeof service === 'string' && service ? service : undefined);
  }

  @Get('places/:businessId')
  @RateLimit({ bucket: 'public-master-card', limit: 300, windowSec: 60, by: 'ip' })
  @ApiOperation({ summary: 'Карточка места/компании (F-14-028)' })
  placeCard(@Param('businessId') businessId: string) {
    return this.svc.placeCard(businessId);
  }

  @Get('places/:businessId/first-badge')
  @RateLimit({ bucket: 'public-master-card', limit: 300, windowSec: 60, by: 'ip' })
  @ApiOperation({ summary: 'Значок «Первый в районе / в сфере» на карточке мастера (награда панели, F-00-152)' })
  async firstBadge(@Param('businessId') businessId: string) {
    return { badge: await this.svc.firstBadge(businessId) };
  }

  @Get('places/:businessId/reviews')
  @RateLimit({ bucket: 'public-master-card', limit: 300, windowSec: 60, by: 'ip' })
  @ApiOperation({ summary: 'Отзывы о месте (F-14-028), этап 21 лейн client — без модерации' })
  placeReviews(@Param('businessId') businessId: string) {
    return this.svc.listReviews(businessId);
  }

  @Get('masters/:staffId/days')
  @RateLimit({ bucket: 'public-slots', limit: 300, windowSec: 60, by: 'ip' })
  @ApiOperation({ summary: 'Окна мастера на N дней по услуге (F-00-092)' })
  days(@Param('staffId') staffId: string, @Query('serviceId') serviceId: string, @Query('workplace') workplace: string | undefined, @Query('days', new Zod(intOpt)) days: number | undefined) {
    return this.svc.bookingDays(staffId, serviceId, workplace, days);
  }

  @Get('masters/:staffId/slots')
  @RateLimit({ bucket: 'public-slots', limit: 300, windowSec: 60, by: 'ip' })
  @ApiOperation({ summary: 'Окна мастера на дату (клиентский режим, 04 §5)' })
  slots(@Param('staffId') staffId: string, @Query('date') date: string, @Query('serviceId') serviceId: string | undefined, @Query('workplace') workplace: string | undefined) {
    return this.svc.slotsFor(staffId, date, serviceId, workplace);
  }

  @Get('services/:serviceId/shades')
  @RateLimit({ bucket: 'public-slots', limit: 300, windowSec: 60, by: 'ip' })
  @ApiOperation({ summary: 'Варианты оттенка при записи (F-00-094…096) — со склада, пока честно пусто без него' })
  shades(@Param('serviceId') serviceId: string) {
    return this.svc.shadeOptions(serviceId);
  }

  @Get('masters/:staffId/cancel-window')
  @RateLimit({ bucket: 'public-slots', limit: 300, windowSec: 60, by: 'ip' })
  @ApiOperation({ summary: 'Часы бесплатной отмены у мастера (F-00-098)' })
  async cancelWindow(@Param('staffId') staffId: string) {
    return { cancelWindowHours: await this.svc.cancelWindowHours(staffId) };
  }

  @Post('demand')
  @HttpCode(204)
  @RateLimit({ bucket: 'public-demand', limit: 20, windowSec: 3600, by: 'ip' })
  @ApiOperation({ summary: '«Не нашли? Сообщить, когда появится» (F-00-112, F-00-180)' })
  @ZodBody(demandBody)
  async demand(@Ctx() ctx: RequestContext, @Body(new Zod(demandBody)) body: z.infer<typeof demandBody>) {
    await this.svc.submitDemand({ ...body, appUserId: ctx.session && !ctx.session.platform ? ctx.session.userId : undefined });
  }

  @Post('callback')
  @HttpCode(204)
  @RateLimit({ bucket: 'public-callback', limit: 20, windowSec: 3600, by: 'ip' })
  @ApiOperation({ summary: '«Попросить перезвонить» (F-00-106)' })
  @ZodBody(callbackBody)
  async callback(@Body(new Zod(callbackBody)) body: z.infer<typeof callbackBody>) {
    await this.svc.requestCallback(body);
  }
}
