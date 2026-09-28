import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { RequestContext } from '../../common/http/context.js';
import { Authed, Biz, Ctx } from '../../common/http/guards.js';
import { ZodBody } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { RateLimit } from '../../common/rate-limit/rate-limit.js';
import { ClientLoyaltyService } from './client-loyalty.service.js';

const callBody = z.object({ args: z.array(z.unknown()).max(10).default([]) });
type CallBody = z.infer<typeof callBody>;

const DOC = 'Функция src/api/client.ts фронта (абонементы/сертификаты/кэшбэк приложения, заявки В-17) с её аргументами без appUserId/businessId — они из сессии/пути. Список — client-loyalty.service.ts.';

/**
 * Этап 21, лейн client-loyalty: абонементы, сертификаты и кэшбэк приложения клиента поверх фасада лояльности
 * (port/client-ops.ts). Три двери по тому, кто спрашивает: клиент (/v1/me — только своё), страница места без
 * входа (/v1/public — что продаётся), кабинет (/v1/biz — заявки, визит-приложение, настройка кэшбэка).
 */
@ApiTags('loyalty')
@Controller('v1/me/loyalty/app')
export class MeClientLoyaltyController {
  constructor(private readonly svc: ClientLoyaltyService) {}

  @Post(':op')
  @HttpCode(200)
  @Authed()
  @RateLimit({ bucket: 'me-loyalty-app', limit: 240, windowSec: 60, by: 'session' })
  @ApiOperation({ summary: 'Абонементы/сертификаты/кэшбэк клиента приложения (op — функция client.ts)', description: DOC })
  @ZodBody(callBody)
  call(@Ctx() ctx: RequestContext, @Param('op') op: string, @Body(new Zod(callBody)) body: CallBody) {
    return this.svc.me(ctx.session!.userId, op, body.args);
  }
}

@ApiTags('loyalty')
@Controller('v1/public/loyalty/:businessId/app')
export class PublicClientLoyaltyController {
  constructor(private readonly svc: ClientLoyaltyService) {}

  @Post(':op')
  @HttpCode(200)
  @RateLimit({ bucket: 'public-loyalty', limit: 60, windowSec: 60, by: 'ip' })
  @ApiOperation({ summary: 'Страница места: абонементы/сертификаты на продажу (F-14-044/045)', description: DOC })
  @ZodBody(callBody)
  call(@Param('businessId') businessId: string, @Param('op') op: string, @Body(new Zod(callBody)) body: CallBody) {
    return this.svc.pub(businessId, op, body.args);
  }
}

@ApiTags('loyalty')
@Controller('v1/biz/:businessId/loyalty/app')
export class BizClientLoyaltyController {
  constructor(private readonly svc: ClientLoyaltyService) {}

  @Post(':op')
  @HttpCode(200)
  @Biz()
  @ApiOperation({ summary: 'Кабинет: заявки приложения (В-17), лояльность визита (F-14-098/102), показ кэшбэка (F-14-053)', description: DOC })
  @ZodBody(callBody)
  call(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('op') op: string, @Body(new Zod(callBody)) body: CallBody) {
    return this.svc.biz(ctx, businessId, op, body.args);
  }
}
