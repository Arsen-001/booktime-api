import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { Biz, Ctx } from '../../common/http/guards.js';
import { ZodBody } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { AvailabilityService } from '../availability/availability.service.js';
import type { SlotRule } from '../availability/engine.js';
import {
  anySpecialistQuery,
  bufferBody,
  effectiveRuleQuery,
  nearestQuery,
  quickSlotsQuery,
  scopeKind,
  serviceWindowBody,
  slotModeBody,
  slotRule,
  slotsQuery,
  togglePartBody,
  toggleSlotBody,
  unavailableBody,
  utilizationQuery,
} from './schedule.schemas.js';
import { RulesService } from './rules.service.js';
import { ScheduleService } from './schedule.service.js';

const kindOf = (v: string) => {
  const r = scopeKind.safeParse(v);
  if (!r.success) throw new ApiError('validation', 'Invalid input', { kind: 'location | staff' });
  return r.data;
};

/**
 * Свободные окна (режим сотрудника) и правила онлайн-записи (docs/backend/02 §5, 04). Окна считает сервер
 * (07 K2/B6/B21 закрыты здесь); публичные окна для клиента — этап 8/9 (`/v1/public/…`), тем же AvailabilityService.
 */
@ApiTags('slots')
@Controller('v1/biz/:businessId')
export class SlotsController {
  constructor(
    private readonly availability: AvailabilityService,
    private readonly rules: RulesService,
    private readonly schedule: ScheduleService,
  ) {}

  @Get('staff/:staffId/slots')
  @Biz('journal.view')
  @ApiOperation({ summary: 'Свободные окна мастера на дату (04 §2)' })
  slots(@Param('businessId') businessId: string, @Param('staffId') staffId: string, @Query(new Zod(slotsQuery)) q: z.infer<typeof slotsQuery>) {
    return this.availability.freeSlots(businessId, { ...q, staffId });
  }

  @Get('staff/:staffId/nearest-slots')
  @Biz('journal.view')
  nearest(@Param('businessId') businessId: string, @Param('staffId') staffId: string, @Query(new Zod(nearestQuery)) q: z.infer<typeof nearestQuery>) {
    return this.availability.nearestSlots(businessId, { ...q, staffId });
  }

  @Get('staff/:staffId/quick-slots')
  @Biz('journal.view')
  @ApiOperation({ summary: 'Окна быстрой записи мастера (F-00-060): без правил онлайн-записи, шаг 15' })
  quick(@Param('businessId') businessId: string, @Param('staffId') staffId: string, @Query(new Zod(quickSlotsQuery)) q: z.infer<typeof quickSlotsQuery>) {
    return this.availability.quickSlots(businessId, { ...q, staffId });
  }

  @Get('slots/any-specialist')
  @Biz('journal.view')
  @ApiOperation({ summary: '«Любой специалист» (F-02-079)' })
  any(@Param('businessId') businessId: string, @Query(new Zod(anySpecialistQuery)) q: z.infer<typeof anySpecialistQuery>) {
    return this.availability.anySpecialistSlots(businessId, q);
  }

  @Get('slots/utilization')
  @Biz('staff.view')
  @ApiOperation({ summary: 'Свободные и занятые слоты по мастерам за период (F-02-094)' })
  utilization(@Param('businessId') businessId: string, @Query(new Zod(utilizationQuery)) q: z.infer<typeof utilizationQuery>) {
    return this.rules.utilization(businessId, q.staffIds.split(',').filter(Boolean), q.from, q.to, q.locationId);
  }

  @Get('staff/:staffId/slot-mode')
  @Biz()
  slotMode(@Param('businessId') businessId: string, @Param('staffId') staffId: string) {
    return this.rules.slotMode(businessId, staffId).then((mode) => ({ mode }));
  }

  @Put('staff/:staffId/slot-mode')
  @HttpCode(204)
  @Biz('schedule.edit')
  @ZodBody(slotModeBody)
  setSlotMode(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('staffId') staffId: string, @Body(new Zod(slotModeBody)) body: z.infer<typeof slotModeBody>) {
    return this.rules.setSlotMode(ctx, businessId, staffId, body.locationId, body.mode);
  }

  @Get('slot-rules/effective')
  @Biz()
  effective(@Param('businessId') businessId: string, @Query(new Zod(effectiveRuleQuery)) q: z.infer<typeof effectiveRuleQuery>) {
    return this.rules.effectiveRule(businessId, q.staffId, q.locationId, q.date);
  }

  @Get('slot-rules/:kind/:id')
  @Biz()
  getRules(@Param('businessId') businessId: string, @Param('kind') kind: string, @Param('id') id: string) {
    return this.rules.rules(businessId, kindOf(kind), id);
  }

  @Put('slot-rules/:kind/:id')
  @Biz('schedule.edit')
  @ApiOperation({ summary: 'Сохранить основное правило или исключение по дням недели (F-02-045, F-02-054)' })
  @ZodBody(slotRule)
  saveRule(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('kind') kind: string, @Param('id') id: string, @Body(new Zod(slotRule)) body: z.infer<typeof slotRule>) {
    const rule: SlotRule = { ...body, leadTimeMin: body.leadTimeMin ?? undefined };
    return this.rules.saveRule(ctx, businessId, kindOf(kind), id, rule);
  }

