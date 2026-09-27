import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { Biz, Ctx } from '../../common/http/guards.js';
import { ZodBody } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { isLocalDate } from '../../common/time/time.js';
import { JournalAccess, csv } from '../journal/access.js';
import { JournalMoreService } from './journal-more.service.js';

type B = { businessId: string };
const date = (v: string | undefined, name: string) => {
  if (!isLocalDate(v)) throw new ApiError('validation', 'Invalid input', { [name]: 'YYYY-MM-DD' });
  return v;
};
const id = z.string().min(1).max(40);
const localAt = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);

const packageSlotsBody = z.object({
  locationId: id,
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  order: z.enum(['parallel', 'sequential_one', 'sequential_many']),
  steps: z
    .array(z.object({ serviceId: id, staffId: id, durationMin: z.number().int().min(1).max(24 * 60), bufferAfterMin: z.number().int().min(0).max(600).optional() }))
    .min(1)
    .max(20),
});
const prefsBody = z.object({
  pinnedFields: z.array(z.string().max(60)).max(60).optional(),
  clientCardPins: z.array(z.string().max(60)).max(60).optional(),
  // FavoriteSection фронта: без labelKey/href «Ещё» журнала падает (Link без href) — принимаем только полную форму
  favorites: z.array(z.object({ id: z.string().min(1).max(120), labelKey: z.string().min(1).max(160), href: z.string().regex(/^\/[^\s]*$/).max(300) }).strict()).max(100).optional(),
  waitlistPanelOpen: z.boolean().optional(),
});
const draftBody = z.object({ key: z.string().min(1).max(200), data: z.unknown().nullable() });
const saleBody = z.object({
  itemId: id,
  qty: z.number().positive().max(10_000),
  paymentMethod: z.enum(['cash', 'card']),
  code: z.string().max(60).optional(),
  clientId: id.optional(),
  clientName: z.string().max(160).optional(),
  locationId: id.optional(),
});
const ledgerBody = z.object({
  locationId: id,
  at: localAt,
  category: z.string().max(30),
  cashRegister: z.string().max(120).optional(),
  counterpartyType: z.enum(['contractor', 'client', 'staff']),
  counterpartyName: z.string().min(1).max(160),
  amount: z.number().int().positive(),
  comment: z.string().max(400).optional(),
  createdByStaffId: z.string().max(40).optional(),
});

/**
 * Этап 21, лейн «journal»: то, что экраны журнала считали у себя по моковой базе (src/api/journal.ts) —
 * часы сетки, загрузка дней, лаки, статистика клиента, частые услуги, сводка дня, окна пакета, личные
 * закрепления и избранное, черновик окна записи, продажа вне визита, «Новый платёж».
 */
@ApiTags('journal')
@Controller('v1/biz/:businessId/journal')
export class JournalMoreController {
  constructor(
    private readonly svc: JournalMoreService,
    private readonly access: JournalAccess,
  ) {}

  @Get('staff-hours')
  @Biz('journal.view')
  @ApiOperation({ summary: 'Рабочие часы сотрудников по дням: {staffId: {date: DayHours}} (F-01-013/019/023)' })
  async staffHours(@Ctx() ctx: RequestContext, @Query('staffIds') staffIds?: string, @Query('from') from?: string, @Query('to') to?: string, @Query('locationId') locationId?: string, @Query('businessIds') ids?: string) {
    const f = date(from, 'from');
    return this.svc.staffHours(await this.access.businessIds(ctx, ids), csv(staffIds).slice(0, 200), f, to ? date(to, 'to') : f, locationId || undefined);
  }

  @Get('range-load')
  @Biz('journal.view')
  @ApiOperation({ summary: 'Загрузка дней диапазона для мини-календаря (F-01-003/004)' })
  async rangeLoad(@Ctx() ctx: RequestContext, @Query('staffIds') staffIds?: string, @Query('from') from?: string, @Query('to') to?: string, @Query('businessIds') ids?: string) {
    return this.svc.rangeLoad(await this.access.businessIds(ctx, ids), csv(staffIds).slice(0, 200), date(from, 'from'), date(to, 'to'));
  }

  @Get('lacquers')
  @Biz('journal.view')
  @ApiOperation({ summary: 'Оттенок лака записей (F-00-094): ?ids= или ?date=' })
  async lacquers(@Ctx() ctx: RequestContext, @Query('ids') ids?: string, @Query('date') day?: string, @Query('businessIds') bizIds?: string) {
    return this.svc.lacquers(await this.access.businessIds(ctx, bizIds), { ids: csv(ids), date: day ? date(day, 'date') : undefined });
  }

  @Get('client-visit-stats')
  @Biz('journal.view')
  @ApiOperation({ summary: 'Статистика клиента в окне записи (F-01-071)' })
  async clientVisitStats(@Ctx() ctx: RequestContext, @Query('clientId') clientId?: string, @Query('businessIds') ids?: string) {
    if (!clientId) throw new ApiError('validation', 'Invalid input', { clientId: 'required' });
    return this.svc.clientVisitStats(await this.access.businessIds(ctx, ids), clientId);
  }

