import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { RequestContext } from '../../common/http/context.js';
import { Biz, Ctx } from '../../common/http/guards.js';
import { ZodBody, ZodOk } from '../../common/http/openapi.js';
import { localToUtc } from '../../common/time/time.js';
import { Zod } from '../../common/http/validation.js';
import {
  assistantSettingsBody,
  changeLogEntryOut,
  checkInstancesFreeBody,
  createAssistantBody,
  eventCategoryBody,
  eventTemplateBody,
  fineRightsBody,
  freeInstancesBody,
  groupSeatsSettingsBody,
  groupServicePaymentBody,
  instanceBody,
  resourceCreateBody,
  resourceOptionsBody,
  resourceOut,
  resourceServicesBody,
  resourceUpdateBody,
  restoreResourceBody,
  splitByResourceBody,
  staffEligibleBody,
  toggleServiceBody,
} from './resources.schemas.js';
import { ResourcesService } from './resources.service.js';

/** Ресурсы: кресла, кабинеты, аппараты — /v1/biz (docs/backend/02 §9, PLAN §6 №4). Групповые события и лист
 * ожидания (F-16-036…169) — модуль journal (этап 7): /events, /waitlist, участники — записи с group_event_id. */
@ApiTags('resources')
@Controller('v1/biz/:businessId/resources')
export class ResourcesController {
  constructor(private readonly svc: ResourcesService) {}

  @Get('split-by-resource')
  @Biz()
  @ApiOperation({ summary: '«Разделять запись с услугами, использующими разные ресурсы» (F-16-016)' })
  getSplit(@Param('businessId') businessId: string) {
    return this.svc.getSplitByResource(businessId).then((value) => ({ value }));
  }

  @Put('split-by-resource')
  @Biz('resources.manage')
  @ZodBody(splitByResourceBody)
  setSplit(@Param('businessId') businessId: string, @Body(new Zod(splitByResourceBody)) body: z.infer<typeof splitByResourceBody>) {
    return this.svc.setSplitByResource(businessId, body.value).then((value) => ({ value }));
  }

  @Get('changelog')
  @Biz('resources.manage')
  @ZodOk(z.array(changeLogEntryOut))
  changelog(@Param('businessId') businessId: string) {
    return this.svc.changelog(businessId);
  }

