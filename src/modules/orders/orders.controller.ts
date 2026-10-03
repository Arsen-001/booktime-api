import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { RequestContext } from '../../common/http/context.js';
import { Biz, Ctx } from '../../common/http/guards.js';
import { ZodBody, ZodOk } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { RateLimit } from '../../common/rate-limit/rate-limit.js';
import { createOrderBody, listOrdersQuery, orderListOut, orderOut, orderStatusBody, patchOrderBody, publicOrderOut } from './orders.schemas.js';
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
  constructor(private readonly svc: OrdersService) {}

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
  @ApiOperation({ summary: 'Принять заказ (статус received, номер с 1001)' })
  create(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(createOrderBody)) body: z.infer<typeof createOrderBody>) {
    return this.svc.create(ctx, businessId, body);
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
}
