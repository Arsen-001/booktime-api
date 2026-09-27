import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { Platform } from '../../common/http/guards.js';
import { Zod } from '../../common/http/validation.js';
import { supportListQuery, supportReplyBody } from './platform.schemas.js';
import { PlatformSupportService } from './support.service.js';

/** Наша панель: единая очередь поддержки (F-00-182, docs/backend/02 §19). */
@ApiTags('platform-support')
@Controller('v1/platform/support')
export class PlatformSupportController {
  constructor(private readonly support: PlatformSupportService) {}

  @Get()
  @Platform()
  list(@Query(new Zod(supportListQuery)) q: z.infer<typeof supportListQuery>) {
    return this.support.list(q);
  }

  @Post(':id/reply')
  @Platform()
  reply(@Param('id') id: string, @Body(new Zod(supportReplyBody)) body: z.infer<typeof supportReplyBody>) {
    return this.support.reply(id, body.text);
  }

  @Post(':id/close')
  @Platform()
  close(@Param('id') id: string) {
    return this.support.setStatus(id, 'closed');
  }

  @Post(':id/reopen')
  @Platform()
  reopen(@Param('id') id: string) {
    return this.support.setStatus(id, 'open');
  }
}
