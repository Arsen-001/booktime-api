import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { Biz, Ctx } from '../../common/http/guards.js';
import { AppReportsService } from './app-reports.service.js';

/**
 * Отчёты раздела «Приложение» (этап 21, лейн client — `src/api/client.ts::getDailyReport/getPeriodReport/
 * getMyAnalytics/getNetworkDayStats`, F-14-123…129). Свой маленький маршрут, см. докстринг `app-reports.service.ts`
 * про то, почему не через реестр `reports.controller.ts`.
 */
@ApiTags('client')
@Controller('v1/biz/:businessId/apps/reports')
export class AppReportsController {
  constructor(private readonly svc: AppReportsService) {}

  @Get('daily')
  @Biz('reports.view')
  @ApiOperation({ summary: 'F-14-123: сегодня/вчера — 6 показателей' })
  daily(@Param('businessId') businessId: string, @Query('date') date: string) {
    return this.svc.daily(businessId, date);
  }

  @Get('period')
  @Biz('reports.view')
  @ApiOperation({ summary: 'F-14-124: произвольный период' })
  period(@Param('businessId') businessId: string, @Query('from') from: string, @Query('to') to: string) {
    return this.svc.period(businessId, from, to);
  }

  @Get('my-analytics')
  @Biz()
  @ApiOperation({ summary: 'F-14-126: «Моя аналитика» — своя без reports.view, чужая — только с ним' })
  myAnalytics(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Query('staffId') staffId: string, @Query('from') from: string, @Query('to') to: string) {
    if (staffId !== ctx.member!.staffId && !ctx.member!.permissions.has('reports.view')) throw new ApiError('forbidden', 'Missing permission: reports.view');
    return this.svc.myAnalytics(businessId, staffId, from, to);
  }

  @Get('network')
  @Biz('reports.view')
  @ApiOperation({ summary: 'F-14-129: показатели дня по филиалам сети (locationIds = businessId филиалов)' })
  network(@Param('businessId') businessId: string, @Query('locationIds') locationIds: string, @Query('date') date: string) {
    const ids = (locationIds ?? '').split(',').filter(Boolean);
    return this.svc.networkDay(businessId, ids, date);
  }
}
