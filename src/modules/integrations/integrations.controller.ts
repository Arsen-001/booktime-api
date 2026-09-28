import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { RequestContext } from '../../common/http/context.js';
import { Biz, Ctx } from '../../common/http/guards.js';
import { ZodBody, ZodOk } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { ApiKeysService } from './api-keys.service.js';
import { ConnectionsService } from './connections.service.js';
import {
  addWebhookAddressBody,
  addWebhookAddressOut,
  apiKeyOut,
  appInstallOut,
  connectAppBody,
  installTestOut,
  issueAiTokenBody,
  issueUserTokenBody,
  setWebhookEnabledBody,
  setWebhookEntitiesBody,
  systemUserOut,
  webhookConfigOut,
  webhookDeliveryOut,
} from './integrations.schemas.js';
import { WebhooksService } from './webhooks.service.js';

/**
 * Интеграции — /v1/biz (docs/backend/02 §17, PLAN §6 №17). Каталог сторонних приложений/отзывы/кабинет
 * разработчика/демо-настройки конкретных приложений (b03/b04/b05) остаются на фронте (Р19, В-28 «позже») —
 * здесь только своё настоящее (ключи, вебхуки) и статус подключения каталожных приложений.
 */
@ApiTags('integrations')
@Controller('v1/biz/:businessId/integrations')
export class IntegrationsController {
  constructor(
    private readonly apiKeys: ApiKeysService,
    private readonly webhooks: WebhooksService,
    private readonly connections: ConnectionsService,
  ) {}

  // ─────────── API-ключи ───────────

  @Get('api-keys/:kind')
  @Biz('integrations.manage')
  @ZodOk(z.array(apiKeyOut))
  listApiKeys(@Param('businessId') businessId: string, @Param('kind') kind: string) {
    return this.apiKeys.list(businessId, kind as 'partner' | 'userToken' | 'aiAssistant');
  }

  @Post('api-keys/partner')
  @Biz('integrations.manage')
  @ZodOk(apiKeyOut)
  issuePartnerKey(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string) {
    return this.apiKeys.issue(ctx, businessId, 'partner');
  }

