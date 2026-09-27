import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { Biz, Ctx } from '../../common/http/guards.js';
import { ZodBody } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { PrismaService } from '../../common/prisma.service.js';
import { BookingPaymentsService } from './booking-payments.service.js';
import { FIN_RECORD_KINDS, FINANCE_SETTING_KEYS, FinanceExtService, type FinanceSettingKey, type FinRecordKind } from './finance-ext.service.js';

const id32 = z.string().min(1).max(32);
const money = z.number().int().min(0).max(1_000_000_000_000);
const settingBody = z.object({ value: z.unknown() });
const recordBody = z.object({ kind: z.enum(FIN_RECORD_KINDS), refId: id32.optional(), clientId: id32.optional(), data: z.record(z.string(), z.unknown()) });
const recordPatchBody = z.object({ data: z.record(z.string(), z.unknown()) });
const discountBody = z.object({ label: z.string().min(1).max(200), amount: money, exactLabel: z.boolean().optional() });
const accountPayBody = z.object({ clientId: id32, amount: money, loyaltyAccountId: id32.optional(), debt: z.boolean().optional() });
const topUpBody = z.object({ accountId: id32, amount: money, method: z.enum(['cash', 'card', 'other']), clientName: z.string().max(200).optional() });
const accountRefundBody = z.object({ accountId: id32, amount: money, comment: z.string().max(400).optional() });
const linkBody = z.object({ targetKind: z.enum(['booking', 'sale']), bookingId: id32.optional(), saleLabel: z.string().max(200).optional(), amount: money, remainingBefore: money });

/** Ключи, которые можно менять без «Финансы: редактировать» — нет: все настройки раздела под finance.edit (как мок) */
const WRITE_FINANCE_EDIT: FinRecordKind[] = ['adyenTxn', 'manualOrder'];

function assertKindWrite(ctx: RequestContext, kind: FinRecordKind) {
  const need = WRITE_FINANCE_EDIT.includes(kind) ? 'finance.edit' : 'journal.edit';
  if (!ctx.member!.permissions.has(need)) throw new ApiError('forbidden', `Missing permission: ${need}`);
}

function settingKey(key: string): FinanceSettingKey {
  if (!(FINANCE_SETTING_KEYS as readonly string[]).includes(key)) throw new ApiError('not_found', 'Unknown finance setting');
  return key as FinanceSettingKey;
}

/**
 * Этап 21, лейн «finance+stock»: недостающие маршруты раздела «Финансы» — см. докстринг `FinanceExtService`.
 * Тот же префикс, что у `FinanceController` этапа 12.
 */
@ApiTags('finance')
@Controller('v1/biz/:businessId/finance')
export class FinanceExtController {
  constructor(
    private readonly ext: FinanceExtService,
    private readonly payments: BookingPaymentsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('settings/:key')
  @Biz()
  getSetting(@Param('businessId') businessId: string, @Param('key') key: string) {
    return this.ext.getSetting(businessId, settingKey(key));
  }

  @Put('settings/:key')
  @Biz('finance.edit')
  @ZodBody(settingBody)
  putSetting(@Ctx() ctx: RequestContext, @Param('key') key: string, @Body(new Zod(settingBody)) body: z.infer<typeof settingBody>) {
    return this.ext.putSetting(ctx, settingKey(key), body.value ?? null);
  }

  @Get('records')
  @Biz()
  listRecords(@Param('businessId') businessId: string, @Query('kind') kind: string, @Query('refId') refId?: string, @Query('clientId') clientId?: string) {
    if (!(FIN_RECORD_KINDS as readonly string[]).includes(kind)) throw new ApiError('validation', 'Unknown record kind');
    return this.ext.listRecords(businessId, kind as FinRecordKind, refId || undefined, clientId || undefined);
  }

  @Post('records')
  @Biz('journal.edit')
  @ZodBody(recordBody)
  createRecord(@Ctx() ctx: RequestContext, @Body(new Zod(recordBody)) body: z.infer<typeof recordBody>) {
    assertKindWrite(ctx, body.kind);
    return this.ext.createRecord(ctx, body.kind, body.data, body.refId, body.clientId);
  }

  @Patch('records/:id')
  @Biz('journal.edit')
  @ZodBody(recordPatchBody)
  async patchRecord(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(recordPatchBody)) body: z.infer<typeof recordPatchBody>) {
    const row = await this.prisma.finRecord.findFirst({ where: { id, businessId: ctx.member!.businessId }, select: { kind: true } });
    if (!row) throw new ApiError('not_found', 'Record not found');
    assertKindWrite(ctx, row.kind as FinRecordKind);
    return this.ext.patchRecord(ctx, id, body.data);
  }

  // ── Оплата визита: скидка по акции, личный счёт клиента ──