  @Get('frequent-services')
  @Biz('journal.view')
  @ApiOperation({ summary: 'Id самых частых услуг мастера (F-01-056)' })
  frequentServices(@Param() p: B, @Query('staffId') staffId?: string, @Query('limit') limit?: string) {
    if (!staffId) throw new ApiError('validation', 'Invalid input', { staffId: 'required' });
    return this.svc.frequentServices(p.businessId, staffId, Number(limit) || 6);
  }

  @Get('day-summary')
  @Biz('journal.view')
  @ApiOperation({ summary: 'Сводка дня: касса, записано, выполнено, товары, клиенты (F-01-011)' })
  daySummary(@Param() p: B, @Query('date') day?: string) {
    return this.svc.daySummary(p.businessId, date(day, 'date'));
  }

  @Post('package-slots')
  @HttpCode(200)
  @Biz('journal.view')
  @ApiOperation({ summary: 'Окна, где помещается весь пакет услуг (F-01-134, F-02-069)' })
  @ZodBody(packageSlotsBody)
  packageSlots(@Param() p: B, @Body(new Zod(packageSlotsBody)) body: z.infer<typeof packageSlotsBody>) {
    return this.svc.packageSlots(p.businessId, body.locationId, body.date, body.steps, body.order);
  }

  // ─────────── личное ───────────

  @Get('prefs/:userKey')
  @Biz('journal.view')
  @ApiOperation({ summary: 'Личные закрепления журнала: поля окна, плитки карточки, избранное, панель ожидания' })
  prefs(@Param() p: B, @Param('userKey') userKey: string) {
    return this.svc.prefs(p.businessId, userKey);
  }

  @Patch('prefs/:userKey')
  @Biz('journal.view')
  @ZodBody(prefsBody)
  patchPrefs(@Ctx() ctx: RequestContext, @Param() p: B, @Param('userKey') userKey: string, @Body(new Zod(prefsBody)) body: z.infer<typeof prefsBody>) {
    return this.svc.patchPrefs(ctx, p.businessId, userKey, body);
  }

  @Get('draft')
  @Biz('journal.view')
  @ApiOperation({ summary: 'Черновик окна записи (F-01-040)' })
  draft(@Param() p: B, @Query('key') key?: string) {
    if (!key) throw new ApiError('validation', 'Invalid input', { key: 'required' });
    return this.svc.draft(p.businessId, key);
  }

  @Put('draft')
  @HttpCode(204)
  @Biz('journal.view')
  @ZodBody(draftBody)
  async setDraft(@Ctx() ctx: RequestContext, @Param() p: B, @Body(new Zod(draftBody)) body: z.infer<typeof draftBody>) {
    await this.svc.setDraft(ctx, p.businessId, body.key, body.data ?? null);
  }

  // ─────────── продажа вне визита ───────────

  @Get('goods-catalog')
  @Biz('journal.view')
  @ApiOperation({ summary: 'Каталог «Продать»: товары склада, типы абонементов и сертификатов (F-01-010)' })
  goodsCatalog(@Ctx() ctx: RequestContext, @Query('locationId') locationId?: string) {
    return this.svc.goodsCatalog(ctx, locationId || undefined);
  }

  @Post('quick-sales')
  @Biz('journal.edit')
  @ApiOperation({ summary: 'Продажа вне визита (F-01-010, F-04-219): склад/лояльность + касса' })
  @ZodBody(saleBody)
  sell(@Ctx() ctx: RequestContext, @Body(new Zod(saleBody)) body: z.infer<typeof saleBody>) {
    return this.svc.sell(ctx, body);
  }

  @Post('quick-sales/:id/cancel')
  @HttpCode(204)
  @Biz('journal.edit')
  async cancelSale(@Ctx() ctx: RequestContext, @Param('id') saleId: string) {
    await this.svc.cancelSale(ctx, saleId);
  }

  // ─────────── «Новый платёж» ───────────

  @Get('ledger')
  @Biz('journal.view')
  @ApiOperation({ summary: 'Платежи без визита филиала — ручные операции кассы (F-01-151)' })
  ledger(@Param() p: B, @Query('locationId') locationId?: string) {
    if (!locationId) throw new ApiError('validation', 'Invalid input', { locationId: 'required' });
    return this.svc.ledger(p.businessId, locationId);
  }

  @Post('ledger')
  @Biz('journal.edit')
  @ZodBody(ledgerBody)
  createLedger(@Ctx() ctx: RequestContext, @Body(new Zod(ledgerBody)) body: z.infer<typeof ledgerBody>) {
    return this.svc.createLedger(ctx, body);
  }

  @Post('ledger/:id/cancel')
  @HttpCode(204)
  @Biz('journal.edit')
  async cancelLedger(@Ctx() ctx: RequestContext, @Param('id') opId: string) {
    await this.svc.cancelLedger(ctx, opId);
  }
}
