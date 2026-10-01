import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { RequestContext } from '../../common/http/context.js';
import { Biz, Ctx } from '../../common/http/guards.js';
import { isLocale } from '../../common/i18n/i18n.js';
import { ZodBody } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { addVisitPaymentBody, addVisitSaleLineBody, sendVisitReceiptBody } from './client.schemas.js';
import { VisitCashService } from './visit-cash.service.js';
import { assertJournal, canJournal } from '../journal/bookings.service.js';

/**
 * «Визит-микрокасса» кабинета (F-14-092…098), стадия 21 (лейн client+online, попытка 4): `src/api/client.ts::
 * listVisitCandidates/getVisitDetail/addVisitSaleLine/removeVisitSaleLine/addVisitPayment/removeVisitPayment/
 * refundVisitPayment/listNoAppRemindersTomorrow/sendVisitReceipt/isVisitReceiptSent`.
 */
@ApiTags('client')
@Controller('v1/biz/:businessId/visit-cash')
export class VisitCashController {
  constructor(private readonly svc: VisitCashService) {}

  // client-2-fix (как мок, AppGate «Напоминания»): список с телефонами клиентов — clients.phones
  @Get('no-app-reminders-tomorrow')
  @Biz('clients.phones')
  @ApiOperation({ summary: '«Завтра N клиентов без приложения» + текст WhatsApp (F-00-121)' })
  noAppReminders(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string) {
    const locale = isLocale(ctx.session?.locale) ? ctx.session!.locale : 'ru';
    return this.svc.listNoAppRemindersTomorrow(businessId, locale);
  }

  @Get('candidates')
  @Biz('journal.view')
  @ApiOperation({ summary: 'Визиты сегодня, доступные для открытия в приложении (F-14-093/094)' })
  async candidates(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Query('staffId') staffId?: string) {
    // client-2-fix: только визиты, которые сотрудник вправе видеть (journal.view по мастеру визита, чужие — journal.others)
    const rows = await this.svc.listVisitCandidates(businessId, staffId);
    return rows.filter((r) => canJournal(ctx, 'journal.view', r.booking.staffId));
  }

  @Get(':bookingId')
  @Biz('journal.view')
  @ApiOperation({ summary: 'Визит в разрезе продаж/оплат (F-14-092…098)' })
  async detail(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('bookingId') bookingId: string) {
    assertJournal(ctx, 'journal.view', await this.svc.visitStaffOf(businessId, { bookingId }));
    return this.svc.getVisitDetail(businessId, bookingId);
  }

  @Get(':bookingId/receipt-sent')
  @Biz('journal.view')
  @ApiOperation({ summary: 'Отправлена ли уже квитанция об оплате визита (F-14-095)' })
  receiptSent(@Param('businessId') businessId: string, @Param('bookingId') bookingId: string) {
    return this.svc.isVisitReceiptSent(businessId, bookingId);
  }

  @Post(':bookingId/receipt')
  @HttpCode(200)
  @Biz('journal.edit')
  @ApiOperation({ summary: 'Отправить клиенту квитанцию об оплате визита (F-14-095)' })
  @ZodBody(sendVisitReceiptBody)
  async sendReceipt(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('bookingId') bookingId: string, @Body(new Zod(sendVisitReceiptBody)) body: z.infer<typeof sendVisitReceiptBody>) {
    assertJournal(ctx, 'journal.edit', await this.svc.visitStaffOf(businessId, { bookingId }));
    return this.svc.sendVisitReceipt(businessId, bookingId, body);
  }

  @Post(':bookingId/sale-lines')
  @Biz('journal.edit')
  @ApiOperation({ summary: '«+ Add sale»: товар/абонемент/сертификат в визите (F-14-092)' })
  @ZodBody(addVisitSaleLineBody)
  async addSaleLine(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('bookingId') bookingId: string, @Body(new Zod(addVisitSaleLineBody)) body: z.infer<typeof addVisitSaleLineBody>) {
    assertJournal(ctx, 'journal.edit', await this.svc.visitStaffOf(businessId, { bookingId }));
    return this.svc.addVisitSaleLine(businessId, bookingId, body);
  }

  @Delete('sale-lines/:id')
  @Biz('journal.edit')
  @ApiOperation({ summary: 'Удалить продажу визита (F-14-092)' })
  async removeSaleLine(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('id') id: string) {
    assertJournal(ctx, 'journal.edit', await this.svc.visitStaffOf(businessId, { recordId: id }));
    return this.svc.removeVisitSaleLine(businessId, id);
  }

  @Post(':bookingId/payments')
  @Biz('journal.edit')
  @ApiOperation({ summary: 'Оплата визита частями (F-14-094/097)' })
  @ZodBody(addVisitPaymentBody)
  async addPayment(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('bookingId') bookingId: string, @Body(new Zod(addVisitPaymentBody)) body: z.infer<typeof addVisitPaymentBody>) {
    assertJournal(ctx, 'journal.edit', await this.svc.visitStaffOf(businessId, { bookingId }));
    return this.svc.addVisitPayment(businessId, bookingId, body);
  }

  @Delete('payments/:id')
  @Biz('journal.edit')
  @ApiOperation({ summary: 'Удалить оплату визита (F-14-097)' })
  async removePayment(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('id') id: string) {
    assertJournal(ctx, 'journal.edit', await this.svc.visitStaffOf(businessId, { recordId: id }));
    return this.svc.removeVisitPayment(businessId, id);
  }

  @Post('payments/:id/refund')
  @HttpCode(200)
  @Biz('journal.edit')
  @ApiOperation({ summary: '«Make a refund» — не стирает оплату, помечает возвращённой (F-14-095)' })
  async refundPayment(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('id') id: string) {
    assertJournal(ctx, 'journal.edit', await this.svc.visitStaffOf(businessId, { recordId: id }));
    return this.svc.refundVisitPayment(businessId, id);
  }
}
