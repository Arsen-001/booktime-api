import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { RequestContext } from '../../common/http/context.js';
import { Ctx, Platform } from '../../common/http/guards.js';
import { FullArchiveService } from './full-archive.service.js';

/**
 * Данные и удаление (этап 20, docs/backend/01 §10, 06 §6). Полный архив бизнеса «по запросу» — отдельно от
 * повседневной выгрузки клиентов/записей (`PlatformBusinessesController`, этап 19): тяжелее и реже.
 */
@ApiTags('platform-data-retention')
@Controller('v1/platform/businesses')
export class DataRetentionController {
  constructor(private readonly archive: FullArchiveService) {}

  @Get(':id/full-archive')
  @Platform()
  fullArchive(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.archive.build(id, ctx.session!.userId, 'platform');
  }
}
