import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext, RequestWithContext } from '../../common/http/context.js';
import { Biz, Ctx } from '../../common/http/guards.js';
import { ZodBody, ZodOk } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { ifMatch } from '../../common/http/version.js';
import {
  apiCredentialsOut,
  bookingLinkOut,
  businessOnlineRulesBody,
  businessOnlineRulesOut,
  clientFieldsConfigBody,
  clientFieldsConfigOut,
  createLinkBody,
  createOnlinePackageBody,
  createPromoBlockBody,
  customClientFieldBody,
  groupBookingRulesBody,
  groupBookingRulesOut,
  integrationConnectionOut,
  inviteToSlotBody,
  listabilityOut,
  mobileAppLinksBody,
  mobileAppLinksOut,
  moveFieldBody,
  offerTimesBody,
  onlineMetaOut,
  onlinePackageOut,
  onlineRequestOut,
  placesDataOut,
  promoBlockOut,
  respondBody,
  serviceOnlineConfigBody,
  serviceOnlineConfigOut,
  setIntegrationConnectedBody,
  setStaffServiceOnlineBody,
  slotCandidateOut,
  slotInviteOut,
  staffClientRulesBody,
  staffClientRulesOut,
  staffServiceFlagsOut,
  statusLogOut,
  updateLinkBody,
  updateOnlinePackageBody,
  updatePromoBlockBody,
  widgetEventOut,
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

  // ═══════════════ стадия 21 (лейн client+online): персональный домен, места, кабинет заявок ═══════════════

  @Get('online/subdomain-available')
  @Biz()
  @ZodOk(z.object({ available: z.boolean() }))
  async subdomainAvailable(@Query('subdomain') subdomain: string, @Query('excludeLinkId') excludeLinkId?: string) {
    return { available: await this.svc.isSubdomainAvailable(subdomain ?? '', excludeLinkId) };
  }

  @Get('online/staff/:staffId/places')
  @Biz()
  @ZodOk(placesDataOut)
  places(@Param('businessId') businessId: string, @Param('staffId') staffId: string, @Query('locationId') locationId?: string) {
    return this.svc.placesData(businessId, staffId, locationId);
  }

  @Get('online/listability')
  @Biz()
  @ZodOk(listabilityOut)
  listability(@Param('businessId') businessId: string) {
    return this.svc.businessListability(businessId);
  }

  // ── экран данных клиента ──

  @Get('online/client-fields')
  @Biz()
  @ZodOk(clientFieldsConfigOut)
  clientFields(@Param('businessId') businessId: string) {
    return this.svc.clientFieldsConfig(businessId);
  }

  @Patch('online/client-fields')
  @Biz('online.manage')
  @ZodBody(clientFieldsConfigBody)
  @ZodOk(clientFieldsConfigOut)
  updateClientFields(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(clientFieldsConfigBody)) body: z.infer<typeof clientFieldsConfigBody>) {
    return this.svc.updateClientFieldsConfig(ctx, businessId, body);
  }

  @Post('online/client-fields/fields')
  @Biz('online.manage')
  @ZodBody(customClientFieldBody)
  @ZodOk(clientFieldsConfigOut)
  addClientField(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(customClientFieldBody)) body: z.infer<typeof customClientFieldBody>) {
    return this.svc.addCustomClientField(ctx, businessId, body);
  }

  @Delete('online/client-fields/fields/:fieldId')
  @Biz('online.manage')
  @ZodOk(clientFieldsConfigOut)
  removeClientField(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('fieldId') fieldId: string) {
    return this.svc.removeCustomClientField(ctx, businessId, fieldId);
  }

  @Post('online/client-fields/fields/:fieldId/move')
  @Biz('online.manage')
  @ZodBody(moveFieldBody)
  @ZodOk(clientFieldsConfigOut)
  moveClientField(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('fieldId') fieldId: string, @Body(new Zod(moveFieldBody)) body: z.infer<typeof moveFieldBody>) {
    return this.svc.moveCustomClientField(ctx, businessId, fieldId, body.direction);
  }

  @Get('online/clients/:clientId/field-answers')
  @Biz('journal.view')
  @ZodOk(z.array(z.object({ label: z.string(), value: z.string() })))
  clientFieldAnswers(@Param('businessId') businessId: string, @Param('clientId') clientId: string) {
    return this.svc.clientCustomFieldAnswers(businessId, clientId);
  }

  // ── очередь заявок (F-00-067, F-00-071, F-03-127) ──

  @Get('online/requests')
  @Biz('journal.view')
  @ZodOk(z.array(onlineRequestOut))
  requests(@Param('businessId') businessId: string, @Query('staffId') staffId?: string) {
    return this.svc.listOnlineRequests(businessId, staffId);
  }

  @Get('online/requests/count')
  @Biz('journal.view')
  @ZodOk(z.object({ count: z.number() }))
  async requestsCount(@Param('businessId') businessId: string, @Query('staffId') staffId?: string) {
    return { count: await this.svc.countPendingRequests(businessId, staffId) };
  }

  @Get('online/requests/:id/status-log')
  @Biz('journal.view')
  @ZodOk(statusLogOut)
  statusLog(@Param('businessId') businessId: string, @Param('id') id: string) {
    return this.svc.bookingStatusLog(businessId, id);
  }

  @Post('online/requests/:id/respond')
  @Biz('journal.edit')
  @ZodBody(respondBody)
  respond(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('id') id: string, @Body(new Zod(respondBody)) body: z.infer<typeof respondBody>) {
    return this.svc.respondToRequest(ctx, businessId, id, body.action);
  }

  @Get('online/requests/:id/suggest-times')
  @Biz('journal.view')
  @ZodOk(z.array(z.string()))
  suggestTimes(@Param('businessId') businessId: string, @Param('id') id: string, @Query('limit') limit?: string) {
    return this.svc.suggestOtherTimes(businessId, id, limit ? Number(limit) : undefined);
  }

  @Post('online/requests/:id/offer-times')
  @Biz('journal.edit')
  @ZodBody(offerTimesBody)
  @ZodOk(z.array(z.string()))
  offerTimes(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('id') id: string, @Body(new Zod(offerTimesBody)) body: z.infer<typeof offerTimesBody>) {
    return this.svc.offerOtherTimes(ctx, businessId, id, body.starts);
  }

  // ═══════════════ стадия 21 (лейн client+online), попытка 2 ═══════════════

  // ── настройка онлайн-записи услуги (F-03-129) ──

  @Get('online/services/:serviceId/config')
  @Biz()
  @ZodOk(serviceOnlineConfigOut)
  serviceConfig(@Param('businessId') businessId: string, @Param('serviceId') serviceId: string) {
    return this.svc.serviceOnlineConfig(businessId, serviceId);
  }

  @Patch('online/services/:serviceId/config')
  @Biz('online.manage')
  @ZodBody(serviceOnlineConfigBody)
  @ZodOk(serviceOnlineConfigOut)
  setServiceConfig(@Param('businessId') businessId: string, @Param('serviceId') serviceId: string, @Body(new Zod(serviceOnlineConfigBody)) body: z.infer<typeof serviceOnlineConfigBody>) {
    return this.svc.updateServiceOnlineConfig(businessId, serviceId, body);
  }

  // ── пара «мастер×услуга» (F-03-133) ──

  @Get('online/staff-service-flags')
  @Biz()
  @ZodOk(staffServiceFlagsOut)
  staffServiceFlags(@Param('businessId') businessId: string) {
    return this.svc.staffServiceOnlineFlags(businessId);
  }

  @Put('online/staff-service-flags')
  @Biz('online.manage')
  @ZodBody(setStaffServiceOnlineBody)
  @ZodOk(staffServiceFlagsOut)
  setStaffServiceFlag(@Param('businessId') businessId: string, @Body(new Zod(setStaffServiceOnlineBody)) body: z.infer<typeof setStaffServiceOnlineBody>) {
    return this.svc.setStaffServiceOnline(businessId, body.staffId, body.serviceId, body.online);
  }

  // ── пакеты услуг (F-03-130) ──

  @Get('online/packages')
  @Biz()
  @ZodOk(z.array(onlinePackageOut))
  packages(@Param('businessId') businessId: string) {
    return this.svc.listOnlinePackages(businessId);
  }

  @Post('online/packages')
  @Biz('online.manage')
  @ZodBody(createOnlinePackageBody)
  @ZodOk(onlinePackageOut)
  createPackage(@Param('businessId') businessId: string, @Body(new Zod(createOnlinePackageBody)) body: z.infer<typeof createOnlinePackageBody>) {
    return this.svc.createOnlinePackage(businessId, body);
  }

  @Patch('online/packages/:id')
  @Biz('online.manage')
  @ZodBody(updateOnlinePackageBody)
  @ZodOk(onlinePackageOut)
  updatePackage(@Param('businessId') businessId: string, @Param('id') id: string, @Body(new Zod(updateOnlinePackageBody)) body: z.infer<typeof updateOnlinePackageBody>) {
    return this.svc.updateOnlinePackage(businessId, id, body);
  }

  @Delete('online/packages/:id')
  @Biz('online.manage')
  async removePackage(@Param('businessId') businessId: string, @Param('id') id: string) {
    await this.svc.deleteOnlinePackage(businessId, id);
    return { ok: true };
  }

  // ── промоблок в виджете (F-03-106) ──

  @Get('online/promo-blocks')
  @Biz()
  @ZodOk(z.array(promoBlockOut))
  promoBlocks(@Param('businessId') businessId: string) {
    return this.svc.listPromoBlocks(businessId);
  }

  @Post('online/promo-blocks')
  @Biz('online.manage')
  @ZodBody(createPromoBlockBody)
  @ZodOk(promoBlockOut)
  createPromo(@Param('businessId') businessId: string, @Body(new Zod(createPromoBlockBody)) body: z.infer<typeof createPromoBlockBody>) {
    return this.svc.createPromoBlock(businessId, body);
  }

  @Patch('online/promo-blocks/:id')
  @Biz('online.manage')
  @ZodBody(updatePromoBlockBody)
  @ZodOk(promoBlockOut)
  updatePromo(@Param('businessId') businessId: string, @Param('id') id: string, @Body(new Zod(updatePromoBlockBody)) body: z.infer<typeof updatePromoBlockBody>) {
    return this.svc.updatePromoBlock(businessId, id, body);
  }

  @Delete('online/promo-blocks/:id')
  @Biz('online.manage')
  async removePromo(@Param('businessId') businessId: string, @Param('id') id: string) {
    await this.svc.deletePromoBlock(businessId, id);
    return { ok: true };
  }

  // ── звёздочка вместо отзывов (F-00-116/117) ──

  @Get('online/reviews/:target/:targetId/count')
  @Biz()
  @ZodOk(z.object({ count: z.number() }))
  async reviewCount(@Param('businessId') businessId: string, @Param('target') target: string, @Param('targetId') targetId: string) {
    return { count: await this.svc.starCount(businessId, target, targetId) };
  }

  // ── события виджета для аналитики (F-03-121) ──

  @Get('online/links/:id/widget-events')
  @Biz()
  @ZodOk(z.array(widgetEventOut))
  widgetEvents(@Param('id') id: string) {
    return this.svc.listWidgetEvents(id);
  }

  // ── групповая запись: настройка ссылки (F-03-076, F-03-102) ──

  @Get('online/links/:id/group-rules')
  @Biz()
  @ZodOk(groupBookingRulesOut)
  groupRules(@Param('id') id: string) {
    return this.svc.groupBookingRules(id);
  }

  @Put('online/links/:id/group-rules')
  @Biz('online.manage')
  @ZodBody(groupBookingRulesBody)
  @ZodOk(groupBookingRulesOut)
  setGroupRules(@Param('businessId') businessId: string, @Param('id') id: string, @Body(new Zod(groupBookingRulesBody)) body: z.infer<typeof groupBookingRulesBody>) {
    return this.svc.updateGroupBookingRules(businessId, id, body);
  }

  // ── мобильные приложения (F-03-048) ──

  @Get('online/mobile-app')
  @Biz()
  @ZodOk(mobileAppLinksOut)
  mobileApp(@Param('businessId') businessId: string) {
    return this.svc.mobileAppLinks(businessId);
  }

  @Put('online/mobile-app')
  @Biz('online.manage')
  @ZodBody(mobileAppLinksBody)
  @ZodOk(mobileAppLinksOut)
  setMobileApp(@Param('businessId') businessId: string, @Body(new Zod(mobileAppLinksBody)) body: z.infer<typeof mobileAppLinksBody>) {
    return this.svc.updateMobileAppLinks(businessId, body);
  }

  // ── другие каналы записи (F-03-036…046) ──

  @Get('online/integrations')
  @Biz()
  @ZodOk(z.array(integrationConnectionOut))
  integrations(@Param('businessId') businessId: string) {
    return this.svc.listIntegrations(businessId);
  }

  @Put('online/integrations/:id')
  @Biz('online.manage')
  @ZodBody(setIntegrationConnectedBody)
  @ZodOk(integrationConnectionOut)
  setIntegration(@Param('businessId') businessId: string, @Param('id') id: string, @Body(new Zod(setIntegrationConnectedBody)) body: z.infer<typeof setIntegrationConnectedBody>) {
    return this.svc.setIntegrationConnected(businessId, id, body.connected);
  }

  @Get('online/api-credentials')
  @Biz()
  @ZodOk(apiCredentialsOut)
  apiCredentials(@Param('businessId') businessId: string) {
    return this.svc.apiCredentials(businessId);
  }

  @Post('online/api-credentials/generate')
  @Biz('online.manage')
  @ZodOk(apiCredentialsOut)
  generateApiKey(@Param('businessId') businessId: string) {
    return this.svc.generateApiKey(businessId);
  }

  @Post('online/api-credentials/revoke')
  @Biz('online.manage')
  async revokeApiKey(@Param('businessId') businessId: string) {
    await this.svc.revokeApiKey(businessId);
    return { ok: true };
  }

  // ── «Кого позвать» (F-03-052) — литеральный `/first` регистрируем ДО `/:staffId`, иначе его перехватит параметр ──

  @Get('online/slot-candidates/first')
  @Biz()
  @ZodOk(z.object({ staffId: z.string().optional() }))
  async firstStaffWithCandidates(@Param('businessId') businessId: string, @Query('staffIds') staffIds: string) {
    return { staffId: await this.svc.firstStaffWithCandidates(businessId, (staffIds ?? '').split(',').filter(Boolean)) };
  }

  @Get('online/slot-candidates/:staffId')
  @Biz()
  @ZodOk(z.array(slotCandidateOut))
  slotCandidates(@Param('businessId') businessId: string, @Param('staffId') staffId: string, @Query('days') days?: string) {
    return this.svc.slotCandidates(businessId, staffId, days ? Number(days) : undefined);
  }

  @Post('online/slot-invites')
  @Biz('journal.edit')
  @ZodBody(inviteToSlotBody)
  @ZodOk(slotInviteOut)
  inviteToSlot(@Param('businessId') businessId: string, @Body(new Zod(inviteToSlotBody)) body: z.infer<typeof inviteToSlotBody>) {
    return this.svc.inviteToSlot(businessId, body.candidate, body.message);
  }

  @Get('online/slot-invites')
  @Biz()
  @ZodOk(z.array(slotInviteOut))
  slotInvites(@Param('businessId') businessId: string) {
    return this.svc.listSlotInvites(businessId);
  }
}
