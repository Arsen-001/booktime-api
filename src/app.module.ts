import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { CommonModule } from './common/common.module.js';
import { ContextMiddleware } from './common/http/context.middleware.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { BusinessesModule } from './modules/businesses/businesses.module.js';
import { ClientModule } from './modules/client/client.module.js';
import { ClientsModule } from './modules/clients/clients.module.js';
import { FinanceModule } from './modules/finance/finance.module.js';
import { JournalModule } from './modules/journal/journal.module.js';
import { HealthController } from './modules/health/health.controller.js';
import { LoyaltyModule } from './modules/loyalty/loyalty.module.js';
import { OnlineModule } from './modules/online/online.module.js';
import { ScheduleModule } from './modules/schedule/schedule.module.js';
import { ResourcesModule } from './modules/resources/resources.module.js';
import { ServicesModule } from './modules/services/services.module.js';
import { NotifyModule } from './modules/notify/notify.module.js';
import { StockModule } from './modules/stock/stock.module.js';

/** Корневой модуль API. Разделы (PLAN.md §6) добавляются сюда по этапам. */
@Module({
  imports: [CommonModule, AuthModule, BusinessesModule, ServicesModule, ResourcesModule, ClientsModule, ScheduleModule, JournalModule, OnlineModule, ClientModule, NotifyModule, LoyaltyModule, FinanceModule, StockModule],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(ContextMiddleware).forRoutes('*');
  }
}
