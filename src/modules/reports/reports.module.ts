import { Module } from '@nestjs/common';
import { ScheduleModule } from '../schedule/schedule.module.js';
import { ReportsAuditService } from './reports-audit.service.js';
import { ReportsDashboardService } from './reports-dashboard.service.js';
import { ReportsExportService } from './reports-export.service.js';
import { ReportsJournalService } from './reports-journal.service.js';
import { ReportsMarketingService } from './reports-marketing.service.js';
import { ReportsReviewsService } from './reports-reviews.service.js';
import { ReportsSalesService } from './reports-sales.service.js';
import { ReportsSettingsService } from './reports-settings.service.js';
import { ReportsController } from './reports.controller.js';

/** Этап 16: отчёты (docs/backend/02 §16, PLAN §6 №16). `ScheduleModule` — «Загруженность» читает часы графика
 * (`ScheduleService.hours()`, этап 6) вместо второго расчёта графика внутри отчётов. `ReportsReviewsService` —
 * этап 21 «network+reports»: отзывы (F-12-068…069) читают модели `client`-модуля (StarRating/StaffReview/
 * LocationReview) напрямую через Prisma, без импорта ClientModule (нет циклической зависимости). */
@Module({
  imports: [ScheduleModule],
  controllers: [ReportsController],
  providers: [ReportsDashboardService, ReportsJournalService, ReportsSalesService, ReportsMarketingService, ReportsAuditService, ReportsSettingsService, ReportsExportService, ReportsReviewsService],
  exports: [ReportsSettingsService, ReportsExportService],
})
export class ReportsModule {}
