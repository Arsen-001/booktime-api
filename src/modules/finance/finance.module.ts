import { Module } from '@nestjs/common';
import { BookingPaymentLineController, BookingPaymentsController, BookingReceiptController } from './booking-payments.controller.js';
import { BookingPaymentsService } from './booking-payments.service.js';
import { FinanceCatalogService } from './finance-catalog.service.js';
import { FinanceController } from './finance.controller.js';
import { FinOpsService } from './fin-ops.service.js';

/** Этап 12: финансы и касса (docs/backend/02-api.md §12, PLAN §6 №12). */
@Module({
  controllers: [FinanceController, BookingPaymentsController, BookingReceiptController, BookingPaymentLineController],
  providers: [FinanceCatalogService, FinOpsService, BookingPaymentsService],
  exports: [FinanceCatalogService, FinOpsService, BookingPaymentsService],
})
export class FinanceModule {}
