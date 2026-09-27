import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import type { RequestContext } from '../../common/http/context.js';
import { Authed, Biz, Ctx, Platform } from '../../common/http/guards.js';
import { Zod } from '../../common/http/validation.js';
import {
  moderationBulkIdsBody,
  moderationBulkRejectBody,
  moderationListQuery,
  moderationRefIdBody,
  moderationSubmitBody,
  rejectBody,
  rejectReasonBody,
} from './platform.schemas.js';
import { ModerationService } from './moderation.service.js';

/** Наша панель: очередь проверки (docs/backend/02 §19, 06 §1). */
@ApiTags('platform-moderation')
@Controller('v1/platform')
export class PlatformModerationController {
  constructor(private readonly moderation: ModerationService) {}

  @Get('moderation')
  @Platform()
  list(@Query(new Zod(moderationListQuery)) q: z.infer<typeof moderationListQuery>) {
    return this.moderation.list(q);
  }

  @Get('moderation/counts')
  @Platform()
  counts() {
    return this.moderation.counts();
  }

  @Post('moderation/:id/approve')
  @Platform()
  approve(@Param('id') id: string) {
    return this.moderation.approve(id);
  }

  @Post('moderation/:id/reject')
  @Platform()
  @ApiOperation({ summary: 'Отклонить с причиной (F-00-170) — платное возвращает монеты' })
  reject(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(rejectBody)) body: z.infer<typeof rejectBody>) {
    return this.moderation.reject(id, body.reasonId, body.note, ctx.session!.userId);
  }

  @Post('moderation/:id/reopen')
  @Platform()
  reopen(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.moderation.reopen(id, ctx.session!.userId);
  }

  /** Пачка из очереди (галочки), этап 21 лейн rest — было: панель звала одиночные /approve параллельно */
  @Post('moderation/bulk/approve')
  @Platform()
  @ApiOperation({ summary: 'Одобрить несколько материалов сразу; уже решённые пропускаются' })
  bulkApprove(@Body(new Zod(moderationBulkIdsBody)) body: z.infer<typeof moderationBulkIdsBody>) {
    return this.moderation.bulkApprove(body.ids);
  }

  @Post('moderation/bulk/reject')
  @Platform()
  @ApiOperation({ summary: 'Отклонить несколько материалов одной причиной — платное возвращает монеты' })
  bulkReject(@Ctx() ctx: RequestContext, @Body(new Zod(moderationBulkRejectBody)) body: z.infer<typeof moderationBulkRejectBody>) {
    return this.moderation.bulkReject(body.ids, body.reasonId, body.note, ctx.session!.userId);
  }

  @Post('moderation/bulk/reopen')
  @Platform()
  bulkReopen(@Ctx() ctx: RequestContext, @Body(new Zod(moderationBulkIdsBody)) body: z.infer<typeof moderationBulkIdsBody>) {
    return this.moderation.bulkReopen(body.ids, ctx.session!.userId);
  }

  @Get('reject-reasons')
  @Platform()
  reasons(@Query('all') all?: string) {
    return this.moderation.listReasons(all === '1' || all === 'true');
  }

  @Put('reject-reasons')
  @Platform()
  saveReason(@Body(new Zod(rejectReasonBody)) body: z.infer<typeof rejectReasonBody>) {
    return this.moderation.saveReason(body);
  }

  @Post('reject-reasons/:id/hide')
  @Platform()
  @HttpCode(204)
  hideReason(@Param('id') id: string) {
    return this.moderation.hideReason(id);
  }
}

/** Кабинет бизнеса: отправить материал на проверку (F-00-168…170) — любой сотрудник, без права */
@ApiTags('moderation')
@Controller('v1/biz/:businessId/moderation')
export class BizModerationController {
  constructor(private readonly moderation: ModerationService) {}

  @Post('submit')
  @Biz()
  submit(@Param('businessId') businessId: string, @Body(new Zod(moderationSubmitBody)) body: z.infer<typeof moderationSubmitBody>) {
    return this.moderation.submit({ ...body, businessId });
  }
}

/**
 * Узнать статус по refId (F-00-168…170) — мок зовёт getModerationStatus/isVisibleToClients без businessId
 * (refId сам по себе ключ вызывающей стороны), поэтому маршрут не под /v1/biz/{b}/: любой вошедший сотрудник
 * кабинета может спросить статус своего же материала, без арендатора в пути.
 */
@ApiTags('moderation')
@Controller('v1/moderation')
export class ModerationStatusController {
  constructor(private readonly moderation: ModerationService) {}

  @Get('status/:refId')
  @Authed()
  status(@Param('refId') refId: string) {
    return this.moderation.getStatus(refId);
  }

  @Get('visible/:refId')
  @Authed()
  async visible(@Param('refId') refId: string) {
    return { visible: await this.moderation.isVisibleToClients(refId) };
  }

  /**
   * То же, что выше, но refId в теле (этап 21, лейн rest): refId бывает самим data: URL картинки (галерея,
   * F-00-111/F-00-168) — как путь Express его не пропускает (длина/слэши), фасад (`platform/moderation.server.ts`)
   * зовёт эти два маршрута вместо `:refId`-версии. GET-версии выше оставлены — вдруг где-то ещё нужен короткий refId.
   */
  @Post('status/lookup')
  @Authed()
  @HttpCode(200)
  statusLookup(@Body(new Zod(moderationRefIdBody)) body: z.infer<typeof moderationRefIdBody>) {
    return this.moderation.getStatus(body.refId);
  }

  @Post('visible/lookup')
  @Authed()
  @HttpCode(200)
  async visibleLookup(@Body(new Zod(moderationRefIdBody)) body: z.infer<typeof moderationRefIdBody>) {
    return { visible: await this.moderation.isVisibleToClients(body.refId) };
  }
}
