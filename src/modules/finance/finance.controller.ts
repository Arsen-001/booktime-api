import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { RequestContext } from '../../common/http/context.js';
import { Biz, BizAny, Ctx } from '../../common/http/guards.js';
import { ZodBody, ZodOk } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { FinanceCatalogService } from './finance-catalog.service.js';
import { FinOpsService, type FinOpFilter } from './fin-ops.service.js';
import { LoyaltySalesService } from './loyalty-sales.service.js';
import {
  cashRegisterBody,
  cashRegisterPatchBody,
  counterpartyBody,
  counterpartyPatchBody,
  documentPatchBody,
  fineBody,
  finOpBody,
  finOpPatchBody,
  importCounterpartiesBody,
  importFinOpsBody,
  loyaltySaleBody,
  paymentItemBody,
  paymentItemPatchBody,
  paymentMethodBody,
  paymentMethodPatchBody,
  refundBody,
  reorderBody,
  transferFundsBody,
} from './finance.schemas.js';

function splitCsv(v?: string): string[] | undefined {
  return v ? v.split(',').filter(Boolean) : undefined;
}

/**
 * Финансы и касса (docs/backend/02-api.md §12, PLAN §6 №12). Владелец данных — сам бизнес. Сделки визита живут в
 * `BookingPaymentsController` (path `/bookings/:id/payments`) — доктему литеральнее, чем гнездиться здесь.
 */
@ApiTags('finance')
@Controller('v1/biz/:businessId/finance')
export class FinanceController {
  constructor(
    private readonly catalog: FinanceCatalogService,
    private readonly ops: FinOpsService,
    private readonly loyaltySales: LoyaltySalesService,
  ) {}

  // ─────────────────────────── Продажа лояльности в кассу (01.10.2026) ───────────────────────────

