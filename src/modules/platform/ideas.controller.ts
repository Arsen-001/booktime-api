import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import type { RequestContext } from '../../common/http/context.js';
import { Biz, Ctx, Platform } from '../../common/http/guards.js';
import { Zod } from '../../common/http/validation.js';
import { ideaCreateBody, ideaStatusBody } from './platform.schemas.js';
import { IdeasService } from './ideas.service.js';

/** Кабинет: «Предложить идею» и голос — любой сотрудник (F-00-009) */
@ApiTags('ideas')
@Controller('v1/biz/:businessId/ideas')
export class BizIdeasController {
  constructor(private readonly ideas: IdeasService) {}

  @Post()
  @Biz()
  create(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(ideaCreateBody)) body: z.infer<typeof ideaCreateBody>) {
    return this.ideas.create(businessId, ctx.member!.name, body.text);
  }

  @Post(':id/vote')
  @Biz()
  vote(@Param('businessId') businessId: string, @Param('id') id: string) {
    return this.ideas.vote(id, businessId);
  }
}

/** Наша панель: очередь идей (F-00-009) */
@ApiTags('platform-ideas')
@Controller('v1/platform/ideas')
export class PlatformIdeasController {
  constructor(private readonly ideas: IdeasService) {}

  @Get()
  @Platform()
  list() {
    return this.ideas.list();
  }

  @Post(':id/status')
  @Platform()
  setStatus(@Param('id') id: string, @Body(new Zod(ideaStatusBody)) body: z.infer<typeof ideaStatusBody>) {
    return this.ideas.setStatus(id, body.status);
  }
}
