import { timingSafeEqual } from 'node:crypto';
import { Body, Controller, Get, Headers, HttpCode, Inject, Injectable, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import type { TgUpdate } from '../../adapters/telegram-bot/telegram-bot.js';
import { env } from '../../common/config/env.js';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { Authed, Biz, Ctx } from '../../common/http/guards.js';
import { ZodOk } from '../../common/http/openapi.js';
import { logger } from '../../common/logging/logger.js';
import { normalizePhone } from '../../common/phone.js';
import { PrismaService } from '../../common/prisma.service.js';
import { RateLimit } from '../../common/rate-limit/rate-limit.js';
import { REDIS } from '../../common/tokens.js';
import { OnlineService } from '../online/online.service.js';
import { TelegramBotService } from './telegram-bot.service.js';
import { bookingPhone, linkOut, type TelegramLinkOut } from './telegram-links.js';

/** Ответ «подключить Telegram»: ссылка на бота с одноразовым кодом (7 дней) и подключён ли уже этот номер */
export const telegramLinkOut = z.object({
  url: z.string().describe('https://t.me/<бот>?start=<код>'),
  botUsername: z.string(),
  linked: z.boolean().describe('У номера клиента уже есть действующая привязка к боту'),
});

@Injectable()
export class TelegramLinksService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly online: OnlineService,
  ) {}

  async forBooking(id: string, hash: string): Promise<TelegramLinkOut> {
    const b = await this.online.bookingByHash(id, hash ?? '');
    const phone = await bookingPhone(this.prisma, b);
    if (!phone) throw new ApiError('phone_required', 'Booking has no client phone');
    return linkOut(this.prisma, this.redis, { phone, bookingId: b.id, appUserId: b.appUserId ?? undefined });
  }

  async forUser(userId: string): Promise<TelegramLinkOut> {
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { phone: true } });
    const phone = u?.phone ? normalizePhone(u.phone) : undefined;
    if (!phone) throw new ApiError('phone_required', 'Account has no phone');
    return linkOut(this.prisma, this.redis, { phone, appUserId: userId });
  }
}

/**
 * Вход обновлений Telegram (прод: setWebhook на https://<api>/v1/telegram/webhook с secret_token). Отвечаем 200 сразу,
 * обработка — в фоне: Telegram ждёт ответ недолго и повторяет обновление (повтор отсекает handleUpdate по update_id).
 */
@ApiTags('telegram')
@Controller('v1/telegram')
export class TelegramWebhookController {
  constructor(private readonly bot: TelegramBotService) {}

  @Post('webhook')
  @HttpCode(200)
  @ApiOperation({ summary: 'Вебхук Telegram-бота напоминаний (заголовок X-Telegram-Bot-Api-Secret-Token)' })
  webhook(@Headers('x-telegram-bot-api-secret-token') secret: string | undefined, @Body() update: TgUpdate) {
    const expected = env.TELEGRAM_WEBHOOK_SECRET;
    // Без секрета любой может прислать «обновление» с чужим контактом (contact.user_id = from.id подделываются) и
    // привязать свой чат к чужому номеру — кнопки отмены чужих записей. В проде вебхук без секрета не принимаем.
    if (!expected && env.NODE_ENV === 'production') throw new ApiError('forbidden', 'Webhook secret is not configured');
    if (expected) {
      const a = Buffer.from(secret ?? '');
      const b = Buffer.from(expected);
      if (a.length !== b.length || !timingSafeEqual(a, b)) throw new ApiError('forbidden', 'Bad webhook secret');
    }
    void this.bot.handleUpdate(update).catch((err: unknown) => logger.error({ err }, 'telegram webhook: обработка упала'));
    return { ok: true };
  }
}

@ApiTags('telegram')
@Controller('v1/public')
export class TelegramPublicController {
  constructor(private readonly links: TelegramLinksService) {}

  @Post('bookings/:id/telegram-link')
  @HttpCode(200)
  @RateLimit({ bucket: 'public-booking-hash-write', limit: 20, windowSec: 3600, by: 'ip' })
  @ApiOperation({ summary: 'Ссылка на Telegram-бот напоминаний для клиента записи (по хэшу, без входа)' })
  @ZodOk(telegramLinkOut)
  link(@Param('id') id: string, @Query('h') hash: string) {
    return this.links.forBooking(id, hash);
  }
}

@ApiTags('telegram')
@Controller('v1/me')
@Authed()
export class TelegramMeController {
  constructor(private readonly links: TelegramLinksService) {}

  @Post('telegram-link')
  @HttpCode(200)
  @ApiOperation({ summary: 'Ссылка на Telegram-бот напоминаний для номера вошедшего клиента' })
  @ZodOk(telegramLinkOut)
  link(@Ctx() ctx: RequestContext) {
    return this.links.forUser(ctx.session!.userId);
  }
}

/**
 * ⭐ «Подтвердить завтра» (F-00-121): каким клиентам бизнеса напомнит Telegram-бот (номер привязан, бот не
 * заблокирован) — журнал помечает их «Напомнит Telegram», чтобы администратор не писал второй раз. Только id
 * клиентов ЭТОГО бизнеса из запроса; сам факт привязки другого бизнеса не раскрывается.
 */
@ApiTags('telegram')
@Controller('v1/biz/:businessId/telegram')
export class TelegramBizController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('linked-clients')
  @Biz('journal.view')
  @ApiOperation({ summary: 'Какие из этих клиентов получают напоминания в Telegram (F-00-121)' })
  @ZodOk(z.object({ clientIds: z.array(z.string()) }))
  async linkedClients(@Param('businessId') businessId: string, @Query('clientIds') raw: string | undefined) {
    const ids = [...new Set((raw ?? '').split(',').map((s) => s.trim()).filter(Boolean))].slice(0, 500);
    if (!ids.length) return { clientIds: [] };
    const clients = await this.prisma.client.findMany({ where: { businessId, id: { in: ids }, deletedAt: null }, select: { id: true, phone: true } });
    const phones = [...new Set(clients.map((c) => (c.phone ? normalizePhone(c.phone) : undefined)).filter((p): p is string => Boolean(p)))];
    if (!phones.length) return { clientIds: [] };
    const links = await this.prisma.telegramLink.findMany({ where: { phone: { in: phones }, blockedAt: null }, select: { phone: true } });
    const linked = new Set(links.map((l) => l.phone));
    return { clientIds: clients.filter((c) => c.phone && linked.has(normalizePhone(c.phone) ?? '')).map((c) => c.id) };
  }
}
