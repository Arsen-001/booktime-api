import { Body, Controller, Get, HttpCode, Post, Put, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { RequestContext } from '../../common/http/context.js';
import { Authed, Ctx } from '../../common/http/guards.js';
import { ZodBody, ZodOk } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { RateLimit } from '../../common/rate-limit/rate-limit.js';
import {
  challengeBody,
  changePasswordBody,
  codeSent,
  logoutAllBody,
  modeBody,
  passwordBody,
  platformView,
  secondFactor,
  sendCodeBody,
  sessionOrGuest,
  sessionView,
  verifyCodeBody,
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

  @Post('code')
  @HttpCode(200)
  @RateLimit({ bucket: 'auth-code-ip', limit: 30, windowSec: 600, by: 'ip' })
  @ApiOperation({ summary: 'Отправить код входа (4 цифры, 5 мин, повтор через 60 с). Ответ одинаков для любого номера.' })
  @ZodBody(sendCodeBody)
  @ZodOk(codeSent)
  sendCode(@Ctx() ctx: RequestContext, @Body(new Zod(sendCodeBody)) body: z.infer<typeof sendCodeBody>) {
    return this.auth.sendCode(ctx, body);
  }

  @Post('verify')
  @HttpCode(200)
  @RateLimit({ bucket: 'auth-verify-ip', limit: 40, windowSec: 600, by: 'ip' })
  @ApiOperation({ summary: 'Проверить код и войти (клиент или кабинет бизнеса). Ставит httpOnly cookie сессии.' })
  @ZodBody(verifyCodeBody)
  @ZodOk(sessionView)
  verify(@Ctx() ctx: RequestContext, @Res({ passthrough: true }) res: Response, @Body(new Zod(verifyCodeBody)) body: z.infer<typeof verifyCodeBody>) {
    return this.auth.verifyCode(ctx, res, body);
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
