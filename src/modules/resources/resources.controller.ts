import { Body, Controller, Delete, Get, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { RequestContext } from '../../common/http/context.js';
import { Biz, Ctx } from '../../common/http/guards.js';
import { ZodBody, ZodOk } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import {
  changeLogEntryOut,
  instanceBody,
  resourceCreateBody,
  resourceOut,
  resourceServicesBody,
  resourceUpdateBody,
  restoreResourceBody,
  splitByResourceBody,
  toggleServiceBody,
} from './resources.schemas.js';
import { ResourcesService } from './resources.service.js';

/** Ресурсы: кресла, кабинеты, аппараты — /v1/biz (docs/backend/02 §9, PLAN §6 №4). Групповые события и лист
 * ожидания (F-16-036…169) — этап 7 «Журнал и записи» (нужна таблица записей/бронирований). */
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
