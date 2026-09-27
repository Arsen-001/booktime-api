import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext, RequestWithContext } from '../../common/http/context.js';
import { Biz, Ctx } from '../../common/http/guards.js';
import { ZodBody, ZodOk } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { ifMatch } from '../../common/http/version.js';
import {
  bookingLinkOut,
  businessOnlineRulesBody,
  businessOnlineRulesOut,
  createLinkBody,
  onlineMetaOut,
  staffClientRulesBody,
  staffClientRulesOut,
  updateLinkBody,
} from './online.schemas.js';
import { OnlineService } from './online.service.js';

/**
 * Кабинет: ссылки на запись (F-03-003…037), правила мастера для клиента (F-00-066), правила бизнеса онлайн-
 * записи (F-03-079, F-03-116, В-24), источник записи в журнале (F-03-123). docs/backend/02 §3, PLAN §6 №8.
 */
@ApiTags('online')
@Controller('v1/biz/:businessId')
export class BizOnlineController {
  constructor(private readonly svc: OnlineService) {}

  // ── ссылки ──

  @Get('links')
  @Biz()
  @ZodOk(z.array(bookingLinkOut))
  list(@Param('businessId') businessId: string) {
    return this.svc.listLinks(businessId);
  }

  @Get('links/:id')
  @Biz()
  @ZodOk(bookingLinkOut)
  get(@Param('businessId') businessId: string, @Param('id') id: string) {
    return this.svc.getLink(businessId, id);
  }

  @Post('links')
  @Biz('online.manage')
  @ApiOperation({ summary: '«Новая ссылка» (F-03-005, F-03-006)' })
  @ZodBody(createLinkBody)
  @ZodOk(bookingLinkOut)
  create(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(createLinkBody)) body: z.infer<typeof createLinkBody>) {
    return this.svc.createLink(ctx, businessId, body);
  }

  @Patch('links/:id')
  @Biz('online.manage')
  @ZodBody(updateLinkBody)
  @ZodOk(bookingLinkOut)
  update(@Ctx() ctx: RequestContext, @Req() req: RequestWithContext, @Param('businessId') businessId: string, @Param('id') id: string, @Body(new Zod(updateLinkBody)) body: z.infer<typeof updateLinkBody>) {
    return this.svc.updateLink(ctx, businessId, id, body, ifMatch(req));
  }

  @Delete('links/:id')
  @Biz('online.manage')
  async remove(@Param('businessId') businessId: string, @Param('id') id: string) {
    await this.svc.deleteLink(businessId, id);
    return { ok: true };
  }

  @Post('links/:id/primary')
  @Biz('online.manage')
  @ZodOk(bookingLinkOut)
  setPrimary(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('id') id: string) {
    return this.svc.setPrimaryLink(ctx, businessId, id);
  }

  // ── правила мастера для клиента (F-00-066) ──

  @Get('staff/:staffId/client-rules')
  @Biz()
  @ZodOk(staffClientRulesOut)
  clientRules(@Param('businessId') businessId: string, @Param('staffId') staffId: string) {
    return this.svc.staffClientRules(businessId, staffId);
  }

  @Put('staff/:staffId/client-rules')
  @Biz()
  @ApiOperation({ summary: 'Владелец/администратор — всем; сам мастер — только себе (online.own, как в 03 §2)' })
  @ZodBody(staffClientRulesBody)
  @ZodOk(staffClientRulesOut)
  setClientRules(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('staffId') staffId: string, @Body(new Zod(staffClientRulesBody)) body: z.infer<typeof staffClientRulesBody>) {
    this.assertClientRulesEdit(ctx, staffId);
    return this.svc.updateStaffClientRules(ctx, businessId, staffId, body);
  }

  private assertClientRulesEdit(ctx: RequestContext, staffId: string): void {
    const m = ctx.member!;
    if (m.permissions.has('online.manage')) return;
    if (staffId === m.staffId && m.permissions.has('online.own')) return;
    throw new ApiError('forbidden', 'Missing permission: online.manage');
  }

  // ── правила бизнеса (F-03-079, F-03-116, В-24) ──

  @Get('online/rules')
  @Biz()
  @ZodOk(businessOnlineRulesOut)
  businessRules(@Param('businessId') businessId: string) {
    return this.svc.businessOnlineRules(businessId);
  }

  @Put('online/rules')
  @Biz('online.manage')
  @ZodBody(businessOnlineRulesBody)
  @ZodOk(businessOnlineRulesOut)
  setBusinessRules(@Param('businessId') businessId: string, @Body(new Zod(businessOnlineRulesBody)) body: z.infer<typeof businessOnlineRulesBody>) {
    return this.svc.updateBusinessOnlineRules(businessId, body);
  }

  // ── источник записи (F-03-123) ──

  @Get('bookings/:id/online-meta')
  @Biz('journal.view')
  @ZodOk(onlineMetaOut)
  onlineMeta(@Param('businessId') businessId: string, @Param('id') id: string) {
    return this.svc.onlineMeta(businessId, id);
  }
}
