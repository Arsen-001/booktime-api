var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { Module } from '@nestjs/common';
import { CommonModule } from './common/common.module.js';
import { ContextMiddleware } from './common/http/context.middleware.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { BusinessesModule } from './modules/businesses/businesses.module.js';
import { ClientModule } from './modules/client/client.module.js';
import { ClientsModule } from './modules/clients/clients.module.js';
import { FinanceModule } from './modules/finance/finance.module.js';
import { JournalModule } from './modules/journal/journal.module.js';
import { JournalMoreModule } from './modules/journal-more/journal-more.module.js';
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
import { PlatformModule } from './modules/platform/platform.module.js';
import { DataRetentionModule } from './modules/data-retention/data-retention.module.js';
/** Корневой модуль API. Разделы (PLAN.md §6) добавляются сюда по этапам. */
let AppModule = class AppModule {
    configure(consumer) {
        consumer.apply(ContextMiddleware).forRoutes('*');
    }
};
AppModule = __decorate([
    Module({
        imports: [CommonModule, AuthModule, BusinessesModule, ServicesModule, ResourcesModule, ClientsModule, ScheduleModule, JournalModule, JournalMoreModule, OnlineModule, ClientModule, NotifyModule, LoyaltyModule, FinanceModule, StockModule, PayrollModule, NetworkModule, ReportsModule, BillingModule, SettingsModule, IntegrationsModule, PlatformModule, DataRetentionModule],
        controllers: [HealthController],
    })
], AppModule);
export { AppModule };
//# sourceMappingURL=app.module.js.map