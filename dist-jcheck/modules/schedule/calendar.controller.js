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
import { ApiError } from '../../common/errors/api-error.js';
import { Biz, Ctx } from '../../common/http/guards.js';
import { ZodBody } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { isLocalDate } from '../../common/time/time.js';
import { calendarDayBody, calendarModeBody, fromToBody, markBody, oneDateBody, rangeBody, restoreMarksBody, vacationBody, weekAnchorBody } from './schedule.schemas.js';
import { CalendarService } from './calendar.service.js';
const date = (v, name) => {
    if (!isLocalDate(v))
        throw new ApiError('validation', 'Invalid input', { [name]: 'YYYY-MM-DD' });
    return v;
};
/** «Мой календарь» мастера (F-00-051…060): /v1/biz/{b}/staff/{s}/… */
let CalendarController = class CalendarController {
    constructor(svc) {
        this.svc = svc;
    }
    mode(businessId, staffId) {
        return this.svc.mode(businessId, staffId).then((mode) => ({ mode }));
    }
    setMode(ctx, businessId, staffId, body) {
        return this.svc.setMode(ctx, businessId, staffId, body.mode);
    }
    marks(businessId, staffId, from, to) {
        return this.svc.marks(businessId, staffId, date(from, 'from'), date(to, 'to'));
    }
    addMark(ctx, businessId, staffId, body) {
        return this.svc.addMark(ctx, businessId, staffId, body);
    }
    removeMark(ctx, businessId, staffId, id) {
        return this.svc.removeMark(ctx, businessId, staffId, id, true);
    }
    restore(ctx, businessId, staffId, body) {
        return this.svc.restoreMarks(ctx, businessId, staffId, body.from, body.to, body.marks);
    }
    wholeDay(ctx, businessId, staffId, body) {
        return this.svc.openWholeDay(ctx, businessId, staffId, body.date);
    }
    openWeek(ctx, businessId, staffId, body) {
        return this.svc.openWeek(ctx, businessId, staffId, body.from, body.to);
    }
    range(ctx, businessId, staffId, body) {
        return this.svc.markRange(ctx, businessId, staffId, body.date, body.from, body.to);
    }
    copyLastWeek(ctx, businessId, staffId, body) {
        return this.svc.copyMarksFromLastWeek(ctx, businessId, staffId, body.weekAnchor);
    }
    vacation(ctx, businessId, staffId, body) {
        return this.svc.setVacation(ctx, businessId, staffId, body.until);
    }
    week(businessId, staffId, from, to) {
        return this.svc.week(businessId, staffId, date(from, 'from'), date(to, 'to'));
    }
    saveDay(ctx, businessId, staffId, body) {
        return this.svc.saveDay(ctx, businessId, staffId, body);
    }
    emptyNextWeek(businessId, staffId, from) {
        return this.svc.hasEmptyNextWeek(businessId, staffId, date(from, 'from')).then((value) => ({ value }));
    }
};
__decorate([
    Get('calendar-mode'),
    Biz(),
    __param(0, Param('businessId')),
    __param(1, Param('staffId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], CalendarController.prototype, "mode", null);
__decorate([
    Put('calendar-mode'),
    HttpCode(204),
    Biz(),
    ApiOperation({ summary: 'Режим календаря — меняет только сам мастер (F-00-051)' }),
    ZodBody(calendarModeBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('staffId')),
    __param(3, Body(new Zod(calendarModeBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object]),
    __metadata("design:returntype", void 0)
], CalendarController.prototype, "setMode", null);
__decorate([
    Get('marks'),
    Biz(),
    __param(0, Param('businessId')),
    __param(1, Param('staffId')),
    __param(2, Query('from')),
    __param(3, Query('to')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, String]),
    __metadata("design:returntype", void 0)
], CalendarController.prototype, "marks", null);
__decorate([
    Post('marks'),
    Biz('schedule.edit'),
    ZodBody(markBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('staffId')),
    __param(3, Body(new Zod(markBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object]),
    __metadata("design:returntype", void 0)
], CalendarController.prototype, "addMark", null);
__decorate([
    Delete('marks/:id'),
    HttpCode(200),
    Biz('schedule.edit'),
    ApiOperation({ summary: 'Снять отметку; ответ — слепок дня «до» для «Отменить»' }),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('staffId')),
    __param(3, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, String]),
    __metadata("design:returntype", void 0)
], CalendarController.prototype, "removeMark", null);
__decorate([
    Post('marks/restore'),
    HttpCode(204),
    Biz('schedule.edit'),
    ZodBody(restoreMarksBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('staffId')),
    __param(3, Body(new Zod(restoreMarksBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object]),
    __metadata("design:returntype", void 0)
], CalendarController.prototype, "restore", null);
__decorate([
    Post('marks/whole-day'),
    HttpCode(200),
    Biz('schedule.edit'),
    ZodBody(oneDateBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('staffId')),
    __param(3, Body(new Zod(oneDateBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object]),
    __metadata("design:returntype", void 0)
], CalendarController.prototype, "wholeDay", null);
__decorate([
    Post('marks/open-week'),
    HttpCode(200),
    Biz('schedule.edit'),
    ZodBody(fromToBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('staffId')),
    __param(3, Body(new Zod(fromToBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object]),
    __metadata("design:returntype", void 0)
], CalendarController.prototype, "openWeek", null);
__decorate([
    Post('marks/range'),
    HttpCode(200),
    Biz('schedule.edit'),
    ZodBody(rangeBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('staffId')),
    __param(3, Body(new Zod(rangeBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object]),
    __metadata("design:returntype", void 0)
], CalendarController.prototype, "range", null);
__decorate([
    Post('marks/copy-last-week'),
    HttpCode(200),
    Biz('schedule.edit'),
    ZodBody(weekAnchorBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('staffId')),
    __param(3, Body(new Zod(weekAnchorBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object]),
    __metadata("design:returntype", void 0)
], CalendarController.prototype, "copyLastWeek", null);
__decorate([
    Post('vacation'),
    HttpCode(200),
    Biz('schedule.edit'),
    ApiOperation({ summary: '«В отпуске до…» (F-00-054): слепок «до» для «Отменить»' }),
    ZodBody(vacationBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('staffId')),
    __param(3, Body(new Zod(vacationBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object]),
    __metadata("design:returntype", void 0)
], CalendarController.prototype, "vacation", null);
__decorate([
    Get('calendar-week'),
    Biz(),
    __param(0, Param('businessId')),
    __param(1, Param('staffId')),
    __param(2, Query('from')),
    __param(3, Query('to')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, String]),
    __metadata("design:returntype", void 0)
], CalendarController.prototype, "week", null);
__decorate([
    Post('calendar-day'),
    HttpCode(200),
    Biz('schedule.edit'),
    ZodBody(calendarDayBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('staffId')),
    __param(3, Body(new Zod(calendarDayBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object]),
    __metadata("design:returntype", void 0)
], CalendarController.prototype, "saveDay", null);
__decorate([
    Get('empty-next-week'),
    Biz(),
    __param(0, Param('businessId')),
    __param(1, Param('staffId')),
    __param(2, Query('from')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String]),
    __metadata("design:returntype", void 0)
], CalendarController.prototype, "emptyNextWeek", null);
CalendarController = __decorate([
    ApiTags('schedule'),
    Controller('v1/biz/:businessId/staff/:staffId'),
    __metadata("design:paramtypes", [CalendarService])
], CalendarController);
export { CalendarController };
//# sourceMappingURL=calendar.controller.js.map