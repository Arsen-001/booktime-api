import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { RequestContext } from '../../common/http/context.js';
import { Biz, Ctx } from '../../common/http/guards.js';
import { ZodBody, ZodOk } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { Idempotent } from '../../common/idempotency/idempotency.js';
import { BookingPaymentsService } from './booking-payments.service.js';
import { bookingPaymentNoteBody, payBookingBody, refundBookingFullBody } from './finance.schemas.js';

const refundPaymentBody = z.object({ amount: z.number().int().min(1).max(1_000_000_000_000), reason: z.string().max(400).default('') });


/**
 * Оплата визита (docs/backend/02-api.md §12). Путь — `/finance/bookings/:id/payments`, НЕ буквальный
 * `/bookings/:id/payments` из 02-api.md: тот уже занят стопгапом этапа 7 (`BookingsController`, PROGRESS.md
 * этапа 12, «решено по ходу») — старая пара «Оплатить» (PaymentSheet.tsx, payLines/instantPay) пишет только
 * в extras.payments, минуя кассы/операции; замена того пути на этот — вне этой сдачи (см. «Осталось»). Право —
 * `journal.edit`, не `finance.edit` (мастер закрывает свой визит без «Финансов» — В-10 «мастер видит свою
 * выручку»): то же право, что уже стоит на плитках-оплате в моке фронта, src/api/finance.ts.
 */
@ApiTags('finance')
@Controller('v1/biz/:businessId/finance/bookings/:bookingId/payments')
export class BookingPaymentsController {
  constructor(private readonly payments: BookingPaymentsService) {}

  @Get()
  @Biz('journal.view')
  getSummary(@Param('businessId') businessId: string, @Param('bookingId') bookingId: string) {
    return this.payments.getSummary(businessId, bookingId);
  }

  @Post()
  @Biz('journal.edit')
  @Idempotent()
  @ZodBody(payBookingBody)
  pay(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('bookingId') bookingId: string, @Body(new Zod(payBookingBody)) body: z.infer<typeof payBookingBody>) {
    return this.payments.pay(ctx, businessId, bookingId, body);
  }

  /** Стереть платежи уже удалённой записи (F-07-050, deleteBookingPaymentsHard) */
  @Delete()
  @Biz('journal.edit')
  @HttpCode(200)
  @ZodOk(z.object({ ok: z.literal(true) }))
  async purge(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('bookingId') bookingId: string) {
    await this.payments.purgeForDeletedBooking(ctx, businessId, bookingId);
    return { ok: true as const };
  }

  @Put('note')
  @Biz('journal.edit')
  @HttpCode(200)
  @ZodBody(bookingPaymentNoteBody)
  @ZodOk(z.object({ ok: z.literal(true) }))
  async setNote(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('bookingId') bookingId: string, @Body(new Zod(bookingPaymentNoteBody)) body: z.infer<typeof bookingPaymentNoteBody>) {
    await this.payments.setNote(ctx, businessId, bookingId, body.note);
    return { ok: true as const };
  }

  @Post('refund-full')
  @Biz('journal.edit')
  @ZodBody(refundBookingFullBody)
  refundFull(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('bookingId') bookingId: string, @Body(new Zod(refundBookingFullBody)) body: z.infer<typeof refundBookingFullBody>) {
    return this.payments.refundFull(ctx, businessId, bookingId, body.reason);
  }
}

/** Нефискальный чек визита (В-33). Контроллер отдельный, потому что путь не вложен в `.../payments`. */
@ApiTags('finance')
@Controller('v1/biz/:businessId/finance/bookings/:bookingId/receipt')
export class BookingReceiptController {
  constructor(private readonly payments: BookingPaymentsService) {}

  @Get()
  @Biz('journal.view')
  receipt(@Param('businessId') businessId: string, @Param('bookingId') bookingId: string) {
    return this.payments.receipt(businessId, bookingId);
  }
}

/** Отмена одной строки денежной оплаты по её id (removeBookingPaymentLine мока не знает bookingId заранее —
 * cancelLine находит бронь по строке сам, поэтому путь плоский, без :bookingId). */
@ApiTags('finance')
@Controller('v1/biz/:businessId/finance/payments')
export class BookingPaymentLineController {
  constructor(private readonly payments: BookingPaymentsService) {}

  @Delete(':paymentId')
  @Biz('journal.edit')
  cancelLine(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('paymentId') paymentId: string) {
    return this.payments.cancelLine(ctx, businessId, paymentId);
  }

  /** Частичный возврат по одному платежу визита (fin-review Ф8) */
  @Post(':paymentId/refund')
  @Biz('journal.edit')
  @HttpCode(200)
  @ZodBody(refundPaymentBody)
  refund(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('paymentId') paymentId: string, @Body(new Zod(refundPaymentBody)) body: z.infer<typeof refundPaymentBody>) {
    return this.payments.refundPayment(ctx, businessId, paymentId, body.amount, body.reason);
  }
}
