import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { RequestContext } from '../../common/http/context.js';
import { Biz, Ctx } from '../../common/http/guards.js';
import { ZodBody } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import {
  addParticipantBody,
  addParticipantExtraBody,
  bulkEventIdsBody,
  closeWaitlistEntryBody,
  createEventSeriesBody,
  createVisitScheduleBody,
  createWaitlistEntryBody,
  editSeriesDayRuleBody,
  eventExtraBody,
  eventJoinBody,
  eventParamsBody,
  extendOrShortenBody,
  notifyWaitlistBody,
  payParticipantBody,
  repeatEventBody,
  seriesDayRuleSchema,
  seriesIdsBody,
  setBookingAssistantsBody,
  transferParticipantBody,
  updateVisitScheduleBody,
  updateWaitlistEntryBody,
} from './resources-events.schemas.js';
import { ResourcesEventsService } from './resources-events.service.js';

/**
 * stage 21 (аудит фасадов, лейн «resources»): участники группового события, лист ожидания СВОЕГО экрана,
 * расписание серии по дням недели, расписание посещений, перенос участника, ассистенты/товары/оплата
 * участника — всё, чего не было на сервере для src/api/resources.ts (см. docstring resources-events.service.ts
 * и комментарий у моделей EventSeriesDef/VisitScheduleEntry/ResourcesWaitlistEntry в schema.prisma).
 * Права: как в моке фронта — большинство действий доступно любому участнику журнала (assertCan там не стоял),
 * `journal.edit` там, где мок уже требовал его для соседней функции этого же файла (saveEventTemplate),
 * `journal.reschedule` у переноса участника и `finance.edit` у денег участника — тем же кодом, что и в моке.
 */
@ApiTags('resources')
@Controller('v1/biz/:businessId/resources')
export class ResourcesEventsController {
  constructor(private readonly svc: ResourcesEventsService) {}

  // ─────────── участники группового события (F-16-044…049) ───────────

  @Get('events/:eventId/participants')
  @Biz()
  listParticipants(@Param('businessId') businessId: string, @Param('eventId') eventId: string) {
    return this.svc.listParticipants(businessId, eventId);
  }

  @Post('events/:eventId/participants')
  @Biz('journal.edit')
  @ZodBody(addParticipantBody)
  addParticipant(
    @Ctx() ctx: RequestContext,
    @Param('businessId') businessId: string,
    @Param('eventId') eventId: string,
    @Body(new Zod(addParticipantBody)) body: z.infer<typeof addParticipantBody>,
  ) {
    return this.svc.addParticipant(ctx, businessId, eventId, body);
  }

  @Delete('participants/:bookingId')
  @Biz('journal.edit')
  removeParticipant(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('bookingId') bookingId: string) {
    return this.svc.removeParticipant(ctx, businessId, bookingId).then(() => ({ value: true }));
  }

  // ─────────── повтор события по шаблону (F-16-064/065/101) ───────────

