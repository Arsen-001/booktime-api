import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { RequestContext } from '../../common/http/context.js';
import { Biz, Ctx } from '../../common/http/guards.js';
import { ZodBody, ZodOk } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { InventoriesService } from './inventories.service.js';
import { StockCatalogService } from './stock-catalog.service.js';
import { StockOpsService } from './stock-ops.service.js';
import {
  categoryBody,
  categoryPatchBody,
  equipmentBody,
  equipmentPatchBody,
  goodBody,
  goodPatchBody,
  idsBody,
  incomeBody,
  inventoryCreateBody,
  inventorySetLinesBody,
  inventoryMetaBody,
  moveBody,
  opDocPatchBody,
  quickUpdateGoodsBody,
  reminderBody,
  reorderBody,
  restoreGoodsBody,
  saleBody,
  stockSettingsPatchBody,
  techCardPutBody,
  warehouseBody,
  warehousePatchBody,
  writeoffBody,
} from './stock.schemas.js';
import { TechCardsService } from './tech-cards.service.js';

/**
 * Склад (docs/backend/02-api.md §13, PLAN §6 №13). Владелец данных — сам бизнес (как финансы, этап 12),
 * не сеть — сетевое копирование товаров (F-08-130/135) не строим в этом проходе (см. PROGRESS.md «Не строил»).
 */
@ApiTags('stock')
@Controller('v1/biz/:businessId/stock')
export class StockController {
  constructor(
    private readonly catalog: StockCatalogService,
    private readonly ops: StockOpsService,
    private readonly techCards: TechCardsService,
    private readonly inventories: InventoriesService,
  ) {}

  // ─────────────────────────── Склады (F-08-004…009) ───────────────────────────

  @Get('warehouses')
  @Biz('stock.view')
  listWarehouses(@Param('businessId') businessId: string, @Query('locationId') locationId: string) {
    return this.catalog.listWarehouses(businessId, locationId);
  }

  @Get('warehouses/:id')
  @Biz('stock.view')
  getWarehouse(@Param('businessId') businessId: string, @Param('id') id: string) {
    return this.catalog.getWarehouse(businessId, id);
  }

  @Post('warehouses')
  @Biz('stock.edit')
  @ZodBody(warehouseBody)
  createWarehouse(@Ctx() ctx: RequestContext, @Body(new Zod(warehouseBody)) body: z.infer<typeof warehouseBody>) {
    return this.catalog.createWarehouse(ctx, body);
  }

