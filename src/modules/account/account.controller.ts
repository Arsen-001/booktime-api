import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { RequestContext, RequestWithContext } from '../../common/http/context.js';
import { Authed, Ctx } from '../../common/http/guards.js';
import { ZodBody, ZodOk } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { ifMatch } from '../../common/http/version.js';
import { RateLimit } from '../../common/rate-limit/rate-limit.js';
import { codeSent } from '../auth/auth.schemas.js';
import {
  accountView,
  clientProfileView,
  dataExportRow,
  loginEventRow,
  networkDefaultLocationBody,
  newsPushOptOutBody,
  patchAccountBody,
  phoneCodeBody,
  phoneConfirmBody,
  pushTokenBody,
  pushTokenDeleteBody,
  sessionRow,
  twoFactorBody,
} from './account.schemas.js';
import { AccountService } from './account.service.js';

/** Аккаунт вошедшего человека — /v1/me (docs/backend/02 §1) */
@ApiTags('account')
@Controller('v1/me')
@Authed()
export class AccountController {
  constructor(private readonly account: AccountService) {}

  @Get('account')
  @ApiOperation({ summary: 'Профиль, язык, крупный шрифт, 2FA, удаление (F-00-124, F-15-158)' })
  @ZodOk(accountView)
  get(@Ctx() ctx: RequestContext) {
    return this.account.get(ctx.session!.userId);
  }

  @Patch('account')
  @ApiOperation({ summary: 'Изменить профиль. If-Match: version — чужая правка между чтением и записью → 409' })
  @ZodBody(patchAccountBody)
  @ZodOk(accountView)
  patch(@Ctx() ctx: RequestContext, @Req() req: RequestWithContext, @Body(new Zod(patchAccountBody)) body: z.infer<typeof patchAccountBody>) {
    return this.account.patch(ctx, body, ifMatch(req));
  }

  @Post('account/delete')
  @HttpCode(200)
  @ApiOperation({ summary: 'Удалить аккаунт через 25 дней (можно отменить)' })
  @ZodOk(accountView)
  requestDeletion(@Ctx() ctx: RequestContext) {
    return this.account.requestDeletion(ctx);
  }

