import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { Biz, Ctx } from '../../common/http/guards.js';
import { ZodBody } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { isLocalDate } from '../../common/time/time.js';
import { calendarDayBody, calendarModeBody, fromToBody, markBody, oneDateBody, rangeBody, restoreMarksBody, vacationBody, weekAnchorBody } from './schedule.schemas.js';
import { CalendarService } from './calendar.service.js';

const date = (v: string | undefined, name: string) => {
  if (!isLocalDate(v)) throw new ApiError('validation', 'Invalid input', { [name]: 'YYYY-MM-DD' });
  return v;
};

/** «Мой календарь» мастера (F-00-051…060): /v1/biz/{b}/staff/{s}/… */
@ApiTags('schedule')
@Controller('v1/biz/:businessId/staff/:staffId')
export class CalendarController {
  constructor(private readonly svc: CalendarService) {}

  @Get('calendar-mode')
  @Biz()
  mode(@Param('businessId') businessId: string, @Param('staffId') staffId: string) {
    return this.svc.mode(businessId, staffId).then((mode) => ({ mode }));
  }

  @Put('calendar-mode')
  @HttpCode(204)
  @Biz()
  @ApiOperation({ summary: 'Режим календаря — меняет только сам мастер (F-00-051)' })
  @ZodBody(calendarModeBody)
  setMode(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('staffId') staffId: string, @Body(new Zod(calendarModeBody)) body: z.infer<typeof calendarModeBody>) {
    return this.svc.setMode(ctx, businessId, staffId, body.mode);
  }

  @Get('marks')
  @Biz()
  marks(@Param('businessId') businessId: string, @Param('staffId') staffId: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.svc.marks(businessId, staffId, date(from, 'from'), date(to, 'to'));
  }

  @Post('marks')
  @Biz('schedule.edit')
  @ZodBody(markBody)
  addMark(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('staffId') staffId: string, @Body(new Zod(markBody)) body: z.infer<typeof markBody>) {
    return this.svc.addMark(ctx, businessId, staffId, body);
  }

  @Delete('marks/:id')
  @HttpCode(200)
  @Biz('schedule.edit')
  @ApiOperation({ summary: 'Снять отметку; ответ — слепок дня «до» для «Отменить»' })
  removeMark(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('staffId') staffId: string, @Param('id') id: string) {
    return this.svc.removeMark(ctx, businessId, staffId, id, true);
  }

  @Post('marks/restore')
  @HttpCode(204)
  @Biz('schedule.edit')
  @ZodBody(restoreMarksBody)
  restore(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('staffId') staffId: string, @Body(new Zod(restoreMarksBody)) body: z.infer<typeof restoreMarksBody>) {
    return this.svc.restoreMarks(ctx, businessId, staffId, body.from, body.to, body.marks);
  }

  @Post('marks/whole-day')
  @HttpCode(200)
  @Biz('schedule.edit')
  @ZodBody(oneDateBody)
  wholeDay(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('staffId') staffId: string, @Body(new Zod(oneDateBody)) body: z.infer<typeof oneDateBody>) {
    return this.svc.openWholeDay(ctx, businessId, staffId, body.date);
  }

  @Post('marks/open-week')
  @HttpCode(200)
  @Biz('schedule.edit')
  @ZodBody(fromToBody)
  openWeek(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('staffId') staffId: string, @Body(new Zod(fromToBody)) body: z.infer<typeof fromToBody>) {
    return this.svc.openWeek(ctx, businessId, staffId, body.from, body.to);
  }

  @Post('marks/range')
  @HttpCode(200)
  @Biz('schedule.edit')
  @ZodBody(rangeBody)
  range(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('staffId') staffId: string, @Body(new Zod(rangeBody)) body: z.infer<typeof rangeBody>) {
    return this.svc.markRange(ctx, businessId, staffId, body.date, body.from, body.to);
  }

  @Post('marks/copy-last-week')
  @HttpCode(200)
  @Biz('schedule.edit')
  @ZodBody(weekAnchorBody)
  copyLastWeek(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('staffId') staffId: string, @Body(new Zod(weekAnchorBody)) body: z.infer<typeof weekAnchorBody>) {
    return this.svc.copyMarksFromLastWeek(ctx, businessId, staffId, body.weekAnchor);
  }

  @Post('vacation')
  @HttpCode(200)
  @Biz('schedule.edit')
  @ApiOperation({ summary: '«В отпуске до…» (F-00-054): слепок «до» для «Отменить»' })
  @ZodBody(vacationBody)
  vacation(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('staffId') staffId: string, @Body(new Zod(vacationBody)) body: z.infer<typeof vacationBody>) {
    return this.svc.setVacation(ctx, businessId, staffId, body.until);
  }

  @Get('calendar-week')
  @Biz()
  week(@Param('businessId') businessId: string, @Param('staffId') staffId: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.svc.week(businessId, staffId, date(from, 'from'), date(to, 'to'));
  }

  @Post('calendar-day')
  @HttpCode(200)
  @Biz('schedule.edit')
  @ZodBody(calendarDayBody)
  saveDay(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('staffId') staffId: string, @Body(new Zod(calendarDayBody)) body: z.infer<typeof calendarDayBody>) {
    return this.svc.saveDay(ctx, businessId, staffId, body);
  }

  @Get('empty-next-week')
  @Biz()
  emptyNextWeek(@Param('businessId') businessId: string, @Param('staffId') staffId: string, @Query('from') from?: string) {
    return this.svc.hasEmptyNextWeek(businessId, staffId, date(from, 'from')).then((value) => ({ value }));
  }
}
