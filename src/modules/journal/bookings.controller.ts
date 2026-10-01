import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { RequestContext, RequestWithContext } from '../../common/http/context.js';
import { Biz, Ctx } from '../../common/http/guards.js';
import { ZodBody } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { ifMatch } from '../../common/http/version.js';
import { Idempotent } from '../../common/idempotency/idempotency.js';
import { newId } from '../../common/ids/ids.js';
import { isLocale, t } from '../../common/i18n/i18n.js';
import { DEFAULT_TZ, utcToLocal, nowLocal } from '../../common/time/time.js';
import { ApiError } from '../../common/errors/api-error.js';
import { waLink } from '../notify/wa-link.js';
import { JournalAccess, csv } from './access.js';
import { BookingsService, staffActor, type BookingPatch, type RawInput } from './bookings.service.js';
import { JournalService } from './journal.service.js';
import {
  arrivedBody,
  decisionBody,
  delayBody,
  deleteBody,
  extrasPatchBody,
  finishEarlyBody,
  goodsLineBody,
  goodsLinePatchBody,
  historyBody,
  idsBody,
  externalBody,
  instantPayBody,
  patchBody,
  paymentLinesBody,
  placeBody,
  rawBody,
  refundBody,
  statusBody,
} from './journal.schemas.js';
import type { BookingStatus } from './rules.js';

type B = { businessId: string };

/** Записи кабинета (02 §4): /v1/biz/{b}/bookings… */
@ApiTags('journal')
@Controller('v1/biz/:businessId/bookings')
export class BookingsController {
  constructor(
    private readonly svc: BookingsService,
    private readonly journal: JournalService,
    private readonly access: JournalAccess,
  ) {}

  @Get()
  @Biz('journal.view')
  @ApiOperation({ summary: 'Записи по фильтру (BookingQuery фронта); ?businessIds= — «Все филиалы» сети' })
  async list(@Ctx() ctx: RequestContext, @Query() q: Record<string, string | undefined>) {
    const businessIds = await this.access.businessIds(ctx, q['businessIds']);
    return this.svc.list({
      businessIds,
      locationId: q['locationId'],
      staffId: q['staffId'],
      clientId: q['clientId'],
      appUserId: q['appUserId'],
      from: q['from'],
      to: q['to'],
      statuses: csv(q['statuses']),
      includeDeleted: q['includeDeleted'] === 'true' || q['includeDeleted'] === '1',
      groupEventId: q['groupEventId'],
      seriesId: q['seriesId'],
      visitId: q['visitId'],
    });
  }

  @Post()
  @Biz('journal.edit')
  @Idempotent()
  @ApiOperation({ summary: 'createBooking «как есть» (строки посчитаны окном); занятость — под замком на мастера' })
  @ZodBody(rawBody)
  createRaw(@Ctx() ctx: RequestContext, @Param() p: B, @Body(new Zod(rawBody)) body: z.infer<typeof rawBody>) {
    return this.svc.createRaw(staffActor(ctx), { ...body, businessId: p.businessId } as RawInput);
  }

  @Post('place')
  @Biz('journal.edit')
  @Idempotent()
  @ApiOperation({ summary: 'Единый поток записи (rules/booking-flow): проверки, клиент по номеру, статус, предоплата' })
  @ZodBody(placeBody)
  place(@Ctx() ctx: RequestContext, @Param() p: B, @Body(new Zod(placeBody)) body: z.infer<typeof placeBody>) {
    return this.svc.place(staffActor(ctx), { ...body, businessId: p.businessId, status: body.status as BookingStatus | undefined });
  }

  @Post('external')
  @Biz('journal.edit')
  @Idempotent()
  @ApiOperation({ summary: 'Запись от бота/CRM (F-01-036): «любой свободный», клиент по номеру' })
  @ZodBody(externalBody)
  external(@Ctx() ctx: RequestContext, @Param() p: B, @Body(new Zod(externalBody)) body: z.infer<typeof externalBody>) {
    return this.journal.external(staffActor(ctx), p.businessId, body);
  }

  @Post('extras')
  @HttpCode(200)
  @Biz('journal.view')
  @ApiOperation({ summary: 'Доп. данные визитов пачкой (цвет, категории, оплаты) — одним запросом на сетку дня' })
  @ZodBody(idsBody)
  async extrasMany(@Ctx() ctx: RequestContext, @Body(new Zod(idsBody)) body: z.infer<typeof idsBody>) {
    const businessIds = await this.access.businessIds(ctx, undefined);
    const rows = await this.svc.prisma.booking.findMany({ where: { id: { in: body.ids }, businessId: { in: businessIds } } });
    const out: Record<string, unknown> = {};
    for (const r of rows) out[r.id] = await this.svc.extras(this.svc.prisma, r);
    return out;
  }

