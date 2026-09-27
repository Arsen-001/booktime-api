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
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Biz, Ctx } from '../../common/http/guards.js';
import { ZodBody } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { isLocalDate } from '../../common/time/time.js';
import { ApiError } from '../../common/errors/api-error.js';
import { addWorkDaysBody, affectedBody, copyBody, copyLastWeekBody, deleteCellsBody, hasSavedBody, journalViewBody, oneDateBody, removeFromScheduleBody, restoreAfterRemoveBody, restoreCellsBody, setCellsBody, settingsPatch, snapshotBody, tableBody, templateBody, templatePatch, } from './schedule.schemas.js';
import { ScheduleService } from './schedule.service.js';
const date = (v, name) => {
    if (!isLocalDate(v))
        throw new ApiError('validation', 'Invalid input', { [name]: 'YYYY-MM-DD' });
    return v;
};
/** График: таблица, ячейки, шаблоны, копирование, история, настройки (docs/backend/02 §5, PLAN §6 №6) */
let ScheduleController = class ScheduleController {
    constructor(svc) {
        this.svc = svc;
    }
    table(ctx, businessId, body) {
        const m = ctx.member;
        const self = !m.permissions.has('staff.view') && !m.permissions.has('journal.others');
        return this.svc.table(businessId, self ? { ...body, filters: { ...body.filters, staffIds: [m.staffId] } } : body);
    }
    hasSaved(businessId, body) {
        return this.svc.hasSavedSchedule(businessId, body.staffIds).then((value) => ({ value }));
    }
    affected(businessId, body) {
        return this.svc.findAffected(this.svc.prisma, businessId, body.staffIds, body.dates, body.newHours);
    }
    setCells(ctx, businessId, body) {
        return this.svc.setCells(ctx, businessId, body);
    }
    apply(ctx, businessId, body) {
        return this.svc.applyCells(ctx, businessId, body);
    }
    deleteCells(ctx, businessId, body) {
        return this.svc.deleteCells(ctx, businessId, body);
    }
    snapshot(businessId, body) {
        return this.svc.snapshotCells(businessId, body.staffIds, body.dates);
    }
    restore(ctx, businessId, body) {
        return this.svc.restoreCells(ctx, businessId, body.snapshot);
    }
    copy(ctx, businessId, body) {
        return this.svc.copySchedule(ctx, businessId, body);
    }
    copyLastWeek(ctx, businessId, body) {
        return this.svc.copyFromLastWeek(ctx, businessId, body.staffId, body.weekAnchor);
    }
    templates(businessId) {
        return this.svc.templates(businessId);
    }
    createTemplate(ctx, businessId, body) {
        return this.svc.createTemplate(ctx, businessId, body);
    }
    updateTemplate(businessId, id, body) {
        return this.svc.updateTemplate(businessId, id, body);
    }
    deleteTemplate(businessId, id) {
        return this.svc.deleteTemplate(businessId, id);
    }
    history(businessId, staffIds) {
        return this.svc.history(businessId, staffIds ? staffIds.split(',').filter(Boolean) : undefined);
    }
    settings(businessId) {
        return this.svc.settings(businessId);
    }
    patchSettings(businessId, body) {
        return this.svc.patchSettings(businessId, body);
    }
    // ─────────── сотрудник ───────────
    journalView(businessId, staffId, body) {
        return this.svc.setJournalView(businessId, staffId, body);
    }
    hours(businessId, staffId, from, to, locationId) {
        const f = date(from, 'from');
        return this.svc.hours(businessId, staffId, f, to ? date(to, 'to') : f, locationId || undefined);
    }
    addWorkDayWithUndo(ctx, businessId, staffId, body) {
        return this.svc.addWorkDayWithUndo(ctx, businessId, staffId, body.date);
    }
    addWorkDays(ctx, businessId, staffId, body) {
        return this.svc.addWorkDays(ctx, businessId, staffId, body);
    }
    removePreview(businessId, staffId) {
        return this.svc.previewRemove(businessId, staffId).then((affected) => ({ affected }));
    }
    remove(ctx, businessId, staffId, body) {
        return this.svc.removeFromSchedule(ctx, businessId, staffId, body.force);
    }
    restoreRemove(ctx, businessId, staffId, body) {
        return this.svc.restoreAfterRemove(ctx, businessId, staffId, body.snapshot);
    }
};
__decorate([
    Post('schedule/table'),
    HttpCode(200),
    Biz(),
    ApiOperation({ summary: 'Таблица «Сотрудники × дни» с фильтрами (F-02-002/003); без staff.view — только своя строка' }),
    ZodBody(tableBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(tableBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], ScheduleController.prototype, "table", null);
__decorate([
    Post('schedule/has-saved'),
    HttpCode(200),
    Biz(),
    ZodBody(hasSavedBody),
    __param(0, Param('businessId')),
    __param(1, Body(new Zod(hasSavedBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], ScheduleController.prototype, "hasSaved", null);
__decorate([
    Post('schedule/affected'),
    HttpCode(200),
    Biz(),
    ApiOperation({ summary: 'Записи, задетые правкой графика (F-02-106)' }),
    ZodBody(affectedBody),
    __param(0, Param('businessId')),
    __param(1, Body(new Zod(affectedBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], ScheduleController.prototype, "affected", null);
__decorate([
    Put('schedule/cells'),
    Biz('schedule.edit'),
    ZodBody(setCellsBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(setCellsBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], ScheduleController.prototype, "setCells", null);
__decorate([
    Post('schedule/cells/apply'),
    HttpCode(200),
    Biz('schedule.edit'),
    ApiOperation({ summary: 'Проверка записей + слепок «до» + запись одним запросом; ok=false — задетые записи (A7)' }),
    ZodBody(setCellsBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(setCellsBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], ScheduleController.prototype, "apply", null);
__decorate([
    Post('schedule/cells/delete'),
    HttpCode(200),
    Biz('schedule.edit'),
    ApiOperation({ summary: 'Удалить рабочие дни (F-02-014); без force при записях — 409 schedule_has_bookings' }),
    ZodBody(deleteCellsBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(deleteCellsBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], ScheduleController.prototype, "deleteCells", null);
__decorate([
    Post('schedule/cells/snapshot'),
    HttpCode(200),
    Biz(),
    ZodBody(snapshotBody),
    __param(0, Param('businessId')),
    __param(1, Body(new Zod(snapshotBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], ScheduleController.prototype, "snapshot", null);
__decorate([
    Post('schedule/cells/restore'),
    HttpCode(204),
    Biz('schedule.edit'),
    ApiOperation({ summary: '«Отменить» правку графика (F-00-061): слепок держит экран' }),
    ZodBody(restoreCellsBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(restoreCellsBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], ScheduleController.prototype, "restore", null);
__decorate([
    Post('schedule/copy'),
    HttpCode(204),
    Biz('schedule.edit'),
    ZodBody(copyBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(copyBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], ScheduleController.prototype, "copy", null);
__decorate([
    Post('schedule/copy-last-week'),
    HttpCode(204),
    Biz('schedule.edit'),
    ZodBody(copyLastWeekBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(copyLastWeekBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], ScheduleController.prototype, "copyLastWeek", null);
__decorate([
    Get('schedule/templates'),
    Biz(),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], ScheduleController.prototype, "templates", null);
__decorate([
    Post('schedule/templates'),
    Biz('schedule.edit'),
    ZodBody(templateBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(templateBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], ScheduleController.prototype, "createTemplate", null);
__decorate([
    Patch('schedule/templates/:id'),
    HttpCode(204),
    Biz('schedule.edit'),
    ZodBody(templatePatch),
    __param(0, Param('businessId')),
    __param(1, Param('id')),
    __param(2, Body(new Zod(templatePatch))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object]),
    __metadata("design:returntype", void 0)
], ScheduleController.prototype, "updateTemplate", null);
__decorate([
    Delete('schedule/templates/:id'),
    HttpCode(204),
    Biz('schedule.edit'),
    __param(0, Param('businessId')),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], ScheduleController.prototype, "deleteTemplate", null);
__decorate([
    Get('schedule/history'),
    Biz('staff.view'),
    ApiOperation({ summary: 'История правок графика и правил окон (F-02-102)' }),
    __param(0, Param('businessId')),
    __param(1, Query('staffIds')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], ScheduleController.prototype, "history", null);
__decorate([
    Get('schedule/settings'),
    Biz(),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], ScheduleController.prototype, "settings", null);
__decorate([
    Patch('schedule/settings'),
    Biz('schedule.edit'),
    ApiOperation({ summary: 'Настройки раздела; в картах по сотруднику null снимает ключ' }),
    ZodBody(settingsPatch),
    __param(0, Param('businessId')),
    __param(1, Body(new Zod(settingsPatch))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], ScheduleController.prototype, "patchSettings", null);
__decorate([
    Put('staff/:staffId/journal-view'),
    HttpCode(204),
    Biz('staff.manage'),
    ApiOperation({ summary: 'Колонка в журнале: скрыть (F-02-082) и шаг разметки (F-02-083)' }),
    ZodBody(journalViewBody),
    __param(0, Param('businessId')),
    __param(1, Param('staffId')),
    __param(2, Body(new Zod(journalViewBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object]),
    __metadata("design:returntype", void 0)
], ScheduleController.prototype, "journalView", null);
__decorate([
    Get('staff/:staffId/hours'),
    Biz(),
    ApiOperation({ summary: 'Часы по дням, сумма минут и конец графика (getDayHours/getWorkDays/getScheduledMinutes/getScheduleEnd)' }),
    __param(0, Param('businessId')),
    __param(1, Param('staffId')),
    __param(2, Query('from')),
    __param(3, Query('to')),
    __param(4, Query('locationId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, String, String]),
    __metadata("design:returntype", void 0)
], ScheduleController.prototype, "hours", null);
__decorate([
    Post('staff/:staffId/work-day-with-undo'),
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
], ScheduleController.prototype, "addWorkDayWithUndo", null);
__decorate([
    Post('staff/:staffId/work-days'),
    HttpCode(200),
    Biz('schedule.edit'),
    ZodBody(addWorkDaysBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('staffId')),
    __param(3, Body(new Zod(addWorkDaysBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object]),
    __metadata("design:returntype", void 0)
], ScheduleController.prototype, "addWorkDays", null);
__decorate([
    Get('staff/:staffId/remove-from-schedule'),
    Biz(),
    __param(0, Param('businessId')),
    __param(1, Param('staffId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], ScheduleController.prototype, "removePreview", null);
__decorate([
    Post('staff/:staffId/remove-from-schedule'),
    HttpCode(200),
    Biz('schedule.edit'),
    ApiOperation({ summary: '«Убрать из графика» (F-02-020): будущие записи без force — ok=false и их число' }),
    ZodBody(removeFromScheduleBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('staffId')),
    __param(3, Body(new Zod(removeFromScheduleBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object]),
    __metadata("design:returntype", void 0)
], ScheduleController.prototype, "remove", null);
__decorate([
    Post('staff/:staffId/remove-from-schedule/restore'),
    HttpCode(204),
    Biz('schedule.edit'),
    ZodBody(restoreAfterRemoveBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('staffId')),
    __param(3, Body(new Zod(restoreAfterRemoveBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object]),
    __metadata("design:returntype", void 0)
], ScheduleController.prototype, "restoreRemove", null);
ScheduleController = __decorate([
    ApiTags('schedule'),
    Controller('v1/biz/:businessId'),
    __metadata("design:paramtypes", [ScheduleService])
], ScheduleController);
export { ScheduleController };
//# sourceMappingURL=schedule.controller.js.map