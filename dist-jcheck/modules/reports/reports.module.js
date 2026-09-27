var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { Module } from '@nestjs/common';
import { ScheduleModule } from '../schedule/schedule.module.js';
import { ReportsAuditService } from './reports-audit.service.js';
import { ReportsDashboardService } from './reports-dashboard.service.js';
import { ReportsExportService } from './reports-export.service.js';
import { ReportsJournalService } from './reports-journal.service.js';
import { ReportsMarketingService } from './reports-marketing.service.js';
import { ReportsSalesService } from './reports-sales.service.js';
import { ReportsSettingsService } from './reports-settings.service.js';
import { ReportsController } from './reports.controller.js';
/** Этап 16: отчёты (docs/backend/02 §16, PLAN §6 №16). `ScheduleModule` — «Загруженность» читает часы графика
 * (`ScheduleService.hours()`, этап 6) вместо второго расчёта графика внутри отчётов. */
let ReportsModule = class ReportsModule {
};
ReportsModule = __decorate([
    Module({
        imports: [ScheduleModule],
        controllers: [ReportsController],
        providers: [ReportsDashboardService, ReportsJournalService, ReportsSalesService, ReportsMarketingService, ReportsAuditService, ReportsSettingsService, ReportsExportService],
        exports: [ReportsSettingsService, ReportsExportService],
    })
], ReportsModule);
export { ReportsModule };
//# sourceMappingURL=reports.module.js.map