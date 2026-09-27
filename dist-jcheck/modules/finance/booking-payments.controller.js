var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Biz, Ctx } from '../../common/http/guards.js';
import { ZodBody, ZodOk } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { BookingPaymentsService } from './booking-payments.service.js';
import { bookingPaymentNoteBody, payBookingBody, refundBookingFullBody } from './finance.schemas.js';
/**
 * Оплата визита (docs/backend/02-api.md §12). Путь — `/finance/bookings/:id/payments`, НЕ буквальный
 * `/bookings/:id/payments` из 02-api.md: тот уже занят стопгапом этапа 7 (`BookingsController`, PROGRESS.md
 * этапа 12, «решено по ходу») — старая пара «Оплатить» (PaymentSheet.tsx, payLines/instantPay) пишет только
 * в extras.payments, минуя кассы/операции; замена того пути на этот — вне этой сдачи (см. «Осталось»). Право —
 * `journal.edit`, не `finance.edit` (мастер закрывает свой визит без «Финансов» — В-10 «мастер видит свою
 * выручку»): то же право, что уже стоит на плитках-оплате в моке фронта, src/api/finance.ts.
 */
let BookingPaymentsController = class BookingPaymentsController {
    constructor(payments) {
        this.payments = payments;
    }
    getSummary(businessId, bookingId) {
        return this.payments.getSummary(businessId, bookingId);
    }
    pay(ctx, businessId, bookingId, body) {
        return this.payments.pay(ctx, businessId, bookingId, body);
    }
    async setNote(ctx, businessId, bookingId, body) {
        await this.payments.setNote(ctx, businessId, bookingId, body.note);
        return { ok: true };
    }
    refundFull(ctx, businessId, bookingId, body) {
        return this.payments.refundFull(ctx, businessId, bookingId, body.reason);
    }
};
__decorate([
    Get(),
    Biz('journal.view'),
    __param(0, Param('businessId')),
    __param(1, Param('bookingId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], BookingPaymentsController.prototype, "getSummary", null);
__decorate([
    Post(),
    Biz('journal.edit'),
    ZodBody(payBookingBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('bookingId')),
    __param(3, Body(new Zod(payBookingBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object]),
    __metadata("design:returntype", void 0)
], BookingPaymentsController.prototype, "pay", null);
__decorate([
    Put('note'),
    Biz('journal.edit'),
    HttpCode(200),
    ZodBody(bookingPaymentNoteBody),
    ZodOk(z.object({ ok: z.literal(true) })),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('bookingId')),
    __param(3, Body(new Zod(bookingPaymentNoteBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object]),
    __metadata("design:returntype", Promise)
], BookingPaymentsController.prototype, "setNote", null);
__decorate([
    Post('refund-full'),
    Biz('journal.edit'),
    ZodBody(refundBookingFullBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('bookingId')),
    __param(3, Body(new Zod(refundBookingFullBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object]),
    __metadata("design:returntype", void 0)
], BookingPaymentsController.prototype, "refundFull", null);
BookingPaymentsController = __decorate([
    ApiTags('finance'),
    Controller('v1/biz/:businessId/finance/bookings/:bookingId/payments'),
    __metadata("design:paramtypes", [BookingPaymentsService])
], BookingPaymentsController);
export { BookingPaymentsController };
/** Нефискальный чек визита (В-33). Контроллер отдельный, потому что путь не вложен в `.../payments`. */
let BookingReceiptController = class BookingReceiptController {
    constructor(payments) {
        this.payments = payments;
    }
    receipt(businessId, bookingId) {
        return this.payments.receipt(businessId, bookingId);
    }
};
__decorate([
    Get(),
    Biz('journal.view'),
    __param(0, Param('businessId')),
    __param(1, Param('bookingId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], BookingReceiptController.prototype, "receipt", null);
BookingReceiptController = __decorate([
    ApiTags('finance'),
    Controller('v1/biz/:businessId/finance/bookings/:bookingId/receipt'),
    __metadata("design:paramtypes", [BookingPaymentsService])
], BookingReceiptController);
export { BookingReceiptController };
/** Отмена одной строки денежной оплаты по её id (removeBookingPaymentLine мока не знает bookingId заранее —
 * cancelLine находит бронь по строке сам, поэтому путь плоский, без :bookingId). */
let BookingPaymentLineController = class BookingPaymentLineController {
    constructor(payments) {
        this.payments = payments;
    }
    cancelLine(ctx, businessId, paymentId) {
        return this.payments.cancelLine(ctx, businessId, paymentId);
    }
};
__decorate([
    Delete(':paymentId'),
    Biz('journal.edit'),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('paymentId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String]),
    __metadata("design:returntype", void 0)
], BookingPaymentLineController.prototype, "cancelLine", null);
BookingPaymentLineController = __decorate([
    ApiTags('finance'),
    Controller('v1/biz/:businessId/finance/payments'),
    __metadata("design:paramtypes", [BookingPaymentsService])
], BookingPaymentLineController);
export { BookingPaymentLineController };
//# sourceMappingURL=booking-payments.controller.js.map