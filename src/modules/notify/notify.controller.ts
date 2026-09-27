import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { Biz, Ctx } from '../../common/http/guards.js';
import { Zod } from '../../common/http/validation.js';
import { PrismaService } from '../../common/prisma.service.js';
import { NotifyChannelsService } from './notify-channels.service.js';
import { NotifyClientPrefsService } from './notify-client-prefs.service.js';
import { NotifyInboxService } from './notify-inbox.service.js';
import { NotifyNewsService } from './notify-news.service.js';
import { NotifyStaffPrefsService } from './notify-staff-prefs.service.js';
import { NotifyTypesService } from './notify-types.service.js';
import {
  clientNotifyPatchBody,
  connectChannelBody,
  createNewsBody,
  inboxReadBody,
  sendTestChannelBody,
  staffNotifyPatchBody,
  updateTemplatesBody,
  updateTypeBody,
} from './notify.schemas.js';

/** Уведомления (docs/backend/02-api.md §10, docs/backend/05) — /v1/biz/{b}/notify, /inbox, /news, вложенные /staff /clients */
@ApiTags('notify')
@Controller('v1/biz/:businessId')
export class NotifyController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly types: NotifyTypesService,
    private readonly news: NotifyNewsService,
    private readonly staffPrefs: NotifyStaffPrefsService,
    private readonly clientPrefs: NotifyClientPrefsService,
    private readonly inbox: NotifyInboxService,
    private readonly channels: NotifyChannelsService,
  ) {}

  // ─────────── типы и шаблоны (F-05-001…023) ───────────

  @Get('notify/types')
  @Biz('notify.manage')
  listTypes(@Param('businessId') businessId: string) {
    return this.types.list(businessId);
  }

  @Put('notify/types')
  @Biz('notify.manage')
  updateType(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(updateTypeBody)) body: z.infer<typeof updateTypeBody>) {
    return this.types.updateType(ctx, businessId, body.kind, body.patch);
  }

  @Get('notify/templates/:kind')
  @Biz('notify.manage')
  getTemplates(@Param('businessId') businessId: string, @Param('kind') kind: string) {
    return this.types.getTemplates(businessId, kind);
  }

  @Put('notify/templates/:kind')
  @Biz('notify.manage')
  updateTemplates(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('kind') kind: string, @Body(new Zod(updateTemplatesBody)) body: z.infer<typeof updateTemplatesBody>) {
    return this.types.updateTemplates(ctx, businessId, kind, body);
  }

  @Post('notify/templates/:kind/preview')
  @Biz('notify.manage')
  preview(@Param('businessId') businessId: string, @Param('kind') kind: string, @Query('locale') locale = 'ru') {
    return this.types.preview(businessId, kind, locale);
  }

  // ─────────── журнал отправок (F-05-107…109) — читает notify_outbox напрямую, это и есть журнал (05 §4) ───────────

  @Get('notify/log')
  @Biz('notify.log')
  async log(@Param('businessId') businessId: string) {
    const rows = await this.prisma.notifyOutbox.findMany({ where: { businessId }, orderBy: { createdAt: 'desc' }, take: 200 });
    return rows.map((r) => ({ id: r.id, kind: r.kind, app: r.app, title: r.title, status: r.status, createdAt: r.createdAt.toISOString(), sentAt: r.sentAt?.toISOString(), lastError: r.lastError ?? undefined }));
  }

  // ─────────── подключение своего SMS/WhatsApp (В-08) ───────────

  @Get('notify/channels')
  @Biz('notify.manage')
  getChannel(@Param('businessId') businessId: string) {
    return this.channels.get(businessId);
  }

  @Put('notify/channels')
  @Biz('notify.manage')
  connectChannel(@Param('businessId') businessId: string, @Body(new Zod(connectChannelBody)) body: z.infer<typeof connectChannelBody>) {
    return this.channels.connect(businessId, body);
  }

  @Post('notify/channels/disconnect')
  @Biz('notify.manage')
  async disconnectChannel(@Param('businessId') businessId: string) {
    await this.channels.disconnect(businessId);
    return { connected: false };
  }

  @Post('notify/channels/test')
  @Biz('notify.manage')
  sendTestChannel(@Param('businessId') businessId: string, @Body(new Zod(sendTestChannelBody)) body: z.infer<typeof sendTestChannelBody>) {
    return this.channels.sendTest(businessId, body.to);
  }

  // ─────────── новости подписчикам (F-00-114) ───────────

  @Post('news')
  @Biz('notify.manage')
  @ApiOperation({ summary: 'Не больше 3 в неделю на бизнес (§5) — 409 weekly_push_limit сверх лимита' })
  createNews(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(createNewsBody)) body: z.infer<typeof createNewsBody>) {
    return this.news.create(ctx, businessId, body.text);
  }

  @Get('news')
  @Biz('notify.manage')
  listNews(@Param('businessId') businessId: string) {
    return this.news.list(businessId);
  }

  @Get('news/quota')
  @Biz('notify.manage')
  newsQuota(@Param('businessId') businessId: string) {
    return this.news.quota(businessId);
  }

  @Get('news/suggestions')
  @Biz('notify.manage')
  newsSuggestions(@Param('businessId') businessId: string) {
    return this.news.suggestions(businessId);
  }

  // ─────────── что приходит сотруднику (F-05-055…060) — сам сотрудник или staff.manage ───────────

  @Get('staff/:staffId/notify')
  @Biz()
  async getStaffNotify(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('staffId') staffId: string) {
    await this.assertStaffAccess(ctx, businessId, staffId);
    return this.staffPrefs.get(staffId);
  }

  @Put('staff/:staffId/notify')
  @Biz()
  async updateStaffNotify(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('staffId') staffId: string, @Body(new Zod(staffNotifyPatchBody)) body: z.infer<typeof staffNotifyPatchBody>) {
    await this.assertStaffAccess(ctx, businessId, staffId);
    return this.staffPrefs.update(staffId, body);
  }

  private async assertStaffAccess(ctx: RequestContext, businessId: string, staffId: string): Promise<void> {
    if (ctx.member!.staffId === staffId || ctx.member!.permissions.has('staff.manage')) return;
    const row = await this.prisma.staff.findFirst({ where: { id: staffId, businessId }, select: { id: true } });
    if (!row) throw new ApiError('not_found', 'Staff not found');
    throw new ApiError('forbidden', 'Missing permission: staff.manage');
  }

  // ─────────── колокольчик кабинета (F-05-061) ───────────

  @Get('inbox')
  @Biz()
  listInbox(@Param('businessId') businessId: string, @Query('preview') preview?: string) {
    return preview ? this.inbox.preview(businessId, Number(preview) || 5) : this.inbox.list(businessId);
  }

  @Get('inbox/unread-count')
  @Biz()
  unreadCount(@Param('businessId') businessId: string) {
    return this.inbox.countUnread(businessId).then((value) => ({ value }));
  }

  @Post('inbox/:id/read')
  @Biz()
  async markOneRead(@Param('businessId') businessId: string, @Param('id') id: string) {
    await this.inbox.markRead(businessId, [id]);
    return { ok: true };
  }

  @Post('inbox/read')
  @Biz()
  async markManyRead(@Param('businessId') businessId: string, @Body(new Zod(inboxReadBody)) body: z.infer<typeof inboxReadBody>) {
    await this.inbox.markRead(businessId, body.ids);
    return { ok: true };
  }

  @Post('inbox/read-all')
  @Biz()
  async markAllRead(@Param('businessId') businessId: string) {
    await this.inbox.markAllRead(businessId);
    return { ok: true };
  }

  // ─────────── настройки уведомлений на клиента (F-04-087…090) ───────────

  @Get('clients/:clientId/notify')
  @Biz('clients.edit')
  getClientNotify(@Param('businessId') businessId: string, @Param('clientId') clientId: string) {
    return this.clientPrefs.get(businessId, clientId);
  }

  @Put('clients/:clientId/notify')
  @Biz('clients.edit')
  updateClientNotify(@Param('businessId') businessId: string, @Param('clientId') clientId: string, @Body(new Zod(clientNotifyPatchBody)) body: z.infer<typeof clientNotifyPatchBody>) {
    return this.clientPrefs.update(businessId, clientId, body);
  }
}
