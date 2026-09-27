import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { RequestContext } from '../../common/http/context.js';
import { Biz, Ctx } from '../../common/http/guards.js';
import { ZodBody } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { StockExtService } from './stock-ext.service.js';

const id32 = z.string().min(1).max(32);
const money = z.number().int().min(0).max(1_000_000_000_000);

const consumableAddBody = z.object({ locationId: id32, goodId: id32, qtyWriteoff: z.number().min(0).max(1_000_000) });
const consumableQtyBody = z.object({ qtyWriteoff: z.number().min(0).max(1_000_000) });
const massEditBody = z.object({
  rows: z
    .array(
      z.object({
        id: id32,
        sku: z.string().max(60).optional(),
        barcode: z.string().max(64).optional(),
        salePrice: money,
        costPrice: money,
        massNetG: z.number().int().min(0).max(1_000_000).optional(),
        massGrossG: z.number().int().min(0).max(1_000_000).optional(),
      }),
    )
    .max(2000),
});
const idsBody = z.object({ ids: z.array(id32).max(2000) });
const importBody = z.object({
  locationId: id32,
  categoryId: id32,
  rows: z.array(z.object({ row: z.number().int(), name: z.string().max(200), patch: z.record(z.string(), z.unknown()) })).max(500),
});
const copyBody = z.object({ targetLocationIds: z.array(id32).min(1).max(100) });
const permsBody = z.object({ permissions: z.record(z.string(), z.unknown()), base: z.record(z.string(), z.unknown()).optional() });
const permsReplaceBody = z.object({ permissions: z.record(z.string(), z.unknown()), label: z.string().max(120).optional(), fromStaffId: id32.optional() });
const priceTagBody = z.object({ patch: z.record(z.string(), z.unknown()), base: z.record(z.string(), z.unknown()) });

/**
 * Этап 21, лейн «finance+stock»: недостающие маршруты раздела «Товары» — см. докстринг `StockExtService`.
 * Тот же префикс, что у `StockController` этапа 13.
 */
@ApiTags('stock')
@Controller('v1/biz/:businessId/stock')
export class StockExtController {
  constructor(private readonly ext: StockExtService) {}

  @Get('journal')
  @Biz('stock.view')
  journal(@Param('businessId') businessId: string, @Query() q: Record<string, string | undefined>) {
    return this.ext.listOperationRows(businessId, q.locationId ?? '', q);
  }

  @Get('reports/movement')
  @Biz('stock.view')
  movement(@Param('businessId') businessId: string, @Query() q: Record<string, string | undefined>) {
    return this.ext.movementReport(businessId, q.locationId ?? '', q.dateFrom ?? '', q.dateTo ?? '', q.warehouseId || undefined);
  }

  @Get('reports/consumables')
  @Biz('stock.view')
  consumables(@Param('businessId') businessId: string, @Query() q: Record<string, string | undefined>) {
    return this.ext.consumablesAnalysis(businessId, q.locationId ?? '', q.dateFrom ?? '', q.dateTo ?? '');
  }

  @Get('cost-price-at')
  @Biz('stock.view')
  costPriceAt(@Param('businessId') businessId: string, @Query('goodId') goodId: string, @Query('at') at: string) {
    return this.ext.costPriceAt(businessId, goodId, at);
  }

  @Get('clients/search')
  @Biz('stock.view')
  searchClients(@Param('businessId') businessId: string, @Query('q') q: string) {
    return this.ext.searchClients(businessId, q ?? '');
  }

  @Get('clients/:clientId/purchases')
  @Biz('stock.view')
  purchases(@Param('businessId') businessId: string, @Param('clientId') clientId: string) {
    return this.ext.clientPurchaseSummary(businessId, clientId);
  }

  @Get('package-tech-card')
  @Biz('stock.view')
  packageTechCard(@Param('businessId') businessId: string, @Query('packageServiceId') packageServiceId: string, @Query('staffId') staffId: string) {
    return this.ext.packageTechCardLines(businessId, packageServiceId, staffId);
  }

  @Get('bookings/:bookingId/consumables')
  @Biz('stock.view')
  bookingConsumables(@Param('businessId') businessId: string, @Param('bookingId') bookingId: string) {
    return this.ext.bookingConsumables(businessId, bookingId);
  }

  @Get('bookings/:bookingId/consumables/by-service')
  @Biz('stock.view')
  bookingConsumablesByService(@Param('businessId') businessId: string, @Param('bookingId') bookingId: string) {
    return this.ext.bookingConsumablesByService(businessId, bookingId);
  }

  @Post('bookings/:bookingId/consumables')
  @Biz('stock.edit')
  @HttpCode(200)
  @ZodBody(consumableAddBody)
  async addConsumable(@Ctx() ctx: RequestContext, @Param('bookingId') bookingId: string, @Body(new Zod(consumableAddBody)) body: z.infer<typeof consumableAddBody>) {
    await this.ext.addBookingConsumable(ctx, bookingId, body.locationId, body.goodId, body.qtyWriteoff);
    return { ok: true as const };
  }

  @Put('bookings/:bookingId/consumables/:goodId')
  @Biz('stock.edit')
  @ZodBody(consumableQtyBody)
  async setConsumable(@Ctx() ctx: RequestContext, @Param('bookingId') bookingId: string, @Param('goodId') goodId: string, @Body(new Zod(consumableQtyBody)) body: z.infer<typeof consumableQtyBody>) {
    await this.ext.setBookingConsumableQty(ctx, bookingId, goodId, body.qtyWriteoff);
    return { ok: true as const };
  }