  @Delete('slot-rules/:kind/:id/:ruleId')
  @HttpCode(204)
  @Biz('schedule.edit')
  deleteRule(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('kind') kind: string, @Param('id') id: string, @Param('ruleId') ruleId: string) {
    return this.rules.deleteRule(ctx, businessId, kindOf(kind), id, ruleId);
  }

  @Post('slot-rules/:kind/:id/:ruleId/toggle-slot')
  @HttpCode(204)
  @Biz('schedule.edit')
  @ZodBody(toggleSlotBody)
  toggleSlot(
    @Ctx() ctx: RequestContext,
    @Param('businessId') businessId: string,
    @Param('kind') kind: string,
    @Param('id') id: string,
    @Param('ruleId') ruleId: string,
    @Body(new Zod(toggleSlotBody)) body: z.infer<typeof toggleSlotBody>,
  ) {
    return this.rules.toggleSlot(ctx, businessId, kindOf(kind), id, ruleId, body.time);
  }

  @Post('slot-rules/:kind/:id/:ruleId/toggle-part')
  @HttpCode(204)
  @Biz('schedule.edit')
  @ZodBody(togglePartBody)
  togglePart(
    @Ctx() ctx: RequestContext,
    @Param('businessId') businessId: string,
    @Param('kind') kind: string,
    @Param('id') id: string,
    @Param('ruleId') ruleId: string,
    @Body(new Zod(togglePartBody)) body: z.infer<typeof togglePartBody>,
  ) {
    return this.rules.togglePart(ctx, businessId, kindOf(kind), id, ruleId, body.times, body.enable);
  }

  @Get('work-range/:kind/:id')
  @Biz()
  workRange(@Param('businessId') businessId: string, @Param('kind') kind: string, @Param('id') id: string) {
    return this.schedule.workRange(businessId, kindOf(kind), id).then((range) => ({ range }));
  }

  @Get('unavailable/:kind/:id')
  @Biz()
  unavailable(@Param('businessId') businessId: string, @Param('kind') kind: string, @Param('id') id: string) {
    return this.rules.unavailable(businessId, kindOf(kind), id);
  }

  @Post('unavailable/:kind/:id')
  @Biz('schedule.edit')
  @ZodBody(unavailableBody)
  addUnavailable(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('kind') kind: string, @Param('id') id: string, @Body(new Zod(unavailableBody)) body: z.infer<typeof unavailableBody>) {
    return this.rules.addUnavailable(ctx, businessId, kindOf(kind), id, body);
  }

  @Delete('unavailable/:kind/:id/:rangeId')
  @HttpCode(204)
  @Biz('schedule.edit')
  removeUnavailable(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('kind') kind: string, @Param('id') id: string, @Param('rangeId') rangeId: string) {
    return this.rules.removeUnavailable(ctx, businessId, kindOf(kind), id, rangeId);
  }

  @Get('buffer/:kind/:id')
  @Biz()
  buffer(@Param('businessId') businessId: string, @Param('kind') kind: string, @Param('id') id: string) {
    return this.rules.buffer(businessId, kindOf(kind), id).then((minutes) => ({ minutes }));
  }

  @Put('buffer/:kind/:id')
  @HttpCode(204)
  @Biz('schedule.edit')
  @ZodBody(bufferBody)
  setBuffer(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('kind') kind: string, @Param('id') id: string, @Body(new Zod(bufferBody)) body: z.infer<typeof bufferBody>) {
    return this.rules.setBuffer(ctx, businessId, kindOf(kind), id, body.minutes);
  }

  @Get('service-window/:serviceId')
  @Biz()
  serviceWindow(@Param('businessId') businessId: string, @Param('serviceId') serviceId: string) {
    return this.rules.serviceWindow(businessId, serviceId).then((window) => ({ window }));
  }

  @Put('service-window/:serviceId')
  @HttpCode(204)
  @Biz('services.edit')
  @ApiOperation({ summary: '«Услуга доступна ограниченное время» (F-02-067)' })
  @ZodBody(serviceWindowBody)
  setServiceWindow(@Param('businessId') businessId: string, @Param('serviceId') serviceId: string, @Body(new Zod(serviceWindowBody)) body: z.infer<typeof serviceWindowBody>) {
    return this.rules.setServiceWindow(businessId, serviceId, body);
  }

  @Delete('service-window/:serviceId')
  @HttpCode(204)
  @Biz('services.edit')
  clearServiceWindow(@Param('businessId') businessId: string, @Param('serviceId') serviceId: string) {
    return this.rules.setServiceWindow(businessId, serviceId, null);
  }

  @Get('schedule/mirror')
  @Biz()
  @ApiOperation({ summary: 'Графики, отметки, типы дня и правила бизнеса одним ответом — для зеркала фронта (PLAN §7)' })
  mirror(@Param('businessId') businessId: string) {
    return this.rules.mirror(businessId);
  }
}
