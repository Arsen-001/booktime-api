import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { RequestContext } from '../../common/http/context.js';
import { Biz, Ctx } from '../../common/http/guards.js';
import { ZodBody } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { isLocalDate } from '../../common/time/time.js';
import { ApiError } from '../../common/errors/api-error.js';
import {
  addWorkDaysBody,
  affectedBody,
  copyBody,
  copyLastWeekBody,
  dayInfoBody,
  deleteCellsBody,
  hasSavedBody,
  journalViewBody,
  moveCandidatesBody,
  oneDateBody,
  removeFromScheduleBody,
  restoreAfterRemoveBody,
  restoreCellsBody,
  setCellsBody,
  settingsPatch,
  snapshotBody,
  tableBody,
  templateBody,
  templatePatch,
} from './schedule.schemas.js';
import { ScheduleService } from './schedule.service.js';

const date = (v: string | undefined, name: string) => {
  if (!isLocalDate(v)) throw new ApiError('validation', 'Invalid input', { [name]: 'YYYY-MM-DD' });
  return v;
};

/** График: таблица, ячейки, шаблоны, копирование, история, настройки (docs/backend/02 §5, PLAN §6 №6) */
@ApiTags('schedule')
@Controller('v1/biz/:businessId')
export class ScheduleController {
  constructor(private readonly svc: ScheduleService) {}