  @Get(':id')
  @Biz('journal.view')
  async get(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.svc.view(this.svc.prisma, await this.svc.find(this.svc.prisma, [ctx.member!.businessId], id));
  }

  @Get(':id/remind-text')
  @Biz('journal.view')
  @ApiOperation({ summary: 'Готовый текст + wa.me для клиента без приложения (F-00-121, 05 §1 «мастер напоминает сам»)' })
  async remindText(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<{ phone: string; text: string; whatsappUrl: string }> {
    const b = await this.svc.find(this.svc.prisma, [ctx.member!.businessId], id);
    const client = b.clientId ? await this.svc.prisma.client.findUnique({ where: { id: b.clientId } }) : null;
    if (!client || !client.phone) throw new ApiError('not_found', 'No client phone for this booking');
    const business = await this.svc.prisma.business.findUnique({ where: { id: b.businessId }, select: { name: true } });
    const serviceId = (b.services as { serviceId?: string }[] | null)?.[0]?.serviceId;
    const service = serviceId ? await this.svc.prisma.service.findUnique({ where: { id: serviceId }, select: { name: true } }) : null;
    const serviceName = (service?.name as Record<string, string> | undefined)?.ru;
    const tz = await this.svc.tzOfLocation(this.svc.prisma, b.locationId);
    const time = utcToLocal(b.startAt, tz).slice(11, 16);
    const locale = isLocale(ctx.session?.locale) ? ctx.session!.locale : 'ru';
    const text = t(locale, 'booking.remindTemplate', { name: client.name, time, service: serviceName ?? '', business: business?.name ?? 'BookTime' });
    return { phone: client.phone, text, whatsappUrl: waLink(client.phone, text) };
  }

  @Patch(':id')
  @Biz('journal.edit')
  @ApiOperation({ summary: 'Правка/перенос (F-01-109…117); expectedUpdatedAt или If-Match — «побеждает первое» (F-01-033)' })
  @ZodBody(patchBody)
  patch(@Ctx() ctx: RequestContext, @Req() req: RequestWithContext, @Param('id') id: string, @Body(new Zod(patchBody)) body: z.infer<typeof patchBody>) {
    const { expectedUpdatedAt, ...patch } = body;
    return this.svc.update(staffActor(ctx), [ctx.member!.businessId], id, patch as BookingPatch, { expectedUpdatedAt, version: ifMatch(req) });
  }

  @Post(':id/status')
  @HttpCode(200)
  @Biz('journal.edit')
  @ApiOperation({ summary: 'Смена статуса по правилам (переход, неявки, занятость, подтверждение)' })
  @ZodBody(statusBody)
  status(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(statusBody)) body: z.infer<typeof statusBody>) {
    return this.svc.changeStatus(staffActor(ctx), [ctx.member!.businessId], id, body.status as BookingStatus, 'business');
  }

