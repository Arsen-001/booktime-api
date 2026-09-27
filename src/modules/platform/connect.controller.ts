import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { Idempotent } from '../../common/idempotency/idempotency.js';
import type { RequestContext } from '../../common/http/context.js';
import { Ctx, Platform } from '../../common/http/guards.js';
import { Zod } from '../../common/http/validation.js';
import { ConnectService } from './connect.service.js';
import { connectDraftPatchBody, connectFinishBody, connectInviteInputBody, connectStartBody } from './platform.schemas.js';

/** Наша панель: подключение салона на визите за 10 минут (docs/backend/02 §19, 06 §1; F-00-176). */
@ApiTags('platform-connect')
@Controller('v1/platform/connect-drafts')
export class PlatformConnectController {
  constructor(private readonly connect: ConnectService) {}

  @Get()
  @Platform()
  list() {
    return this.connect.list();
  }

  @Get(':id')
  @Platform()
  get(@Param('id') id: string) {
    return this.connect.get(id);
  }

  @Post()
  @Platform()
  @ApiOperation({ summary: 'Новый черновик; из карточки визита — сразу с его названием/контактом/районом/сферой' })
  start(@Ctx() ctx: RequestContext, @Body(new Zod(connectStartBody)) body: z.infer<typeof connectStartBody>) {
    return this.connect.start(ctx, body);
  }

  @Put(':id')
  @Platform()
  @ApiOperation({ summary: 'Сохранить поля шага; смена сферы подставляет её услуги, все отмечены' })
  save(@Param('id') id: string, @Body(new Zod(connectDraftPatchBody)) body: z.infer<typeof connectDraftPatchBody>) {
    return this.connect.save(id, body);
  }

  @Delete(':id')
  @Platform()
  @HttpCode(204)
  delete(@Param('id') id: string) {
    return this.connect.delete(id);
  }

  @Post(':id/invites')
  @Platform()
  addInvite(@Param('id') id: string, @Body(new Zod(connectInviteInputBody)) body: z.infer<typeof connectInviteInputBody>) {
    return this.connect.addInvite(id, body);
  }

  @Delete(':id/invites/:inviteId')
  @Platform()
  removeInvite(@Param('id') id: string, @Param('inviteId') inviteId: string) {
    return this.connect.removeInvite(id, inviteId);
  }

  @Post(':id/finish')
  @Platform()
  @Idempotent()
  @ApiOperation({ summary: 'Подключить: бизнес+филиал+владелец+мастера+услуги+часы+фото+бесплатный месяц+промокод одной транзакцией' })
  finish(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(connectFinishBody)) body: z.infer<typeof connectFinishBody>) {
    return this.connect.finish(ctx, id, body);
  }
}

/** Итог подключения для экрана «передать владельцу» — переживает перезагрузку (`?done=<businessId>`) */
@ApiTags('platform-connect')
@Controller('v1/platform/connect-result')
export class PlatformConnectResultController {
  constructor(private readonly connect: ConnectService) {}

  @Get(':businessId')
  @Platform()
  result(@Param('businessId') businessId: string) {
    return this.connect.getResult(businessId);
  }
}
