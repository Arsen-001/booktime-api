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
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Biz, Ctx } from '../../common/http/guards.js';
import { ZodBody, ZodOk } from '../../common/http/openapi.js';
import { localToUtc } from '../../common/time/time.js';
import { Zod } from '../../common/http/validation.js';
import { assistantSettingsBody, changeLogEntryOut, checkInstancesFreeBody, createAssistantBody, eventCategoryBody, eventTemplateBody, fineRightsBody, freeInstancesBody, groupSeatsSettingsBody, groupServicePaymentBody, instanceBody, resourceCreateBody, resourceOptionsBody, resourceOut, resourceServicesBody, resourceUpdateBody, restoreResourceBody, splitByResourceBody, staffEligibleBody, toggleServiceBody, } from './resources.schemas.js';
import { ResourcesService } from './resources.service.js';
/** Ресурсы: кресла, кабинеты, аппараты — /v1/biz (docs/backend/02 §9, PLAN §6 №4). Групповые события и лист
 * ожидания (F-16-036…169) — модуль journal (этап 7): /events, /waitlist, участники — записи с group_event_id. */
let ResourcesController = class ResourcesController {
    constructor(svc) {
        this.svc = svc;
    }
    getSplit(businessId) {
        return this.svc.getSplitByResource(businessId).then((value) => ({ value }));
    }
    setSplit(businessId, body) {
        return this.svc.setSplitByResource(businessId, body.value).then((value) => ({ value }));
    }
    changelog(businessId) {
        return this.svc.changelog(businessId);
    }
    restore(ctx, businessId, body) {
        return this.svc.restore(ctx, businessId, body);
    }
    listForService(businessId, serviceId) {
        return this.svc.listForService(businessId, serviceId);
    }
    // ─────────── stage 21: окно записи — подбор/проверка свободных экземпляров (F-16-011…013) ───────────
    // Литеральные сегменты объявлены ДО `:id`/`@Get()` ниже — иначе Nest принял бы их за id ресурса.
    async freeInstances(businessId, body) {
        const tz = await this.svc.tzOfBusiness(businessId);
        return this.svc.pickFreeInstances(businessId, body.serviceIds, localToUtc(body.start, tz), body.durationMin, body.excludeBookingId);
    }
    async checkFree(businessId, body) {
        const tz = await this.svc.tzOfBusiness(businessId);
        return { value: await this.svc.checkInstancesFree(businessId, body.instanceIds, localToUtc(body.start, tz), body.durationMin, body.excludeBookingId) };
    }
    async options(businessId, body) {
        const tz = await this.svc.tzOfBusiness(businessId);
        return this.svc.listResourceOptions(businessId, localToUtc(body.start, tz), body.durationMin, body.excludeBookingId);
    }
    // ─────────── stage 21: ассистенты (F-16-136…147) ───────────
    getAssistantSettings(businessId) {
        return this.svc.getAssistantSettings(businessId);
    }
    saveAssistantSettings(businessId, body) {
        return this.svc.saveAssistantSettings(businessId, body);
    }
    listAssistantStaff(businessId) {
        return this.svc.listAssistantStaff(businessId);
    }
    setStaffAssistantEligible(businessId, staffId, body) {
        return this.svc.setStaffAssistantEligible(businessId, staffId, body.value);
    }
    createAssistant(ctx, businessId, body) {
        return this.svc.createAssistant(ctx, businessId, body.locationId, body.name, body.phone);
    }
    // ─────────── stage 21: тонкие права раздела (F-16-026, F-16-144, F-16-169) ───────────
    getStaffResourcesRights(businessId, staffId) {
        return this.svc.getStaffResourcesRights(businessId, staffId);
    }
    setStaffResourcesRights(businessId, staffId, body) {
        return this.svc.setStaffResourcesRights(businessId, staffId, body);
    }
    // ─────────── stage 21: несколько мест для клиента (F-16-049) ───────────
    getGroupSeatsSettings(businessId) {
        return this.svc.getGroupSeatsSettings(businessId);
    }
    saveGroupSeatsSettings(businessId, body) {
        return this.svc.saveGroupSeatsSettings(businessId, body);
    }
    // ─────────── stage 21: шаблоны повтора события (F-16-064/065/101) ───────────
    listEventTemplates(businessId) {
        return this.svc.listEventTemplates(businessId);
    }
    saveEventTemplate(businessId, body) {
        return this.svc.saveEventTemplate(businessId, body);
    }
    // ─────────── stage 21: категории событий (F-16-043) ───────────
    listEventCategories(businessId) {
        return this.svc.listEventCategories(businessId);
    }
    createEventCategory(businessId, body) {
        return this.svc.createEventCategory(businessId, body.name, body.colorIndex);
    }
    updateEventCategory(businessId, id, body) {
        return this.svc.updateEventCategory(businessId, id, body);
    }
    deleteEventCategory(businessId, id) {
        return this.svc.deleteEventCategory(businessId, id);
    }
    // ─────────── stage 21: предоплата и абонемент у групповой услуги (F-16-031) ───────────
    getGroupServicePayment(businessId, serviceId) {
        return this.svc.getGroupServicePayment(businessId, serviceId);
    }
    setGroupServicePayment(businessId, serviceId, body) {
        return this.svc.setGroupServicePayment(businessId, serviceId, body);
    }
    list(businessId) {
        return this.svc.list(businessId);
    }
    create(ctx, businessId, body) {
        return this.svc.create(ctx, businessId, body);
    }
    get(businessId, id) {
        return this.svc.get(businessId, id);
    }
    update(ctx, businessId, id, body) {
        return this.svc.update(ctx, businessId, id, body);
    }
    futureUsage(businessId, id) {
        return this.svc.countFutureUsage(businessId, id).then((count) => ({ count }));
    }
    remove(ctx, businessId, id) {
        return this.svc.delete(ctx, businessId, id);
    }
    addInstance(businessId, id, body) {
        return this.svc.addInstance(businessId, id, body.name);
    }
    renameInstance(businessId, id, instanceId, body) {
        return this.svc.renameInstance(businessId, id, instanceId, body.name);
    }
    removeInstance(businessId, id, instanceId) {
        return this.svc.removeInstance(businessId, id, instanceId);
    }
    setServices(businessId, id, body) {
        return this.svc.setServices(businessId, id, body.serviceIds);
    }
    toggleService(businessId, id, serviceId, body) {
        return this.svc.toggleService(businessId, id, serviceId, body.linked);
    }
};
__decorate([
    Get('split-by-resource'),
    Biz(),
    ApiOperation({ summary: '«Разделять запись с услугами, использующими разные ресурсы» (F-16-016)' }),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], ResourcesController.prototype, "getSplit", null);
