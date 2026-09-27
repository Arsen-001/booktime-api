import { Module } from '@nestjs/common';
import { FinanceModule } from '../finance/finance.module.js';
import { ScheduleModule } from '../schedule/schedule.module.js';
import { PayrollCatalogService } from './payroll-catalog.service.js';
import { PayrollComputeService } from './payroll-compute.service.js';
import { PayrollSettlementsService } from './payroll-settlements.service.js';
import { PayrollController, PayrollStaffController } from './payroll.controller.js';

/**
 * Этап 14: зарплата (PLAN §6 №14, docs/backend/02-api.md §14) — настройки, упрощённая схема сотрудника,
 * классическая модель (правила/критерии/схемы/назначения), расчёт за день/период/ведомость, взаиморасчёты
 * (премии/штрафы/выплата → FinOp), согласование ведомости, аналитика ФОТ.
 * `ScheduleModule` — рабочие часы дня (F-09-036, тот же `ScheduleService.hours`, что у отчётов/журнала).
 * `FinanceModule` — выплата заводит расходную операцию «Зарплата персонала» (`FinanceCatalogService.systemItemId`).
 */
@Module({
  imports: [ScheduleModule, FinanceModule],
  controllers: [PayrollController, PayrollStaffController],
  providers: [PayrollCatalogService, PayrollComputeService, PayrollSettlementsService],
  exports: [PayrollCatalogService, PayrollComputeService, PayrollSettlementsService],
})
export class PayrollModule {}