  @Patch('warehouses/:id')
  @Biz('stock.edit')
  @ZodBody(warehousePatchBody)
  updateWarehouse(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(warehousePatchBody)) body: z.infer<typeof warehousePatchBody>) {
    return this.catalog.updateWarehouse(ctx, id, body);
  }

  @Delete('warehouses/:id')
  @Biz('stock.edit')
  @HttpCode(200)
  @ZodOk(z.object({ ok: z.literal(true) }))
  async removeWarehouse(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    await this.catalog.removeWarehouse(ctx.member!.businessId, id);
    return { ok: true as const };
  }

  @Post('warehouses/reorder')
  @Biz('stock.edit')
  @HttpCode(200)
  @ZodBody(reorderBody)
  @ZodOk(z.object({ ok: z.literal(true) }))
  async reorderWarehouses(@Ctx() ctx: RequestContext, @Query('locationId') locationId: string, @Body(new Zod(reorderBody)) body: z.infer<typeof reorderBody>) {
    await this.catalog.reorderWarehouses(ctx.member!.businessId, locationId, body.orderedIds);
    return { ok: true as const };
  }

  // ─────────────────────────── Категории (F-08-010…014) ───────────────────────────

  @Get('product-categories')
  @Biz('stock.view')
  listCategories(@Param('businessId') businessId: string, @Query('locationId') locationId: string, @Query('tree') tree?: string, @Query('includeArchived') includeArchived?: string) {
    if (tree === '1' || tree === 'true') return this.catalog.listCategoryTree(businessId, locationId);
    return this.catalog.listCategoriesFlat(businessId, locationId, includeArchived === '1' || includeArchived === 'true');
  }

  @Post('product-categories')
  @Biz('stock.edit')
  @ZodBody(categoryBody)
  createCategory(@Ctx() ctx: RequestContext, @Body(new Zod(categoryBody)) body: z.infer<typeof categoryBody>) {
    return this.catalog.createCategory(ctx, body);
  }

  @Patch('product-categories/:id')
  @Biz('stock.edit')
  @ZodBody(categoryPatchBody)
  updateCategory(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(categoryPatchBody)) body: z.infer<typeof categoryPatchBody>) {
    return this.catalog.updateCategory(ctx, id, body);
  }

  @Post('product-categories/:id/archive')
  @Biz('stock.edit')
  @HttpCode(200)
  @ZodOk(z.object({ ok: z.literal(true) }))
  async archiveCategory(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    await this.catalog.archiveCategory(ctx, id);
    return { ok: true as const };
  }

  @Post('product-categories/:id/restore')
  @Biz('stock.edit')
  @HttpCode(200)
  @ZodOk(z.object({ ok: z.literal(true) }))
  async restoreCategory(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    await this.catalog.restoreCategory(ctx, id);
    return { ok: true as const };
  }

  @Post('product-categories/restore')
  @Biz('stock.edit')
  @ZodBody(idsBody)
  restoreCategories(@Ctx() ctx: RequestContext, @Body(new Zod(idsBody)) body: z.infer<typeof idsBody>) {
    return this.catalog.restoreCategories(ctx, body.ids);
  }

  @Delete('product-categories/:id')
  @Biz('stock.edit')
  @HttpCode(200)
  @ZodOk(z.object({ ok: z.literal(true) }))
  async removeCategory(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    await this.catalog.removeCategory(ctx.member!.businessId, id);
    return { ok: true as const };
  }

  // ─────────────────────────── Товары (F-08-015…027) ───────────────────────────

  @Get('products')
  @Biz('stock.view')
  listGoods(@Param('businessId') businessId: string, @Query() q: Record<string, string | undefined>) {
    return this.catalog.listGoods(businessId, q.locationId!, { categoryId: q.categoryId, search: q.search, includeArchived: q.includeArchived === '1' || q.includeArchived === 'true', page: q.page ? Number(q.page) : undefined, pageSize: q.pageSize ? Number(q.pageSize) : undefined });
  }

  @Get('products/search')
  @Biz('stock.view')
  searchGoods(@Param('businessId') businessId: string, @Query('locationId') locationId: string, @Query('q') query = '', @Query('limit') limit?: string) {
    return this.catalog.searchGoods(businessId, locationId, query, limit ? Number(limit) : undefined);
  }

  @Get('products/:id')
  @Biz('stock.view')
  getGood(@Param('businessId') businessId: string, @Param('id') id: string) {
    return this.catalog.getGood(businessId, id);
  }

  @Get('products/:id/history')
  @Biz('stock.view')
  getGoodHistory(@Param('businessId') businessId: string, @Param('id') id: string) {
    return this.catalog.listEntityHistory(businessId, 'stockGood', id);
  }

  @Post('products')
  @Biz('stock.edit')
  @ZodBody(goodBody)
  createGood(@Ctx() ctx: RequestContext, @Body(new Zod(goodBody)) body: z.infer<typeof goodBody>) {
    return this.catalog.createGood(ctx, body);
  }

  @Patch('products/:id')
  @Biz('stock.edit')
  @ZodBody(goodPatchBody)
  updateGood(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(goodPatchBody)) body: z.infer<typeof goodPatchBody>) {
    return this.catalog.updateGood(ctx, id, body);
  }

  @Post('products/quick-update')
  @Biz('stock.edit')
  @HttpCode(200)
  @ZodBody(quickUpdateGoodsBody)
  @ZodOk(z.object({ ok: z.literal(true) }))
  async quickUpdateGoods(@Ctx() ctx: RequestContext, @Body(new Zod(quickUpdateGoodsBody)) body: z.infer<typeof quickUpdateGoodsBody>) {
    await this.catalog.quickUpdateGoods(ctx, body.ids, body);
    return { ok: true as const };
  }

  @Post('products/:id/archive')
  @Biz('stock.edit')
  @HttpCode(200)
  @ZodOk(z.object({ ok: z.literal(true) }))
  async archiveGood(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    await this.catalog.archiveGood(ctx, id);
    return { ok: true as const };
  }

  @Post('products/archive')
  @Biz('stock.edit')
  @ZodBody(idsBody)
  archiveGoods(@Ctx() ctx: RequestContext, @Body(new Zod(idsBody)) body: z.infer<typeof idsBody>) {
    return this.catalog.archiveGoods(ctx, body.ids);
  }

  @Post('products/:id/restore')
  @Biz('stock.edit')
  @HttpCode(200)
  @ZodOk(z.object({ ok: z.literal(true) }))
  async restoreGood(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    await this.catalog.restoreGood(ctx, id);
    return { ok: true as const };
  }

  @Post('products/restore')
  @Biz('stock.edit')
  @ZodBody(restoreGoodsBody)
  restoreGoods(@Ctx() ctx: RequestContext, @Body(new Zod(restoreGoodsBody)) body: z.infer<typeof restoreGoodsBody>) {
    return this.catalog.restoreGoods(ctx, body.ids, body.markRestored);
  }

  @Delete('products/:id')
  @Biz('stock.edit')
  @HttpCode(200)
  @ZodOk(z.object({ ok: z.literal(true) }))
  async removeGood(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    await this.catalog.removeGood(ctx.member!.businessId, id);
    return { ok: true as const };
  }

  // ─────────────────────────── Остатки и «заказать» (F-00-137) ───────────────────────────

  @Get('balances')
  @Biz('stock.view')
  async balances(@Param('businessId') businessId: string, @Query('goodId') goodId: string) {
    return this.catalog.computeLevels(businessId, goodId);
  }

  @Get('to-order')
  @Biz('stock.view')
  toOrder(@Param('businessId') businessId: string, @Query('locationId') locationId: string) {
    return this.catalog.listOrderCandidates(businessId, locationId);
  }

  @Get('to-order/whatsapp-text')
  @Biz('stock.view')
  async toOrderWhatsApp(@Param('businessId') businessId: string, @Query('locationId') locationId: string, @Query('phone') phone: string) {
    const items = await this.catalog.listOrderCandidates(businessId, locationId);
    return { url: this.catalog.buildOrderWhatsAppUrl(phone, items) };
  }

  // ─────────────────────────── Операции: приход/списание/перемещение/продажа (F-08-046…078) ───────────────────────────

  @Get('stock-ops')
  @Biz('stock.view')
  listOps(@Param('businessId') businessId: string, @Query() q: Record<string, string | undefined>) {
    return this.ops.listOps(businessId, { type: q.type, warehouseId: q.warehouseId, goodId: q.goodId, dateFrom: q.dateFrom, dateTo: q.dateTo, search: q.search, page: q.page ? Number(q.page) : undefined, pageSize: q.pageSize ? Number(q.pageSize) : undefined });
  }

  @Get('stock-ops/:id')
  @Biz('stock.view')
  getOp(@Param('businessId') businessId: string, @Param('id') id: string) {
    return this.ops.getDoc(businessId, id);
  }

  @Get('stock-ops/:id/history')
  @Biz('stock.view')
  getOpHistory(@Param('businessId') businessId: string, @Param('id') id: string) {
    return this.catalog.listEntityHistory(businessId, 'stockOperation', id);
  }

  @Post('stock-ops/income')
  @Biz('stock.edit')
  @ZodBody(incomeBody)
  createIncome(@Ctx() ctx: RequestContext, @Body(new Zod(incomeBody)) body: z.infer<typeof incomeBody>) {
    return this.ops.createIncome(ctx, body.locationId, body);
  }

  @Post('stock-ops/writeoff')
  @Biz('stock.edit')
  @ZodBody(writeoffBody)
  createWriteoff(@Ctx() ctx: RequestContext, @Body(new Zod(writeoffBody)) body: z.infer<typeof writeoffBody>) {
    return this.ops.createWriteoff(ctx, body.locationId, body);
  }

  @Post('stock-ops/move')
  @Biz('stock.edit')
  @ZodBody(moveBody)
  createMove(@Ctx() ctx: RequestContext, @Body(new Zod(moveBody)) body: z.infer<typeof moveBody>) {
    return this.ops.createMove(ctx, body.locationId, body);
  }

  @Post('stock-ops/:id/cancel-move')
  @Biz('stock.edit')
  cancelMove(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.ops.cancelMove(ctx, id);
  }

  /** F-07-051…054: продажа вне визита — закрывает «честную дыру» этапа 12 (см. PROGRESS.md §12 «Осталось») */
  @Post('sales')
  @Biz('stock.edit')
  @ZodBody(saleBody)
  createSale(@Ctx() ctx: RequestContext, @Body(new Zod(saleBody)) body: z.infer<typeof saleBody>) {
    return this.ops.createSale(ctx, body.locationId, body);
  }

  @Post('sales/:id/cancel')
  @Biz('stock.edit')
  @HttpCode(200)
  @ZodOk(z.object({ ok: z.literal(true) }))
  async cancelSale(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    await this.ops.cancelSale(ctx, id);
    return { ok: true as const };
  }

  @Patch('stock-ops/:id')
  @Biz('stock.edit')
  @ZodBody(opDocPatchBody)
  updateOp(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(opDocPatchBody)) body: z.infer<typeof opDocPatchBody>) {
    return this.ops.updateDoc(ctx, id, body);
  }

  @Delete('stock-ops/:id/lines/:goodId')
  @Biz('stock.edit')
  @HttpCode(200)
  @ZodOk(z.object({ ok: z.literal(true) }))
  async deleteLine(@Ctx() ctx: RequestContext, @Param('id') id: string, @Param('goodId') goodId: string) {
    await this.ops.deleteLine(ctx, id, goodId);
    return { ok: true as const };
  }

  @Delete('stock-ops/:id')
  @Biz('stock.edit')
  @HttpCode(200)
  @ZodOk(z.object({ ok: z.literal(true) }))
  async deleteOp(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    await this.ops.deleteDoc(ctx, id);
    return { ok: true as const };
  }

  // ─────────────────────────── Техкарты (F-08-036…045) ───────────────────────────

  @Get('tech-cards')
  @Biz('stock.view')
  listTechCards(@Param('businessId') businessId: string, @Query('locationId') locationId: string, @Query('serviceId') serviceId?: string, @Query('staffId') staffId?: string) {
    return this.techCards.list(businessId, locationId, serviceId, staffId);
  }

  /** F-08-039: техкарты одной услуги по всем мастерам, без привязки к филиалу (карточка услуги) */
  @Get('tech-cards/by-service/:serviceId')
  @Biz('stock.view')
  listTechCardsForService(@Param('businessId') businessId: string, @Param('serviceId') serviceId: string) {
    return this.techCards.listForService(businessId, serviceId);
  }

  @Put('staff/:staffId/services/:serviceId/tech-card')
  @Biz('stock.edit')
  @ZodBody(techCardPutBody)
  upsertTechCard(@Ctx() ctx: RequestContext, @Param('staffId') staffId: string, @Param('serviceId') serviceId: string, @Body(new Zod(techCardPutBody)) body: z.infer<typeof techCardPutBody>) {
    return this.techCards.upsert(ctx, { ...body, staffId, serviceId });
  }

  @Get('staff/:staffId/services/:serviceId/tech-card')
  @Biz('stock.view')
  getTechCard(@Param('businessId') businessId: string, @Param('staffId') staffId: string, @Param('serviceId') serviceId: string) {
    return this.techCards.getForServiceStaff(businessId, serviceId, staffId);
  }

  @Delete('tech-cards/:id')
  @Biz('stock.edit')
  @HttpCode(200)
  @ZodOk(z.object({ ok: z.literal(true) }))
  async removeTechCard(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    await this.techCards.remove(ctx.member!.businessId, id);
    return { ok: true as const };
  }

  // ─────────────────────────── Инвентаризация (F-08-079…089) ───────────────────────────

  @Get('inventories')
  @Biz('stock.view')
  listInventories(@Param('businessId') businessId: string, @Query('locationId') locationId: string) {
    return this.inventories.list(businessId, locationId);
  }

  @Get('inventories/:id')
  @Biz('stock.view')
  getInventory(@Param('businessId') businessId: string, @Param('id') id: string) {
    return this.inventories.get(businessId, id);
  }

  @Post('inventories')
  @Biz('stock.edit')
  @ZodBody(inventoryCreateBody)
  createInventory(@Ctx() ctx: RequestContext, @Body(new Zod(inventoryCreateBody)) body: z.infer<typeof inventoryCreateBody>) {
    return this.inventories.create(ctx, body.locationId, body);
  }

  @Patch('inventories/:id/lines')
  @Biz('stock.edit')
  @ZodBody(inventorySetLinesBody)
  setInventoryLines(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(inventorySetLinesBody)) body: z.infer<typeof inventorySetLinesBody>) {
    return this.inventories.setLines(ctx, id, body.lines);
  }

  @Patch('inventories/:id')
  @Biz('stock.edit')
  @ZodBody(inventoryMetaBody)
  updateInventoryMeta(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(inventoryMetaBody)) body: z.infer<typeof inventoryMetaBody>) {
    return this.inventories.updateMeta(ctx, id, body);
  }

  @Post('inventories/:id/complete')
  @Biz('stock.edit')
  completeInventory(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.inventories.complete(ctx, id);
  }

  @Delete('inventories/:id')
  @Biz('stock.edit')
  @HttpCode(200)
  @ZodOk(z.object({ ok: z.literal(true) }))
  async removeInventory(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    await this.inventories.remove(ctx.member!.businessId, id);
    return { ok: true as const };
  }

  // ─────────────────────────── Оборудование (⭐ F-00-141) ───────────────────────────

  @Get('equipment')
  @Biz('stock.view')
  listEquipment(@Param('businessId') businessId: string, @Query('locationId') locationId: string, @Query('includeArchived') includeArchived?: string) {
    return this.catalog.listEquipment(businessId, locationId, includeArchived === '1' || includeArchived === 'true');
  }

  @Get('equipment/:id')
  @Biz('stock.view')
  getEquipment(@Param('businessId') businessId: string, @Param('id') id: string) {
    return this.catalog.getEquipment(businessId, id);
  }

  @Post('equipment')
  @Biz('stock.edit')
  @ZodBody(equipmentBody)
  createEquipment(@Ctx() ctx: RequestContext, @Body(new Zod(equipmentBody)) body: z.infer<typeof equipmentBody>) {
    return this.catalog.createEquipment(ctx, body);
  }

  @Patch('equipment/:id')
  @Biz('stock.edit')
  @ZodBody(equipmentPatchBody)
  updateEquipment(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(equipmentPatchBody)) body: z.infer<typeof equipmentPatchBody>) {
    return this.catalog.updateEquipment(ctx, id, body);
  }

  @Post('equipment/:id/archive')
  @Biz('stock.edit')
  @HttpCode(200)
  @ZodOk(z.object({ ok: z.literal(true) }))
  async archiveEquipment(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    await this.catalog.archiveEquipment(ctx.member!.businessId, id);
    return { ok: true as const };
  }

  @Delete('equipment/:id')
  @Biz('stock.edit')
  @HttpCode(200)
  @ZodOk(z.object({ ok: z.literal(true) }))
  async removeEquipment(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    await this.catalog.removeEquipment(ctx.member!.businessId, id);
    return { ok: true as const };
  }

  // ─────────────────────────── Напоминания (⭐ F-00-142) ───────────────────────────

  @Get('reminders')
  @Biz('stock.view')
  listReminders(@Param('businessId') businessId: string, @Query('locationId') locationId: string) {
    return this.catalog.listReminders(businessId, locationId);
  }

  @Post('reminders')
  @Biz('stock.edit')
  @ZodBody(reminderBody)
  createReminder(@Ctx() ctx: RequestContext, @Body(new Zod(reminderBody)) body: z.infer<typeof reminderBody>) {
    return this.catalog.createReminder(ctx, body);
  }

  @Post('reminders/:id/toggle')
  @Biz('stock.edit')
  @HttpCode(200)
  @ZodBody(z.object({ done: z.boolean() }))
  @ZodOk(z.object({ ok: z.literal(true) }))
  async toggleReminder(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(z.object({ done: z.boolean() }))) body: { done: boolean }) {
    await this.catalog.toggleReminder(ctx.member!.businessId, id, body.done);
    return { ok: true as const };
  }

  @Delete('reminders/:id')
  @Biz('stock.edit')
  @HttpCode(200)
  @ZodOk(z.object({ ok: z.literal(true) }))
  async removeReminder(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    await this.catalog.removeReminder(ctx.member!.businessId, id);
    return { ok: true as const };
  }

  // ─────────────────────────── Настройки (F-08-096…100) ───────────────────────────

  @Get('settings')
  @Biz('stock.view')
  getSettings(@Param('businessId') businessId: string) {
    return this.catalog.getSettings(businessId);
  }

  @Patch('settings')
  @Biz('stock.edit')
  @ZodBody(stockSettingsPatchBody)
  updateSettings(@Ctx() ctx: RequestContext, @Body(new Zod(stockSettingsPatchBody)) body: z.infer<typeof stockSettingsPatchBody>) {
    return this.catalog.updateSettings(ctx, body);
  }
}
