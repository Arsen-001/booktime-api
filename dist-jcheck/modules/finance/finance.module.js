var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { Module } from '@nestjs/common';
import { BookingPaymentLineController, BookingPaymentsController, BookingReceiptController } from './booking-payments.controller.js';
import { BookingPaymentsService } from './booking-payments.service.js';
import { FinanceCatalogService } from './finance-catalog.service.js';
import { FinanceController } from './finance.controller.js';
import { FinOpsService } from './fin-ops.service.js';
/** Этап 12: финансы и касса (docs/backend/02-api.md §12, PLAN §6 №12). */
let FinanceModule = class FinanceModule {
};
FinanceModule = __decorate([
    Module({
        controllers: [FinanceController, BookingPaymentsController, BookingReceiptController, BookingPaymentLineController],
        providers: [FinanceCatalogService, FinOpsService, BookingPaymentsService],
        exports: [FinanceCatalogService, FinOpsService, BookingPaymentsService],
    })
], FinanceModule);
export { FinanceModule };
//# sourceMappingURL=finance.module.js.map