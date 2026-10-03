import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import type { RequestWithContext } from '../../common/http/context.js';
import { Platform } from '../../common/http/guards.js';
import { ZodBody } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { ifMatch } from '../../common/http/version.js';
import { prospectImportBody, prospectListQuery, prospectPatchBody } from './platform.schemas.js';
import { ProspectsService } from './prospects.service.js';

/** Наша панель: «Места» — база заведений Еревана для отдела продаж (03.10.2026). Права — как у визитов. */
@ApiTags('platform-prospects')
@Controller('v1/platform/prospects')
export class PlatformProspectsController {
  constructor(private readonly prospects: ProspectsService) {}

  @Get()
  @Platform()
  @ApiOperation({ summary: 'Список мест: фильтры (системы записи, сфера, район, мастеров от/до, статус, поиск), сортировка, страницы, счётчики по системам' })
  list(@Query(new Zod(prospectListQuery)) q: z.infer<typeof prospectListQuery>) {
    return this.prospects.list(q);
  }

  @Get('export')
  @Platform()
  @ApiOperation({ summary: 'CSV мест с теми же фильтрами, что список: { fileName, csv, rows }' })
  exportCsv(@Query(new Zod(prospectListQuery)) q: z.infer<typeof prospectListQuery>) {
    return this.prospects.exportCsv(q);
  }

  @Post('import')
  @Platform()
  @ZodBody(prospectImportBody)
  @ApiOperation({ summary: 'Импорт JSON-массива мест (snake_case), upsert по «имя|адрес»; отчёт added/updated/unchanged/skipped' })
  import(@Body(new Zod(prospectImportBody)) body: z.infer<typeof prospectImportBody>) {
    return this.prospects.import(body);
  }

  @Get(':id')
  @Platform()
  get(@Param('id') id: string) {
    return this.prospects.get(id);
  }

  @Put(':id')
  @Platform()
  @ZodBody(prospectPatchBody)
  update(@Req() req: RequestWithContext, @Param('id') id: string, @Body(new Zod(prospectPatchBody)) body: z.infer<typeof prospectPatchBody>) {
    return this.prospects.update(id, body, ifMatch(req));
  }

  @Delete(':id')
  @Platform()
  remove(@Param('id') id: string) {
    return this.prospects.remove(id);
  }
}
