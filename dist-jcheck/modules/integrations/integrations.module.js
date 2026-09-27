var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { Module } from '@nestjs/common';
import { ApiKeysService } from './api-keys.service.js';
import { ConnectionsService } from './connections.service.js';
import { IntegrationsController } from './integrations.controller.js';
import { WebhooksService } from './webhooks.service.js';
/** Этап 17: интеграции — своё настоящее (ключи, вебхуки) + статус каталожных приложений (docs/backend/02 §17) */
let IntegrationsModule = class IntegrationsModule {
};
IntegrationsModule = __decorate([
    Module({
        controllers: [IntegrationsController],
        providers: [ApiKeysService, WebhooksService, ConnectionsService],
        exports: [WebhooksService, ConnectionsService],
    })
], IntegrationsModule);
export { IntegrationsModule };
//# sourceMappingURL=integrations.module.js.map