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
@Module({
  imports: [ScheduleModule, StockModule, FinanceModule, LoyaltyModule],
  controllers: [JournalMoreController],
  providers: [JournalMoreService, JournalAccess],
})
export class JournalMoreModule {}