  @Post(':id/arrived')
  @HttpCode(200)
  @Biz('journal.edit')
  @ApiOperation({ summary: '«Пришёл · сумма» (F-00-127, В-39)' })
  @ZodBody(arrivedBody)
  arrived(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(arrivedBody)) body: z.infer<typeof arrivedBody>) {
    return this.svc.markArrived(staffActor(ctx), [ctx.member!.businessId], id, body.amount);
  }

  @Delete(':id')
  @HttpCode(200)
  @Biz('journal.edit')
  @ApiOperation({ summary: 'Мягкое удаление с автором (F-01-118…120): деньги/расходники снимаются, время освобождается' })
  @ZodBody(deleteBody)
  remove(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(deleteBody.optional().default({}))) body: z.infer<typeof deleteBody>) {
    return this.svc.remove(staffActor(ctx), [ctx.member!.businessId], id, body ?? {});
  }

  @Post(':id/restore')
  @HttpCode(200)
  @Biz('journal.edit')
  @ApiOperation({ summary: 'Вернуть удалённую (F-01-121: 7 дней, если время свободно) — и «Отменить» 5 с' })
  restore(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.svc.restore(staffActor(ctx), [ctx.member!.businessId], id);
  }

  @Get(':id/deletion-impact')
  @Biz('journal.view')
  async impact(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    const e = await this.svc.extras(this.svc.prisma, await this.svc.find(this.svc.prisma, [ctx.member!.businessId], id));
    return { paidAmount: e.paidAmount, consumablesReturned: Boolean(e.consumablesDeducted), subscriptionVisitReturned: e.autoWriteoff?.status === 'written_off' };
  }

  @Post(':id/confirm')
  @HttpCode(200)
  @Biz('journal.edit')
  @ApiOperation({ summary: 'Подтвердить заявку (В-03, F-00-067)' })
  confirm(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.svc.confirm(staffActor(ctx), [ctx.member!.businessId], id);
  }

  @Post(':id/decline')
  @HttpCode(200)
  @Biz('journal.edit')
  decline(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.svc.decline(staffActor(ctx), [ctx.member!.businessId], id);
  }

  @Post(':id/prepayment-received')
  @HttpCode(200)
  @Biz('journal.edit')
  @ApiOperation({ summary: 'Ручная предоплата получена (В-05, F-00-097)' })
  prepaymentReceived(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.svc.prepaymentReceived(staffActor(ctx), [ctx.member!.businessId], id);
  }

  @Post(':id/refund-done')
  @HttpCode(200)
  @Biz('journal.edit')
  @ApiOperation({ summary: 'Предоплата возвращена клиенту (F-00-100)' })
  refundDone(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.svc.refundDone(staffActor(ctx), [ctx.member!.businessId], id);
  }

  @Post(':id/finished-early')
  @HttpCode(200)
  @Biz('journal.edit')
  @ApiOperation({ summary: '«Закончил раньше» (F-00-058): остаток становится окном' })
  @ZodBody(finishEarlyBody)
  finishEarly(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(finishEarlyBody)) body: z.infer<typeof finishEarlyBody>) {
    return this.svc.finishEarly(staffActor(ctx), [ctx.member!.businessId], id, body.actualDurationMin);
  }

  @Post(':id/delay')
  @HttpCode(200)
  @Biz('journal.edit')
  @ApiOperation({ summary: '«Задерживаюсь» (F-00-059): событие delayed клиенту и кабинету' })
  @ZodBody(delayBody)
  delay(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(delayBody)) body: z.infer<typeof delayBody>) {
    return this.svc.reportDelay(staffActor(ctx), [ctx.member!.businessId], id, body.delayMin);
  }

  @Post(':id/duplicate')
  @HttpCode(200)
  @Biz('journal.edit')
  @ApiOperation({ summary: 'Копия записи без оплаты и депозита (F-01-192)' })
  duplicate(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.journal.duplicate(ctx, [ctx.member!.businessId], id);
  }

  // ─────────── доп. данные визита ───────────

  @Get(':id/extras')
  @Biz('journal.view')
  async extras(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.svc.extras(this.svc.prisma, await this.svc.find(this.svc.prisma, [ctx.member!.businessId], id));
  }

  @Put(':id/extras')
  @Biz('journal.edit')
  @ApiOperation({ summary: 'Доп. данные визита (F-01-050…053, 058…061): категории, цвет, поля, товары, скидки строк' })
  @ZodBody(extrasPatchBody)
  setExtras(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(extrasPatchBody)) body: z.infer<typeof extrasPatchBody>) {
    return this.svc.patchExtras(staffActor(ctx), [ctx.member!.businessId], id, (e) => {
      for (const [k, v] of Object.entries(body)) {
        if (v === undefined) continue;
        if (v === null) delete (e as unknown as Record<string, unknown>)[k];
        else (e as unknown as Record<string, unknown>)[k] = v;
      }
      if (body.payments && body.paidAmount === undefined) e.paidAmount = body.payments.reduce((s, l) => s + l.amount, 0);
    });
  }

  @Post(':id/payments')
  @HttpCode(200)
  @Biz('journal.edit')
  @Idempotent()
  @ApiOperation({ summary: 'Оплата визита (F-01-138/139): строки оплаты, paidAmount — их сумма' })
  @ZodBody(paymentLinesBody)
  pay(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(paymentLinesBody)) body: z.infer<typeof paymentLinesBody>) {
    return this.svc.patchExtras(staffActor(ctx), [ctx.member!.businessId], id, (e) => {
      const at = nowLocal();
      e.payments = [...(e.payments ?? []), ...body.lines.map((l) => ({ ...l, id: newId('payment'), at }))];
      e.paidAmount = e.payments.reduce((s, l) => s + l.amount, 0);
    });
  }

  @Post(':id/payments/instant')
  @HttpCode(200)
  @Biz('journal.edit')
  @ApiOperation({ summary: 'Мгновенная оплата всей суммы (F-01-141)' })
  @ZodBody(instantPayBody)
  instant(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(instantPayBody)) body: z.infer<typeof instantPayBody>) {
    return this.svc.patchExtras(staffActor(ctx), [ctx.member!.businessId], id, (e) => {
      // Полученная предоплата (F-00-097, строка 'prepayment' из prepaymentReceived) остаётся — наличными только остаток
      const prepaid = (e.payments ?? []).filter((l) => l.label === 'prepayment');
      const rest = Math.max(0, body.total - prepaid.reduce((s, l) => s + l.amount, 0));
      e.payments = rest > 0 ? [...prepaid, { id: newId('payment'), method: 'cash', amount: rest, label: 'Наличные', at: nowLocal() }] : prepaid;
      e.paidAmount = body.total;
    });
  }

  @Delete(':id/payments')
  @HttpCode(200)
  @Biz('journal.edit')
  @ApiOperation({ summary: 'Снять отметку оплаты (F-01-079)' })
  cancelPayments(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.svc.patchExtras(staffActor(ctx), [ctx.member!.businessId], id, (e) => {
      e.payments = [];
      e.paidAmount = 0;
    });
  }

  @Delete(':id/payments/:lineId')
  @HttpCode(200)
  @Biz('journal.edit')
  @ApiOperation({ summary: 'Удалить ошибочную строку оплаты (F-01-143)' })
  cancelLine(@Ctx() ctx: RequestContext, @Param('id') id: string, @Param('lineId') lineId: string) {
    return this.svc.patchExtras(staffActor(ctx), [ctx.member!.businessId], id, (e) => {
      e.payments = (e.payments ?? []).filter((l) => l.id !== lineId);
      e.paidAmount = e.payments.reduce((s, l) => s + l.amount, 0);
    });
  }

  @Post(':id/payments/:lineId/refund')
  @HttpCode(200)
  @Biz('journal.edit')
  @ApiOperation({ summary: 'Частичный возврат по строке оплаты (F-01-212)' })
  @ZodBody(refundBody)
  refund(@Ctx() ctx: RequestContext, @Param('id') id: string, @Param('lineId') lineId: string, @Body(new Zod(refundBody)) body: z.infer<typeof refundBody>) {
    return this.svc.patchExtras(staffActor(ctx), [ctx.member!.businessId], id, (e) => {
      e.payments = (e.payments ?? []).map((l) => (l.id === lineId ? { ...l, amount: Math.max(0, l.amount - body.amount) } : l)).filter((l) => l.amount > 0);
      e.paidAmount = e.payments.reduce((s, l) => s + l.amount, 0);
    });
  }

  @Post(':id/prepayment-decision')
  @HttpCode(200)
  @Biz('journal.edit')
  @ApiOperation({ summary: '«Удержать / Простить» предоплату при позднем переносе или неявке (В-04, F-01-116/124)' })
  @ZodBody(decisionBody)
  decide(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(decisionBody)) body: z.infer<typeof decisionBody>) {
    return this.svc.patchExtras(staffActor(ctx), [ctx.member!.businessId], id, (e) => {
      e.prepaymentDecision = { ...body, decidedAt: nowLocal() };
    });
  }

  @Post(':id/goods-lines')
  @HttpCode(200)
  @Biz('journal.edit')
  @ZodBody(goodsLineBody)
  addGoods(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(goodsLineBody)) body: z.infer<typeof goodsLineBody>) {
    return this.svc.patchExtras(staffActor(ctx), [ctx.member!.businessId], id, (e) => {
      e.goodsLines = [...e.goodsLines, { ...body, id: newId('goodsLine') }];
    });
  }

  @Patch(':id/goods-lines/:lineId')
  @Biz('journal.edit')
  @ZodBody(goodsLinePatchBody)
  patchGoods(@Ctx() ctx: RequestContext, @Param('id') id: string, @Param('lineId') lineId: string, @Body(new Zod(goodsLinePatchBody)) body: z.infer<typeof goodsLinePatchBody>) {
    return this.svc.patchExtras(staffActor(ctx), [ctx.member!.businessId], id, (e) => {
      e.goodsLines = e.goodsLines.map((l) => (l.id === lineId ? { ...l, ...Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) } : l));
    });
  }

  @Delete(':id/goods-lines/:lineId')
  @HttpCode(200)
  @Biz('journal.edit')
  removeGoods(@Ctx() ctx: RequestContext, @Param('id') id: string, @Param('lineId') lineId: string) {
    return this.svc.patchExtras(staffActor(ctx), [ctx.member!.businessId], id, (e) => {
      e.goodsLines = e.goodsLines.filter((l) => l.id !== lineId);
    });
  }

  // ─────────── история, серия, пакет ───────────

  @Get(':id/history')
  @Biz('journal.view')
  history(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.journal.history([ctx.member!.businessId], id);
  }

  @Post(':id/history')
  @HttpCode(200)
  @Biz('journal.edit')
  @ZodBody(historyBody)
  logHistory(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(historyBody)) body: z.infer<typeof historyBody>) {
    return this.journal.logHistory([ctx.member!.businessId], id, body);
  }
}
