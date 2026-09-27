import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import type { RequestContext } from '../../common/http/context.js';
import { Ctx, Platform } from '../../common/http/guards.js';
import { Zod } from '../../common/http/validation.js';
import { adsOptInBody, blockBody, exportBody, exportQuery, markLeftBody } from './platform.schemas.js';
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

  @Get('visit-connected')
  @Platform()
  @ApiOperation({ summary: 'Подключённые на визите — только им можно выдать бесплатный месяц вручную (F-00-019)' })
  visitConnected() {
    return this.businesses.listVisitBusinesses();
  }

  @Post(':id/ads-opt-in')
  @Platform()
  @HttpCode(204)
  setAdsOptIn(@Param('id') id: string, @Body(new Zod(adsOptInBody)) body: z.infer<typeof adsOptInBody>) {
    return this.businesses.setAdsOptIn(id, body.optIn);
  }

  @Post(':id/block')
  @Platform()
  @HttpCode(204)
  @ApiOperation({ summary: 'Заблокировать/разблокировать бизнес (status frozen ↔ active); ушедший — 409' })
  setBlocked(@Param('id') id: string, @Body(new Zod(blockBody)) body: z.infer<typeof blockBody>) {
    return this.businesses.setBlocked(id, body.blocked);
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
  @HttpCode(204)
  markLeft(@Param('id') id: string, @Body(new Zod(markLeftBody)) body: z.infer<typeof markLeftBody>) {
    return this.businesses.markLeft(id, body.dataHanded);
  }
}
