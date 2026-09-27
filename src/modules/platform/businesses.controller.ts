import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import type { RequestContext } from '../../common/http/context.js';
import { Ctx, Platform } from '../../common/http/guards.js';
import { Zod } from '../../common/http/validation.js';
import { adsOptInBody, exportBody, exportQuery, markLeftBody } from './platform.schemas.js';
import { PlatformBusinessesService } from './businesses.service.js';

/** Наша панель: бизнесы, копии данных, выгрузка при уходе, согласие на рекламу (docs/backend/02 §19, 06 §6). */
@ApiTags('platform-businesses')
@Controller('v1/platform/businesses')
export class PlatformBusinessesController {
  constructor(private readonly businesses: PlatformBusinessesService) {}

  @Get()
  @Platform()
  overview() {
    return this.businesses.overview();
  }

  @Post(':id/ads-opt-in')
  @Platform()
  setAdsOptIn(@Param('id') id: string, @Body(new Zod(adsOptInBody)) body: z.infer<typeof adsOptInBody>) {
    return this.businesses.setAdsOptIn(id, body.optIn);
  }

  @Get(':id/backups')
  @Platform()
  backups(@Param('id') id: string) {
    return this.businesses.listBackupCopies(id);
  }

  @Post(':id/backups')
  @Platform()
  makeBackup(@Param('id') id: string) {
    return this.businesses.makeBackupCopy(id);
  }

  @Post(':id/export')
  @Platform()
  export(@Ctx() ctx: RequestContext, @Param('id') id: string, @Query(new Zod(exportQuery)) q: z.infer<typeof exportQuery>, @Body(new Zod(exportBody)) body: z.infer<typeof exportBody>) {
    return this.businesses.exportBusinessData(id, q.what, body.headers, ctx.session!.userId, 'platform');
  }

  @Post(':id/leave')
  @Platform()
  markLeft(@Param('id') id: string, @Body(new Zod(markLeftBody)) body: z.infer<typeof markLeftBody>) {
    return this.businesses.markLeft(id, body.dataHanded);
  }
}
