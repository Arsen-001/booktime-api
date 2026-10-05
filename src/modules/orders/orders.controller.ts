import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { RequestContext } from '../../common/http/context.js';
import { Biz, Ctx } from '../../common/http/guards.js';
import { ZodBody, ZodOk } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { RateLimit } from '../../common/rate-limit/rate-limit.js';
import { OrderIntakeService } from './order-intake.service.js';
import {
  createOrderBody,
  intakeBookingOut,
  intakeBookingsQuery,
  intakeSettingsBody,
  intakeSettingsOut,
  listOrdersQuery,
  orderListOut,
  orderOut,
  orderStatusBody,
  patchOrderBody,
  publicEstimateDecisionBody,
  publicOrderOut,
  sendEstimateBody,
  staffEstimateDecisionBody,
} from './orders.schemas.js';
import { OrdersService } from './orders.service.js';

/**
 * Заказы (03.10.2026): кабинет бизнеса. Путь по договорённости с фронтом — /v1/businesses/:businessId/orders;
 * тот же контроллер отвечает и по привычному префиксу кабинета /v1/biz/:businessId/orders.
 * Права — как у журнала: смотреть — journal.view, принимать/править/двигать статус — journal.edit (мастер приёмки
 * тоже работает с заказами). Телефон клиента без права clients.phones — маской.
 */
@ApiTags('orders')
@Controller(['v1/businesses/:businessId/orders', 'v1/biz/:businessId/orders'])
export class OrdersController {
  constructor(
    private readonly svc: OrdersService,
    private readonly intake: OrderIntakeService,
  ) {}

  @Get()
  @Biz('journal.view')
  @ZodOk(orderListOut)
  @ApiOperation({ summary: 'Заказы бизнеса: status=<s|active|all>, q — номер/имя/телефон/вещь, новые сверху' })
  list(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Query(new Zod(listOrdersQuery)) q: z.infer<typeof listOrdersQuery>) {
    return this.svc.list(ctx, businessId, q);
  }