  @Post('schedule/table')
  @HttpCode(200)
  @Biz()
  @ApiOperation({ summary: 'Таблица «Сотрудники × дни» с фильтрами (F-02-002/003); без staff.view — только своя строка' })
  @ZodBody(tableBody)
  table(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(tableBody)) body: z.infer<typeof tableBody>) {
    const m = ctx.member!;
    const self = !m.permissions.has('staff.view') && !m.permissions.has('journal.others');
    return this.svc.table(businessId, self ? { ...body, filters: { ...body.filters, staffIds: [m.staffId] } } : body);
  }

  @Post('schedule/has-saved')
  @HttpCode(200)
  @Biz()
  @ZodBody(hasSavedBody)
  hasSaved(@Param('businessId') businessId: string, @Body(new Zod(hasSavedBody)) body: z.infer<typeof hasSavedBody>) {
    return this.svc.hasSavedSchedule(businessId, body.staffIds).then((value) => ({ value }));
  }

  @Post('schedule/affected')
  @HttpCode(200)
  @Biz()
  @ApiOperation({ summary: 'Записи, задетые правкой графика (F-02-106)' })
  @ZodBody(affectedBody)
  affected(@Param('businessId') businessId: string, @Body(new Zod(affectedBody)) body: z.infer<typeof affectedBody>) {
    return this.svc.findAffected(this.svc.prisma, businessId, body.staffIds, body.dates, body.newHours);
  }

  // === stage 21 (лейн services+rest) ===

  @Post('schedule/day-info')
  @HttpCode(200)
  @Biz('journal.view')
  @ApiOperation({ summary: 'Тип и заметка дня сотрудников на дату — колонка журнала (Г3, Г16)' })
  @ZodBody(dayInfoBody)
  dayInfo(@Param('businessId') businessId: string, @Body(new Zod(dayInfoBody)) body: z.infer<typeof dayInfoBody>) {
    return this.svc.getStaffDayInfo(businessId, body.staffIds, body.date);
  }

  @Post('schedule/move-candidates')
  @HttpCode(200)
  @Biz('journal.edit')
  @ApiOperation({ summary: 'Кому передать записи закрываемого дня (Г3)' })
  @ZodBody(moveCandidatesBody)
  moveCandidates(@Param('businessId') businessId: string, @Body(new Zod(moveCandidatesBody)) body: z.infer<typeof moveCandidatesBody>) {
    return this.svc.getMoveCandidates(businessId, body.bookingIds);
  }

  @Put('schedule/cells')
  @Biz('schedule.edit')
  @ZodBody(setCellsBody)
  setCells(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(setCellsBody)) body: z.infer<typeof setCellsBody>) {
    return this.svc.setCells(ctx, businessId, body);
  }

  @Post('schedule/cells/apply')
  @HttpCode(200)
  @Biz('schedule.edit')
  @ApiOperation({ summary: 'Проверка записей + слепок «до» + запись одним запросом; ok=false — задетые записи (A7)' })
  @ZodBody(setCellsBody)
  apply(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(setCellsBody)) body: z.infer<typeof setCellsBody>) {
    return this.svc.applyCells(ctx, businessId, body);
  }

  @Post('schedule/cells/delete')
  @HttpCode(200)
  @Biz('schedule.edit')
  @ApiOperation({ summary: 'Удалить рабочие дни (F-02-014); без force при записях — 409 schedule_has_bookings' })
  @ZodBody(deleteCellsBody)
  deleteCells(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(deleteCellsBody)) body: z.infer<typeof deleteCellsBody>) {
    return this.svc.deleteCells(ctx, businessId, body);
  }

  @Post('schedule/cells/snapshot')
  @HttpCode(200)
  @Biz()
  @ZodBody(snapshotBody)
  snapshot(@Param('businessId') businessId: string, @Body(new Zod(snapshotBody)) body: z.infer<typeof snapshotBody>) {
    return this.svc.snapshotCells(businessId, body.staffIds, body.dates);
  }

  @Post('schedule/cells/restore')
  @HttpCode(204)
  @Biz('schedule.edit')
  @ApiOperation({ summary: '«Отменить» правку графика (F-00-061): слепок держит экран' })
  @ZodBody(restoreCellsBody)
  restore(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(restoreCellsBody)) body: z.infer<typeof restoreCellsBody>) {
    return this.svc.restoreCells(ctx, businessId, body.snapshot);
  }

  @Post('schedule/copy')
  @HttpCode(204)
  @Biz('schedule.edit')
  @ZodBody(copyBody)
  copy(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(copyBody)) body: z.infer<typeof copyBody>) {
    return this.svc.copySchedule(ctx, businessId, body);
  }

  @Post('schedule/copy-last-week')
  @HttpCode(204)
  @Biz('schedule.edit')
  @ZodBody(copyLastWeekBody)
  copyLastWeek(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(copyLastWeekBody)) body: z.infer<typeof copyLastWeekBody>) {
    return this.svc.copyFromLastWeek(ctx, businessId, body.staffId, body.weekAnchor);
  }

  @Get('schedule/templates')
  @Biz()
  templates(@Param('businessId') businessId: string) {
    return this.svc.templates(businessId);
  }

  @Post('schedule/templates')
  @Biz('schedule.edit')
  @ZodBody(templateBody)
  createTemplate(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(templateBody)) body: z.infer<typeof templateBody>) {
    return this.svc.createTemplate(ctx, businessId, body);
  }

  @Patch('schedule/templates/:id')
  @HttpCode(204)
  @Biz('schedule.edit')
  @ZodBody(templatePatch)
  updateTemplate(@Param('businessId') businessId: string, @Param('id') id: string, @Body(new Zod(templatePatch)) body: z.infer<typeof templatePatch>) {
    return this.svc.updateTemplate(businessId, id, body);
  }

  @Delete('schedule/templates/:id')
  @HttpCode(204)
  @Biz('schedule.edit')
  deleteTemplate(@Param('businessId') businessId: string, @Param('id') id: string) {
    return this.svc.deleteTemplate(businessId, id);
  }

  @Get('schedule/history')
  @Biz('staff.view')
  @ApiOperation({ summary: 'История правок графика и правил окон (F-02-102)' })
  history(@Param('businessId') businessId: string, @Query('staffIds') staffIds?: string) {
    return this.svc.history(businessId, staffIds ? staffIds.split(',').filter(Boolean) : undefined);
  }

  @Get('schedule/settings')
  @Biz()
  settings(@Param('businessId') businessId: string) {
    return this.svc.settings(businessId);
  }

  @Patch('schedule/settings')
  @Biz('schedule.edit')
  @ApiOperation({ summary: 'Настройки раздела; в картах по сотруднику null снимает ключ' })
  @ZodBody(settingsPatch)
  patchSettings(@Param('businessId') businessId: string, @Body(new Zod(settingsPatch)) body: z.infer<typeof settingsPatch>) {
    return this.svc.patchSettings(businessId, body);
  }

  // ─────────── сотрудник ───────────

  @Put('staff/:staffId/journal-view')
  @HttpCode(204)
  @Biz('staff.manage')
  @ApiOperation({ summary: 'Колонка в журнале: скрыть (F-02-082) и шаг разметки (F-02-083)' })
  @ZodBody(journalViewBody)
  journalView(@Param('businessId') businessId: string, @Param('staffId') staffId: string, @Body(new Zod(journalViewBody)) body: z.infer<typeof journalViewBody>) {
    return this.svc.setJournalView(businessId, staffId, body);
  }

  @Get('staff/:staffId/hours')
  @Biz()
  @ApiOperation({ summary: 'Часы по дням, сумма минут и конец графика (getDayHours/getWorkDays/getScheduledMinutes/getScheduleEnd)' })
  hours(
    @Param('businessId') businessId: string,
    @Param('staffId') staffId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('locationId') locationId?: string,
  ) {
    const f = date(from, 'from');
    return this.svc.hours(businessId, staffId, f, to ? date(to, 'to') : f, locationId || undefined);
  }

  @Post('staff/:staffId/work-day-with-undo')
  @HttpCode(200)
  @Biz('schedule.edit')
  @ZodBody(oneDateBody)
  addWorkDayWithUndo(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('staffId') staffId: string, @Body(new Zod(oneDateBody)) body: z.infer<typeof oneDateBody>) {
    return this.svc.addWorkDayWithUndo(ctx, businessId, staffId, body.date);
  }

  @Post('staff/:staffId/work-days')
  @HttpCode(200)
  @Biz('schedule.edit')
  @ZodBody(addWorkDaysBody)
  addWorkDays(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('staffId') staffId: string, @Body(new Zod(addWorkDaysBody)) body: z.infer<typeof addWorkDaysBody>) {
    return this.svc.addWorkDays(ctx, businessId, staffId, body);
  }

  @Get('staff/:staffId/remove-from-schedule')
  @Biz()
  removePreview(@Param('businessId') businessId: string, @Param('staffId') staffId: string) {
    return this.svc.previewRemove(businessId, staffId).then((affected) => ({ affected }));
  }

  @Post('staff/:staffId/remove-from-schedule')
  @HttpCode(200)
  @Biz('schedule.edit')
  @ApiOperation({ summary: '«Убрать из графика» (F-02-020): будущие записи без force — ok=false и их число' })
  @ZodBody(removeFromScheduleBody)
  remove(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('staffId') staffId: string, @Body(new Zod(removeFromScheduleBody)) body: z.infer<typeof removeFromScheduleBody>) {
    return this.svc.removeFromSchedule(ctx, businessId, staffId, body.force);
  }

  @Post('staff/:staffId/remove-from-schedule/restore')
  @HttpCode(204)
  @Biz('schedule.edit')
  @ZodBody(restoreAfterRemoveBody)
  restoreRemove(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('staffId') staffId: string, @Body(new Zod(restoreAfterRemoveBody)) body: z.infer<typeof restoreAfterRemoveBody>) {
    return this.svc.restoreAfterRemove(ctx, businessId, staffId, body.snapshot);
  }
}