  @Post('bookings/:bookingId/payments/discount')
  @Biz('journal.edit')
  @HttpCode(200)
  @ZodBody(discountBody)
  discount(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('bookingId') bookingId: string, @Body(new Zod(discountBody)) body: z.infer<typeof discountBody>) {
    return this.payments.applyDiscount(ctx, businessId, bookingId, body.label, body.amount, body.exactLabel);
  }

  @Post('bookings/:bookingId/payments/account')
  @Biz('journal.edit')
  @HttpCode(200)
  @ZodBody(accountPayBody)
  payFromAccount(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('bookingId') bookingId: string, @Body(new Zod(accountPayBody)) body: z.infer<typeof accountPayBody>) {
    return this.payments.applyAccount(ctx, businessId, bookingId, body.clientId, body.amount, body.loyaltyAccountId ? { accountId: body.loyaltyAccountId, debt: Boolean(body.debt) } : undefined);
  }

  @Get('bookings/:bookingId/receipt-data')
  @Biz('journal.view')
  receiptData(@Param('businessId') businessId: string, @Param('bookingId') bookingId: string) {
    return this.ext.bookingReceiptData(businessId, bookingId);
  }

  // ── Ссылка на оплату ──

  @Get('bookings/:bookingId/payment-link')
  @Biz('journal.view')
  linkForBooking(@Param('businessId') businessId: string, @Param('bookingId') bookingId: string) {
    return this.ext.paymentLinkForBooking(businessId, bookingId);
  }

  @Post('payment-links')
  @Biz('journal.edit')
  @ZodBody(linkBody)
  createLink(@Ctx() ctx: RequestContext, @Body(new Zod(linkBody)) body: z.infer<typeof linkBody>) {
    return this.ext.createPaymentLink(ctx, body);
  }

  @Post('payment-links/:id/paid')
  @Biz('journal.edit')
  @HttpCode(200)
  markLinkPaid(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.ext.markPaymentLinkPaid(ctx, id);
  }

  @Post('payment-links/:id/cancel')
  @Biz('journal.edit')
  @HttpCode(200)
  async cancelLink(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    await this.ext.cancelPaymentLink(ctx, id);
    return { ok: true as const };
  }

  // ── Личный счёт клиента ──

  @Get('clients/:clientId/account')
  @Biz('clients.view')
  clientAccount(@Param('businessId') businessId: string, @Param('clientId') clientId: string) {
    return this.ext.clientAccount(businessId, clientId);
  }

  @Post('clients/:clientId/account/topup')
  @Biz('finance.edit')
  @HttpCode(200)
  @ZodBody(topUpBody)
  topUp(@Ctx() ctx: RequestContext, @Param('clientId') clientId: string, @Body(new Zod(topUpBody)) body: z.infer<typeof topUpBody>) {
    return this.ext.topUpClientAccount(ctx, clientId, body);
  }

  @Post('account-topups/:opId/cancel')
  @Biz('finance.edit')
  @HttpCode(200)
  async cancelTopUp(@Ctx() ctx: RequestContext, @Param('opId') opId: string) {
    await this.ext.cancelTopUp(ctx, opId);
    return { ok: true as const };
  }

  @Post('clients/:clientId/account/refund')
  @Biz('finance.edit')
  @HttpCode(200)
  @ZodBody(accountRefundBody)
  refundAccount(@Ctx() ctx: RequestContext, @Param('clientId') clientId: string, @Body(new Zod(accountRefundBody)) body: z.infer<typeof accountRefundBody>) {
    return this.ext.refundClientAccount(ctx, clientId, body);
  }

  @Get('client-accounts/in-use')
  @Biz('finance.view')
  accountsInUse(@Param('businessId') businessId: string) {
    return this.ext.anyNonZeroAccount(businessId);
  }

  @Get('clients/:clientId/money')
  @Biz('clients.view')
  clientMoney(@Param('businessId') businessId: string, @Param('clientId') clientId: string) {
    return this.ext.clientMoneyInputs(businessId, clientId);
  }

  @Get('clients/:clientId/debt-visits')
  @Biz('clients.view')
  debtVisits(@Param('businessId') businessId: string, @Param('clientId') clientId: string) {
    return this.ext.clientDebtVisits(businessId, clientId);
  }

  @Get('reports/day-money')
  @Biz('journal.view')
  dayMoney(@Param('businessId') businessId: string, @Query('date') date: string, @Query('locationIds') locationIds?: string) {
    return this.ext.dayMoneySummary(businessId, date, locationIds ? locationIds.split(',').filter(Boolean) : undefined);
  }

  @Post('salary-payouts/:entryId/cancel')
  @Biz('finance.edit')
  @HttpCode(200)
  async cancelPayout(@Ctx() ctx: RequestContext, @Param('entryId') entryId: string) {
    await this.ext.cancelSalaryPayout(ctx, entryId);
    return { ok: true as const };
  }
}
