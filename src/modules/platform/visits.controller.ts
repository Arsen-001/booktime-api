import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { Platform } from '../../common/http/guards.js';
import { Zod } from '../../common/http/validation.js';
import { completeCallbackBody, visitInputBody, visitListQuery, visitPatchBody } from './platform.schemas.js';
import { VisitsService } from './visits.service.js';

/** Наша панель: учёт визитов (F-00-177, docs/backend/02 §19). */
@ApiTags('platform-visits')
@Controller('v1/platform/visits')
export class PlatformVisitsController {
  constructor(private readonly visits: VisitsService) {}

  @Get()
  @Platform()
  list(@Query(new Zod(visitListQuery)) q: z.infer<typeof visitListQuery>) {
    return this.visits.list(q);
  }

  @Get('counts')
  @Platform()
  counts() {
    return this.visits.counts();
  }

  @Get('callbacks-today')
  @Platform()
  callbacksToday() {
    return this.visits.listCallbacksToday();
  }

  @Post()
  @Platform()
  create(@Body(new Zod(visitInputBody)) body: z.infer<typeof visitInputBody>) {
    return this.visits.create(body);
  }

  @Put(':id')
  @Platform()
  update(@Param('id') id: string, @Body(new Zod(visitPatchBody)) body: z.infer<typeof visitPatchBody>) {
    return this.visits.update(id, body);
  }

  @Post(':id/callback-done')
  @Platform()
  completeCallback(@Param('id') id: string, @Body(new Zod(completeCallbackBody)) body: z.infer<typeof completeCallbackBody>) {
    return this.visits.completeCallback(id, body.note);
  }
}