  /**
   * recordLoyaltySale мока: приход за абонемент / сертификат / пополнение счёта клиента способом `methodKey`
   * (касса — у способа). Права — у продажи в «Лояльности»: администратор продаёт абонемент без права править финансы
   * (loyalty.manage), как и кассир (finance.edit). Продажи из раздела «Лояльность» (/loyalty/x/sell…) проводят
   * приход сами, в той же транзакции, — этот маршрут для продаж, собранных фронтом отдельно.
   */
  @Post('loyalty-sales')
  @BizAny('loyalty.manage', 'finance.edit')
  @HttpCode(200)
  @ZodBody(loyaltySaleBody)
  recordLoyaltySale(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(loyaltySaleBody)) body: z.infer<typeof loyaltySaleBody>) {
    return this.loyaltySales.record(businessId, body, ctx.member!.staffId).then((op) => this.ops.get(businessId, op.id));
  }

  // ─────────────────────────── Кассы ───────────────────────────

  @Get('cash-registers')
  // Кассовая смена (01.10.2026): администратору с finance.shift нужен список касс для смены
  @BizAny('finance.view', 'finance.shift')
  listCashRegisters(@Param('businessId') businessId: string, @Query('locationIds') locationIds?: string, @Query('withBalance') withBalance?: string) {
    return this.catalog.listCashRegisters(businessId, splitCsv(locationIds), withBalance === '1' || withBalance === 'true');
  }

  @Post('cash-registers')
  @Biz('finance.edit')
  @ZodBody(cashRegisterBody)
  createCashRegister(@Ctx() ctx: RequestContext, @Body(new Zod(cashRegisterBody)) body: z.infer<typeof cashRegisterBody>) {
    return this.catalog.createCashRegister(ctx, body);
  }

  @Patch('cash-registers/:id')
  @Biz('finance.edit')
  @ZodBody(cashRegisterPatchBody)
  updateCashRegister(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(cashRegisterPatchBody)) body: z.infer<typeof cashRegisterPatchBody>) {
    return this.catalog.updateCashRegister(ctx, id, body);
  }

  @Delete('cash-registers/:id')
  @Biz('finance.edit')
  @HttpCode(200)
  @ZodOk(z.object({ ok: z.literal(true) }))
  async removeCashRegister(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    await this.catalog.removeCashRegister(ctx, id);
    return { ok: true as const };
  }

  @Post('cash-registers/reorder')
  @Biz('finance.edit')
  @HttpCode(200)
  @ZodBody(reorderBody)
  @ZodOk(z.object({ ok: z.literal(true) }))
  async reorderCashRegisters(@Ctx() ctx: RequestContext, @Body(new Zod(reorderBody)) body: z.infer<typeof reorderBody>) {
    await this.catalog.reorderCashRegisters(ctx, body.orderedIds);
    return { ok: true as const };
  }

  @Post('cash-registers/transfer')
  @Biz('finance.edit')
  @ZodBody(transferFundsBody)
  async transfer(@Ctx() ctx: RequestContext, @Body(new Zod(transferFundsBody)) body: z.infer<typeof transferFundsBody>) {
    const { fromOperationId, toOperationId } = await this.catalog.transfer(ctx, body);
    return Promise.all([this.ops.get(ctx.member!.businessId, fromOperationId), this.ops.get(ctx.member!.businessId, toOperationId)]);
  }

  // ─────────────────────────── Статьи ───────────────────────────

  @Get('items')
  @Biz('finance.view')
  listItems(@Param('businessId') businessId: string) {
    return this.catalog.listItems(businessId);
  }

  @Post('items')
  @Biz('finance.edit')
  @ZodBody(paymentItemBody)
  createItem(@Ctx() ctx: RequestContext, @Body(new Zod(paymentItemBody)) body: z.infer<typeof paymentItemBody>) {
    return this.catalog.createItem(ctx, body);
  }

  @Patch('items/:id')
  @Biz('finance.edit')
  @ZodBody(paymentItemPatchBody)
  updateItem(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(paymentItemPatchBody)) body: z.infer<typeof paymentItemPatchBody>) {
    return this.catalog.updateItem(ctx, id, body);
  }

  @Delete('items/:id')
  @Biz('finance.edit')
  @HttpCode(200)
  @ZodOk(z.object({ ok: z.literal(true) }))
  async removeItem(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    await this.catalog.removeItem(ctx.member!.businessId, id);
    return { ok: true as const };
  }

  // ─────────────────────────── Методы оплаты (упрощённо) ───────────────────────────

  @Get('payment-methods')
  @Biz('finance.view')
  listMethods(@Param('businessId') businessId: string) {
    return this.catalog.listMethods(businessId);
  }

  @Post('payment-methods')
  @Biz('finance.edit')
  @ZodBody(paymentMethodBody)
  createMethod(@Ctx() ctx: RequestContext, @Body(new Zod(paymentMethodBody)) body: z.infer<typeof paymentMethodBody>) {
    return this.catalog.createMethod(ctx, body);
  }

  @Patch('payment-methods/:id')
  @Biz('finance.edit')
  @ZodBody(paymentMethodPatchBody)
  updateMethod(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(paymentMethodPatchBody)) body: z.infer<typeof paymentMethodPatchBody>) {
    return this.catalog.updateMethod(ctx, id, body);
  }

  @Delete('payment-methods/:id')
  @Biz('finance.edit')
  @HttpCode(200)
  @ZodOk(z.object({ ok: z.literal(true) }))
  async removeMethod(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    await this.catalog.removeMethod(ctx.member!.businessId, id);
    return { ok: true as const };
  }

  // ─────────────────────────── Контрагенты ───────────────────────────

  @Get('counterparties')
  @Biz('finance.view')
  listCounterparties(@Param('businessId') businessId: string) {
    return this.catalog.listCounterparties(businessId);
  }

  @Post('counterparties')
  @Biz('finance.edit')
  @ZodBody(counterpartyBody)
  createCounterparty(@Ctx() ctx: RequestContext, @Body(new Zod(counterpartyBody)) body: z.infer<typeof counterpartyBody>) {
    return this.catalog.createCounterparty(ctx, body);
  }

  @Patch('counterparties/:id')
  @Biz('finance.edit')
  @ZodBody(counterpartyPatchBody)
  updateCounterparty(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(counterpartyPatchBody)) body: z.infer<typeof counterpartyPatchBody>) {
    return this.catalog.updateCounterparty(ctx, id, body);
  }

  @Delete('counterparties/:id')
  @Biz('finance.edit')
  @HttpCode(200)
  @ZodOk(z.object({ ok: z.literal(true) }))
  async removeCounterparty(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    await this.catalog.removeCounterparty(ctx.member!.businessId, id);
    return { ok: true as const };
  }

  @Post('counterparties/import')
  @Biz('finance.edit')
  @ZodBody(importCounterpartiesBody)
  importCounterparties(@Ctx() ctx: RequestContext, @Body(new Zod(importCounterpartiesBody)) body: z.infer<typeof importCounterpartiesBody>) {
    return this.catalog.importCounterparties(ctx, body.rows);
  }

  // ─────────────────────────── Документы ───────────────────────────

  @Get('documents')
  @Biz('finance.view')
  listDocuments(@Param('businessId') businessId: string, @Query() q: Record<string, string | undefined>) {
    return this.catalog.listDocuments(businessId, { type: q.type, contentKind: q.contentKind, dateFrom: q.dateFrom, dateTo: q.dateTo, search: q.search });
  }

  @Get('documents/:id')
  @Biz('finance.view')
  getDocument(@Param('businessId') businessId: string, @Param('id') id: string) {
    return this.catalog.getDocument(businessId, id);
  }

  @Patch('documents/:id')
  @Biz('finance.edit')
  @ZodBody(documentPatchBody)
  updateDocument(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(documentPatchBody)) body: z.infer<typeof documentPatchBody>) {
    return this.catalog.updateDocument(ctx, id, body.note);
  }

  // ─────────────────────────── Операции ───────────────────────────

  @Get('fin-ops')
  @Biz('finance.view')
  listOps(@Param('businessId') businessId: string, @Query() q: Record<string, string | undefined>) {
    const filter: FinOpFilter = {
      locationIds: splitCsv(q.locationIds),
      accountId: q.accountId,
      itemId: q.itemId,
      kind: q.kind,
      method: q.method,
      partyType: q.partyType,
      partyId: q.partyId,
      cancelled: q.cancelled === undefined ? undefined : q.cancelled === 'true',
      dateFrom: q.dateFrom,
      dateTo: q.dateTo,
      search: q.search,
    };
    return this.ops.list(businessId, filter);
  }

  @Get('fin-ops/:id')
  @Biz('finance.view')
  getOp(@Param('businessId') businessId: string, @Param('id') id: string) {
    return this.ops.get(businessId, id);
  }

  @Post('fin-ops')
  @Biz('finance.edit')
  @ZodBody(finOpBody)
  createOp(@Ctx() ctx: RequestContext, @Body(new Zod(finOpBody)) body: z.infer<typeof finOpBody>) {
    // Этап 21: источник из тела (account/sale/…) — политика оплаты, заказы и счёт клиента пишут не «вручную»
    return this.ops.create(ctx, body, body.source);
  }

  @Patch('fin-ops/:id')
  @Biz('finance.edit')
  @ZodBody(finOpPatchBody)
  updateOp(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(finOpPatchBody)) body: z.infer<typeof finOpPatchBody>) {
    return this.ops.update(ctx, id, body);
  }

  @Post('fin-ops/:id/cancel')
  @Biz('finance.edit')
  @HttpCode(200)
  @ZodOk(z.object({ ok: z.literal(true) }))
  async cancelOp(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    await this.ops.cancel(ctx, id);
    return { ok: true as const };
  }

  @Post('fin-ops/import')
  @Biz('finance.edit')
  @ZodBody(importFinOpsBody)
  importOps(@Ctx() ctx: RequestContext, @Body(new Zod(importFinOpsBody)) body: z.infer<typeof importFinOpsBody>) {
    return this.ops.importRows(ctx, body.rows);
  }

  // ─────────────────────────── Возвраты и штрафы (F-07-066…075) ───────────────────────────

  @Post('refunds')
  @Biz('finance.edit')
  @ZodBody(refundBody)
  refund(@Ctx() ctx: RequestContext, @Body(new Zod(refundBody)) body: z.infer<typeof refundBody>) {
    return this.ops.refund(ctx, body);
  }

  @Post('fines')
  @Biz('finance.edit')
  @ZodBody(fineBody)
  fine(@Ctx() ctx: RequestContext, @Body(new Zod(fineBody)) body: z.infer<typeof fineBody>) {
    return this.ops.fine(ctx, body);
  }

  // ─────────────────────────── Отчёты (F-07-163…165) ───────────────────────────

  @Get('reports/cash-day')
  @Biz('finance.view')
  cashDay(@Param('businessId') businessId: string, @Query('date') date: string, @Query('locationIds') locationIds?: string) {
    return this.ops.cashDay(businessId, date, splitCsv(locationIds));
  }

  @Get('reports/finance')
  @Biz('finance.view')
  overview(@Param('businessId') businessId: string, @Query('from') from: string, @Query('to') to: string, @Query('locationIds') locationIds?: string) {
    return this.ops.overview(businessId, from, to, splitCsv(locationIds));
  }

  @Get('reports/pnl')
  @Biz('finance.view')
  pnl(@Param('businessId') businessId: string, @Query('from') from: string, @Query('to') to: string, @Query('locationIds') locationIds?: string) {
    return this.ops.pnl(businessId, from, to, splitCsv(locationIds));
  }
}
