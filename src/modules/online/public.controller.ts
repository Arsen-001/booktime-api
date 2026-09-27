import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { RequestContext } from '../../common/http/context.js';
import { Ctx } from '../../common/http/guards.js';
import { ZodBody, ZodOk } from '../../common/http/openapi.js';
import { RateLimit } from '../../common/rate-limit/rate-limit.js';
import { Zod } from '../../common/http/validation.js';
import {
  addReviewBody,
  cancelWindowOut,
  codeSentOut,
  createOnlineBookingBody,
  freeSlotOut,
  groupBookingRulesOut,
  joinWaitlistBody,
  monthAvailabilityOut,
  onlineBookingResultOut,
  onlineBookingViewOut,
  publicBusinessOut,
  reviewOut,
  sendBookingCodeBody,
  trackWidgetEventBody,
  waitlistRequestOut,
} from './online.schemas.js';
import { OnlineService } from './online.service.js';

const num = z.coerce.number().int().positive();
const optNum = z.coerce.number().int().positive().optional();

/**
 * Публичные маршруты страницы записи по ссылке (docs/backend/02 §3, PLAN §6 №8): без входа — страница бизнеса,
 * окна виджета, создание записи (с кодом, B2), «моя запись» по хэшу (B8, B19, не переносится — только просмотр
 * и отмена, решение владельца по 08-open-questions.md).
 */
@ApiTags('online')
@Controller('v1/public')
export class PublicOnlineController {
  constructor(private readonly svc: OnlineService) {}

  @Get('b/:slug')
  @RateLimit({ bucket: 'public-business', limit: 120, windowSec: 60, by: 'ip' })
  @ApiOperation({ summary: 'Публичная страница бизнеса /b/<slug> (F-03-134)' })
  @ZodOk(publicBusinessOut)
  business(@Param('slug') slug: string, @Query('formId') formId?: string) {
    return this.svc.publicBusinessData(slug, formId);
  }

  @Get('b/:slug/f/:formId')
  @RateLimit({ bucket: 'public-business', limit: 120, windowSec: 60, by: 'ip' })
  @ApiOperation({ summary: 'Страница формы /b/<slug>/f/<formId> (F-03-009)' })
  @ZodOk(publicBusinessOut)
  businessForm(@Param('slug') slug: string, @Param('formId') formId: string) {
    return this.svc.publicBusinessData(slug, formId);
  }

  @Get('b/:slug/slots')
  @RateLimit({ bucket: 'public-slots', limit: 300, windowSec: 60, by: 'ip' })
  @ApiOperation({ summary: 'Свободные окна виджета (F-03-065) — вход как у `getWidgetFreeSlots` фронта' })
  @ZodOk(z.array(freeSlotOut))
  slots(
    @Param('slug') slug: string,
    @Query('staffId') staffId: string,
    @Query('date') date: string,
    @Query('durationMin', new Zod(num)) durationMin: number,
    @Query('durationMax', new Zod(optNum)) durationMax: number | undefined,
    @Query('serviceId') serviceId: string | undefined,
    @Query('locationId') locationId: string | undefined,
    @Query('workplace') workplace: string | undefined,
  ) {
    return this.svc.widgetSlots(slug, { staffId, date, durationMin, durationMax, serviceId, locationId, workplace });
  }

  @Get('b/:slug/nearest-date')
  @RateLimit({ bucket: 'public-slots', limit: 300, windowSec: 60, by: 'ip' })
  @ApiOperation({ summary: 'Ближайший день с окнами (F-03-085)' })
  @ZodOk(z.object({ date: z.string().optional() }))
  async nearestDate(
    @Param('slug') slug: string,
    @Query('staffId') staffId: string,
    @Query('from') from: string,
    @Query('durationMin', new Zod(num)) durationMin: number,
    @Query('durationMax', new Zod(optNum)) durationMax: number | undefined,
    @Query('serviceId') serviceId: string | undefined,
    @Query('locationId') locationId: string | undefined,
    @Query('workplace') workplace: string | undefined,
  ) {
    return { date: await this.svc.nearestDate(slug, { staffId, from, durationMin, durationMax, serviceId, locationId, workplace }) };
  }

  @Get('b/:slug/month')
  @RateLimit({ bucket: 'public-slots', limit: 300, windowSec: 60, by: 'ip' })
  @ApiOperation({ summary: 'Дни месяца с окнами (F-03-084)' })
  @ZodOk(monthAvailabilityOut)
  month(
    @Param('slug') slug: string,
    @Query('staffId') staffId: string,
    @Query('month') month: string,
    @Query('durationMin', new Zod(num)) durationMin: number,
    @Query('durationMax', new Zod(optNum)) durationMax: number | undefined,
    @Query('serviceId') serviceId: string | undefined,
    @Query('locationId') locationId: string | undefined,
    @Query('workplace') workplace: string | undefined,
  ) {
    return this.svc.monthAvailability(slug, { staffId, month, durationMin, durationMax, serviceId, locationId, workplace });
  }

  @Post('b/:slug/code')
  @HttpCode(200)
  @RateLimit({ bucket: 'public-booking-code', limit: 5, windowSec: 3600, by: 'ip' })
  @ApiOperation({ summary: 'Код перед записью без входа (F-00-007, B2) — тот же канал, что вход' })
  @ZodBody(sendBookingCodeBody)
  @ZodOk(codeSentOut)
  sendCode(@Ctx() ctx: RequestContext, @Body(new Zod(sendBookingCodeBody)) body: z.infer<typeof sendBookingCodeBody>) {
    return this.svc.sendCode(ctx, body);
  }

