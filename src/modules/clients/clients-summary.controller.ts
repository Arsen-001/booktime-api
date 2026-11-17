import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { Biz, Ctx } from '../../common/http/guards.js';
import { ClientsSummaryService } from './clients-summary.service.js';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Сводка клиентов и «отметьте визиты» (скорость 17.11.2026: считает сервер, а не браузер по всем визитам салона).
 * Свой контроллер стоит в модуле раньше ClientsController — пути clients/summary и clients/pending-marks
 * регистрируются раньше clients/:id.
 */
@ApiTags('clients')
@Controller('v1/biz/:businessId')
export class ClientsSummaryController {
  constructor(private readonly summaries: ClientsSummaryService) {}

  @Get('clients/summary')
  @Biz('clients.view')
  @ApiOperation({ summary: 'Сводка клиентов за период (F-04-123…125/163/185): выручка, визиты, по мастерам, новые / не новые / потерянные' })
  summary(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Query('from') from?: string, @Query('to') to?: string) {
    if (!from || !to || !DAY.test(from) || !DAY.test(to)) throw new ApiError('validation', 'Invalid input', { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' });
    return this.summaries.summary(ctx, businessId, { from, to });
  }

  @Get('clients/pending-marks')
  @Biz('clients.view')
  @ApiOperation({ summary: 'Прошедшие записи без отметки «пришёл / не пришёл» (F-00-127)' })
  pendingMarks(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string) {
    return this.summaries.pendingMarks(ctx, businessId);
  }
}
