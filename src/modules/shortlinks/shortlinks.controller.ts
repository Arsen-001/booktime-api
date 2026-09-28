import { Body, Controller, Get, Param, Post, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { Biz } from '../../common/http/guards.js';
import { ZodBody } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { ShortLinksService } from './shortlinks.service.js';

const createShortLinkBody = z.object({
  /** Путь на нашем домене: /b/<slug>/booking/<id>?h=…, /b/<slug>/book … */
  target: z.string().min(1).max(512),
  expiresAt: z.string().datetime().optional(),
});

/**
 * Короткие ссылки SMS (этап 21, 28.09). POST — внутренний: его зовёт отправитель уведомлений кабинета бизнеса
 * (право notify.manage), GET — публичный, без сессии: им пользуется страница `/s/<code>` фронта.
 */
@ApiTags('shortlinks')
@Controller('v1')
export class ShortLinksController {
  constructor(private readonly links: ShortLinksService) {}

  @Post('biz/:businessId/short-links')
  @Biz('notify.manage')
  @ZodBody(createShortLinkBody)
  @ApiOperation({ summary: 'Короткая ссылка на путь нашего домена (для SMS)' })
  create(@Param('businessId') businessId: string, @Body(new Zod(createShortLinkBody)) body: z.infer<typeof createShortLinkBody>) {
    return this.links.create(businessId, body.target, body.expiresAt ? new Date(body.expiresAt) : undefined);
  }

  @Get('public/s/:code')
  @ApiOperation({ summary: 'Куда ведёт короткая ссылка /s/<code> (публично)' })
  resolve(@Param('code') code: string) {
    return this.links.resolve(code);
  }
}

/**
 * Тот же код прямым 302 — если `booktime.am/s/*` проксируется на сервер, ссылка открывается без фронта: один
 * запрос по первичному ключу и Location на путь (относительный — тот же домен). Браузер кеширует ответ на час.
 */
@ApiTags('shortlinks')
@Controller('s')
export class ShortLinksRedirectController {
  constructor(private readonly links: ShortLinksService) {}

  @Get(':code')
  @ApiOperation({ summary: '302 на полный путь короткой ссылки' })
  async go(@Param('code') code: string, @Res() res: Response): Promise<void> {
    const { target } = await this.links.resolve(code);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.redirect(302, target);
  }
}
