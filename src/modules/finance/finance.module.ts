import { Module } from '@nestjs/common';
import { BookingPaymentLineController, BookingPaymentsController, BookingReceiptController } from './booking-payments.controller.js';
import { BookingPaymentsService } from './booking-payments.service.js';
import { FinanceCatalogService } from './finance-catalog.service.js';
import { FinanceController } from './finance.controller.js';
import { FinanceExtController } from './finance-ext.controller.js';
import { FinanceExtService } from './finance-ext.service.js';
import { FinOpsService } from './fin-ops.service.js';
import { CashShiftsService } from './cash-shifts.service.js';

/** Этап 12: финансы и касса (docs/backend/02-api.md §12, PLAN §6 №12). */
@Module({
  controllers: [FinanceController, BookingPaymentsController, BookingReceiptController, BookingPaymentLineController, FinanceExtController],
  providers: [FinanceCatalogService, FinOpsService, BookingPaymentsService, FinanceExtService, CashShiftsService],
  exports: [FinanceCatalogService, FinOpsService, BookingPaymentsService, FinanceExtService],
})
export class FinanceModule {}