  @Post('api-keys/user-token')
  @Biz('integrations.manage')
  @ZodBody(issueUserTokenBody)
  @ZodOk(apiKeyOut)
  issueUserToken(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(issueUserTokenBody)) body: z.infer<typeof issueUserTokenBody>) {
    return this.apiKeys.issue(ctx, businessId, 'userToken', { label: body.label });
  }

  @Post('api-keys/ai-token')
  @Biz('integrations.manage')
  @ZodBody(issueAiTokenBody)
  @ZodOk(apiKeyOut)
  issueAiToken(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(issueAiTokenBody)) body: z.infer<typeof issueAiTokenBody>) {
    return this.apiKeys.issue(ctx, businessId, 'aiAssistant', { scope: body.scope });
  }

  @Delete('api-keys/:id')
  @Biz('integrations.manage')
  revokeApiKey(@Param('businessId') businessId: string, @Param('id') id: string) {
    return this.apiKeys.revoke(businessId, id).then(() => ({ ok: true }));
  }

  // ─────────── Вебхуки ───────────

  @Get('webhooks')
  @Biz('integrations.manage')
  @ZodOk(webhookConfigOut)
  getWebhookConfig(@Param('businessId') businessId: string) {
    return this.webhooks.getConfig(businessId);
  }

  @Put('webhooks/enabled')
  @Biz('integrations.manage')
  @ZodBody(setWebhookEnabledBody)
  @ZodOk(webhookConfigOut)
  setWebhookEnabled(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(setWebhookEnabledBody)) body: z.infer<typeof setWebhookEnabledBody>) {
    return this.webhooks.setEnabled(businessId, ctx.member!.staffId, body.enabled);
  }

  @Put('webhooks/entities')
  @Biz('integrations.manage')
  @ZodBody(setWebhookEntitiesBody)
  @ZodOk(webhookConfigOut)
  setWebhookEntities(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(setWebhookEntitiesBody)) body: z.infer<typeof setWebhookEntitiesBody>) {
    return this.webhooks.setEntities(businessId, ctx.member!.staffId, body.entities);
  }

  @Get('webhooks/deliveries')
  @Biz('integrations.manage')
  @ZodOk(z.array(webhookDeliveryOut))
  listDeliveries(@Param('businessId') businessId: string) {
    return this.webhooks.listDeliveries(businessId);
  }

  // ─────────── Ревью 27.09 (И13): адреса вебхуков ───────────

  @Post('webhooks/addresses')
  @Biz('integrations.manage')
  @ZodBody(addWebhookAddressBody)
  @ZodOk(addWebhookAddressOut)
  addWebhookAddress(@Param('businessId') businessId: string, @Body(new Zod(addWebhookAddressBody)) body: z.infer<typeof addWebhookAddressBody>) {
    return this.webhooks.addAddress(businessId, body.url);
  }

  @Delete('webhooks/addresses/:id')
  @Biz('integrations.manage')
  removeWebhookAddress(@Param('businessId') businessId: string, @Param('id') id: string) {
    return this.webhooks.removeAddress(businessId, id).then(() => ({ ok: true }));
  }

  @Post('webhooks/addresses/:id/secret')
  @Biz('integrations.manage')
  rotateWebhookSecret(@Param('businessId') businessId: string, @Param('id') id: string) {
    return this.webhooks.rotateSecret(businessId, id).then((secret) => ({ secret }));
  }

  @Post('webhooks/deliveries/:id/retry')
  @Biz('integrations.manage')
  @ZodOk(webhookDeliveryOut)
  retryDelivery(@Param('businessId') businessId: string, @Param('id') id: string) {
    return this.webhooks.retryDelivery(businessId, id);
  }

  // ─────────── Подключения каталожных приложений (Р19: только статус) ───────────

  @Get('installs')
  @Biz()
  @ZodOk(z.array(appInstallOut))
  listInstalled(@Param('businessId') businessId: string, @Query('locationIds') locationIds: string) {
    return this.connections.listInstalled(businessId, (locationIds ?? '').split(',').filter(Boolean));
  }

  @Get('installs/count')
  @Biz()
  countInstalled(@Param('businessId') businessId: string) {
    return this.connections.countForBusiness(businessId).then((count) => ({ count }));
  }

  @Get('installs/one')
  @Biz()
  @ZodOk(appInstallOut)
  getOne(@Param('businessId') businessId: string, @Query('appId') appId: string, @Query('locationId') locationId: string) {
    return this.connections.getOne(businessId, appId, locationId);
  }

  @Get('installs/live-locations')
  @Biz()
  liveLocations(@Param('businessId') businessId: string, @Query('appId') appId: string, @Query('locationIds') locationIds: string) {
    return this.connections.liveLocationIds(businessId, appId, (locationIds ?? '').split(',').filter(Boolean));
  }

  @Post('installs')
  @Biz('integrations.manage')
  @ZodBody(connectAppBody)
  @ZodOk(z.array(appInstallOut))
  connect(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(connectAppBody)) body: z.infer<typeof connectAppBody>) {
    return this.connections.connect(businessId, body, ctx.member?.role);
  }

  @Post('installs/:id/activate')
  @Biz('integrations.manage')
  @ZodOk(appInstallOut)
  activate(@Param('businessId') businessId: string, @Param('id') id: string) {
    return this.connections.activate(businessId, id);
  }

  @Post('installs/:id/disconnect')
  @Biz('integrations.manage')
  disconnect(@Param('businessId') businessId: string, @Param('id') id: string) {
    return this.connections.disconnect(businessId, id).then(() => ({ ok: true }));
  }

  @Get('installs/system-users')
  @Biz()
  @ZodOk(z.array(systemUserOut))
  listSystemUsers(@Param('businessId') businessId: string, @Query('locationId') locationId: string) {
    return this.connections.listSystemUsers(businessId, locationId);
  }

  @Post('installs/:id/test')
  @Biz('integrations.manage')
  @ZodOk(installTestOut)
  sendTest(@Param('businessId') businessId: string, @Param('id') id: string) {
    return this.connections.sendTest(businessId, id);
  }
}
