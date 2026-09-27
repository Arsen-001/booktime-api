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
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Authed, Ctx } from '../../common/http/guards.js';
import { ZodBody } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { buyRequestBody, createMyBookingBody, diaryEntryBody, favoriteBody, favoriteMuteBody, myWaitlistBody, rateStaffBody, supportBody } from './client.schemas.js';
import { MeService } from './me.service.js';
/**
 * Раздел «client», после входа (docs/backend/02 §2.2, PLAN §6 №9): запись из приложения, «мои записи», лист
 * ожидания «от себя», избранное, звёздочка, дневник, «мои мастера», лента, сторис, обращение к нам.
 */
let MeController = class MeController {
    constructor(svc) {
        this.svc = svc;
    }
    // ─────────────────────────── записи ───────────────────────────
    createBooking(ctx, body) {
        return this.svc.createBooking(ctx, body);
    }
    listBookings(ctx, businessId) {
        return this.svc.listMine(ctx.session.userId, businessId);
    }
    getBooking(ctx, id) {
        return this.svc.getOne(ctx.session.userId, id);
    }
    // «Я оплатил» (`POST bookings/:id/paid`) — уже построен в `MeBookingsController` (журнал, этап 7); не дублируем.
    // ─────────────────────────── лист ожидания «от себя» ───────────────────────────
    listWaitlist(ctx) {
        return this.svc.listMyWaitlist(ctx.session.userId);
    }
    addWaitlist(ctx, body) {
        return this.svc.addWaitlist(ctx.session.userId, body);
    }
    removeWaitlist(ctx, id) {
        return this.svc.removeWaitlist(ctx.session.userId, id);
    }
    // ─────────────────────────── «Мои мастера» (F-00-118) ───────────────────────────
    myMasters(ctx, limit) {
        return this.svc.listMyMasters(ctx.session.userId, limit ? Number(limit) : undefined);
    }
    // ─────────────────────────── ❤ избранное (F-00-113/115) ───────────────────────────
    listFavorites(ctx) {
        return this.svc.listFavorites(ctx.session.userId);
    }
    isFavorited(ctx, targetType, targetId) {
        return this.svc.isFavorited(ctx.session.userId, targetType, targetId).then((favorited) => ({ favorited }));
    }
    async toggleFavorite(ctx, body) {
        return { subscribed: await this.svc.toggleFavorite(ctx.session.userId, body.targetType, body.targetId) };
    }
    async muteFavorite(ctx, id, body) {
        await this.svc.setFavoriteNewsMuted(ctx.session.userId, id, body.muted);
    }
    // ─────────────────────────── ★ звёздочка (F-00-116) ───────────────────────────
    getMyStar(ctx, staffId) {
        return this.svc.getMyStar(ctx.session.userId, staffId);
    }
    async rateStaff(ctx, staffId, body) {
        await this.svc.rateStaff(ctx.session.userId, staffId, body.bookingId);
    }
    async unrateStaff(ctx, staffId) {
        await this.svc.unrateStaff(ctx.session.userId, staffId);
    }
    // ─────────────────────────── дневник (F-00-122) ───────────────────────────
    listDiary(ctx) {
        return this.svc.listDiary(ctx.session.userId);
    }
    addDiary(ctx, body) {
        return this.svc.addDiary(ctx.session.userId, body);
    }
    removeDiary(ctx, id) {
        return this.svc.removeDiary(ctx.session.userId, id);
    }
    // ─────────────────────────── лента (F-14-055) ───────────────────────────
    listInbox(ctx) {
        return this.svc.listInbox(ctx.session.userId);
    }
    markInboxRead(ctx, id) {
        return this.svc.markInboxRead(ctx.session.userId, id);
    }
    markAllInboxRead(ctx) {
        return this.svc.markAllInboxRead(ctx.session.userId);
    }
    // ─────────────────────────── сторис (просмотр) ───────────────────────────
    listStories() {
        return this.svc.listStories();
    }
    // ─────────────────────────── лояльность (F-06-156…163, В-17) ───────────────────────────
    myLoyalty(ctx, businessId) {
        return this.svc.myLoyalty(ctx.session.userId, businessId);
    }
    myLoyaltyBuyable(businessId) {
        return this.svc.myLoyaltyBuyable(businessId);
    }
    requestCertificate(ctx, body) {
        return this.svc.requestCertificate(ctx.session.userId, body.businessId, body.typeId);
    }
    requestMembership(ctx, body) {
        return this.svc.requestMembership(ctx.session.userId, body.businessId, body.typeId);
    }
    // ─────────────────────────── обращение к нам (F-00-182) ───────────────────────────
    async submitSupport(ctx, body) {
        await this.svc.submitSupport({ appUserId: ctx.session.userId, phone: body.phone, subject: body.subject, message: body.message });
    }
};
__decorate([
    Post('bookings'),
    ApiOperation({ summary: 'Запись из приложения (F-00-031) — окно/статус/предоплата решает единый поток place()' }),
    ZodBody(createMyBookingBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(createMyBookingBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], MeController.prototype, "createBooking", null);
__decorate([
    Get('bookings'),
    ApiOperation({ summary: 'Мои записи: предстоящие/прошедшие/отменённые (F-14-011), или ?businessId= — в одной компании (F-14-026)' }),
    __param(0, Ctx()),
    __param(1, Query('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], MeController.prototype, "listBookings", null);
__decorate([
    Get('bookings/:id'),
    ApiOperation({ summary: 'Детали моей записи — только своя (F-00-092)' }),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], MeController.prototype, "getBooking", null);
__decorate([
    Get('waitlist'),
    ApiOperation({ summary: 'Мой лист ожидания (F-00-101/102)' }),
    __param(0, Ctx()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], MeController.prototype, "listWaitlist", null);
__decorate([
    Post('waitlist'),
    ApiOperation({ summary: 'Встать в лист ожидания' }),
    ZodBody(myWaitlistBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(myWaitlistBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], MeController.prototype, "addWaitlist", null);
__decorate([
    Delete('waitlist/:id'),
    ApiOperation({ summary: 'Выйти из листа ожидания' }),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], MeController.prototype, "removeWaitlist", null);
__decorate([
    Get('masters'),
    ApiOperation({ summary: '«Мои мастера» — только записанные сам через приложение/веб' }),
    __param(0, Ctx()),
    __param(1, Query('limit')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], MeController.prototype, "myMasters", null);
__decorate([
    Get('favorites'),
    ApiOperation({ summary: 'Список избранного (F-14-031)' }),
    __param(0, Ctx()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], MeController.prototype, "listFavorites", null);
__decorate([
    Get('favorites/check'),
    ApiOperation({ summary: 'Подписан ли на мастера/место — кнопка ❤ на карточке' }),
    __param(0, Ctx()),
    __param(1, Query('targetType')),
    __param(2, Query('targetId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String]),
    __metadata("design:returntype", void 0)
], MeController.prototype, "isFavorited", null);
__decorate([
    Post('favorites'),
    ApiOperation({ summary: '❤ подписаться/отписаться (F-00-113)' }),
    ZodBody(favoriteBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(favoriteBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], MeController.prototype, "toggleFavorite", null);
__decorate([
    Post('favorites/:id/mute'),
    HttpCode(200),
    ApiOperation({ summary: '«Приглушить новости», не отписываясь (F-00-115)' }),
    ZodBody(favoriteMuteBody),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body(new Zod(favoriteMuteBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", Promise)
], MeController.prototype, "muteFavorite", null);
__decorate([
    Get('ratings/:staffId'),
    ApiOperation({ summary: 'Моя звёздочка этому мастеру, если стоит' }),
    __param(0, Ctx()),
    __param(1, Param('staffId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], MeController.prototype, "getMyStar", null);
__decorate([
    Put('ratings/:staffId'),
    ApiOperation({ summary: 'Поставить ★ (одна на клиента на мастера, только после визита «пришёл»)' }),
    ZodBody(rateStaffBody),
    __param(0, Ctx()),
    __param(1, Param('staffId')),
    __param(2, Body(new Zod(rateStaffBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", Promise)
], MeController.prototype, "rateStaff", null);
__decorate([
    Delete('ratings/:staffId'),
    ApiOperation({ summary: 'Снять свою ★' }),
    __param(0, Ctx()),
    __param(1, Param('staffId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], MeController.prototype, "unrateStaff", null);
__decorate([
    Get('diary'),
    ApiOperation({ summary: 'Дневник: визиты «пришёл» через приложение сами + ручные строки' }),
    __param(0, Ctx()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], MeController.prototype, "listDiary", null);
__decorate([
    Post('diary'),
    ApiOperation({ summary: 'Добавить ручную строку дневника' }),
    ZodBody(diaryEntryBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(diaryEntryBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], MeController.prototype, "addDiary", null);
__decorate([
    Delete('diary/:id'),
    ApiOperation({ summary: 'Удалить ручную строку дневника' }),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], MeController.prototype, "removeDiary", null);
__decorate([
    Get('inbox'),
    ApiOperation({ summary: 'Лента уведомлений клиента (статусы своих записей — напоминания/новости: этап 10)' }),
    __param(0, Ctx()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], MeController.prototype, "listInbox", null);
__decorate([
    Post('inbox/:id/read'),
    HttpCode(200),
    ApiOperation({ summary: 'Отметить одно уведомление прочитанным' }),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], MeController.prototype, "markInboxRead", null);
__decorate([
    Post('inbox/read-all'),
    HttpCode(200),
    ApiOperation({ summary: 'Отметить всю ленту прочитанной' }),
    __param(0, Ctx()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], MeController.prototype, "markAllInboxRead", null);
__decorate([
    Get('stories'),
    ApiOperation({ summary: 'Сторис на главной — заводит нашa панель (этап 19), пока честно пусто' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], MeController.prototype, "listStories", null);
__decorate([
    Get('loyalty'),
    ApiOperation({ summary: 'Мои карты/сертификаты/абонементы/счета в этом бизнесе (В-06/В-09)' }),
    __param(0, Ctx()),
    __param(1, Query('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], MeController.prototype, "myLoyalty", null);
__decorate([
    Get('loyalty/buyable'),
    ApiOperation({ summary: 'Что можно купить в приложении (типы сертификатов/абонементов, В-17)' }),
    __param(0, Query('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], MeController.prototype, "myLoyaltyBuyable", null);
__decorate([
    Post('loyalty/certificates'),
    ApiOperation({ summary: 'В-17: заявка на сертификат — «ждёт подтверждения»' }),
    ZodBody(buyRequestBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(buyRequestBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], MeController.prototype, "requestCertificate", null);
__decorate([
    Post('loyalty/memberships'),
    ApiOperation({ summary: 'В-17: заявка на абонемент — «ждёт подтверждения»' }),
    ZodBody(buyRequestBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(buyRequestBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], MeController.prototype, "requestMembership", null);
__decorate([
    Post('support'),
    ApiOperation({ summary: 'Обращение к нам из приложения' }),
    ZodBody(supportBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(supportBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], MeController.prototype, "submitSupport", null);
MeController = __decorate([
    ApiTags('client'),
    Controller('v1/me'),
    Authed(),
    __metadata("design:paramtypes", [MeService])
], MeController);
export { MeController };
//# sourceMappingURL=me.controller.js.map