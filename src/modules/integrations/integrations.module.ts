import { Module } from '@nestjs/common';
import { ApiKeysService } from './api-keys.service.js';
import { ConnectionsService } from './connections.service.js';
import { IntegrationsController } from './integrations.controller.js';
import { IntegrationsCatalogController, IntegrationsMarketController } from './marketplace.controller.js';
import { MarketplaceService } from './marketplace.service.js';
import { WebhooksService } from './webhooks.service.js';

/** Этап 17: интеграции — своё настоящее (ключи, вебхуки) + статус каталожных приложений (docs/backend/02 §17) */
@Module({
  controllers: [IntegrationsController, IntegrationsCatalogController, IntegrationsMarketController],
  providers: [ApiKeysService, WebhooksService, ConnectionsService, MarketplaceService],
  exports: [WebhooksService, ConnectionsService],
})
export class IntegrationsModule {}
