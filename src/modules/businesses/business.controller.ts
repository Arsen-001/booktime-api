import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext, RequestWithContext } from '../../common/http/context.js';
import { Authed, Biz, Ctx } from '../../common/http/guards.js';
import { ZodBody, ZodOk } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { ifMatch } from '../../common/http/version.js';
import { Idempotent } from '../../common/idempotency/idempotency.js';
import { PrismaService } from '../../common/prisma.service.js';
import { RateLimit } from '../../common/rate-limit/rate-limit.js';
import {
  businessOut,
  coreOut,
  hereBody,
  locationBody,
  locationOut,
  patchBusinessBody,
  patchLocationBody,
  registerBusinessBody,
  registerOut,
  securityBody,
  securityOut,
  settingBody,
  settingOut,
} from './business.schemas.js';
import { BusinessService } from './business.service.js';

const AREA_RE = /^[a-z][a-zA-Z0-9_.-]{1,39}$/;

/** Бизнес, филиалы, настройки разделов — /v1/biz (docs/backend/02 §18, §7) */
@ApiTags('business')
@Controller('v1/biz')
export class BusinessController {
  constructor(
    private readonly biz: BusinessService,
    private readonly prisma: PrismaService,
  ) {}

  @Post()
  @Authed()
  @Idempotent()
  @RateLimit({ bucket: 'biz-register', limit: 10, windowSec: 86_400, by: 'session' })
  @ApiOperation({ summary: 'Регистрация бизнеса (F-00-035): бизнес + филиал + владелец; сессия переходит в «Мой бизнес»' })
  @ZodBody(registerBusinessBody)
  @ZodOk(registerOut)
  register(@Ctx() ctx: RequestContext, @Body(new Zod(registerBusinessBody)) body: z.infer<typeof registerBusinessBody>) {
    return this.biz.register(ctx, body);
  }

  @Get(':businessId')
  @Biz()
  @ApiOperation({ summary: 'Бизнес (вид «свой бизнес»)' })
  @ZodOk(businessOut)
  get(@Param('businessId') businessId: string) {
    return this.biz.get(businessId);
  }

  @Get(':businessId/core')
  @Biz()
  @ApiOperation({ summary: 'Бизнес(ы), филиалы, сотрудники, сеть одним ответом (владельцу сети — все филиалы)' })
  @ZodOk(coreOut)
  async core(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string) {
    const m = ctx.member!;
    let ids = [businessId];
    if (m.role === 'network' && m.networkId) {
      ids = (await this.prisma.business.findMany({ where: { networkId: m.networkId, leftAt: null }, select: { id: true } })).map((b) => b.id);
    }
    return this.biz.core(businessId, ids);
  }

  @Patch(':businessId')
  @Biz('settings.manage')
  @ApiOperation({ summary: 'Название, описание, логотип, контакты, соцсети (F-15-097…120). If-Match: version' })
  @ZodBody(patchBusinessBody)
  @ZodOk(businessOut)
  patch(
    @Ctx() ctx: RequestContext,
    @Req() req: RequestWithContext,
    @Param('businessId') businessId: string,
    @Body(new Zod(patchBusinessBody)) body: z.infer<typeof patchBusinessBody>,
  ) {
    return this.biz.patch(ctx, businessId, body, ifMatch(req));
  }

  // ─────────── филиалы ───────────

  @Get(':businessId/locations')
  @Biz()
  @ApiOperation({ summary: 'Филиалы (места) бизнеса' })
  @ZodOk(z.array(locationOut))
  locations(@Param('businessId') businessId: string) {
    return this.biz.locations(businessId);
  }

  @Post(':businessId/locations')
  @Biz('settings.manage')
  @ApiOperation({ summary: 'Добавить место/филиал (F-15-104)' })
  @ZodBody(locationBody)
  @ZodOk(locationOut)
  addLocation(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(locationBody)) body: z.infer<typeof locationBody>) {
    return this.biz.addLocation(ctx, businessId, body);
  }

  @Patch(':businessId/locations/:locationId')
  @Biz('settings.manage')
  @ApiOperation({ summary: 'Адрес, телефоны, часы, пояс филиала. If-Match: version' })
  @ZodBody(patchLocationBody)
  @ZodOk(locationOut)
  patchLocation(
    @Ctx() ctx: RequestContext,
    @Req() req: RequestWithContext,
    @Param('businessId') businessId: string,
    @Param('locationId') locationId: string,
    @Body(new Zod(patchLocationBody)) body: z.infer<typeof patchLocationBody>,
  ) {
    return this.biz.patchLocation(ctx, businessId, locationId, body, ifMatch(req));
  }

  @Post(':businessId/locations/:locationId/here')
  @HttpCode(200)
  @Biz()
  @ApiOperation({ summary: '«Я сейчас на месте работы» — точка филиала (F-00-075)' })
  @ZodBody(hereBody)
  @ZodOk(locationOut)
  here(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('locationId') locationId: string, @Body(new Zod(hereBody)) body: z.infer<typeof hereBody>) {
    return this.biz.markHere(ctx, businessId, locationId, body);
  }

  // ─────────── безопасность бизнеса (F-00-047) и настройки разделов ───────────

  @Get(':businessId/security')
  @Biz()
  @ZodOk(securityOut)
  async security(@Param('businessId') businessId: string) {
    const b = await this.biz.get(businessId);
    return { blockHomeVisitDuringShift: b.forbidHomeBookingsDuringShift };
  }

  @Put(':businessId/security')
  @Biz('settings.manage')
  @ApiOperation({ summary: 'Запрет домашних записей в часы смены (F-00-047)' })
  @ZodBody(securityBody)
  @ZodOk(securityOut)
  async setSecurity(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(securityBody)) body: z.infer<typeof securityBody>) {
    const b = await this.biz.patch(ctx, businessId, { forbidHomeBookingsDuringShift: body.blockHomeVisitDuringShift }, undefined);
    return { blockHomeVisitDuringShift: b.forbidHomeBookingsDuringShift };
  }

  @Get(':businessId/settings/:area')
  @Biz()
  @ApiOperation({ summary: 'Настройки раздела (JSON на раздел, F4)' })
  @ZodOk(settingOut)
  getSetting(@Param('businessId') businessId: string, @Param('area') area: string) {
    if (!AREA_RE.test(area)) throw new ApiError('validation', 'Bad area');
    return this.biz.getSetting(businessId, area);
  }

  @Put(':businessId/settings/:area')
  @Biz('settings.manage')
  @ApiOperation({ summary: 'Сохранить настройки раздела целиком. If-Match: version (0 — ещё не сохраняли)' })
  @ZodBody(settingBody)
  @ZodOk(settingOut)
  putSetting(
    @Ctx() ctx: RequestContext,
    @Req() req: RequestWithContext,
    @Param('businessId') businessId: string,
    @Param('area') area: string,
    @Body(new Zod(settingBody)) body: z.infer<typeof settingBody>,
  ) {
    if (!AREA_RE.test(area)) throw new ApiError('validation', 'Bad area');
    const raw = req.header('if-match');
    return this.biz.putSetting(ctx, businessId, area, body.data, raw === '0' ? 0 : ifMatch(req));
  }
}
