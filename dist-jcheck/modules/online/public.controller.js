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
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Ctx } from '../../common/http/guards.js';
import { ZodBody, ZodOk } from '../../common/http/openapi.js';
import { RateLimit } from '../../common/rate-limit/rate-limit.js';
import { Zod } from '../../common/http/validation.js';
import { cancelWindowOut, codeSentOut, createOnlineBookingBody, freeSlotOut, monthAvailabilityOut, onlineBookingResultOut, onlineBookingViewOut, publicBusinessOut, sendBookingCodeBody, } from './online.schemas.js';
import { OnlineService } from './online.service.js';
const num = z.coerce.number().int().positive();
const optNum = z.coerce.number().int().positive().optional();
/**
 * Публичные маршруты страницы записи по ссылке (docs/backend/02 §3, PLAN §6 №8): без входа — страница бизнеса,
 * окна виджета, создание записи (с кодом, B2), «моя запись» по хэшу (B8, B19, не переносится — только просмотр
 * и отмена, решение владельца по 08-open-questions.md).
 */
let PublicOnlineController = class PublicOnlineController {
    constructor(svc) {
        this.svc = svc;
    }
    business(slug, formId) {
        return this.svc.publicBusinessData(slug, formId);
    }
    businessForm(slug, formId) {
        return this.svc.publicBusinessData(slug, formId);
    }
    slots(slug, staffId, date, durationMin, durationMax, serviceId, locationId, workplace) {
        return this.svc.widgetSlots(slug, { staffId, date, durationMin, durationMax, serviceId, locationId, workplace });
    }
    async nearestDate(slug, staffId, from, durationMin, durationMax, serviceId, locationId, workplace) {
        return { date: await this.svc.nearestDate(slug, { staffId, from, durationMin, durationMax, serviceId, locationId, workplace }) };
    }
    month(slug, staffId, month, durationMin, durationMax, serviceId, locationId, workplace) {
        return this.svc.monthAvailability(slug, { staffId, month, durationMin, durationMax, serviceId, locationId, workplace });
    }
    sendCode(ctx, body) {
        return this.svc.sendCode(ctx, body);
    }
    create(slug, body) {
        return this.svc.createBooking(slug, body);
    }
    view(id, hash) {
        return this.svc.viewByHash(id, hash);
    }
    cancelWindow(id, hash) {
        return this.svc.cancelWindow(id, hash);
    }
    cancel(id, hash) {
        return this.svc.cancelByHash(id, hash);
    }
};
__decorate([
    Get('b/:slug'),
    RateLimit({ bucket: 'public-business', limit: 120, windowSec: 60, by: 'ip' }),
    ApiOperation({ summary: 'Публичная страница бизнеса /b/<slug> (F-03-134)' }),
    ZodOk(publicBusinessOut),
    __param(0, Param('slug')),
    __param(1, Query('formId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], PublicOnlineController.prototype, "business", null);
__decorate([
    Get('b/:slug/f/:formId'),
    RateLimit({ bucket: 'public-business', limit: 120, windowSec: 60, by: 'ip' }),
    ApiOperation({ summary: 'Страница формы /b/<slug>/f/<formId> (F-03-009)' }),
    ZodOk(publicBusinessOut),
    __param(0, Param('slug')),
    __param(1, Param('formId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], PublicOnlineController.prototype, "businessForm", null);
__decorate([
    Get('b/:slug/slots'),
    RateLimit({ bucket: 'public-slots', limit: 300, windowSec: 60, by: 'ip' }),
    ApiOperation({ summary: 'Свободные окна виджета (F-03-065) — вход как у `getWidgetFreeSlots` фронта' }),
    ZodOk(z.array(freeSlotOut)),
    __param(0, Param('slug')),
    __param(1, Query('staffId')),
    __param(2, Query('date')),
    __param(3, Query('durationMin', new Zod(num))),
    __param(4, Query('durationMax', new Zod(optNum))),
    __param(5, Query('serviceId')),
    __param(6, Query('locationId')),
    __param(7, Query('workplace')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, Number, Object, Object, Object, Object]),
    __metadata("design:returntype", void 0)
], PublicOnlineController.prototype, "slots", null);
__decorate([
    Get('b/:slug/nearest-date'),
    RateLimit({ bucket: 'public-slots', limit: 300, windowSec: 60, by: 'ip' }),
    ApiOperation({ summary: 'Ближайший день с окнами (F-03-085)' }),
    ZodOk(z.object({ date: z.string().optional() })),
    __param(0, Param('slug')),
    __param(1, Query('staffId')),
    __param(2, Query('from')),
    __param(3, Query('durationMin', new Zod(num))),
    __param(4, Query('durationMax', new Zod(optNum))),
    __param(5, Query('serviceId')),
    __param(6, Query('locationId')),
    __param(7, Query('workplace')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, Number, Object, Object, Object, Object]),
    __metadata("design:returntype", Promise)
], PublicOnlineController.prototype, "nearestDate", null);
__decorate([
    Get('b/:slug/month'),
    RateLimit({ bucket: 'public-slots', limit: 300, windowSec: 60, by: 'ip' }),
    ApiOperation({ summary: 'Дни месяца с окнами (F-03-084)' }),
    ZodOk(monthAvailabilityOut),
    __param(0, Param('slug')),
    __param(1, Query('staffId')),
    __param(2, Query('month')),
    __param(3, Query('durationMin', new Zod(num))),
    __param(4, Query('durationMax', new Zod(optNum))),
    __param(5, Query('serviceId')),
    __param(6, Query('locationId')),
    __param(7, Query('workplace')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, Number, Object, Object, Object, Object]),
    __metadata("design:returntype", void 0)
], PublicOnlineController.prototype, "month", null);
__decorate([
    Post('b/:slug/code'),
    HttpCode(200),
    RateLimit({ bucket: 'public-booking-code', limit: 5, windowSec: 3600, by: 'ip' }),
    ApiOperation({ summary: 'Код перед записью без входа (F-00-007, B2) — тот же канал, что вход' }),
    ZodBody(sendBookingCodeBody),
    ZodOk(codeSentOut),
    __param(0, Ctx()),
    __param(1, Body(new Zod(sendBookingCodeBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], PublicOnlineController.prototype, "sendCode", null);
__decorate([
    Post('b/:slug/bookings'),
    RateLimit({ bucket: 'public-booking-create', limit: 20, windowSec: 3600, by: 'ip' }),
    ApiOperation({ summary: '«Записаться» из виджета/ссылки (F-03-093, F-03-125)' }),
    ZodBody(createOnlineBookingBody),
    ZodOk(onlineBookingResultOut),
    __param(0, Param('slug')),
    __param(1, Body(new Zod(createOnlineBookingBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], PublicOnlineController.prototype, "create", null);
__decorate([
    Get('bookings/:id'),
    RateLimit({ bucket: 'public-booking-hash', limit: 60, windowSec: 60, by: 'ip' }),
    ApiOperation({ summary: 'Запись по ссылке без входа (F-03-098) — только по правильному хэшу' }),
    ZodOk(onlineBookingViewOut),
    __param(0, Param('id')),
    __param(1, Query('h')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], PublicOnlineController.prototype, "view", null);
__decorate([
    Get('bookings/:id/cancel-window'),
    RateLimit({ bucket: 'public-booking-hash', limit: 60, windowSec: 60, by: 'ip' }),
    ApiOperation({ summary: 'Можно ли сейчас бесплатно отменить/перенести (F-03-066/067)' }),
    ZodOk(cancelWindowOut),
    __param(0, Param('id')),
    __param(1, Query('h')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], PublicOnlineController.prototype, "cancelWindow", null);
__decorate([
    Post('bookings/:id/cancel'),
    RateLimit({ bucket: 'public-booking-hash', limit: 20, windowSec: 3600, by: 'ip' }),
    ApiOperation({ summary: 'Отмена своей записи по ссылке без входа (F-03-100). Перенос по ссылке не строим — B8' }),
    __param(0, Param('id')),
    __param(1, Query('h')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], PublicOnlineController.prototype, "cancel", null);
PublicOnlineController = __decorate([
    ApiTags('online'),
    Controller('v1/public'),
    __metadata("design:paramtypes", [OnlineService])
], PublicOnlineController);
export { PublicOnlineController };
//# sourceMappingURL=public.controller.js.map