var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { Module } from '@nestjs/common';
import { FinanceModule } from '../finance/finance.module.js';
import { JournalAccess } from '../journal/access.js';
import { LoyaltyModule } from '../loyalty/loyalty.module.js';
import { ScheduleModule } from '../schedule/schedule.module.js';
import { StockModule } from '../stock/stock.module.js';
import { JournalMoreController } from './journal-more.controller.js';
import { JournalMoreService } from './journal-more.service.js';
/**
 * Этап 21, лейн «journal» — функции src/api/journal.ts фронта, которые до этого считали по моку браузера.
 * Отдельный модуль, а не правка JournalModule: соседние лейны правят журнал одновременно, свой файл не мешает им.
 * `ScheduleModule` даёт AvailabilityService (часы, занятость человека), `StockModule`/`FinanceModule`/`LoyaltyModule` —
 * продажу вне визита и «Новый платёж» в настоящую кассу.
 */
let JournalMoreModule = class JournalMoreModule {
};
JournalMoreModule = __decorate([
    Module({
        imports: [ScheduleModule, StockModule, FinanceModule, LoyaltyModule],
        controllers: [JournalMoreController],
        providers: [JournalMoreService, JournalAccess],
    })
], JournalMoreModule);
export { JournalMoreModule };
//# sourceMappingURL=journal-more.module.js.map