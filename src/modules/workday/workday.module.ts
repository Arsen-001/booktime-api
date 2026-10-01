import { Module } from '@nestjs/common';
import { FinanceModule } from '../finance/finance.module.js';
import { WorkdayController } from './workday.controller.js';
import { WorkdayService } from './workday.service.js';

/**
 * ⭐ Рабочий день журнала (01.10.2026, пункты 5–7): утренняя сводка, незакрытые визиты, итоги дня. Свой модуль —
 * соседние лейны правят JournalModule/JournalMoreModule одновременно. FinanceModule — сумма визита с товарами.
 */
@Module({
  imports: [FinanceModule],
  controllers: [WorkdayController],
  providers: [WorkdayService],
})
export class WorkdayModule {}
