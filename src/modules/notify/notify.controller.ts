import { Body, Controller, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { Biz, Ctx } from '../../common/http/guards.js';
import { Zod } from '../../common/http/validation.js';
import { PrismaService } from '../../common/prisma.service.js';
import { StaffService } from '../staff/staff.service.js';
import { NotifyChannelsService } from './notify-channels.service.js';
import { NotifyClientPrefsService } from './notify-client-prefs.service.js';
import { NotifyInboxService, type InboxViewer } from './notify-inbox.service.js';
import { NotifyMiscService } from './notify-misc.service.js';
import { NotifyMoreService } from './notify-more.service.js';
import { NotifyNewsService } from './notify-news.service.js';
import { NotifyRichTypesService } from './notify-rich-types.service.js';
import { NotifyStaffPrefsService } from './notify-staff-prefs.service.js';
import { NotifyTypesService } from './notify-types.service.js';
import {
  agentFlagsBody,
  altegioWhatsAppBody,
  altegioWhatsAppModeBody,
  anyStaffPrefsConfiguredBody,
  bookingNotifyOverrideBody,
  channelOverviewBody,
  clientNotifyPatchBody,
  connectChannelBody,
  createNewsBody,
  createWebhookBody,
  dismissBannerBody,
  emailChannelBody,
  giftShowcaseBody,
  loyaltyRulePatchBody,
  partnerConnectionBody,
  partnerStatusBody,
  inboxReadBody,
  notifySettingsBody,
  openSlotsScheduleBody,
  partnerSummaryBody,
  sendDataExportEmailBody,
  sendFiscalReceiptEmailBody,
  sendPlanReportEmailBody,
  sendStaffInviteBody,
  sendTestChannelBody,
  serviceReminderHoursBody,
  setWebhookActiveBody,
  staffNotifyPatchBody,
  staffPrefsRichCellBody,
  staffPrefsRichPatchBody,
  updateTemplatesBody,
  updateTypeBody,
  webPopupBody,
} from './notify.schemas.js';

/** Кто смотрит колокольчик — «День закрыт» приходит лично владельцам (notify/day-close-notice.ts) */
function inboxViewer(ctx: RequestContext): InboxViewer | null {
  return ctx.member ? { staffId: ctx.member.staffId, userId: ctx.member.userId } : null;
}

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
    private readonly misc: NotifyMiscService,
    private readonly more: NotifyMoreService,
    private readonly richTypes: NotifyRichTypesService,
    private readonly staff: StaffService,
  ) {}

  // ─────────── типы и шаблоны (F-05-001…023) ───────────
  // Каталог типов (29 настраиваемых + 2 служебных, F-05-004) — решение владельца 28.09 (этап 21, попытка 3):
  // сервер строит ПОД экран, richTypes (notify-rich-types.service.ts), а не старый `this.types` (13 kind, тот
  // питает настоящую отправку — bookings.service.ts/notify-dispatch.service.ts, трогать нельзя, см. kinds.ts).

  @Get('notify/types')
  @Biz('notify.manage')
  listTypes(@Param('businessId') businessId: string) {
    return this.richTypes.list(businessId);
  }

  @Get('notify/types/:code')
  @Biz('notify.manage')
  getType(@Param('businessId') businessId: string, @Param('code') code: string) {
    return this.richTypes.get(businessId, Number(code));
  }

  @Put('notify/types')
  @Biz('notify.manage')
  updateType(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(updateTypeBody)) body: z.infer<typeof updateTypeBody>) {
    return this.richTypes.update(businessId, body.code, body.patch, ctx.member?.staffId);
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
  listInbox(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Query('preview') preview?: string) {
    return preview ? this.inbox.preview(businessId, inboxViewer(ctx), Number(preview) || 5) : this.inbox.list(businessId, inboxViewer(ctx));
  }

  @Get('inbox/unread-count')
  @Biz()
  unreadCount(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string) {
    return this.inbox.countUnread(businessId, inboxViewer(ctx)).then((value) => ({ value }));
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
  async markAllRead(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string) {
    await this.inbox.markAllRead(businessId, inboxViewer(ctx));
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

  // ─────────── попапы в веб-версии (F-05-058), этап 21 «notify+integrations» ───────────

  // Чтение — любому сотруднику: колокольчик шапки у всех ролей смотрит «Операции с записями» (как мок); правка — notify.manage
  @Get('notify/web-popup')
  @Biz()
  getWebPopup(@Param('businessId') businessId: string) {
    return this.misc.getWebPopup(businessId);
  }

  @Put('notify/web-popup')
  @Biz('notify.manage')
  setWebPopup(@Param('businessId') businessId: string, @Body(new Zod(webPopupBody)) body: z.infer<typeof webPopupBody>) {
    return this.misc.setWebPopup(businessId, body);
  }

  // ─────────── Email «для ответов» (F-05-066) ───────────

  @Get('notify/email')
  @Biz('notify.manage')
  getEmailSettings(@Param('businessId') businessId: string) {
    return this.misc.getEmailSettings(businessId);
  }

  @Put('notify/email')
  @Biz('notify.manage')
  setEmailSettings(@Param('businessId') businessId: string, @Body(new Zod(emailChannelBody)) body: z.infer<typeof emailChannelBody>) {
    return this.misc.setEmailSettings(businessId, body);
  }

  // ─────────── служебные баннеры (F-05-135) ───────────

  @Get('notify/banners')
  @Biz('notify.manage')
  listBanners(@Param('businessId') businessId: string) {
    return this.misc.listBanners(businessId);
  }

  @Post('notify/banners/dismiss')
  @Biz('notify.manage')
  async dismissBanner(@Param('businessId') businessId: string, @Body(new Zod(dismissBannerBody)) body: z.infer<typeof dismissBannerBody>) {
    await this.misc.dismissBanner(businessId, body.bannerId);
    return { ok: true };
  }

  // ─────────── обзор каналов (F-05-065) ───────────

  @Get('notify/channels/overview')
  @Biz('notify.manage')
  listChannelsOverview(@Param('businessId') businessId: string) {
    return this.misc.listChannels(businessId);
  }

  @Put('notify/channels/overview')
  @Biz('notify.manage')
  setChannelOverview(@Param('businessId') businessId: string, @Body(new Zod(channelOverviewBody)) body: z.infer<typeof channelOverviewBody>) {
    return this.misc.setChannelFlag(businessId, body.channel, body.connected);
  }

  // ─────────── приглашение сотрудника с доступом (F-05-063) — переиспользует staff/:staffId/invite (этап 3) ───────────

  @Post('staff/:staffId/notify-invite')
  @Biz('staff.manage')
  @ApiOperation({ summary: 'Обёртка над реальным приглашением сотрудника (staff.reissueInvite) под форму нотифай-фасада' })
  async sendStaffInvite(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('staffId') staffId: string, @Body(new Zod(sendStaffInviteBody)) body: z.infer<typeof sendStaffInviteBody>) {
    const { invite, link } = await this.staff.reissueInvite(ctx, businessId, staffId);
    return {
      staffId,
      status: invite.status === 'accepted' ? 'accepted' : invite.status === 'revoked' ? 'revoked' : 'pending',
      target: body.target,
      token: link.split('/').pop() ?? '',
      sentAt: invite.createdAt,
      link,
      reachableByPhone: true,
    };
  }

  // ─────────── этап 21 «notify+integrations», попытка 3 ───────────
  // ── язык/формат/тихие часы (F-05-010/011) ──

  @Get('notify/settings')
  @Biz('notify.manage')
  getSettings(@Param('businessId') businessId: string) {
    return this.more.getSettings(businessId);
  }

  @Put('notify/settings')
  @Biz('notify.manage')
  setSettings(@Param('businessId') businessId: string, @Body(new Zod(notifySettingsBody)) body: z.infer<typeof notifySettingsBody>) {
    return this.more.updateSettings(businessId, { ...body, quietHours: body.quietHours ?? { enabled: true, from: '22:00', to: '09:00' } });
  }

  // ── ручная правка уведомлений ОДНОЙ записи (F-05-009/082) ──

  @Get('bookings/:bookingId/notify-override')
  @Biz()
  getBookingNotifyOverride(@Param('businessId') businessId: string, @Param('bookingId') bookingId: string) {
    return this.more.getBookingOverride(businessId, bookingId);
  }

  @Put('bookings/:bookingId/notify-override')
  @Biz()
  setBookingNotifyOverride(@Param('businessId') businessId: string, @Param('bookingId') bookingId: string, @Body(new Zod(bookingNotifyOverrideBody)) body: z.infer<typeof bookingNotifyOverrideBody>) {
    return this.more.updateBookingOverride(businessId, bookingId, body);
  }

  // ── витрина подарков партнёра (F-05-127) ──

  @Get('notify/gift-showcase')
  @Biz('notify.manage')
  getGiftShowcase(@Param('businessId') businessId: string) {
    return this.more.getGiftShowcase(businessId);
  }

  @Put('notify/gift-showcase')
  @Biz('notify.manage')
  setGiftShowcase(@Param('businessId') businessId: string, @Body(new Zod(giftShowcaseBody)) body: z.infer<typeof giftShowcaseBody>) {
    return this.more.updateGiftShowcase(businessId, body);
  }

  // ── правила уведомлений лояльности (F-05-100…106), этап 21 «Сдача» ──

  @Get('notify/loyalty-rules')
  @Biz('notify.manage')
  getLoyaltyRules(@Param('businessId') businessId: string) {
    return this.more.getLoyaltyRulePatches(businessId);
  }

  @Patch('notify/loyalty-rules/:code')
  @Biz('notify.manage')
  updateLoyaltyRule(@Param('businessId') businessId: string, @Param('code') code: string, @Body(new Zod(loyaltyRulePatchBody)) body: z.infer<typeof loyaltyRulePatchBody>) {
    if (!/^[a-z0-9_.-]{1,64}$/i.test(code)) throw new ApiError('validation', 'bad code');
    return this.more.updateLoyaltyRule(businessId, code, body);
  }

  // ── подключения партнёрских приложений (F-05-117/122/123), этап 21 «Сдача», Р19 ──

  @Get('notify/partner-connections')
  @Biz('notify.manage')
  listPartnerConnections(@Param('businessId') businessId: string) {
    return this.more.listPartnerConnections(businessId);
  }

  @Put('notify/partner-connections/:appId')
  @Biz('notify.manage')
  connectPartner(@Param('businessId') businessId: string, @Param('appId') appId: string, @Body(new Zod(partnerConnectionBody)) body: z.infer<typeof partnerConnectionBody>) {
    if (body.appId !== appId) throw new ApiError('validation', 'appId mismatch');
    return this.more.connectPartner(businessId, body);
  }

  @Post('notify/partner-connections/:appId/delete')
  @Biz('notify.manage')
  async disconnectPartner(@Param('businessId') businessId: string, @Param('appId') appId: string) {
    await this.more.disconnectPartner(businessId, appId);
    return { ok: true as const };
  }

  @Post('notify/partner-connections/:appId/status')
  @Biz('notify.manage')
  async setPartnerStatus(@Param('businessId') businessId: string, @Param('appId') appId: string, @Body(new Zod(partnerStatusBody)) body: z.infer<typeof partnerStatusBody>) {
    await this.more.setPartnerStatus(businessId, appId, body.status);
    return { ok: true as const };
  }

  // ── Open Slots — расписание (F-05-124) ──

  @Get('notify/open-slots-schedule')
  @Biz('notify.manage')
  getOpenSlotsSchedule(@Param('businessId') businessId: string) {
    return this.more.getOpenSlotsSchedule(businessId);
  }

  @Put('notify/open-slots-schedule')
  @Biz('notify.manage')
  setOpenSlotsSchedule(@Param('businessId') businessId: string, @Body(new Zod(openSlotsScheduleBody)) body: z.infer<typeof openSlotsScheduleBody>) {
    return this.more.updateOpenSlotsSchedule(businessId, body);
  }

  // ── сводки и оповещения партнёров (F-05-126) ──

  @Get('notify/partner-summary')
  @Biz('notify.manage')
  getPartnerSummary(@Param('businessId') businessId: string) {
    return this.more.getPartnerSummary(businessId);
  }

  @Put('notify/partner-summary')
  @Biz('notify.manage')
  setPartnerSummary(@Param('businessId') businessId: string, @Body(new Zod(partnerSummaryBody)) body: z.infer<typeof partnerSummaryBody>) {
    return this.more.updatePartnerSummary(businessId, body);
  }

  // ── WhatsApp через Altegio (F-05-071…073) — статус/настройки, без реального обмена (Р19) ──

  @Get('notify/altegio-whatsapp')
  @Biz('notify.manage')
  getAltegioWhatsApp(@Param('businessId') businessId: string) {
    return this.more.getAltegioWhatsApp(businessId);
  }

  @Put('notify/altegio-whatsapp')
  @Biz('notify.manage')
  setAltegioWhatsApp(@Param('businessId') businessId: string, @Body(new Zod(altegioWhatsAppBody)) body: z.infer<typeof altegioWhatsAppBody>) {
    return this.more.updateAltegioWhatsApp(businessId, body);
  }

  @Post('notify/altegio-whatsapp/mode')
  @Biz('notify.manage')
  setAltegioWhatsAppMode(@Param('businessId') businessId: string, @Body(new Zod(altegioWhatsAppModeBody)) body: z.infer<typeof altegioWhatsAppModeBody>) {
    return this.more.setAltegioWhatsAppMode(businessId, body.mode);
  }

  @Post('notify/altegio-whatsapp/approve-templates')
  @Biz('notify.manage')
  approveWhatsAppTemplates(@Param('businessId') businessId: string) {
    return this.more.approveWhatsAppTemplates(businessId);
  }

  // ── флаги внешнего агента (F-05-121) ──

  @Get('notify/agent-flags')
  @Biz('notify.manage')
  getAgentFlags(@Param('businessId') businessId: string) {
    return this.more.getAgentFlags(businessId);
  }

  @Put('notify/agent-flags')
  @Biz('notify.manage')
  setAgentFlags(@Param('businessId') businessId: string, @Body(new Zod(agentFlagsBody)) body: z.infer<typeof agentFlagsBody>) {
    return this.more.updateAgentFlags(businessId, body);
  }

  // ── своё время напоминания на услугу (Ув15) ──

  @Get('notify/service-reminder-hours/:serviceId')
  @Biz('notify.manage')
  async getServiceReminderHours(@Param('businessId') businessId: string, @Param('serviceId') serviceId: string) {
    return { hours: await this.more.getServiceReminderHours(businessId, serviceId) };
  }

  @Put('notify/service-reminder-hours/:serviceId')
  @Biz('notify.manage')
  async setServiceReminderHours(@Param('businessId') businessId: string, @Param('serviceId') serviceId: string, @Body(new Zod(serviceReminderHoursBody)) body: z.infer<typeof serviceReminderHoursBody>) {
    await this.more.setServiceReminderHours(businessId, serviceId, body.hours);
    return { ok: true };
  }

  // ── свои вебхуки (F-05-120) ──

  @Get('notify/webhooks')
  @Biz('notify.manage')
  listWebhooks(@Param('businessId') businessId: string) {
    return this.more.listWebhooks(businessId);
  }

  @Post('notify/webhooks')
  @Biz('notify.manage')
  createWebhook(@Param('businessId') businessId: string, @Body(new Zod(createWebhookBody)) body: z.infer<typeof createWebhookBody>) {
    return this.more.createWebhook(businessId, body.url, [...body.entities]);
  }

  @Put('notify/webhooks/:webhookId/active')
  @Biz('notify.manage')
  async setWebhookActive(@Param('businessId') businessId: string, @Param('webhookId') webhookId: string, @Body(new Zod(setWebhookActiveBody)) body: z.infer<typeof setWebhookActiveBody>) {
    await this.more.setWebhookActive(businessId, webhookId, body.active);
    return { ok: true };
  }

  @Post('notify/webhooks/:webhookId/delete')
  @Biz('notify.manage')
  async deleteWebhook(@Param('businessId') businessId: string, @Param('webhookId') webhookId: string) {
    await this.more.deleteWebhook(businessId, webhookId);
    return { ok: true };
  }

  // ── письма от разделов-хозяев (F-05-129/131/134) ──

  @Post('notify/send/fiscal-receipt')
  @Biz()
  sendFiscalReceiptEmail(@Param('businessId') businessId: string, @Body(new Zod(sendFiscalReceiptEmailBody)) body: z.infer<typeof sendFiscalReceiptEmailBody>) {
    return this.more.sendFiscalReceiptEmail(body.email, body.receiptUrl);
  }

  @Post('notify/send/data-export')
  @Biz()
  sendDataExportEmail(@Param('businessId') businessId: string, @Body(new Zod(sendDataExportEmailBody)) body: z.infer<typeof sendDataExportEmailBody>) {
    return this.more.sendDataExportEmail(body.toEmail, body.reportLabel.ru, body.downloadUrl);
  }

  @Post('notify/send/plan-report')
  @Biz()
  sendPlanReportEmail(@Param('businessId') businessId: string, @Body(new Zod(sendPlanReportEmailBody)) body: z.infer<typeof sendPlanReportEmailBody>) {
    return this.more.sendPlanReportEmail(body.toEmail, body.downloadUrl, body.frequency);
  }

  // ── Open Slots — окна на сегодня/завтра (F-05-124) / Кого позвать (F-05-125), этап 21 попытка 4 ──

  @Get('notify/open-slots')
  @Biz('notify.manage')
  listOpenSlots(@Param('businessId') businessId: string, @Query('day') day?: string) {
    return this.more.listOpenSlots(businessId, day === 'tomorrow' ? 'tomorrow' : 'today');
  }

  @Get('notify/who-to-invite')
  @Biz('notify.manage')
  listWhoToInvite(@Param('businessId') businessId: string) {
    return this.more.listWhoToInvite(businessId);
  }

  // ── уведомления сотрудника — богатая матрица под экран (F-05-055…060), НЕ StaffNotifyPref внутренний ──

  @Get('staff/:staffId/notify-prefs-rich')
  @Biz()
  async getStaffPrefsRich(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('staffId') staffId: string) {
    await this.assertStaffAccess(ctx, businessId, staffId);
    return this.more.getStaffPrefsRich(businessId, staffId);
  }

  @Put('staff/:staffId/notify-prefs-rich')
  @Biz()
  async setStaffPrefsRich(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('staffId') staffId: string, @Body(new Zod(staffPrefsRichPatchBody)) body: z.infer<typeof staffPrefsRichPatchBody>) {
    await this.assertStaffAccess(ctx, businessId, staffId);
    return this.more.updateStaffPrefsRich(businessId, staffId, body);
  }

  @Post('staff/:staffId/notify-prefs-rich/cell')
  @Biz()
  async setStaffPrefsRichCell(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('staffId') staffId: string, @Body(new Zod(staffPrefsRichCellBody)) body: z.infer<typeof staffPrefsRichCellBody>) {
    await this.assertStaffAccess(ctx, businessId, staffId);
    return this.more.setStaffPrefsMatrixCell(businessId, staffId, body.event, body.channel, body.value);
  }

  @Post('staff/notify-prefs-rich/any-configured')
  @Biz()
  async anyStaffPrefsConfigured(@Param('businessId') businessId: string, @Body(new Zod(anyStaffPrefsConfiguredBody)) body: z.infer<typeof anyStaffPrefsConfiguredBody>) {
    return { value: await this.more.anyStaffPrefsConfigured(businessId, body.staffIds) };
  }

  // ── лента новостей платформы (F-05-061/062) ──

  @Get('notify/news-feed')
  @Biz()
  listPlatformNews() {
    return this.more.listPlatformNews();
  }
}