__decorate([
    Put('split-by-resource'),
    Biz('resources.manage'),
    ZodBody(splitByResourceBody),
    __param(0, Param('businessId')),
    __param(1, Body(new Zod(splitByResourceBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], ResourcesController.prototype, "setSplit", null);
__decorate([
    Get('changelog'),
    Biz('resources.manage'),
    ZodOk(z.array(changeLogEntryOut)),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], ResourcesController.prototype, "changelog", null);
__decorate([
    Post('restore'),
    Biz('resources.manage'),
    ApiOperation({ summary: '«Отменить» удаление ресурса (F-00-061): восстанавливает тем же id' }),
    ZodBody(restoreResourceBody),
    ZodOk(resourceOut),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(restoreResourceBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], ResourcesController.prototype, "restore", null);
__decorate([
    Get('for-service/:serviceId'),
    Biz(),
    ApiOperation({ summary: 'Ресурсы, привязанные к услуге — вклад в карточку услуги (F-16-006)' }),
    ZodOk(z.array(resourceOut)),
    __param(0, Param('businessId')),
    __param(1, Param('serviceId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], ResourcesController.prototype, "listForService", null);
__decorate([
    Post('free-instances'),
    HttpCode(200),
    Biz(),
    ApiOperation({ summary: 'По одному свободному экземпляру каждого ресурса услуги (F-16-011/012)' }),
    ZodBody(freeInstancesBody),
    __param(0, Param('businessId')),
    __param(1, Body(new Zod(freeInstancesBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], ResourcesController.prototype, "freeInstances", null);
__decorate([
    Post('check-instances-free'),
    HttpCode(200),
    Biz(),
    ApiOperation({ summary: 'Выбранные вручную экземпляры всё ещё свободны? (F-16-013)' }),
    ZodBody(checkInstancesFreeBody),
    __param(0, Param('businessId')),
    __param(1, Body(new Zod(checkInstancesFreeBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], ResourcesController.prototype, "checkFree", null);
__decorate([
    Post('options'),
    HttpCode(200),
    Biz(),
    ApiOperation({ summary: 'Все активные ресурсы с отметкой занятых сейчас экземпляров (F-16-013)' }),
    ZodBody(resourceOptionsBody),
    __param(0, Param('businessId')),
    __param(1, Body(new Zod(resourceOptionsBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], ResourcesController.prototype, "options", null);
__decorate([
    Get('assistant-settings'),
    Biz(),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], ResourcesController.prototype, "getAssistantSettings", null);
__decorate([
    Put('assistant-settings'),
    Biz('resources.manage'),
    ZodBody(assistantSettingsBody),
    __param(0, Param('businessId')),
    __param(1, Body(new Zod(assistantSettingsBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], ResourcesController.prototype, "saveAssistantSettings", null);
__decorate([
    Get('assistant-staff'),
    Biz(),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], ResourcesController.prototype, "listAssistantStaff", null);
__decorate([
    Put('assistant-staff/:staffId'),
    Biz('resources.manage'),
    ZodBody(staffEligibleBody),
    __param(0, Param('businessId')),
    __param(1, Param('staffId')),
    __param(2, Body(new Zod(staffEligibleBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object]),
    __metadata("design:returntype", void 0)
], ResourcesController.prototype, "setStaffAssistantEligible", null);
__decorate([
    Post('create-assistant'),
    Biz('resources.manage'),
    ApiOperation({ summary: 'F-09-044/F-16-137/139: короткий путь для минимального помощника без графика' }),
    ZodBody(createAssistantBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(createAssistantBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], ResourcesController.prototype, "createAssistant", null);
__decorate([
    Get('staff-rights/:staffId'),
    Biz(),
    __param(0, Param('businessId')),
    __param(1, Param('staffId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], ResourcesController.prototype, "getStaffResourcesRights", null);
__decorate([
    Put('staff-rights/:staffId'),
    Biz('resources.manage'),
    ZodBody(fineRightsBody),
    __param(0, Param('businessId')),
    __param(1, Param('staffId')),
    __param(2, Body(new Zod(fineRightsBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object]),
    __metadata("design:returntype", void 0)
], ResourcesController.prototype, "setStaffResourcesRights", null);
__decorate([
    Get('group-seats-settings'),
    Biz(),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], ResourcesController.prototype, "getGroupSeatsSettings", null);
__decorate([
    Put('group-seats-settings'),
    Biz('resources.manage'),
    ZodBody(groupSeatsSettingsBody),
    __param(0, Param('businessId')),
    __param(1, Body(new Zod(groupSeatsSettingsBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], ResourcesController.prototype, "saveGroupSeatsSettings", null);
__decorate([
    Get('event-templates'),
    Biz(),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], ResourcesController.prototype, "listEventTemplates", null);
__decorate([
    Post('event-templates'),
    Biz('journal.edit'),
    ZodBody(eventTemplateBody),
    __param(0, Param('businessId')),
    __param(1, Body(new Zod(eventTemplateBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], ResourcesController.prototype, "saveEventTemplate", null);
__decorate([
    Get('event-categories'),
    Biz(),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], ResourcesController.prototype, "listEventCategories", null);
__decorate([
    Post('event-categories'),
    Biz('resources.manage'),
    ZodBody(eventCategoryBody),
    __param(0, Param('businessId')),
    __param(1, Body(new Zod(eventCategoryBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], ResourcesController.prototype, "createEventCategory", null);
__decorate([
    Patch('event-categories/:id'),
    Biz('resources.manage'),
    ZodBody(eventCategoryBody),
    __param(0, Param('businessId')),
    __param(1, Param('id')),
    __param(2, Body(new Zod(eventCategoryBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object]),
    __metadata("design:returntype", void 0)
], ResourcesController.prototype, "updateEventCategory", null);
__decorate([
    Delete('event-categories/:id'),
    Biz('resources.manage'),
    __param(0, Param('businessId')),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], ResourcesController.prototype, "deleteEventCategory", null);
__decorate([
    Get('group-service-payment/:serviceId'),
    Biz(),
    __param(0, Param('businessId')),
    __param(1, Param('serviceId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], ResourcesController.prototype, "getGroupServicePayment", null);
__decorate([
    Put('group-service-payment/:serviceId'),
    Biz('services.edit'),
    ZodBody(groupServicePaymentBody),
    __param(0, Param('businessId')),
    __param(1, Param('serviceId')),
    __param(2, Body(new Zod(groupServicePaymentBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object]),
    __metadata("design:returntype", void 0)
], ResourcesController.prototype, "setGroupServicePayment", null);
__decorate([
    Get(),
    Biz(),
    ZodOk(z.array(resourceOut)),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], ResourcesController.prototype, "list", null);
__decorate([
    Post(),
    Biz('resources.manage'),
    ZodBody(resourceCreateBody),
    ZodOk(resourceOut),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(resourceCreateBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], ResourcesController.prototype, "create", null);
__decorate([
    Get(':id'),
    Biz(),
    ZodOk(resourceOut),
    __param(0, Param('businessId')),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], ResourcesController.prototype, "get", null);
__decorate([
    Patch(':id'),
    Biz('resources.manage'),
    ZodBody(resourceUpdateBody),
    ZodOk(resourceOut),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('id')),
    __param(3, Body(new Zod(resourceUpdateBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object]),
    __metadata("design:returntype", void 0)
], ResourcesController.prototype, "update", null);
__decorate([
    Get(':id/future-usage'),
    Biz(),
    __param(0, Param('businessId')),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], ResourcesController.prototype, "futureUsage", null);
__decorate([
    Delete(':id'),
    Biz('resources.manage'),
    ZodOk(resourceOut),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String]),
    __metadata("design:returntype", void 0)
], ResourcesController.prototype, "remove", null);
__decorate([
    Post(':id/instances'),
    Biz('resources.manage'),
    ZodBody(instanceBody),
    ZodOk(resourceOut),
    __param(0, Param('businessId')),
    __param(1, Param('id')),
    __param(2, Body(new Zod(instanceBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object]),
    __metadata("design:returntype", void 0)
], ResourcesController.prototype, "addInstance", null);
__decorate([
    Patch(':id/instances/:instanceId'),
    Biz('resources.manage'),
    ZodBody(instanceBody),
    ZodOk(resourceOut),
    __param(0, Param('businessId')),
    __param(1, Param('id')),
    __param(2, Param('instanceId')),
    __param(3, Body(new Zod(instanceBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, Object]),
    __metadata("design:returntype", void 0)
], ResourcesController.prototype, "renameInstance", null);
__decorate([
    Delete(':id/instances/:instanceId'),
    Biz('resources.manage'),
    ZodOk(resourceOut),
    __param(0, Param('businessId')),
    __param(1, Param('id')),
    __param(2, Param('instanceId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String]),
    __metadata("design:returntype", void 0)
], ResourcesController.prototype, "removeInstance", null);
__decorate([
    Put(':id/services'),
    Biz('resources.manage'),
    ZodBody(resourceServicesBody),
    ZodOk(resourceOut),
    __param(0, Param('businessId')),
    __param(1, Param('id')),
    __param(2, Body(new Zod(resourceServicesBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object]),
    __metadata("design:returntype", void 0)
], ResourcesController.prototype, "setServices", null);
__decorate([
    Put(':id/services/:serviceId'),
    Biz('resources.manage'),
    ZodBody(toggleServiceBody),
    ZodOk(resourceOut),
    __param(0, Param('businessId')),
    __param(1, Param('id')),
    __param(2, Param('serviceId')),
    __param(3, Body(new Zod(toggleServiceBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, Object]),
    __metadata("design:returntype", void 0)
], ResourcesController.prototype, "toggleService", null);
ResourcesController = __decorate([
    ApiTags('resources'),
    Controller('v1/biz/:businessId/resources'),
    __metadata("design:paramtypes", [ResourcesService])
], ResourcesController);
export { ResourcesController };
//# sourceMappingURL=resources.controller.js.map