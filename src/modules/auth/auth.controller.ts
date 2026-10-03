import { Body, Controller, Delete, Get, HttpCode, Post, Put, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { RequestContext } from '../../common/http/context.js';
import { Authed, Ctx } from '../../common/http/guards.js';
import { ZodBody, ZodOk } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { RateLimit } from '../../common/rate-limit/rate-limit.js';
import {
  appleBody,
  appleLogin,
  challengeBody,
  changePasswordBody,
  codeChannels,
  codeSent,
  googleBody,
  googleLinkBody,
  googleLogin,
  googleStatus,
  logoutAllBody,
  modeBody,
  passwordBody,
  platformView,
  secondFactor,
  sendCodeBody,
  sessionOrGuest,
  sessionView,
  verifyCodeBody,
  verifyView,
} from './auth.schemas.js';
import { AuthService } from './auth.service.js';
import type { z } from 'zod';

/** Вход и сессии — /v1/auth (docs/backend/02 §1, 05 §6, PLAN Р8/Р11) */
@ApiTags('auth')
@Controller('v1/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Get('session')
  @ApiOperation({ summary: 'Кто вошёл: сессия или { session: null } для гостя' })
  @ZodOk(sessionOrGuest)
  async session(@Ctx() ctx: RequestContext) {
    if (!ctx.session) return { session: null };
    return { session: await this.auth.view(ctx.session.sessionId) };
  }

  @Get('channels')
  @ApiOperation({ summary: 'Куда можно прислать код: включённые каналы по порядку (telegram, whatsapp, sms)' })
  @ZodOk(codeChannels)
  channels() {
    return this.auth.codeChannels();
  }

  @Post('code')
  @HttpCode(200)
  @RateLimit({ bucket: 'auth-code-ip', limit: 30, windowSec: 600, by: 'ip' })
  @ApiOperation({ summary:
      'Отправить код входа (4 цифры, 5 мин, повтор через 60 с). channel — куда просят (по умолчанию telegram); не доставлен — ' +
      'следующий включённый канал. Ответ: channel — куда ушёл, channels — включённые каналы.' })
  @ZodBody(sendCodeBody)
  @ZodOk(codeSent)
  sendCode(@Ctx() ctx: RequestContext, @Body(new Zod(sendCodeBody)) body: z.infer<typeof sendCodeBody>) {
    return this.auth.sendCode(ctx, body);
  }

  @Post('verify')
  @HttpCode(200)
  @RateLimit({ bucket: 'auth-verify-ip', limit: 40, windowSec: 600, by: 'ip' })
  @ApiOperation({ summary:
      'Проверить код и войти (клиент или кабинет бизнеса). Ставит httpOnly cookie сессии. ' +
      'pendingGoogle — привязать Google к этому номеру (ответ: googleLinked); pendingApple — Apple (ответ: appleLinked).' })
  @ZodBody(verifyCodeBody)
  @ZodOk(verifyView)
  verify(@Ctx() ctx: RequestContext, @Res({ passthrough: true }) res: Response, @Body(new Zod(verifyCodeBody)) body: z.infer<typeof verifyCodeBody>) {
    return this.auth.verifyCode(ctx, res, body);
  }

  @Post('google')
  @HttpCode(200)
  @RateLimit({ bucket: 'auth-google-ip', limit: 30, windowSec: 600, by: 'ip' })
  @ApiOperation({ summary:
      'Войти через Google (ID token из Google Identity Services). Привязан к человеку — сессия (cookie); не привязан — ' +
      'pendingGoogle: номер и код один раз (/v1/auth/code, затем /v1/auth/verify с pendingGoogle), дальше — одним нажатием.' })
  @ZodBody(googleBody)
  @ZodOk(googleLogin)
  google(@Ctx() ctx: RequestContext, @Res({ passthrough: true }) res: Response, @Body(new Zod(googleBody)) body: z.infer<typeof googleBody>) {
    return this.auth.googleLogin(ctx, res, body);
  }

  @Post('apple')
  @HttpCode(200)
  @RateLimit({ bucket: 'auth-apple-ip', limit: 30, windowSec: 600, by: 'ip' })
  @ApiOperation({ summary:
      'Войти через Apple (identity token из Sign in with Apple; name — имя из первого ответа Apple). Привязан к человеку — ' +
      'сессия (cookie); не привязан — pendingApple: номер и код один раз (/v1/auth/code, затем /v1/auth/verify с ' +
      'pendingApple), дальше — одним нажатием.' })
  @ZodBody(appleBody)
  @ZodOk(appleLogin)
  apple(@Ctx() ctx: RequestContext, @Res({ passthrough: true }) res: Response, @Body(new Zod(appleBody)) body: z.infer<typeof appleBody>) {
    return this.auth.appleLogin(ctx, res, body);
  }

  @Get('google/link')
  @Authed()
  @ApiOperation({ summary: 'Профиль: привязан ли Google и включён ли вход через Google' })
  @ZodOk(googleStatus)
  googleStatus(@Ctx() ctx: RequestContext) {
    return this.auth.googleStatus(ctx);
  }

  @Post('google/link')
  @HttpCode(200)
  @Authed()
  @RateLimit({ bucket: 'auth-google-link', limit: 20, windowSec: 600, by: 'session' })
  @ApiOperation({ summary: 'Профиль: привязать Google к вошедшему по номеру (прежний Google заменяется)' })
  @ZodBody(googleLinkBody)
  @ZodOk(googleStatus)
  googleLink(@Ctx() ctx: RequestContext, @Body(new Zod(googleLinkBody)) body: z.infer<typeof googleLinkBody>) {
    return this.auth.linkGoogle(ctx, body);
  }

  @Delete('google/link')
  @Authed()
  @ApiOperation({ summary: 'Профиль: отвязать Google (дальше — вход по номеру и коду)' })
  @ZodOk(googleStatus)
  googleUnlink(@Ctx() ctx: RequestContext) {
    return this.auth.unlinkGoogle(ctx);
  }

  @Post('password')
  @HttpCode(200)
  @RateLimit({ bucket: 'auth-password-ip', limit: 30, windowSec: 600, by: 'ip' })
  @ApiOperation({ summary: 'Вход администратора логином и паролем (F-00-034). Если включён второй шаг — { secondFactor }.' })
  @ZodBody(passwordBody)
  password(@Ctx() ctx: RequestContext, @Res({ passthrough: true }) res: Response, @Body(new Zod(passwordBody)) body: z.infer<typeof passwordBody>) {
    return this.auth.passwordLogin(ctx, res, body);
  }

  @Post('second-factor')
  @HttpCode(200)
  @RateLimit({ bucket: 'auth-verify-ip', limit: 40, windowSec: 600, by: 'ip' })
  @ApiOperation({ summary: 'Второй шаг входа по паролю: код на телефон (F-15-159)' })
  @ZodBody(challengeBody)
  @ZodOk(sessionView)
  secondFactor(@Ctx() ctx: RequestContext, @Res({ passthrough: true }) res: Response, @Body(new Zod(challengeBody)) body: z.infer<typeof challengeBody>) {
    return this.auth.secondFactor(ctx, res, body);
  }

  @Post('password/change')
  @HttpCode(204)
  @Authed()
  @ApiOperation({ summary: 'Сменить пароль администратора; при первом входе старый не нужен (F-00-034)' })
  @ZodBody(changePasswordBody)
  async changePassword(@Ctx() ctx: RequestContext, @Body(new Zod(changePasswordBody)) body: z.infer<typeof changePasswordBody>) {
    await this.auth.changePassword(ctx, body);
  }

  @Put('mode')
  @Authed()
  @ApiOperation({ summary: 'Переключатель «Я клиент / Мой бизнес» (В-21)' })
  @ZodBody(modeBody)
  @ZodOk(sessionView)
  mode(@Ctx() ctx: RequestContext, @Body(new Zod(modeBody)) body: z.infer<typeof modeBody>) {
    return this.auth.setMode(ctx, body);
  }

  @Post('logout')
  @HttpCode(204)
  @ApiOperation({ summary: 'Выйти на этом устройстве' })
  async logout(@Ctx() ctx: RequestContext, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(ctx, res, false);
  }

  @Post('logout-all')
  @HttpCode(200)
  @Authed()
  @ApiOperation({ summary: '«Завершить все сеансы» (F-15-152, F-10-125); keepCurrent — кроме этого устройства' })
  @ZodBody(logoutAllBody)
  logoutAll(@Ctx() ctx: RequestContext, @Res({ passthrough: true }) res: Response, @Body(new Zod(logoutAllBody)) body: z.infer<typeof logoutAllBody>) {
    return this.auth.logoutAll(ctx, res, body.keepCurrent);
  }

  // ─────────── команда платформы (Р11) — своя cookie ───────────

  @Post('platform/login')
  @HttpCode(200)
  @RateLimit({ bucket: 'auth-platform-ip', limit: 10, windowSec: 600, by: 'ip' })
  @ApiOperation({ summary: 'Панель: логин + пароль → код на телефон (всегда второй шаг)' })
  @ZodBody(passwordBody)
  @ZodOk(secondFactor)
  platformLogin(@Ctx() ctx: RequestContext, @Body(new Zod(passwordBody)) body: z.infer<typeof passwordBody>) {
    return this.auth.platformLogin(ctx, body);
  }

  @Post('platform/verify')
  @HttpCode(200)
  @RateLimit({ bucket: 'auth-platform-ip', limit: 10, windowSec: 600, by: 'ip' })
  @ApiOperation({ summary: 'Панель: код второго шага → сессия платформы' })
  @ZodBody(challengeBody)
  @ZodOk(platformView)
  platformVerify(@Ctx() ctx: RequestContext, @Res({ passthrough: true }) res: Response, @Body(new Zod(challengeBody)) body: z.infer<typeof challengeBody>) {
    return this.auth.platformVerify(ctx, res, body);
  }

  @Get('platform/session')
  @ApiOperation({ summary: 'Панель: кто вошёл ({ session: null } — не вошёл)' })
  async platformSession(@Ctx() ctx: RequestContext) {
    if (!ctx.session?.platform) return { session: null };
    return { session: await this.auth.platformView(ctx.session.sessionId) };
  }

  @Post('platform/logout')
  @HttpCode(204)
  @ApiOperation({ summary: 'Панель: выйти' })
  async platformLogout(@Ctx() ctx: RequestContext, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(ctx, res, true);
  }
}