  @Post('events/repeat')
  @Biz('journal.edit')
  @ZodBody(repeatEventBody)
  repeatEvent(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(repeatEventBody)) body: z.infer<typeof repeatEventBody>) {
    return this.svc.repeatEvent(ctx, businessId, body);
  }

  // ─────────── массовое удаление/восстановление событий (F-16-066) ───────────

  @Post('events/bulk-delete')
  @Biz('journal.edit')
  @ZodBody(bulkEventIdsBody)
  bulkDelete(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(bulkEventIdsBody)) body: z.infer<typeof bulkEventIdsBody>) {
    return this.svc.bulkDelete(ctx, businessId, body.eventIds);
  }

  @Post('events/bulk-restore')
  @Biz('journal.edit')
  @ZodBody(bulkEventIdsBody)
  bulkRestore(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(bulkEventIdsBody)) body: z.infer<typeof bulkEventIdsBody>) {
    return this.svc.bulkRestore(ctx, businessId, body.eventIds);
  }

  // ─────────── параметры события (F-16-096) ───────────

  @Patch('events/:eventId/params')
  @Biz('journal.edit')
  @ZodBody(eventParamsBody)
  saveEventParams(
    @Ctx() ctx: RequestContext,
    @Param('businessId') businessId: string,
    @Param('eventId') eventId: string,
    @Body(new Zod(eventParamsBody)) body: z.infer<typeof eventParamsBody>,
  ) {
    return this.svc.saveEventParams(ctx, businessId, eventId, body);
  }

  @Get('events/count-future/:serviceId')
  @Biz()
  countFutureForService(@Param('businessId') businessId: string, @Param('serviceId') serviceId: string) {
    return this.svc.countFutureForService(businessId, serviceId).then((count) => ({ count }));
  }

  // ─────────── детали события (F-16-039) и присоединение (F-16-081/082) ───────────

  @Get('events/:eventId/extra')
  @Biz()
  getEventExtra(@Param('businessId') businessId: string, @Param('eventId') eventId: string) {
    return this.svc.getEventExtra(businessId, eventId);
  }

  @Put('events/:eventId/extra')
  @Biz('journal.edit')
  @ZodBody(eventExtraBody)
  saveEventExtra(
    @Ctx() ctx: RequestContext,
    @Param('businessId') businessId: string,
    @Param('eventId') eventId: string,
    @Body(new Zod(eventExtraBody)) body: z.infer<typeof eventExtraBody>,
  ) {
    return this.svc.saveEventExtra(ctx, businessId, eventId, body);
  }

  @Get('events/:eventId/join')
  @Biz()
  getEventJoin(@Param('businessId') businessId: string, @Param('eventId') eventId: string) {
    return this.svc.getEventJoin(businessId, eventId);
  }

  @Put('events/:eventId/join')
  @Biz('journal.edit')
  @ZodBody(eventJoinBody)
  saveEventJoin(@Param('businessId') businessId: string, @Param('eventId') eventId: string, @Body(new Zod(eventJoinBody)) body: z.infer<typeof eventJoinBody>) {
    return this.svc.saveEventJoin(businessId, eventId, body);
  }

  @Post('events/:eventId/join/notify')
  @HttpCode(200)
  @Biz('journal.edit')
  sendEventJoinNotifications(@Param('businessId') businessId: string, @Param('eventId') eventId: string) {
    return this.svc.sendEventJoinNotifications(businessId, eventId);
  }

  // ─────────── расписание серии по дням недели (F-16-067…077) ───────────

  @Get('series/:seriesId')
  @Biz()
  getSeriesDef(@Param('businessId') businessId: string, @Param('seriesId') seriesId: string) {
    return this.svc.getSeriesDef(businessId, seriesId);
  }

  @Post('series/by-ids')
  @HttpCode(200)
  @Biz()
  @ZodBody(seriesIdsBody)
  listSeriesDefsByIds(@Param('businessId') businessId: string, @Body(new Zod(seriesIdsBody)) body: z.infer<typeof seriesIdsBody>) {
    return this.svc.listSeriesDefsByIds(businessId, body.ids);
  }

  @Get('series/:seriesId/events')
  @Biz()
  listSeriesEvents(@Param('businessId') businessId: string, @Param('seriesId') seriesId: string) {
    return this.svc.listSeriesEvents(businessId, seriesId);
  }

  @Post('series')
  @Biz('journal.edit')
  @ZodBody(createEventSeriesBody)
  createEventSeries(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(createEventSeriesBody)) body: z.infer<typeof createEventSeriesBody>) {
    return this.svc.createEventSeries(ctx, businessId, body);
  }

  @Post('series/:seriesId/extend')
  @Biz('journal.edit')
  @ZodBody(extendOrShortenBody)
  extendOrShortenSeries(
    @Ctx() ctx: RequestContext,
    @Param('businessId') businessId: string,
    @Param('seriesId') seriesId: string,
    @Body(new Zod(extendOrShortenBody)) body: z.infer<typeof extendOrShortenBody>,
  ) {
    return this.svc.extendOrShortenSeries(ctx, businessId, seriesId, body.newEndDate);
  }

  @Post('series/:seriesId/weekday')
  @Biz('journal.edit')
  @ZodBody(seriesDayRuleSchema)
  addSeriesWeekday(
    @Ctx() ctx: RequestContext,
    @Param('businessId') businessId: string,
    @Param('seriesId') seriesId: string,
    @Body(new Zod(seriesDayRuleSchema)) body: z.infer<typeof seriesDayRuleSchema>,
  ) {
    return this.svc.addSeriesWeekday(ctx, businessId, seriesId, body);
  }

  @Delete('series/:seriesId/weekday/:weekday')
  @Biz('journal.edit')
  removeSeriesWeekday(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('seriesId') seriesId: string, @Param('weekday') weekday: string) {
    return this.svc.removeSeriesWeekday(ctx, businessId, seriesId, Number(weekday));
  }

  @Patch('series/:seriesId/day-rule/:weekday')
  @Biz('journal.edit')
  @ZodBody(editSeriesDayRuleBody)
  editSeriesDayRule(
    @Ctx() ctx: RequestContext,
    @Param('businessId') businessId: string,
    @Param('seriesId') seriesId: string,
    @Param('weekday') weekday: string,
    @Body(new Zod(editSeriesDayRuleBody)) body: z.infer<typeof editSeriesDayRuleBody>,
  ) {
    return this.svc.editSeriesDayRule(ctx, businessId, seriesId, Number(weekday), body.patch, body.applyToUnique);
  }

  @Delete('series/:seriesId')
  @Biz('journal.edit')
  deleteSeries(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('seriesId') seriesId: string) {
    return this.svc.deleteSeries(ctx, businessId, seriesId);
  }

  // ─────────── расписание посещений клиента (F-16-078…080) ───────────

  @Get('visit-schedules/:seriesId')
  @Biz()
  listVisitSchedules(@Param('businessId') businessId: string, @Param('seriesId') seriesId: string) {
    return this.svc.listVisitSchedules(businessId, seriesId);
  }

  @Post('visit-schedules')
  @Biz('journal.edit')
  @ZodBody(createVisitScheduleBody)
  createVisitSchedule(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(createVisitScheduleBody)) body: z.infer<typeof createVisitScheduleBody>) {
    return this.svc.createVisitSchedule(ctx, businessId, body);
  }

  @Patch('visit-schedules/:id')
  @Biz('journal.edit')
  @ZodBody(updateVisitScheduleBody)
  updateVisitSchedule(
    @Ctx() ctx: RequestContext,
    @Param('businessId') businessId: string,
    @Param('id') id: string,
    @Body(new Zod(updateVisitScheduleBody)) body: z.infer<typeof updateVisitScheduleBody>,
  ) {
    return this.svc.updateVisitSchedule(ctx, businessId, id, body.weekdays);
  }

  @Delete('visit-schedules/:id')
  @Biz('journal.edit')
  deleteVisitSchedule(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('id') id: string) {
    return this.svc.deleteVisitSchedule(ctx, businessId, id).then(() => ({ value: true }));
  }

  // ─────────── лист ожидания СВОЕГО экрана (F-16-149…168) ───────────

  @Get('waitlist')
  @Biz()
  listWaitlist(@Param('businessId') businessId: string) {
    return this.svc.listWaitlist(businessId);
  }

  @Post('waitlist')
  @Biz('journal.edit')
  @ZodBody(createWaitlistEntryBody)
  createWaitlistEntry(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(createWaitlistEntryBody)) body: z.infer<typeof createWaitlistEntryBody>) {
    return this.svc.createWaitlistEntry(ctx, businessId, body);
  }

  @Patch('waitlist/:id')
  @Biz('journal.edit')
  @ZodBody(updateWaitlistEntryBody)
  updateWaitlistEntry(
    @Ctx() ctx: RequestContext,
    @Param('businessId') businessId: string,
    @Param('id') id: string,
    @Body(new Zod(updateWaitlistEntryBody)) body: z.infer<typeof updateWaitlistEntryBody>,
  ) {
    return this.svc.updateWaitlistEntry(ctx, businessId, id, body);
  }

  @Post('waitlist/:id/close')
  @Biz('journal.edit')
  @ZodBody(closeWaitlistEntryBody)
  closeWaitlistEntry(
    @Ctx() ctx: RequestContext,
    @Param('businessId') businessId: string,
    @Param('id') id: string,
    @Body(new Zod(closeWaitlistEntryBody)) body: z.infer<typeof closeWaitlistEntryBody>,
  ) {
    return this.svc.closeWaitlistEntry(ctx, businessId, id, body.bookingId);
  }

  @Delete('waitlist/:id')
  @Biz('journal.edit')
  removeWaitlistEntry(@Param('businessId') businessId: string, @Param('id') id: string) {
    return this.svc.removeWaitlistEntry(businessId, id).then(() => ({ value: true }));
  }

  @Post('waitlist/notify')
  @HttpCode(200)
  @Biz('journal.edit')
  @ZodBody(notifyWaitlistBody)
  notifyWaitlistForFreedSlot(@Param('businessId') businessId: string, @Body(new Zod(notifyWaitlistBody)) body: z.infer<typeof notifyWaitlistBody>) {
    return this.svc.notifyWaitlistForFreedSlot(businessId, body.serviceId, body.date, body.staffId);
  }

  @Get('waitlist/:id/notifications')
  @Biz()
  getWaitlistNotifications(@Param('businessId') businessId: string, @Param('id') id: string) {
    return this.svc.getWaitlistNotifications(businessId, id);
  }

  // ─────────── перенос брони в другое событие (F-16-055) ───────────

  @Get('transfer-targets')
  @Biz()
  listTransferTargets(@Param('businessId') businessId: string, @Query('serviceId') serviceId: string, @Query('excludeEventId') excludeEventId: string) {
    return this.svc.listTransferTargets(businessId, serviceId, excludeEventId);
  }

  @Post('participants/:bookingId/transfer')
  @Biz('journal.reschedule')
  @ZodBody(transferParticipantBody)
  transferParticipant(
    @Param('businessId') businessId: string,
    @Param('bookingId') bookingId: string,
    @Body(new Zod(transferParticipantBody)) body: z.infer<typeof transferParticipantBody>,
  ) {
    return this.svc.transferParticipant(businessId, bookingId, body.targetEventId);
  }

  // ─────────── ассистенты строки записи (F-16-142/143) ───────────

  @Get('bookings/:bookingId/assistants/:serviceIndex')
  @Biz()
  getBookingAssistants(@Param('businessId') businessId: string, @Param('bookingId') bookingId: string, @Param('serviceIndex') serviceIndex: string) {
    return this.svc.getBookingAssistants(businessId, bookingId, Number(serviceIndex));
  }

  @Put('bookings/:bookingId/assistants/:serviceIndex')
  @Biz('resources.manage')
  @ZodBody(setBookingAssistantsBody)
  setBookingAssistants(
    @Param('businessId') businessId: string,
    @Param('bookingId') bookingId: string,
    @Param('serviceIndex') serviceIndex: string,
    @Body(new Zod(setBookingAssistantsBody)) body: z.infer<typeof setBookingAssistantsBody>,
  ) {
    return this.svc.setBookingAssistants(businessId, bookingId, Number(serviceIndex), body.assistants, body.shareRule);
  }

  // ─────────── товар/абонемент/сертификат участника (F-16-059) ───────────

  @Get('bookings/:bookingId/extras')
  @Biz()
  listParticipantExtras(@Param('businessId') businessId: string, @Param('bookingId') bookingId: string) {
    return this.svc.listParticipantExtras(businessId, bookingId);
  }

  @Post('bookings/:bookingId/extras')
  @Biz('finance.edit')
  @ZodBody(addParticipantExtraBody)
  addParticipantExtra(
    @Param('businessId') businessId: string,
    @Param('bookingId') bookingId: string,
    @Body(new Zod(addParticipantExtraBody)) body: z.infer<typeof addParticipantExtraBody>,
  ) {
    return this.svc.addParticipantExtra(businessId, bookingId, body.kind, body.name, body.price);
  }

  @Delete('bookings/:bookingId/extras/:itemId')
  @Biz('finance.edit')
  removeParticipantExtra(@Param('businessId') businessId: string, @Param('bookingId') bookingId: string, @Param('itemId') itemId: string) {
    return this.svc.removeParticipantExtra(businessId, bookingId, itemId).then(() => ({ value: true }));
  }

  // ─────────── оплата участника (F-16-060/061) ───────────

  @Get('bookings/:bookingId/payment')
  @Biz()
  getParticipantPayment(@Param('businessId') businessId: string, @Param('bookingId') bookingId: string) {
    return this.svc.getParticipantPayment(businessId, bookingId);
  }

  @Post('bookings/:bookingId/payment')
  @Biz('finance.edit')
  @ZodBody(payParticipantBody)
  payParticipant(@Param('businessId') businessId: string, @Param('bookingId') bookingId: string, @Body(new Zod(payParticipantBody)) body: z.infer<typeof payParticipantBody>) {
    return this.svc.payParticipant(businessId, bookingId, body.method);
  }

  @Delete('bookings/:bookingId/payment')
  @Biz('finance.edit')
  cancelParticipantPayment(@Param('businessId') businessId: string, @Param('bookingId') bookingId: string) {
    return this.svc.cancelParticipantPayment(businessId, bookingId);
  }
}