  @Post('b/:slug/bookings')
  @RateLimit({ bucket: 'public-booking-create', limit: 20, windowSec: 3600, by: 'ip' })
  @ApiOperation({ summary: '«Записаться» из виджета/ссылки (F-03-093, F-03-125)' })
  @ZodBody(createOnlineBookingBody)
  @ZodOk(onlineBookingResultOut)
  create(@Param('slug') slug: string, @Body(new Zod(createOnlineBookingBody)) body: z.infer<typeof createOnlineBookingBody>) {
    return this.svc.createBooking(slug, body);
  }

  @Get('bookings/:id')
  @RateLimit({ bucket: 'public-booking-hash', limit: 60, windowSec: 60, by: 'ip' })
  @ApiOperation({ summary: 'Запись по ссылке без входа (F-03-098) — только по правильному хэшу' })
  @ZodOk(onlineBookingViewOut)
  view(@Param('id') id: string, @Query('h') hash: string) {
    return this.svc.viewByHash(id, hash);
  }

  @Get('bookings/:id/cancel-window')
  @RateLimit({ bucket: 'public-booking-hash', limit: 60, windowSec: 60, by: 'ip' })
  @ApiOperation({ summary: 'Можно ли сейчас бесплатно отменить/перенести (F-03-066/067)' })
  @ZodOk(cancelWindowOut)
  cancelWindow(@Param('id') id: string, @Query('h') hash: string) {
    return this.svc.cancelWindow(id, hash);
  }

  @Post('bookings/:id/cancel')
  @RateLimit({ bucket: 'public-booking-hash', limit: 20, windowSec: 3600, by: 'ip' })
  @ApiOperation({ summary: 'Отмена своей записи по ссылке без входа (F-03-100). Перенос по ссылке не строим — B8' })
  cancel(@Param('id') id: string, @Query('h') hash: string) {
    return this.svc.cancelByHash(id, hash);
  }

  // ═══════════════ стадия 21 (лейн client+online), попытка 2 ═══════════════

  @Post('bookings/:id/prepayment-paid')
  @HttpCode(200)
  @RateLimit({ bucket: 'public-booking-hash', limit: 20, windowSec: 3600, by: 'ip' })
  @ApiOperation({ summary: '«Я оплатил» по ссылке без входа (B8, В-05)' })
  markPrepaymentPaid(@Param('id') id: string, @Query('h') hash: string) {
    return this.svc.markPrepaymentPaid(id, hash);
  }

  @Post('bookings/:id/reviews')
  @HttpCode(200)
  @RateLimit({ bucket: 'public-booking-hash', limit: 20, windowSec: 3600, by: 'ip' })
  @ApiOperation({ summary: 'Звёздочка после визита (F-00-116) — без входа, как у мока' })
  @ZodBody(addReviewBody)
  @ZodOk(reviewOut)
  addReview(@Param('id') id: string, @Body(new Zod(addReviewBody)) body: z.infer<typeof addReviewBody>) {
    return this.svc.addReviewByBooking(id, body);
  }

  @Get('bookings/:id/reviews/:target')
  @RateLimit({ bucket: 'public-booking-hash', limit: 60, windowSec: 60, by: 'ip' })
  @ApiOperation({ summary: 'Уже ли поставлена звёздочка за эту запись' })
  @ZodOk(z.object({ reviewed: z.boolean() }))
  async hasReviewed(@Param('id') id: string, @Param('target') target: string) {
    return { reviewed: await this.svc.hasReviewed(id, target) };
  }

  @Post('track')
  @HttpCode(200)
  @RateLimit({ bucket: 'public-slots', limit: 300, windowSec: 60, by: 'ip' })
  @ApiOperation({ summary: 'Событие пути записи для аналитики (F-03-117…122)' })
  @ZodBody(trackWidgetEventBody)
  async track(@Body(new Zod(trackWidgetEventBody)) body: z.infer<typeof trackWidgetEventBody>) {
    await this.svc.trackWidgetEvent(body.businessId, body.linkId, body.type);
    return { ok: true };
  }

  @Get('links/:linkId/group-rules')
  @RateLimit({ bucket: 'public-slots', limit: 300, windowSec: 60, by: 'ip' })
  @ApiOperation({ summary: 'Правила групповой записи ссылки (F-03-076/102) — числа не секретные, читаем без входа' })
  @ZodOk(groupBookingRulesOut)
  groupRules(@Param('linkId') linkId: string) {
    return this.svc.groupBookingRules(linkId);
  }

  @Post('businesses/:businessId/waitlist')
  @RateLimit({ bucket: 'public-booking-create', limit: 20, windowSec: 3600, by: 'ip' })
  @ApiOperation({ summary: 'Клиент сам встаёт в лист ожидания из виджета (F-03-086, ⭐ F-00-101/102)' })
  @ZodBody(joinWaitlistBody)
  @ZodOk(waitlistRequestOut)
  joinWaitlist(@Param('businessId') businessId: string, @Body(new Zod(joinWaitlistBody)) body: z.infer<typeof joinWaitlistBody>) {
    return this.svc.joinOnlineWaitlist({ businessId, ...body });
  }
}