  /** Продажа товаров визита на складе — зовёт окно визита после оплаты/правки товаров (journal.syncVisitGoodsSale) */
  @Post('bookings/:bookingId/goods-sale/sync')
  @Biz('journal.edit')
  @HttpCode(200)
  goodsSaleSync(@Ctx() ctx: RequestContext, @Param('bookingId') bookingId: string) {
    return this.ext.syncVisitGoodsSale(ctx, bookingId);
  }

  @Get('stock-ops/:id/receipt')
  @Biz('stock.view')
  receipt(@Param('businessId') businessId: string, @Param('id') id: string) {
    return this.ext.receiptData(businessId, id);
  }

  @Post('products/mass-edit')
  @Biz('stock.edit')
  @HttpCode(200)
  @ZodBody(massEditBody)
  massEdit(@Ctx() ctx: RequestContext, @Body(new Zod(massEditBody)) body: z.infer<typeof massEditBody>) {
    return this.ext.saveMassEdit(ctx, body.rows);
  }

  @Post('products/delete')
  @Biz('stock.edit')
  @HttpCode(200)
  @ZodBody(idsBody)
  deleteGoods(@Ctx() ctx: RequestContext, @Body(new Zod(idsBody)) body: z.infer<typeof idsBody>) {
    return this.ext.deleteGoods(ctx, body.ids);
  }

  @Post('products/import')
  @Biz('stock.edit')
  @HttpCode(200)
  @ZodBody(importBody)
  importGoods(@Ctx() ctx: RequestContext, @Body(new Zod(importBody)) body: z.infer<typeof importBody>) {
    return this.ext.importGoods(ctx, body.locationId, body.categoryId, body.rows);
  }

  @Post('products/:id/copy-networked')
  @Biz('stock.edit')
  @HttpCode(200)
  @ZodBody(copyBody)
  copyNetworked(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(copyBody)) body: z.infer<typeof copyBody>) {
    return this.ext.copyGoodNetworked(ctx, id, body.targetLocationIds);
  }

  @Get('permissions/:staffId')
  @Biz()
  getPermissions(@Param('businessId') businessId: string, @Param('staffId') staffId: string) {
    return this.ext.getPermissions(businessId, staffId);
  }

  @Put('permissions/:staffId')
  @Biz('staff.manage')
  @ZodBody(permsBody)
  async setPermissions(@Ctx() ctx: RequestContext, @Param('staffId') staffId: string, @Body(new Zod(permsBody)) body: z.infer<typeof permsBody>) {
    const name = await this.ext.staffName(ctx.member!.businessId, staffId);
    return this.ext.putPermissions(ctx, staffId, body.permissions, 'set', `Права на склад сотрудника «${name}» изменены`, body.base ?? {});
  }

  /** Шаблон роли (label) или копия с другого сотрудника (fromStaffId) — набор уже посчитан фасадом */
  @Post('permissions/:staffId/replace')
  @Biz('staff.manage')
  @HttpCode(200)
  @ZodBody(permsReplaceBody)
  async replacePermissions(@Ctx() ctx: RequestContext, @Param('staffId') staffId: string, @Body(new Zod(permsReplaceBody)) body: z.infer<typeof permsReplaceBody>) {
    const businessId = ctx.member!.businessId;
    const toName = await this.ext.staffName(businessId, staffId);
    const summary = body.fromStaffId
      ? `Права на склад скопированы с «${await this.ext.staffName(businessId, body.fromStaffId)}» сотруднику «${toName}»`
      : `Шаблон роли «${body.label ?? ''}» применён к правам на склад сотрудника «${toName}»`;
    return this.ext.putPermissions(ctx, staffId, body.permissions, 'replace', summary, {});
  }

  @Get('permissions/:staffId/history')
  @Biz()
  permissionHistory(@Param('businessId') businessId: string, @Param('staffId') staffId: string) {
    return this.ext.permissionHistory(businessId, staffId);
  }

  @Get('price-tag-layout')
  @Biz('stock.view')
  getPriceTag(@Param('businessId') businessId: string) {
    return this.ext.getPriceTagLayout(businessId);
  }

  @Put('price-tag-layout')
  @Biz('stock.edit')
  @ZodBody(priceTagBody)
  putPriceTag(@Ctx() ctx: RequestContext, @Body(new Zod(priceTagBody)) body: z.infer<typeof priceTagBody>) {
    return this.ext.updatePriceTagLayout(ctx, body.patch, body.base);
  }

  @Get('reminders/summary')
  @Biz('stock.view')
  remindersSummary(@Param('businessId') businessId: string, @Query('locationId') locationId: string, @Query('staffId') staffId?: string) {
    return this.ext.remindersSummary(businessId, locationId, staffId || undefined);
  }

  @Get('client-materials')
  @Biz()
  clientMaterials(@Param('businessId') businessId: string, @Query('locationId') locationId: string) {
    return this.ext.clientMaterials(businessId, locationId);
  }

  @Get('client-palette')
  @Biz()
  clientPalette(@Param('businessId') businessId: string, @Query('locationId') locationId: string) {
    return this.ext.clientPalette(businessId, locationId);
  }

  @Get('supplier-offer')
  @Biz('stock.view')
  async supplierOffer(@Param('businessId') businessId: string, @Query('productName') productName: string) {
    return { offer: await this.ext.supplierOffer(businessId, productName ?? '') };
  }
}