  @Post('restore')
  @Biz('resources.manage')
  @ApiOperation({ summary: '«Отменить» удаление ресурса (F-00-061): восстанавливает тем же id' })
  @ZodBody(restoreResourceBody)
  @ZodOk(resourceOut)
  restore(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(restoreResourceBody)) body: z.infer<typeof restoreResourceBody>) {
    return this.svc.restore(ctx, businessId, body);
  }

  @Get('for-service/:serviceId')
  @Biz()
  @ApiOperation({ summary: 'Ресурсы, привязанные к услуге — вклад в карточку услуги (F-16-006)' })
  @ZodOk(z.array(resourceOut))
  listForService(@Param('businessId') businessId: string, @Param('serviceId') serviceId: string) {
    return this.svc.listForService(businessId, serviceId);
  }

  // ─────────── stage 21: окно записи — подбор/проверка свободных экземпляров (F-16-011…013) ───────────
  // Литеральные сегменты объявлены ДО `:id`/`@Get()` ниже — иначе Nest принял бы их за id ресурса.

  @Post('free-instances')
  @HttpCode(200)
  @Biz()
  @ApiOperation({ summary: 'По одному свободному экземпляру каждого ресурса услуги (F-16-011/012)' })
  @ZodBody(freeInstancesBody)
  async freeInstances(@Param('businessId') businessId: string, @Body(new Zod(freeInstancesBody)) body: z.infer<typeof freeInstancesBody>) {
    const tz = await this.svc.tzOfBusiness(businessId);
    return this.svc.pickFreeInstances(businessId, body.serviceIds, localToUtc(body.start, tz), body.durationMin, body.excludeBookingId);
  }

  @Post('check-instances-free')
  @HttpCode(200)
  @Biz()
  @ApiOperation({ summary: 'Выбранные вручную экземпляры всё ещё свободны? (F-16-013)' })
  @ZodBody(checkInstancesFreeBody)
  async checkFree(@Param('businessId') businessId: string, @Body(new Zod(checkInstancesFreeBody)) body: z.infer<typeof checkInstancesFreeBody>) {
    const tz = await this.svc.tzOfBusiness(businessId);
    return { value: await this.svc.checkInstancesFree(businessId, body.instanceIds, localToUtc(body.start, tz), body.durationMin, body.excludeBookingId) };
  }

  @Post('options')
  @HttpCode(200)
  @Biz()
  @ApiOperation({ summary: 'Все активные ресурсы с отметкой занятых сейчас экземпляров (F-16-013)' })
  @ZodBody(resourceOptionsBody)
  async options(@Param('businessId') businessId: string, @Body(new Zod(resourceOptionsBody)) body: z.infer<typeof resourceOptionsBody>) {
    const tz = await this.svc.tzOfBusiness(businessId);
    return this.svc.listResourceOptions(businessId, localToUtc(body.start, tz), body.durationMin, body.excludeBookingId);
  }

  // ─────────── stage 21: ассистенты (F-16-136…147) ───────────

  @Get('assistant-settings')
  @Biz()
  getAssistantSettings(@Param('businessId') businessId: string) {
    return this.svc.getAssistantSettings(businessId);
  }

  @Put('assistant-settings')
  @Biz('resources.manage')
  @ZodBody(assistantSettingsBody)
  saveAssistantSettings(@Param('businessId') businessId: string, @Body(new Zod(assistantSettingsBody)) body: z.infer<typeof assistantSettingsBody>) {
    return this.svc.saveAssistantSettings(businessId, body);
  }

  @Get('assistant-staff')
  @Biz()
  listAssistantStaff(@Param('businessId') businessId: string) {
    return this.svc.listAssistantStaff(businessId);
  }

  @Put('assistant-staff/:staffId')
  @Biz('resources.manage')
  @ZodBody(staffEligibleBody)
  setStaffAssistantEligible(@Param('businessId') businessId: string, @Param('staffId') staffId: string, @Body(new Zod(staffEligibleBody)) body: z.infer<typeof staffEligibleBody>) {
    return this.svc.setStaffAssistantEligible(businessId, staffId, body.value);
  }

  @Post('create-assistant')
  @Biz('resources.manage')
  @ApiOperation({ summary: 'F-09-044/F-16-137/139: короткий путь для минимального помощника без графика' })
  @ZodBody(createAssistantBody)
  createAssistant(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(createAssistantBody)) body: z.infer<typeof createAssistantBody>) {
    return this.svc.createAssistant(ctx, businessId, body.locationId, body.name, body.phone);
  }

  // ─────────── stage 21: тонкие права раздела (F-16-026, F-16-144, F-16-169) ───────────

  @Get('staff-rights/:staffId')
  @Biz()
  getStaffResourcesRights(@Param('businessId') businessId: string, @Param('staffId') staffId: string) {
    return this.svc.getStaffResourcesRights(businessId, staffId);
  }

  @Put('staff-rights/:staffId')
  @Biz('resources.manage')
  @ZodBody(fineRightsBody)
  setStaffResourcesRights(@Param('businessId') businessId: string, @Param('staffId') staffId: string, @Body(new Zod(fineRightsBody)) body: z.infer<typeof fineRightsBody>) {
    return this.svc.setStaffResourcesRights(businessId, staffId, body);
  }

  // ─────────── stage 21: несколько мест для клиента (F-16-049) ───────────

  @Get('group-seats-settings')
  @Biz()
  getGroupSeatsSettings(@Param('businessId') businessId: string) {
    return this.svc.getGroupSeatsSettings(businessId);
  }

  @Put('group-seats-settings')
  @Biz('resources.manage')
  @ZodBody(groupSeatsSettingsBody)
  saveGroupSeatsSettings(@Param('businessId') businessId: string, @Body(new Zod(groupSeatsSettingsBody)) body: z.infer<typeof groupSeatsSettingsBody>) {
    return this.svc.saveGroupSeatsSettings(businessId, body);
  }

  // ─────────── stage 21: шаблоны повтора события (F-16-064/065/101) ───────────

  @Get('event-templates')
  @Biz()
  listEventTemplates(@Param('businessId') businessId: string) {
    return this.svc.listEventTemplates(businessId);
  }

  @Post('event-templates')
  @Biz('journal.edit')
  @ZodBody(eventTemplateBody)
  saveEventTemplate(@Param('businessId') businessId: string, @Body(new Zod(eventTemplateBody)) body: z.infer<typeof eventTemplateBody>) {
    return this.svc.saveEventTemplate(businessId, body);
  }

  // ─────────── stage 21: категории событий (F-16-043) ───────────

  @Get('event-categories')
  @Biz()
  listEventCategories(@Param('businessId') businessId: string) {
    return this.svc.listEventCategories(businessId);
  }

  @Post('event-categories')
  @Biz('resources.manage')
  @ZodBody(eventCategoryBody)
  createEventCategory(@Param('businessId') businessId: string, @Body(new Zod(eventCategoryBody)) body: z.infer<typeof eventCategoryBody>) {
    return this.svc.createEventCategory(businessId, body.name, body.colorIndex);
  }

  @Patch('event-categories/:id')
  @Biz('resources.manage')
  @ZodBody(eventCategoryBody)
  updateEventCategory(@Param('businessId') businessId: string, @Param('id') id: string, @Body(new Zod(eventCategoryBody)) body: z.infer<typeof eventCategoryBody>) {
    return this.svc.updateEventCategory(businessId, id, body);
  }

  @Delete('event-categories/:id')
  @Biz('resources.manage')
  deleteEventCategory(@Param('businessId') businessId: string, @Param('id') id: string) {
    return this.svc.deleteEventCategory(businessId, id);
  }

  // ─────────── stage 21: предоплата и абонемент у групповой услуги (F-16-031) ───────────

  @Get('group-service-payment/:serviceId')
  @Biz()
  getGroupServicePayment(@Param('businessId') businessId: string, @Param('serviceId') serviceId: string) {
    return this.svc.getGroupServicePayment(businessId, serviceId);
  }

  @Put('group-service-payment/:serviceId')
  @Biz('services.edit')
  @ZodBody(groupServicePaymentBody)
  setGroupServicePayment(@Param('businessId') businessId: string, @Param('serviceId') serviceId: string, @Body(new Zod(groupServicePaymentBody)) body: z.infer<typeof groupServicePaymentBody>) {
    return this.svc.setGroupServicePayment(businessId, serviceId, body);
  }

  @Get()
  @Biz()
  @ZodOk(z.array(resourceOut))
  list(@Param('businessId') businessId: string) {
    return this.svc.list(businessId);
  }

  @Post()
  @Biz('resources.manage')
  @ZodBody(resourceCreateBody)
  @ZodOk(resourceOut)
  create(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(resourceCreateBody)) body: z.infer<typeof resourceCreateBody>) {
    return this.svc.create(ctx, businessId, body);
  }

  @Get(':id')
  @Biz()
  @ZodOk(resourceOut)
  get(@Param('businessId') businessId: string, @Param('id') id: string) {
    return this.svc.get(businessId, id);
  }

  @Patch(':id')
  @Biz('resources.manage')
  @ZodBody(resourceUpdateBody)
  @ZodOk(resourceOut)
  update(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('id') id: string, @Body(new Zod(resourceUpdateBody)) body: z.infer<typeof resourceUpdateBody>) {
    return this.svc.update(ctx, businessId, id, body);
  }

  @Get(':id/future-usage')
  @Biz()
  futureUsage(@Param('businessId') businessId: string, @Param('id') id: string) {
    return this.svc.countFutureUsage(businessId, id).then((count) => ({ count }));
  }

  @Delete(':id')
  @Biz('resources.manage')
  @ZodOk(resourceOut)
  remove(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('id') id: string) {
    return this.svc.delete(ctx, businessId, id);
  }

  @Post(':id/instances')
  @Biz('resources.manage')
  @ZodBody(instanceBody)
  @ZodOk(resourceOut)
  addInstance(@Param('businessId') businessId: string, @Param('id') id: string, @Body(new Zod(instanceBody)) body: z.infer<typeof instanceBody>) {
    return this.svc.addInstance(businessId, id, body.name);
  }

  @Patch(':id/instances/:instanceId')
  @Biz('resources.manage')
  @ZodBody(instanceBody)
  @ZodOk(resourceOut)
  renameInstance(
    @Param('businessId') businessId: string,
    @Param('id') id: string,
    @Param('instanceId') instanceId: string,
    @Body(new Zod(instanceBody)) body: z.infer<typeof instanceBody>,
  ) {
    return this.svc.renameInstance(businessId, id, instanceId, body.name);
  }

  @Delete(':id/instances/:instanceId')
  @Biz('resources.manage')
  @ZodOk(resourceOut)
  removeInstance(@Param('businessId') businessId: string, @Param('id') id: string, @Param('instanceId') instanceId: string) {
    return this.svc.removeInstance(businessId, id, instanceId);
  }

  @Put(':id/services')
  @Biz('resources.manage')
  @ZodBody(resourceServicesBody)
  @ZodOk(resourceOut)
  setServices(@Param('businessId') businessId: string, @Param('id') id: string, @Body(new Zod(resourceServicesBody)) body: z.infer<typeof resourceServicesBody>) {
    return this.svc.setServices(businessId, id, body.serviceIds);
  }

  @Put(':id/services/:serviceId')
  @Biz('resources.manage')
  @ZodBody(toggleServiceBody)
  @ZodOk(resourceOut)
  toggleService(
    @Param('businessId') businessId: string,
    @Param('id') id: string,
    @Param('serviceId') serviceId: string,
    @Body(new Zod(toggleServiceBody)) body: z.infer<typeof toggleServiceBody>,
  ) {
    return this.svc.toggleService(businessId, id, serviceId, body.linked);
  }
}
