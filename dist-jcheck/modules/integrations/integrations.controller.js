var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Biz, Ctx } from '../../common/http/guards.js';
import { ZodBody, ZodOk } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { ApiKeysService } from './api-keys.service.js';
import { ConnectionsService } from './connections.service.js';
import { apiKeyOut, appInstallOut, connectAppBody, issueAiTokenBody, issueUserTokenBody, setWebhookEnabledBody, setWebhookEntitiesBody, systemUserOut, webhookConfigOut, webhookDeliveryOut, } from './integrations.schemas.js';
import { WebhooksService } from './webhooks.service.js';
/**
 * Интеграции — /v1/biz (docs/backend/02 §17, PLAN §6 №17). Каталог сторонних приложений/отзывы/кабинет
 * разработчика/демо-настройки конкретных приложений (b03/b04/b05) остаются на фронте (Р19, В-28 «позже») —
 * здесь только своё настоящее (ключи, вебхуки) и статус подключения каталожных приложений.
 */
let IntegrationsController = class IntegrationsController {
    constructor(apiKeys, webhooks, connections) {
        this.apiKeys = apiKeys;
        this.webhooks = webhooks;
        this.connections = connections;
    }
    // ─────────── API-ключи ───────────
    listApiKeys(businessId, kind) {
        return this.apiKeys.list(businessId, kind);
    }
    issuePartnerKey(ctx, businessId) {
        return this.apiKeys.issue(ctx, businessId, 'partner');
    }
    issueUserToken(ctx, businessId, body) {
        return this.apiKeys.issue(ctx, businessId, 'userToken', { label: body.label });
    }
    issueAiToken(ctx, businessId, body) {
        return this.apiKeys.issue(ctx, businessId, 'aiAssistant', { scope: body.scope });
    }
    revokeApiKey(businessId, id) {
        return this.apiKeys.revoke(businessId, id).then(() => ({ ok: true }));
    }
    // ─────────── Вебхуки ───────────
    getWebhookConfig(businessId) {
        return this.webhooks.getConfig(businessId);
    }
    setWebhookEnabled(ctx, businessId, body) {
        return this.webhooks.setEnabled(businessId, ctx.member.staffId, body.enabled);
    }
    setWebhookEntities(ctx, businessId, body) {
        return this.webhooks.setEntities(businessId, ctx.member.staffId, body.entities);
    }
    listDeliveries(businessId) {
        return this.webhooks.listDeliveries(businessId);
    }
    // ─────────── Подключения каталожных приложений (Р19: только статус) ───────────
    listInstalled(businessId, locationIds) {
        return this.connections.listInstalled(businessId, (locationIds ?? '').split(',').filter(Boolean));
    }
    countInstalled(businessId) {
        return this.connections.countForBusiness(businessId).then((count) => ({ count }));
    }
    getOne(businessId, appId, locationId) {
        return this.connections.getOne(businessId, appId, locationId);
    }
    liveLocations(businessId, appId, locationIds) {
        return this.connections.liveLocationIds(businessId, appId, (locationIds ?? '').split(',').filter(Boolean));
    }
    connect(businessId, body) {
        return this.connections.connect(businessId, body);
    }
    activate(businessId, id) {
        return this.connections.activate(businessId, id);
    }
    disconnect(businessId, id) {
        return this.connections.disconnect(businessId, id).then(() => ({ ok: true }));
    }
    listSystemUsers(businessId, locationId) {
        return this.connections.listSystemUsers(businessId, locationId);
    }
};
__decorate([
    Get('api-keys/:kind'),
    Biz('integrations.manage'),
    ZodOk(z.array(apiKeyOut)),
    __param(0, Param('businessId')),
    __param(1, Param('kind')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], IntegrationsController.prototype, "listApiKeys", null);
__decorate([
    Post('api-keys/partner'),
    Biz('integrations.manage'),
    ZodOk(apiKeyOut),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], IntegrationsController.prototype, "issuePartnerKey", null);
__decorate([
    Post('api-keys/user-token'),
    Biz('integrations.manage'),
    ZodBody(issueUserTokenBody),
    ZodOk(apiKeyOut),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(issueUserTokenBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], IntegrationsController.prototype, "issueUserToken", null);
__decorate([
    Post('api-keys/ai-token'),
    Biz('integrations.manage'),
    ZodBody(issueAiTokenBody),
    ZodOk(apiKeyOut),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(issueAiTokenBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], IntegrationsController.prototype, "issueAiToken", null);
__decorate([
    Delete('api-keys/:id'),
    Biz('integrations.manage'),
    __param(0, Param('businessId')),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], IntegrationsController.prototype, "revokeApiKey", null);
__decorate([
    Get('webhooks'),
    Biz('integrations.manage'),
    ZodOk(webhookConfigOut),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], IntegrationsController.prototype, "getWebhookConfig", null);
__decorate([
    Put('webhooks/enabled'),
    Biz('integrations.manage'),
    ZodBody(setWebhookEnabledBody),
    ZodOk(webhookConfigOut),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(setWebhookEnabledBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], IntegrationsController.prototype, "setWebhookEnabled", null);
__decorate([
    Put('webhooks/entities'),
    Biz('integrations.manage'),
    ZodBody(setWebhookEntitiesBody),
    ZodOk(webhookConfigOut),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(setWebhookEntitiesBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], IntegrationsController.prototype, "setWebhookEntities", null);
__decorate([
    Get('webhooks/deliveries'),
    Biz('integrations.manage'),
    ZodOk(z.array(webhookDeliveryOut)),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], IntegrationsController.prototype, "listDeliveries", null);
__decorate([
    Get('installs'),
    Biz(),
    ZodOk(z.array(appInstallOut)),
    __param(0, Param('businessId')),
    __param(1, Query('locationIds')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], IntegrationsController.prototype, "listInstalled", null);
__decorate([
    Get('installs/count'),
    Biz(),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], IntegrationsController.prototype, "countInstalled", null);
__decorate([
    Get('installs/one'),
    Biz(),
    ZodOk(appInstallOut),
    __param(0, Param('businessId')),
    __param(1, Query('appId')),
    __param(2, Query('locationId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String]),
    __metadata("design:returntype", void 0)
], IntegrationsController.prototype, "getOne", null);
__decorate([
    Get('installs/live-locations'),
    Biz(),
    __param(0, Param('businessId')),
    __param(1, Query('appId')),
    __param(2, Query('locationIds')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String]),
    __metadata("design:returntype", void 0)
], IntegrationsController.prototype, "liveLocations", null);
__decorate([
    Post('installs'),
    Biz('integrations.manage'),
    ZodBody(connectAppBody),
    ZodOk(z.array(appInstallOut)),
    __param(0, Param('businessId')),
    __param(1, Body(new Zod(connectAppBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], IntegrationsController.prototype, "connect", null);
__decorate([
    Post('installs/:id/activate'),
    Biz('integrations.manage'),
    ZodOk(appInstallOut),
    __param(0, Param('businessId')),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], IntegrationsController.prototype, "activate", null);
__decorate([
    Post('installs/:id/disconnect'),
    Biz('integrations.manage'),
    __param(0, Param('businessId')),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], IntegrationsController.prototype, "disconnect", null);
__decorate([
    Get('installs/system-users'),
    Biz(),
    ZodOk(z.array(systemUserOut)),
    __param(0, Param('businessId')),
    __param(1, Query('locationId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], IntegrationsController.prototype, "listSystemUsers", null);
IntegrationsController = __decorate([
    ApiTags('integrations'),
    Controller('v1/biz/:businessId/integrations'),
    __metadata("design:paramtypes", [ApiKeysService,
        WebhooksService,
        ConnectionsService])
], IntegrationsController);
export { IntegrationsController };
//# sourceMappingURL=integrations.controller.js.map