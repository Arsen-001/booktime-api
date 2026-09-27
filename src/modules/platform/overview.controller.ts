import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Platform } from '../../common/http/guards.js';
import { OverviewService } from './overview.service.js';

/** Наша панель: обзор (docs/backend/02 §19). */
@ApiTags('platform-overview')
@Controller('v1/platform/overview')
export class PlatformOverviewController {
  constructor(private readonly overview: OverviewService) {}

  @Get()
  @Platform()
  summary() {
    return this.overview.summary();
  }
}