  @Post()
  @Biz('journal.edit')
  @ZodBody(createOrderBody)
  @ZodOk(orderOut)
  @ApiOperation({ summary: 'Принять заказ (статус received, номер с 1001); bookingId — по записи на сдачу (один заказ на запись, 409 intake_already_accepted)' })
  async create(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(createOrderBody)) body: z.infer<typeof createOrderBody>) {
    const order = await this.svc.create(ctx, businessId, body);
    // ⭐ По записи на сдачу: клиент пришёл — запись «Пришёл» (best-effort, заказ уже принят)
    if (body.bookingId) await this.intake.markArrived(ctx, businessId, body.bookingId);
    return order;
  }

  // ─────────── ⭐ запись на сдачу по времени (05.10.2026) — до ':orderId', иначе 'intake' примется за id заказа ───────────

  @Get('intake')
  @Biz('journal.view')
  @ZodOk(intakeSettingsOut)
  @ApiOperation({ summary: '«Запись на сдачу»: вкл/выкл, длина окна приёма, кто принимает (скрытая услуга kind=intake)' })
  intakeSettings(@Param('businessId') businessId: string) {
    return this.intake.settings(businessId);
  }

  @Put('intake')
  @Biz('settings.manage')
  @ZodBody(intakeSettingsBody)
  @ZodOk(intakeSettingsOut)
  @ApiOperation({ summary: 'Сохранить «Запись на сдачу»: создаёт/правит услугу «Приём заказа»; некому принимать — 422 intake_no_staff' })
  setIntakeSettings(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(intakeSettingsBody)) body: z.infer<typeof intakeSettingsBody>) {
    return this.intake.setSettings(ctx, businessId, body);
  }

  @Get('intake/bookings')
  @Biz('journal.view')
  @ZodOk(z.array(intakeBookingOut))
  @ApiOperation({ summary: 'Записи на сдачу за день (date=YYYY-MM-DD): кто придёт, что сдаёт, принят ли уже заказ' })
  intakeBookings(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Query(new Zod(intakeBookingsQuery)) q: z.infer<typeof intakeBookingsQuery>) {
    return this.intake.bookingsOn(ctx, businessId, q.date);
  }

  @Get(':orderId')
  @Biz('journal.view')
  @ZodOk(orderOut)
  get(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('orderId') orderId: string) {
    return this.svc.get(ctx, businessId, orderId);
  }

  @Patch(':orderId')
  @Biz('journal.edit')
  @ZodBody(patchOrderBody)
  @ZodOk(orderOut)
  patch(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('orderId') orderId: string, @Body(new Zod(patchOrderBody)) body: z.infer<typeof patchOrderBody>) {
    return this.svc.patch(ctx, businessId, orderId, body);
  }

  @Post(':orderId/status')
  @Biz('journal.edit')
  @ZodBody(orderStatusBody)
  @ZodOk(orderOut)
  @ApiOperation({ summary: 'Сменить статус; недопустимый переход — 422 invalid_order_transition; ready — уведомление клиенту' })
  status(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('orderId') orderId: string, @Body(new Zod(orderStatusBody)) body: z.infer<typeof orderStatusBody>) {
    return this.svc.setStatus(ctx, businessId, orderId, body.status);
  }

  @Post(':orderId/notify')
  @Biz('journal.edit')
  @ZodOk(orderOut)
  @ApiOperation({ summary: 'Ещё раз сообщить клиенту, что заказ готов (только status=ready, иначе 422 order_not_ready)' })
  notify(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('orderId') orderId: string) {
    return this.svc.resendReady(ctx, businessId, orderId);
  }

  // ─────────── ⭐ смета (05.10.2026) ───────────

  @Post(':orderId/estimate')
  @Biz('journal.edit')
  @ZodBody(sendEstimateBody)
  @ZodOk(orderOut)
  @ApiOperation({ summary: 'Отправить клиенту смету (строки или одна сумма + комментарий) — новая версия, ждём ответа; только received/in_progress' })
  sendEstimate(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('orderId') orderId: string, @Body(new Zod(sendEstimateBody)) body: z.infer<typeof sendEstimateBody>) {
    return this.svc.sendEstimate(ctx, businessId, orderId, body);
  }

  @Post(':orderId/estimate/notify')
  @Biz('journal.edit')
  @ZodOk(orderOut)
  @ApiOperation({ summary: 'Ещё раз отправить клиенту смету, которая ждёт ответа (иначе 409 estimate_not_pending)' })
  resendEstimate(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('orderId') orderId: string) {
    return this.svc.resendEstimate(ctx, businessId, orderId);
  }

  @Post(':orderId/estimate/decision')
  @Biz('journal.edit')
  @ZodBody(staffEstimateDecisionBody)
  @ZodOk(orderOut)
  @ApiOperation({ summary: 'Отметить ответ клиента по смете, полученный по телефону: approve — в работу, цена = смета' })
  decideEstimate(
    @Ctx() ctx: RequestContext,
    @Param('businessId') businessId: string,
    @Param('orderId') orderId: string,
    @Body(new Zod(staffEstimateDecisionBody)) body: z.infer<typeof staffEstimateDecisionBody>,
  ) {
    return this.svc.decideEstimateByStaff(ctx, businessId, orderId, body.decision, body.comment);
  }
}

/** Публичная страница заказа /o/<code> — без входа */
@ApiTags('orders')
@Controller('v1/public/orders')
export class PublicOrdersController {
  constructor(private readonly svc: OrdersService) {}

  @Get(':code')
  @RateLimit({ bucket: 'public-order', limit: 60, windowSec: 60, by: 'ip' })
  @ZodOk(publicOrderOut)
  @ApiOperation({ summary: 'Статус заказа по публичному коду (без телефона клиента, комментария и сотрудников)' })
  byCode(@Param('code') code: string) {
    return this.svc.publicByCode(code);
  }

  @Post(':code/estimate')
  @HttpCode(200)
  @RateLimit({ bucket: 'public-order-estimate', limit: 10, windowSec: 60, by: 'ip' })
  @ZodBody(publicEstimateDecisionBody)
  @ZodOk(publicOrderOut)
  @ApiOperation({ summary: '⭐ Клиент отвечает на смету по ссылке: approve | decline (+ комментарий); повтор того же — без изменений; устаревшая версия — 409 estimate_changed' })
  decideEstimate(@Param('code') code: string, @Body(new Zod(publicEstimateDecisionBody)) body: z.infer<typeof publicEstimateDecisionBody>) {
    return this.svc.decideEstimatePublic(code, body.decision, body.version, body.comment);
  }
}
