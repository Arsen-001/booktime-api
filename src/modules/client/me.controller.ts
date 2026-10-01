import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { RequestContext } from '../../common/http/context.js';
import { Authed, Ctx } from '../../common/http/guards.js';
import { ZodBody } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { buyRequestBody, createMyBookingBody, diaryEntryBody, favoriteBody, favoriteMuteBody, locationReviewBody, myWaitlistBody, rateStaffBody, staffReviewBody, supportBody } from './client.schemas.js';
import { ApiError } from '../../common/errors/api-error.js';
import { MeService } from './me.service.js';

/**
 * Раздел «client», после входа (docs/backend/02 §2.2, PLAN §6 №9): запись из приложения, «мои записи», лист
 * ожидания «от себя», избранное, звёздочка, дневник, «мои мастера», лента, сторис, обращение к нам.
 */
@ApiTags('client')
@Controller('v1/me')
@Authed()
export class MeController {
  constructor(private readonly svc: MeService) {}

  // ─────────────────────────── записи ───────────────────────────

  @Post('bookings')
  @ApiOperation({ summary: 'Запись из приложения (F-00-031) — окно/статус/предоплата решает единый поток place()' })
  @ZodBody(createMyBookingBody)
  createBooking(@Ctx() ctx: RequestContext, @Body(new Zod(createMyBookingBody)) body: z.infer<typeof createMyBookingBody>) {
    return this.svc.createBooking(ctx, body);
  }

  @Get('bookings')
  @ApiOperation({ summary: 'Мои записи: предстоящие/прошедшие/отменённые (F-14-011), или ?businessId= — в одной компании (F-14-026)' })
  listBookings(@Ctx() ctx: RequestContext, @Query('businessId') businessId?: string) {
    return this.svc.listMine(ctx.session!.userId, businessId);
  }

  @Get('bookings/:id')
  @ApiOperation({ summary: 'Детали моей записи — только своя (F-00-092)' })
  getBooking(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.svc.getOne(ctx.session!.userId, id);
  }

  @Get('prepayment-need')
  @ApiOperation({ summary: '⭐ Нужна ли мне предоплата у мастера из-за пропущенных визитов (счётчик у этого мастера, В-07)' })
  prepaymentNeed(@Ctx() ctx: RequestContext, @Query('staffId') staffId?: string) {
    if (!staffId) throw new ApiError('validation', 'staffId is required', { staffId: 'required' });
    return this.svc.prepaymentNeed(ctx.session!.userId, staffId);
  }

  // «Я оплатил» (`POST bookings/:id/paid`) — уже построен в `MeBookingsController` (журнал, этап 7); не дублируем.

  // ─────────────────────────── лист ожидания «от себя» ───────────────────────────

  @Get('waitlist')
  @ApiOperation({ summary: 'Мой лист ожидания (F-00-101/102)' })
  listWaitlist(@Ctx() ctx: RequestContext) {
    return this.svc.listMyWaitlist(ctx.session!.userId);
  }

  @Post('waitlist')
  @ApiOperation({ summary: 'Встать в лист ожидания' })
  @ZodBody(myWaitlistBody)
  addWaitlist(@Ctx() ctx: RequestContext, @Body(new Zod(myWaitlistBody)) body: z.infer<typeof myWaitlistBody>) {
    return this.svc.addWaitlist(ctx.session!.userId, body);
  }

  @Delete('waitlist/:id')
  @ApiOperation({ summary: 'Выйти из листа ожидания' })
  removeWaitlist(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.svc.removeWaitlist(ctx.session!.userId, id);
  }

  // ─────────────────────────── «Мои мастера» (F-00-118) ───────────────────────────

  @Get('masters')
  @ApiOperation({ summary: '«Мои мастера» — только записанные сам через приложение/веб' })
  myMasters(@Ctx() ctx: RequestContext, @Query('limit') limit?: string) {
    return this.svc.listMyMasters(ctx.session!.userId, limit ? Number(limit) : undefined);
  }

  // ─────────────────────────── ❤ избранное (F-00-113/115) ───────────────────────────

  @Get('favorites')
  @ApiOperation({ summary: 'Список избранного (F-14-031)' })
  listFavorites(@Ctx() ctx: RequestContext) {
    return this.svc.listFavorites(ctx.session!.userId);
  }

