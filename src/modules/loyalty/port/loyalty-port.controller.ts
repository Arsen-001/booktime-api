import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error.js';
import type { RequestContext } from '../../../common/http/context.js';
import { Authed, Biz, Ctx } from '../../../common/http/guards.js';
import { ZodBody } from '../../../common/http/openapi.js';
import { Zod } from '../../../common/http/validation.js';
import { RateLimit } from '../../../common/rate-limit/rate-limit.js';
import { PrismaService } from '../../../common/prisma.service.js';
import { requireAny } from '../loyalty.owner.js';
import { BIZ_OPS, ME_OPS, PUBLIC_OPS } from './ops.js';
import { LoyaltyPortRunner } from './runner.service.js';

const callBody = z.object({ args: z.array(z.unknown()).max(20).default([]) });
type CallBody = z.infer<typeof callBody>;

const OPS_DOC = `Функция фасада src/api/loyalty.ts фронта с теми же аргументами (первый — бизнес — берётся из пути). Список и права — port/ops.ts.`;

/**
 * Раздел «Лояльность» кабинета целиком (этап 21, лейн loyalty): расчётный слой фронта (Altegio-паритет, 3400+
 * строк: карты, акции с порогами и расписанием, кэшбэк, сертификаты, абонементы с заморозкой, счета клиентов,
 * оплата визита лояльностью, онлайн-продажи) исполняется на сервере над таблицами лояльности — см.
 * port/shim.ts, port/store.ts. Маршрут один на функцию фасада: `POST …/loyalty/x/{op}` с `{ args }`.
 * Маршруты этапа 11 (`…/loyalty/card-types` и т.д.) остаются — их зовут приложение клиента и заявки В-17,
 * данные общие (одни и те же строки таблиц).
 */
@ApiTags('loyalty')
@Controller('v1/biz/:businessId/loyalty/x')
export class LoyaltyPortController {
  constructor(private readonly runner: LoyaltyPortRunner) {}

  @Post(':op')
  @HttpCode(200)
  @Biz()
  @ApiOperation({ summary: 'Вызов функции раздела «Лояльность» (op — имя функции фасада)', description: OPS_DOC })
  @ZodBody(callBody)
  async call(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('op') op: string, @Body(new Zod(callBody)) body: CallBody) {
    const perms = BIZ_OPS[op];
    if (!perms) throw new ApiError('not_found', `Unknown loyalty op ${op}`);
    if (perms.length) requireAny(ctx, perms);
    const args = [businessId, ...body.args.slice(1)];
    const scope = await this.runner.scopeOf(businessId);
    return this.runner.run(op, args, { businessId, scope, actor: ctx.member!.staffId });
  }
}

@ApiTags('loyalty')
@Controller('v1/me/loyalty/x')
export class MeLoyaltyPortController {
  constructor(
    private readonly runner: LoyaltyPortRunner,
    private readonly prisma: PrismaService,
  ) {}

  @Post(':op')
  @HttpCode(200)
  @Authed()
  @ApiOperation({ summary: 'Лояльность клиента приложения: listMyLoyalty, getOnlineSalePayment (реквизиты оплаты заявки)', description: OPS_DOC })
  @ZodBody(callBody)
  async call(@Ctx() ctx: RequestContext, @Param('op') op: string, @Body(new Zod(callBody)) body: CallBody) {
    if (!ME_OPS.has(op)) throw new ApiError('not_found', `Unknown loyalty op ${op}`);
    const userId = ctx.session!.userId;
    if (op === 'listMyLoyalty') {
      const rows = await this.prisma.client.findMany({ where: { appUserId: userId, deletedAt: null }, select: { businessId: true } });
      const scope = [...new Set(rows.map((r) => r.businessId))];
      return this.runner.run(op, [userId], { scope, appUserId: userId, actor: userId });
    }
    const businessId = typeof body.args[0] === 'string' ? body.args[0] : '';
    if (!businessId) throw new ApiError('validation', 'businessId required');
    const scope = await this.runner.scopeOf(businessId);
    return this.runner.run(op, [businessId, ...body.args.slice(1)], { businessId, scope, actor: userId });
  }
}

@ApiTags('loyalty')
@Controller('v1/public/loyalty/:businessId/x')
export class PublicLoyaltyPortController {
  constructor(private readonly runner: LoyaltyPortRunner) {}

  @Post(':op')
  @HttpCode(200)
  @RateLimit({ bucket: 'public-loyalty', limit: 60, windowSec: 60, by: 'ip' })
  @ApiOperation({ summary: 'Страница записи без входа: getOnlineRequireMembership, hasOnlineMembership (F-06-128)', description: OPS_DOC })
  @ZodBody(callBody)
  async call(@Param('businessId') businessId: string, @Param('op') op: string, @Body(new Zod(callBody)) body: CallBody) {
    if (!PUBLIC_OPS.has(op)) throw new ApiError('not_found', `Unknown loyalty op ${op}`);
    const exists = await this.runner.scopeOf(businessId);
    return this.runner.run(op, [businessId, ...body.args.slice(1)], { businessId, scope: exists, actor: 'public' });
  }
}