  @Post('account/delete/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Отменить удаление аккаунта' })
  @ZodOk(accountView)
  cancelDeletion(@Ctx() ctx: RequestContext) {
    return this.account.cancelDeletion(ctx);
  }

  @Post('account/data-export')
  @HttpCode(200)
  @ApiOperation({ summary: 'Выгрузить мои данные (F-15-154) — не чаще раза в сутки' })
  @ZodOk(dataExportRow)
  requestDataExport(@Ctx() ctx: RequestContext) {
    return this.account.requestDataExport(ctx);
  }

  @Get('account/data-exports')
  @ApiOperation({ summary: 'История заявок на выгрузку (F-15-154), новые сверху' })
  @ZodOk(z.array(dataExportRow))
  listDataExports(@Ctx() ctx: RequestContext) {
    return this.account.listDataExports(ctx);
  }

  @Post('account/data-block')
  @HttpCode(200)
  @ApiOperation({ summary: 'Запрос на блокировку данных (F-15-155) — заявка, не мгновенное действие' })
  @ZodOk(accountView)
  requestDataBlock(@Ctx() ctx: RequestContext) {
    return this.account.requestDataBlock(ctx);
  }

  @Post('account/phone/code')
  @HttpCode(200)
  @RateLimit({ bucket: 'phone-change', limit: 10, windowSec: 3600, by: 'session' })
  @ApiOperation({ summary: 'Смена номера: код на новый номер (F-15-149)' })
  @ZodBody(phoneCodeBody)
  @ZodOk(codeSent)
  phoneCode(@Ctx() ctx: RequestContext, @Body(new Zod(phoneCodeBody)) body: z.infer<typeof phoneCodeBody>) {
    return this.account.sendPhoneCode(ctx, body);
  }

  @Post('account/phone/confirm')
  @HttpCode(200)
  @ApiOperation({ summary: 'Смена номера: подтвердить код' })
  @ZodBody(phoneConfirmBody)
  @ZodOk(accountView)
  phoneConfirm(@Ctx() ctx: RequestContext, @Body(new Zod(phoneConfirmBody)) body: z.infer<typeof phoneConfirmBody>) {
    return this.account.confirmPhone(ctx, body);
  }

  @Put('security/two-factor')
  @ApiOperation({ summary: 'Двухэтапная проверка входа по паролю (F-15-159)' })
  @ZodBody(twoFactorBody)
  @ZodOk(accountView)
  twoFactor(@Ctx() ctx: RequestContext, @Body(new Zod(twoFactorBody)) body: z.infer<typeof twoFactorBody>) {
    return this.account.setTwoFactor(ctx, body.enabled);
  }

  @Get('consent')
  @ApiOperation({ summary: 'Принято ли пользовательское соглашение (F-14-008)' })
  consent(@Ctx() ctx: RequestContext) {
    return this.account.consent(ctx.session!.userId);
  }

  @Post('consent')
  @HttpCode(200)
  @ApiOperation({ summary: 'Принять соглашение (человек вошёл как бизнес и открыл приложение клиента)' })
  acceptConsent(@Ctx() ctx: RequestContext) {
    return this.account.acceptConsent(ctx.session!.userId);
  }

  @Get('sessions')
  @ApiOperation({ summary: 'Устройства, где открыт вход' })
  @ZodOk(z.array(sessionRow))
  sessions(@Ctx() ctx: RequestContext) {
    return this.account.listSessions(ctx);
  }

  @Delete('sessions/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Закрыть вход на одном устройстве' })
  async revoke(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    await this.account.revokeSession(ctx, id);
  }

  @Get('login-events')
  @ApiOperation({ summary: 'Журнал входов (F-10-106, F-15-159), новые сверху' })
  @ZodOk(z.array(loginEventRow))
  loginEvents(@Ctx() ctx: RequestContext, @Query('limit') limit?: string) {
    return this.account.loginEvents(ctx, Number(limit) || 50);
  }

  @Post('push-tokens')
  @HttpCode(204)
  @ApiOperation({ summary: 'Сохранить токен пуша (Web Push / FCM)' })
  @ZodBody(pushTokenBody)
  async pushToken(@Ctx() ctx: RequestContext, @Body(new Zod(pushTokenBody)) body: z.infer<typeof pushTokenBody>) {
    await this.account.savePushToken(ctx, body);
  }

  @Delete('push-tokens')
  @HttpCode(204)
  @ApiOperation({ summary: 'Удалить токен пуша (выход, отказ от пушей)' })
  @ZodBody(pushTokenDeleteBody)
  async deletePushToken(@Ctx() ctx: RequestContext, @Body(new Zod(pushTokenDeleteBody)) body: z.infer<typeof pushTokenDeleteBody>) {
    await this.account.deletePushToken(ctx, body.token);
  }

  // ─────────── этап 21 (лейн client+online, попытка 2) ───────────

  @Get('client-profile')
  @ApiOperation({ summary: 'Карточка профиля приложения — фото, формат времени, свои неявки (F-14-059, В-07)' })
  @ZodOk(clientProfileView)
  clientProfile(@Ctx() ctx: RequestContext) {
    return this.account.getClientProfile(ctx.session!.userId);
  }

  @Get('news-push-opt-out')
  @ApiOperation({ summary: 'Отключён ли пуш о новостях продукта (F-14-136)' })
  async getNewsPushOptOut(@Ctx() ctx: RequestContext) {
    return { optOut: await this.account.getNewsPushOptOut(ctx.session!.userId) };
  }

  @Put('news-push-opt-out')
  @HttpCode(204)
  @ApiOperation({ summary: 'Включить/выключить пуш о новостях продукта' })
  @ZodBody(newsPushOptOutBody)
  async setNewsPushOptOut(@Ctx() ctx: RequestContext, @Body(new Zod(newsPushOptOutBody)) body: z.infer<typeof newsPushOptOutBody>) {
    await this.account.setNewsPushOptOut(ctx.session!.userId, body.optOut);
  }

  @Get('network-default-location/:networkId')
  @ApiOperation({ summary: 'Филиал сети по умолчанию (F-14-163)' })
  async getDefaultNetworkLocation(@Ctx() ctx: RequestContext, @Param('networkId') networkId: string) {
    return { businessId: (await this.account.getDefaultNetworkLocation(ctx.session!.userId, networkId)) ?? null };
  }

  @Put('network-default-location/:networkId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Клиент сети выбирает филиал по умолчанию (F-14-163)' })
  @ZodBody(networkDefaultLocationBody)
  async setDefaultNetworkLocation(@Ctx() ctx: RequestContext, @Param('networkId') networkId: string, @Body(new Zod(networkDefaultLocationBody)) body: z.infer<typeof networkDefaultLocationBody>) {
    await this.account.setDefaultNetworkLocation(ctx.session!.userId, networkId, body.businessId);
  }
}