  @Get('favorites/check')
  @ApiOperation({ summary: 'Подписан ли на мастера/место — кнопка ❤ на карточке' })
  isFavorited(@Ctx() ctx: RequestContext, @Query('targetType', new Zod(z.string().min(1).max(20))) targetType: string, @Query('targetId', new Zod(z.string().min(1).max(40))) targetId: string) {
    return this.svc.isFavorited(ctx.session!.userId, targetType, targetId).then((favorited) => ({ favorited }));
  }

  @Post('favorites')
  @ApiOperation({ summary: '❤ подписаться/отписаться (F-00-113)' })
  @ZodBody(favoriteBody)
  async toggleFavorite(@Ctx() ctx: RequestContext, @Body(new Zod(favoriteBody)) body: z.infer<typeof favoriteBody>) {
    return { subscribed: await this.svc.toggleFavorite(ctx.session!.userId, body.targetType, body.targetId) };
  }

  @Post('favorites/:id/mute')
  @HttpCode(200)
  @ApiOperation({ summary: '«Приглушить новости», не отписываясь (F-00-115)' })
  @ZodBody(favoriteMuteBody)
  async muteFavorite(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(favoriteMuteBody)) body: z.infer<typeof favoriteMuteBody>) {
    await this.svc.setFavoriteNewsMuted(ctx.session!.userId, id, body.muted);
  }

  // ─────────────────────────── ★ звёздочка (F-00-116) ───────────────────────────

  @Get('ratings/:staffId')
  @ApiOperation({ summary: 'Моя звёздочка этому мастеру, если стоит' })
  getMyStar(@Ctx() ctx: RequestContext, @Param('staffId') staffId: string) {
    return this.svc.getMyStar(ctx.session!.userId, staffId);
  }

  @Put('ratings/:staffId')
  @ApiOperation({ summary: 'Поставить ★ (одна на клиента на мастера, только после визита «пришёл»)' })
  @ZodBody(rateStaffBody)
  async rateStaff(@Ctx() ctx: RequestContext, @Param('staffId') staffId: string, @Body(new Zod(rateStaffBody)) body: z.infer<typeof rateStaffBody>) {
    await this.svc.rateStaff(ctx.session!.userId, staffId, body.bookingId);
  }

  @Delete('ratings/:staffId')
  @ApiOperation({ summary: 'Снять свою ★' })
  async unrateStaff(@Ctx() ctx: RequestContext, @Param('staffId') staffId: string) {
    await this.svc.unrateStaff(ctx.session!.userId, staffId);
  }

  // ─────────────────────────── оценка 1–5 + текст (В-24, F-14-013) — этап 21, лейн client ───────────────────────────

  @Get('reviews/staff/:staffId')
  @ApiOperation({ summary: 'Моя оценка+текст этому мастеру, если оставлена' })
  getMyStaffReview(@Ctx() ctx: RequestContext, @Param('staffId') staffId: string) {
    return this.svc.getMyStaffReview(ctx.session!.userId, staffId);
  }

  @Put('reviews/staff/:staffId')
  @ApiOperation({ summary: 'Поставить/изменить оценку 1–5 и текст (текст уходит на модерацию)' })
  @ZodBody(staffReviewBody)
  submitStaffReview(@Ctx() ctx: RequestContext, @Param('staffId') staffId: string, @Body(new Zod(staffReviewBody)) body: z.infer<typeof staffReviewBody>) {
    return this.svc.submitStaffReview(ctx.session!.userId, staffId, body.businessId, body.bookingId, body.rating, body.text);
  }

  // ─────────────────────────── отзыв о месте (F-14-014) — этап 21, лейн client ───────────────────────────

  @Get('reviews/location/:bookingId')
  @ApiOperation({ summary: 'Мой отзыв об этом визите, если оставлен' })
  getMyLocationReview(@Ctx() ctx: RequestContext, @Param('bookingId') bookingId: string) {
    return this.svc.getMyLocationReview(ctx.session!.userId, bookingId);
  }

  @Put('reviews/location/:bookingId')
  @ApiOperation({ summary: 'Оставить/изменить отзыв о месте — только у своего визита «пришёл», один на визит' })
  @ZodBody(locationReviewBody)
  submitLocationReview(@Ctx() ctx: RequestContext, @Param('bookingId') bookingId: string, @Body(new Zod(locationReviewBody)) body: z.infer<typeof locationReviewBody>) {
    return this.svc.submitLocationReview(ctx.session!.userId, body.businessId, bookingId, body.text);
  }

  // ─────────────────────────── дневник (F-00-122) ───────────────────────────

  @Get('diary')
  @ApiOperation({ summary: 'Дневник: визиты «пришёл» через приложение сами + ручные строки' })
  listDiary(@Ctx() ctx: RequestContext) {
    return this.svc.listDiary(ctx.session!.userId);
  }

  @Post('diary')
  @ApiOperation({ summary: 'Добавить ручную строку дневника' })
  @ZodBody(diaryEntryBody)
  addDiary(@Ctx() ctx: RequestContext, @Body(new Zod(diaryEntryBody)) body: z.infer<typeof diaryEntryBody>) {
    return this.svc.addDiary(ctx.session!.userId, body);
  }

  @Delete('diary/:id')
  @ApiOperation({ summary: 'Удалить ручную строку дневника' })
  removeDiary(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.svc.removeDiary(ctx.session!.userId, id);
  }

  // ─────────────────────────── лента (F-14-055) ───────────────────────────

  @Get('inbox')
  @ApiOperation({ summary: 'Лента уведомлений клиента (статусы своих записей — напоминания/новости: этап 10)' })
  listInbox(@Ctx() ctx: RequestContext) {
    return this.svc.listInbox(ctx.session!.userId);
  }

  @Post('inbox/:id/read')
  @HttpCode(200)
  @ApiOperation({ summary: 'Отметить одно уведомление прочитанным' })
  markInboxRead(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.svc.markInboxRead(ctx.session!.userId, id);
  }

  @Post('inbox/read-all')
  @HttpCode(200)
  @ApiOperation({ summary: 'Отметить всю ленту прочитанной' })
  markAllInboxRead(@Ctx() ctx: RequestContext) {
    return this.svc.markAllInboxRead(ctx.session!.userId);
  }

  // ─────────────────────────── сторис (просмотр) ───────────────────────────

  @Get('stories')
  @ApiOperation({ summary: 'Сторис на главной — заводит нашa панель (этап 19), пока честно пусто' })
  listStories() {
    return this.svc.listStories();
  }

  // ─────────────────────────── лояльность (F-06-156…163, В-17) ───────────────────────────

  @Get('loyalty')
  @ApiOperation({ summary: 'Мои карты/сертификаты/абонементы/счета в этом бизнесе (В-06/В-09)' })
  myLoyalty(@Ctx() ctx: RequestContext, @Query('businessId', new Zod(z.string().min(1).max(40))) businessId: string) {
    return this.svc.myLoyalty(ctx.session!.userId, businessId);
  }

  @Get('loyalty/buyable')
  @ApiOperation({ summary: 'Что можно купить в приложении (типы сертификатов/абонементов, В-17)' })
  myLoyaltyBuyable(@Query('businessId', new Zod(z.string().min(1).max(40))) businessId: string) {
    return this.svc.myLoyaltyBuyable(businessId);
  }

  @Post('loyalty/certificates')
  @ApiOperation({ summary: 'В-17: заявка на сертификат — «ждёт подтверждения»' })
  @ZodBody(buyRequestBody)
  requestCertificate(@Ctx() ctx: RequestContext, @Body(new Zod(buyRequestBody)) body: z.infer<typeof buyRequestBody>) {
    return this.svc.requestCertificate(ctx.session!.userId, body.businessId, body.typeId);
  }

  @Post('loyalty/memberships')
  @ApiOperation({ summary: 'В-17: заявка на абонемент — «ждёт подтверждения»' })
  @ZodBody(buyRequestBody)
  requestMembership(@Ctx() ctx: RequestContext, @Body(new Zod(buyRequestBody)) body: z.infer<typeof buyRequestBody>) {
    return this.svc.requestMembership(ctx.session!.userId, body.businessId, body.typeId);
  }

  // ─────────────────────────── обращение к нам (F-00-182) ───────────────────────────

  @Post('support')
  @ApiOperation({ summary: 'Обращение к нам из приложения' })
  @ZodBody(supportBody)
  async submitSupport(@Ctx() ctx: RequestContext, @Body(new Zod(supportBody)) body: z.infer<typeof supportBody>) {
    await this.svc.submitSupport({ appUserId: ctx.session!.userId, phone: body.phone, subject: body.subject, message: body.message });
  }
}
