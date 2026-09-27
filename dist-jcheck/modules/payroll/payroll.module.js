var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
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
let PayrollModule = class PayrollModule {
};
PayrollModule = __decorate([
    Module({
        imports: [ScheduleModule, FinanceModule],
        controllers: [PayrollController, PayrollStaffController],
        providers: [PayrollCatalogService, PayrollComputeService, PayrollSettlementsService],
        exports: [PayrollCatalogService, PayrollComputeService, PayrollSettlementsService],
    })
], PayrollModule);
export { PayrollModule };
//# sourceMappingURL=payroll.module.js.map