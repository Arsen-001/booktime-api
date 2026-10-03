import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { CommonModule } from './common/common.module.js';
import { ContextMiddleware } from './common/http/context.middleware.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { BusinessesModule } from './modules/businesses/businesses.module.js';
import { ClientModule } from './modules/client/client.module.js';
import { ClientsModule } from './modules/clients/clients.module.js';
import { FinanceModule } from './modules/finance/finance.module.js';
import { JournalModule } from './modules/journal/journal.module.js';
import { JournalMoreModule } from './modules/journal-more/journal-more.module.js';
import { WorkdayModule } from './modules/workday/workday.module.js';
import { HealthController } from './modules/health/health.controller.js';
import { LoyaltyModule } from './modules/loyalty/loyalty.module.js';
import { OnlineModule } from './modules/online/online.module.js';
import { ScheduleModule } from './modules/schedule/schedule.module.js';
import { ResourcesModule } from './modules/resources/resources.module.js';
import { ServicesModule } from './modules/services/services.module.js';
import { NetworkModule } from './modules/network/network.module.js';
import { NotifyModule } from './modules/notify/notify.module.js';
import { PayrollModule } from './modules/payroll/payroll.module.js';
import { ReportsModule } from './modules/reports/reports.module.js';
import { StockModule } from './modules/stock/stock.module.js';
import { BillingModule } from './modules/billing/billing.module.js';
import { SettingsModule } from './modules/settings/settings.module.js';
import { IntegrationsModule } from './modules/integrations/integrations.module.js';
import { NotifyChatModule } from './modules/notify/notify-chat.controller.js';
import { PlatformModule } from './modules/platform/platform.module.js';
import { DataRetentionModule } from './modules/data-retention/data-retention.module.js';
import { ShortLinksModule } from './modules/shortlinks/shortlinks.module.js';
import { TelegramModule } from './modules/telegram/telegram.module.js';
import { OrdersModule } from './modules/orders/orders.module.js';
import { UploadsModule } from './modules/uploads/uploads.module.js';

/** Корневой модуль API. Разделы (PLAN.md §6) добавляются сюда по этапам. */
@Module({
  imports: [CommonModule, AuthModule, BusinessesModule, ServicesModule, ResourcesModule, ClientsModule, ScheduleModule, JournalModule, JournalMoreModule, WorkdayModule, OnlineModule, ClientModule, NotifyModule, LoyaltyModule, FinanceModule, StockModule, PayrollModule, NetworkModule, ReportsModule, BillingModule, SettingsModule, IntegrationsModule, NotifyChatModule, PlatformModule, DataRetentionModule, ShortLinksModule, TelegramModule, OrdersModule, UploadsModule],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Раздача фото (/v1/files/…) — без сессии: браузер шлёт cookie и с картинками, а чтение сессии из базы на каждое фото не нужно
    consumer.apply(ContextMiddleware).exclude('v1/files/*path').forRoutes('*');
  }
}
