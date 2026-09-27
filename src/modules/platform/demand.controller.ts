import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import type { RequestContext } from '../../common/http/context.js';
import { Ctx, Platform } from '../../common/http/guards.js';
import { Zod } from '../../common/http/validation.js';
import { DemandService } from './demand.service.js';
import { demandQuery, firstAwardBody } from './platform.schemas.js';

/** Наша панель: спрос без предложения и «первый в районе/сфере» (F-00-180/181, docs/backend/02 §19). */
@ApiTags('platform-demand')
@Controller('v1/platform')
export class PlatformDemandController {
  constructor(private readonly demand: DemandService) {}

  @Get('demand')
  @Platform()
  report(@Query(new Zod(demandQuery)) q: z.infer<typeof demandQuery>) {
    return this.demand.getReport(q.period);
  }

  @Get('first-candidates')
  @Platform()
  candidates() {
    return this.demand.listFirstCandidates();
  }

  @Post('first-awards')
  @Platform()
  grant(@Ctx() ctx: RequestContext, @Body(new Zod(firstAwardBody)) body: z.infer<typeof firstAwardBody>) {
    return this.demand.grantFirstAward(ctx.session!.userId, body);
  }
}
