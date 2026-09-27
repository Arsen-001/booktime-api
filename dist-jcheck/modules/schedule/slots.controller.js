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
import { AvailabilityService } from '../availability/availability.service.js';
import { anySpecialistQuery, bufferBody, effectiveRuleQuery, nearestQuery, quickSlotsQuery, scopeKind, serviceWindowBody, slotModeBody, slotRule, slotsQuery, togglePartBody, toggleSlotBody, unavailableBody, utilizationQuery, } from './schedule.schemas.js';
import { RulesService } from './rules.service.js';
import { ScheduleService } from './schedule.service.js';
const kindOf = (v) => {
    const r = scopeKind.safeParse(v);
    if (!r.success)
        throw new ApiError('validation', 'Invalid input', { kind: 'location | staff' });
    return r.data;
};
/**
 * Свободные окна (режим сотрудника) и правила онлайн-записи (docs/backend/02 §5, 04). Окна считает сервер
 * (07 K2/B6/B21 закрыты здесь); публичные окна для клиента — этап 8/9 (`/v1/public/…`), тем же AvailabilityService.
 */
let SlotsController = class SlotsController {
    constructor(availability, rules, schedule) {
        this.availability = availability;
        this.rules = rules;
        this.schedule = schedule;
    }
    slots(businessId, staffId, q) {
        return this.availability.freeSlots(businessId, { ...q, staffId });
    }
    nearest(businessId, staffId, q) {
        return this.availability.nearestSlots(businessId, { ...q, staffId });
    }
    quick(businessId, staffId, q) {
        return this.availability.quickSlots(businessId, { ...q, staffId });
    }
    any(businessId, q) {
        return this.availability.anySpecialistSlots(businessId, q);
    }
    utilization(businessId, q) {
        return this.rules.utilization(businessId, q.staffIds.split(',').filter(Boolean), q.from, q.to, q.locationId);
    }
    slotMode(businessId, staffId) {
        return this.rules.slotMode(businessId, staffId).then((mode) => ({ mode }));
    }
    setSlotMode(ctx, businessId, staffId, body) {
        return this.rules.setSlotMode(ctx, businessId, staffId, body.locationId, body.mode);
    }
    effective(businessId, q) {
        return this.rules.effectiveRule(businessId, q.staffId, q.locationId, q.date);
    }
    getRules(businessId, kind, id) {
        return this.rules.rules(businessId, kindOf(kind), id);
    }
    saveRule(ctx, businessId, kind, id, body) {
        const rule = { ...body, leadTimeMin: body.leadTimeMin ?? undefined };
        return this.rules.saveRule(ctx, businessId, kindOf(kind), id, rule);
    }
    deleteRule(ctx, businessId, kind, id, ruleId) {
        return this.rules.deleteRule(ctx, businessId, kindOf(kind), id, ruleId);
    }
    toggleSlot(ctx, businessId, kind, id, ruleId, body) {
        return this.rules.toggleSlot(ctx, businessId, kindOf(kind), id, ruleId, body.time);
    }
    togglePart(ctx, businessId, kind, id, ruleId, body) {
        return this.rules.togglePart(ctx, businessId, kindOf(kind), id, ruleId, body.times, body.enable);
    }
    workRange(businessId, kind, id) {
        return this.schedule.workRange(businessId, kindOf(kind), id).then((range) => ({ range }));
    }
    unavailable(businessId, kind, id) {
        return this.rules.unavailable(businessId, kindOf(kind), id);
    }
    addUnavailable(ctx, businessId, kind, id, body) {
        return this.rules.addUnavailable(ctx, businessId, kindOf(kind), id, body);
    }
    removeUnavailable(ctx, businessId, kind, id, rangeId) {
        return this.rules.removeUnavailable(ctx, businessId, kindOf(kind), id, rangeId);
    }
    buffer(businessId, kind, id) {
        return this.rules.buffer(businessId, kindOf(kind), id).then((minutes) => ({ minutes }));
    }
    setBuffer(ctx, businessId, kind, id, body) {
        return this.rules.setBuffer(ctx, businessId, kindOf(kind), id, body.minutes);
    }
    serviceWindow(businessId, serviceId) {
        return this.rules.serviceWindow(businessId, serviceId).then((window) => ({ window }));
    }
    setServiceWindow(businessId, serviceId, body) {
        return this.rules.setServiceWindow(businessId, serviceId, body);
    }
    clearServiceWindow(businessId, serviceId) {
        return this.rules.setServiceWindow(businessId, serviceId, null);
    }
    mirror(businessId) {
        return this.rules.mirror(businessId);
    }
};
__decorate([
    Get('staff/:staffId/slots'),
    Biz('journal.view'),
    ApiOperation({ summary: 'Свободные окна мастера на дату (04 §2)' }),
    __param(0, Param('businessId')),
    __param(1, Param('staffId')),
    __param(2, Query(new Zod(slotsQuery))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object]),
    __metadata("design:returntype", void 0)
], SlotsController.prototype, "slots", null);
__decorate([
    Get('staff/:staffId/nearest-slots'),
    Biz('journal.view'),
    __param(0, Param('businessId')),
    __param(1, Param('staffId')),
    __param(2, Query(new Zod(nearestQuery))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object]),
    __metadata("design:returntype", void 0)
], SlotsController.prototype, "nearest", null);
__decorate([
    Get('staff/:staffId/quick-slots'),
    Biz('journal.view'),
    ApiOperation({ summary: 'Окна быстрой записи мастера (F-00-060): без правил онлайн-записи, шаг 15' }),
    __param(0, Param('businessId')),
    __param(1, Param('staffId')),
    __param(2, Query(new Zod(quickSlotsQuery))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object]),
    __metadata("design:returntype", void 0)
], SlotsController.prototype, "quick", null);
__decorate([
    Get('slots/any-specialist'),
    Biz('journal.view'),
    ApiOperation({ summary: '«Любой специалист» (F-02-079)' }),
    __param(0, Param('businessId')),
    __param(1, Query(new Zod(anySpecialistQuery))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], SlotsController.prototype, "any", null);
__decorate([
    Get('slots/utilization'),
    Biz('staff.view'),
    ApiOperation({ summary: 'Свободные и занятые слоты по мастерам за период (F-02-094)' }),
    __param(0, Param('businessId')),
    __param(1, Query(new Zod(utilizationQuery))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], SlotsController.prototype, "utilization", null);
__decorate([
    Get('staff/:staffId/slot-mode'),
    Biz(),
    __param(0, Param('businessId')),
    __param(1, Param('staffId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], SlotsController.prototype, "slotMode", null);
__decorate([
    Put('staff/:staffId/slot-mode'),
    HttpCode(204),
    Biz('schedule.edit'),
    ZodBody(slotModeBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('staffId')),
    __param(3, Body(new Zod(slotModeBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object]),
    __metadata("design:returntype", void 0)
], SlotsController.prototype, "setSlotMode", null);
__decorate([
    Get('slot-rules/effective'),
    Biz(),
    __param(0, Param('businessId')),
    __param(1, Query(new Zod(effectiveRuleQuery))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], SlotsController.prototype, "effective", null);
__decorate([
    Get('slot-rules/:kind/:id'),
    Biz(),
    __param(0, Param('businessId')),
    __param(1, Param('kind')),
    __param(2, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String]),
    __metadata("design:returntype", void 0)
], SlotsController.prototype, "getRules", null);
__decorate([
    Put('slot-rules/:kind/:id'),
    Biz('schedule.edit'),
    ApiOperation({ summary: 'Сохранить основное правило или исключение по дням недели (F-02-045, F-02-054)' }),
    ZodBody(slotRule),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('kind')),
    __param(3, Param('id')),
    __param(4, Body(new Zod(slotRule))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, String, Object]),
    __metadata("design:returntype", void 0)
], SlotsController.prototype, "saveRule", null);
__decorate([
    Delete('slot-rules/:kind/:id/:ruleId'),
    HttpCode(204),
    Biz('schedule.edit'),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('kind')),
    __param(3, Param('id')),
    __param(4, Param('ruleId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, String, String]),
    __metadata("design:returntype", void 0)
], SlotsController.prototype, "deleteRule", null);
__decorate([
    Post('slot-rules/:kind/:id/:ruleId/toggle-slot'),
    HttpCode(204),
    Biz('schedule.edit'),
    ZodBody(toggleSlotBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('kind')),
    __param(3, Param('id')),
    __param(4, Param('ruleId')),
    __param(5, Body(new Zod(toggleSlotBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, String, String, Object]),
    __metadata("design:returntype", void 0)
], SlotsController.prototype, "toggleSlot", null);
__decorate([
    Post('slot-rules/:kind/:id/:ruleId/toggle-part'),
    HttpCode(204),
    Biz('schedule.edit'),
    ZodBody(togglePartBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('kind')),
    __param(3, Param('id')),
    __param(4, Param('ruleId')),
    __param(5, Body(new Zod(togglePartBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, String, String, Object]),
    __metadata("design:returntype", void 0)
], SlotsController.prototype, "togglePart", null);
__decorate([
    Get('work-range/:kind/:id'),
    Biz(),
    __param(0, Param('businessId')),
    __param(1, Param('kind')),
    __param(2, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String]),
    __metadata("design:returntype", void 0)
], SlotsController.prototype, "workRange", null);
__decorate([
    Get('unavailable/:kind/:id'),
    Biz(),
    __param(0, Param('businessId')),
    __param(1, Param('kind')),
    __param(2, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String]),
    __metadata("design:returntype", void 0)
], SlotsController.prototype, "unavailable", null);
__decorate([
    Post('unavailable/:kind/:id'),
    Biz('schedule.edit'),
    ZodBody(unavailableBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('kind')),
    __param(3, Param('id')),
    __param(4, Body(new Zod(unavailableBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, String, Object]),
    __metadata("design:returntype", void 0)
], SlotsController.prototype, "addUnavailable", null);
__decorate([
    Delete('unavailable/:kind/:id/:rangeId'),
    HttpCode(204),
    Biz('schedule.edit'),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('kind')),
    __param(3, Param('id')),
    __param(4, Param('rangeId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, String, String]),
    __metadata("design:returntype", void 0)
], SlotsController.prototype, "removeUnavailable", null);
__decorate([
    Get('buffer/:kind/:id'),
    Biz(),
    __param(0, Param('businessId')),
    __param(1, Param('kind')),
    __param(2, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String]),
    __metadata("design:returntype", void 0)
], SlotsController.prototype, "buffer", null);
__decorate([
    Put('buffer/:kind/:id'),
    HttpCode(204),
    Biz('schedule.edit'),
    ZodBody(bufferBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('kind')),
    __param(3, Param('id')),
    __param(4, Body(new Zod(bufferBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, String, Object]),
    __metadata("design:returntype", void 0)
], SlotsController.prototype, "setBuffer", null);
__decorate([
    Get('service-window/:serviceId'),
    Biz(),
    __param(0, Param('businessId')),
    __param(1, Param('serviceId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], SlotsController.prototype, "serviceWindow", null);
__decorate([
    Put('service-window/:serviceId'),
    HttpCode(204),
    Biz('services.edit'),
    ApiOperation({ summary: '«Услуга доступна ограниченное время» (F-02-067)' }),
    ZodBody(serviceWindowBody),
    __param(0, Param('businessId')),
    __param(1, Param('serviceId')),
    __param(2, Body(new Zod(serviceWindowBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object]),
    __metadata("design:returntype", void 0)
], SlotsController.prototype, "setServiceWindow", null);
__decorate([
    Delete('service-window/:serviceId'),
    HttpCode(204),
    Biz('services.edit'),
    __param(0, Param('businessId')),
    __param(1, Param('serviceId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], SlotsController.prototype, "clearServiceWindow", null);
__decorate([
    Get('schedule/mirror'),
    Biz(),
    ApiOperation({ summary: 'Графики, отметки, типы дня и правила бизнеса одним ответом — для зеркала фронта (PLAN §7)' }),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], SlotsController.prototype, "mirror", null);
SlotsController = __decorate([
    ApiTags('slots'),
    Controller('v1/biz/:businessId'),
    __metadata("design:paramtypes", [AvailabilityService,
        RulesService,
        ScheduleService])
], SlotsController);
export { SlotsController };
//# sourceMappingURL=slots.controller.js.map