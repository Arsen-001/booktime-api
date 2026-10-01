import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { Biz, Ctx } from '../../common/http/guards.js';
import { isLocalDate } from '../../common/time/time.js';
import { UNCLOSED_DAYS, WorkdayService, ownStaffOf } from './workday.service.js';

const date = (v: string | undefined, name: string) => {
  if (!isLocalDate(v)) throw new ApiError('validation', 'Invalid input', { [name]: 'YYYY-MM-DD' });
  return v;
};

/**
 * ⭐ Рабочий день журнала (01.10.2026): утренняя сводка, незакрытые визиты, итоги дня. Только чтение — закрывают визит
 * те же команды, что и журнал (статус записи, оплата через кассу), смену — кассовая смена finance.
 */
@ApiTags('journal')
@Controller('v1/biz/:businessId/journal/workday')
export class WorkdayController {
  constructor(private readonly svc: WorkdayService) {}

  @Get('morning')
  @Biz('journal.stats')
  @ApiOperation({ summary: 'Утренняя сводка: записи дня, не подтвердили, новые клиенты, дни рождения, предоплаты, долги' })
  morning(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Query('date') d?: string) {
    return this.svc.morning(businessId, ownStaffOf(ctx.member!), date(d, 'date'));
  }

  @Get('unclosed')
  @Biz('journal.view')
  @ApiOperation({ summary: 'Незакрытые визиты: прошедшие без «Пришёл»/«Не пришёл» и «Пришёл» без оплаты (мастер — свои)' })
  unclosed(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Query('days') days?: string) {
    return this.svc.unclosed(businessId, ownStaffOf(ctx.member!), Number(days) || UNCLOSED_DAYS);
  }

  @Get('day-close')
  @Biz('journal.stats')
  @ApiOperation({ summary: 'Итоги дня: записи, «не пришёл», отмены, выручка, деньги кассы по способам' })
  dayClose(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Query('date') d?: string) {
    return this.svc.dayClose(businessId, ownStaffOf(ctx.member!), date(d, 'date'));
  }
}
