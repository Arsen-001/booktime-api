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
import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Biz, Ctx } from '../../common/http/guards.js';
import { ZodBody, ZodOk } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { ifMatch } from '../../common/http/version.js';
import { activeBody, categoryBody, categoryDeleteImpactOut, categoryOut, createServiceBody, deleteImpactOut, materialsProfileBody, orderBody, packageCreateBody, packageOut, packageSaveBody, photoProfileBody, photoSlotsOut, restoreServiceBody, serviceBody, serviceExtraBody, serviceMaterialsOut, serviceOut, serviceRowOut, staffContentCountsOut, staffDocumentBody, staffDocumentOut, staffDocumentRestoreBody, staffTermBody, techBreakBody, techBreakExportRowOut, techBreakImportBody, techBreakImportResultOut, } from './services.schemas.js';
import { ServicesService } from './services.service.js';
/** Каталог: категории, услуги, пакеты «Комплекс» — /v1/biz (docs/backend/02 §8, PLAN §6 №4) */
let ServicesController = class ServicesController {
    constructor(svc) {
        this.svc = svc;
    }
    // ─────────── категории ───────────
    listCategories(businessId) {
        return this.svc.listCategories(businessId);
    }
    getCategory(businessId, id) {
        return this.svc.getCategory(businessId, id);
    }
    createCategory(ctx, businessId, body) {
        return this.svc.createCategory(ctx, businessId, body);
    }
    updateCategory(ctx, businessId, id, body) {
        return this.svc.updateCategory(ctx, businessId, id, body);
    }
    categoryDeleteImpact(businessId, id) {
        return this.svc.categoryDeleteImpact(businessId, id);
    }
    categoryOnlineName(businessId, id) {
        return this.svc.categoryOnlineName(businessId, id);
    }
    deleteCategory(ctx, businessId, id) {
        return this.svc.deleteCategory(ctx, businessId, id);
    }
    reorderCategories(businessId, body) {
        return this.svc.reorderCategories(businessId, body.ids);
    }
    // ─────────── услуги — статичные пути (регистрируются раньше /services/:id) ───────────
    listServiceRows(businessId) {
        return this.svc.listServiceRows(businessId);
    }
    techBreakExport(businessId) {
        return this.svc.techBreakExportRows(businessId);
    }
    techBreakImport(ctx, businessId, body) {
        return this.svc.importTechBreaks(ctx, businessId, body.rows);
    }
    restoreService(ctx, businessId, body) {
        return this.svc.restoreService(ctx, businessId, body);
    }
    reorderServices(businessId, body) {
        return this.svc.reorder(businessId, body.ids);
    }
    getPhotoLinks(businessId, urls) {
        const list = urls ? urls.split(',').filter(Boolean) : [];
        return this.svc.getPhotoLinks(businessId, list);
    }
    // ─────────── услуги ───────────
    listServices(businessId, kind) {
        return this.svc.listServices(businessId, kind);
    }
    getService(businessId, id) {
        return this.svc.getService(businessId, id);
    }
    createService(ctx, businessId, body) {
        return this.svc.createService(ctx, businessId, body);
    }
    updateService(ctx, req, businessId, id, body) {
        return this.svc.updateService(ctx, businessId, id, body, ifMatch(req));
    }
    setActive(ctx, businessId, id, body) {
        return this.svc.setActive(ctx, businessId, id, body.active);
    }
    setTechBreak(ctx, businessId, id, body) {
        return this.svc.setTechBreak(ctx, businessId, id, body.mode, body.min);
    }
    deleteImpact(businessId, id) {
        return this.svc.deleteImpact(businessId, id);
    }
    deleteService(ctx, businessId, id) {
        return this.svc.deleteService(ctx, businessId, id);
    }
    // ─────────── мастера услуги (F-10-156, F-02-058, F-16-030) ───────────
    listServiceStaff(businessId, id) {
        return this.svc.listServiceStaff(businessId, id);
    }
    listAssignableStaff(businessId, id) {
        return this.svc.listAssignableStaff(businessId, id);
    }
    assignStaff(ctx, businessId, id, staffId) {
        return this.svc.assignStaffToService(ctx, businessId, id, staffId);
    }
    removeStaff(ctx, businessId, id, staffId) {
        return this.svc.removeStaffFromService(ctx, businessId, id, staffId);
    }
    getStaffTerm(businessId, id, staffId) {
        return this.svc.getStaffServiceTerms(businessId, id, staffId);
    }
    setStaffTerm(businessId, id, staffId, body) {
        return this.svc.setStaffServiceTerm(businessId, id, staffId, body.price, body.durationMin);
    }
    listStaffServices(businessId, staffId) {
        return this.svc.listStaffServices(businessId, staffId);
    }
    listAssignableServices(businessId, staffId) {
        return this.svc.listAssignableServices(businessId, staffId);
    }
    // ─────────── языки, чек, выбор при записи (F-03-115, F-15-141, F-07-149) ───────────
    getServiceExtra(businessId, id) {
        return this.svc.getServiceExtra(businessId, id);
    }
    updateServiceExtra(businessId, id, body) {
        return this.svc.updateServiceExtra(businessId, id, body);
    }
    getReceiptName(businessId, id) {
        return this.svc.getReceiptName(businessId, id);
    }
    getServiceTranslations(businessId, id) {
        return this.svc.getServiceTranslations(businessId, id);
    }
    // ─────────── пакеты «Комплекс» (F-16-107…135) ───────────
    listPackages(businessId) {
        return this.svc.listPackages(businessId);
    }
    getPackage(businessId, id) {
        return this.svc.getPackage(businessId, id);
    }
    createPackage(ctx, businessId, body) {
        return this.svc.createPackage(ctx, businessId, body);
    }
    savePackage(ctx, businessId, id, body) {
        return this.svc.savePackage(ctx, businessId, id, body);
    }
    futureBookings(businessId, id) {
        return this.svc.countFuturePackageBookings(businessId, id).then((count) => ({ count }));
    }
    deletePackage(ctx, businessId, id) {
        return this.svc.deletePackage(ctx, businessId, id);
    }
    // ─────────── стадия 21 (лейн services+rest): фото работ мастера (F-00-085/086) ───────────
    getPhotoSlots(businessId, staffId) {
        return this.svc.getPhotoSlots(businessId, staffId);
    }
    savePhotoProfile(ctx, businessId, staffId, body) {
        return this.svc.savePhotoProfile(ctx, businessId, staffId, body.photos, body.links);
    }
    // ─────────── дипломы и сертификаты — проверяем мы (F-00-088) ───────────
    listStaffDocuments(businessId, staffId) {
        return this.svc.listStaffDocuments(businessId, staffId);
    }
    addStaffDocument(ctx, businessId, staffId, body) {
        return this.svc.addStaffDocument(ctx, businessId, staffId, body.imageUrl, body.fileName, body.moderationId);
    }
    removeStaffDocument(ctx, businessId, id) {
        return this.svc.removeStaffDocument(ctx, businessId, id);
    }
    restoreStaffDocument(ctx, businessId, body) {
        return this.svc.restoreStaffDocument(ctx, businessId, body);
    }
    // ─────────── материалы (F-00-089) и стерилизация (F-00-090) ───────────
    getSterilization(businessId, staffId) {
        return this.svc.getSterilization(businessId, staffId);
    }
    saveMaterialsProfile(ctx, businessId, staffId, body) {
        return this.svc.saveMaterialsProfile(ctx, businessId, staffId, body);
    }
    getServiceMaterials(businessId, id, locationIds) {
        const list = locationIds ? locationIds.split(',').filter(Boolean) : [];
        return this.svc.getServiceMaterials(businessId, id, list);
    }
    // ─────────── что есть у мастера: фото, документы, материалы (У28) ───────────
    listStaffContentCounts(businessId) {
        return this.svc.listStaffContentCounts(businessId);
    }
};
__decorate([
    Get('categories'),
    Biz('services.view'),
    ZodOk(z.array(categoryOut)),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], ServicesController.prototype, "listCategories", null);
__decorate([
    Get('categories/:id'),
    Biz('services.view'),
    ZodOk(categoryOut),
    __param(0, Param('businessId')),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], ServicesController.prototype, "getCategory", null);
__decorate([
    Post('categories'),
    Biz('services.edit'),
    ZodBody(categoryBody),
    ZodOk(categoryOut),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(categoryBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], ServicesController.prototype, "createCategory", null);
__decorate([
    Patch('categories/:id'),
    Biz('services.edit'),
    ZodBody(categoryBody),
    ZodOk(categoryOut),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('id')),
    __param(3, Body(new Zod(categoryBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object]),
    __metadata("design:returntype", void 0)
], ServicesController.prototype, "updateCategory", null);
__decorate([
    Get('categories/:id/delete-impact'),
    Biz('services.view'),
    ZodOk(categoryDeleteImpactOut),
    __param(0, Param('businessId')),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], ServicesController.prototype, "categoryDeleteImpact", null);
__decorate([
    Get('categories/:id/online-name'),
    Biz('services.view'),
    ApiOperation({ summary: 'Своё имя категории для витрины (F-03-131)' }),
    __param(0, Param('businessId')),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], ServicesController.prototype, "categoryOnlineName", null);
__decorate([
    Delete('categories/:id'),
    Biz('services.edit'),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String]),
    __metadata("design:returntype", void 0)
], ServicesController.prototype, "deleteCategory", null);
__decorate([
    Put('categories/order'),
    Biz('services.edit'),
    ApiOperation({ summary: 'Порядок категорий (У25)' }),
    ZodBody(orderBody),
    __param(0, Param('businessId')),
    __param(1, Body(new Zod(orderBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], ServicesController.prototype, "reorderCategories", null);
__decorate([
    Get('service-rows'),
    Biz('services.view'),
    ZodOk(z.array(serviceRowOut)),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], ServicesController.prototype, "listServiceRows", null);
__decorate([
    Get('services/tech-break/export'),
    Biz('services.view'),
    ApiOperation({ summary: 'Выгрузка Tech. break в Excel (F-02-063)' }),
    ZodOk(z.array(techBreakExportRowOut)),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], ServicesController.prototype, "techBreakExport", null);
__decorate([
    Post('services/tech-break/import'),
    Biz('services.edit'),
    ApiOperation({ summary: 'Загрузка Tech. break из Excel — до 500 строк за раз' }),
    ZodBody(techBreakImportBody),
    ZodOk(techBreakImportResultOut),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(techBreakImportBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], ServicesController.prototype, "techBreakImport", null);
__decorate([
    Post('services/restore'),
    Biz('services.edit'),
    ApiOperation({ summary: '«Отменить» удаление (F-00-061): пересоздаёт услугу тем же id из снимка экрана' }),
    ZodBody(restoreServiceBody),
    ZodOk(serviceOut),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(restoreServiceBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], ServicesController.prototype, "restoreService", null);
__decorate([
    Put('services/order'),
    Biz('services.edit'),
    ZodBody(orderBody),
    __param(0, Param('businessId')),
    __param(1, Body(new Zod(orderBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], ServicesController.prototype, "reorderServices", null);
__decorate([
    Get('services/photo-links'),
    Biz('services.view'),
    ApiOperation({ summary: 'Привязка фото→услуга одним запросом (вместо запроса на каждое фото); ключ — сам url фото, не мастер' }),
    __param(0, Param('businessId')),
    __param(1, Query('urls')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], ServicesController.prototype, "getPhotoLinks", null);
__decorate([
    Get('services'),
    Biz('services.view'),
    ZodOk(z.array(serviceOut)),
    __param(0, Param('businessId')),
    __param(1, Query('kind')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], ServicesController.prototype, "listServices", null);
__decorate([
    Get('services/:id'),
    Biz('services.view'),
    ZodOk(serviceOut),
    __param(0, Param('businessId')),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], ServicesController.prototype, "getService", null);
__decorate([
    Post('services'),
    Biz('services.edit'),
    ZodBody(createServiceBody),
    ZodOk(serviceOut),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(createServiceBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], ServicesController.prototype, "createService", null);
__decorate([
    Patch('services/:id'),
    Biz('services.edit'),
    ZodBody(serviceBody),
    ZodOk(serviceOut),
    __param(0, Ctx()),
    __param(1, Req()),
    __param(2, Param('businessId')),
    __param(3, Param('id')),
    __param(4, Body(new Zod(serviceBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, String, String, Object]),
    __metadata("design:returntype", void 0)
], ServicesController.prototype, "updateService", null);
__decorate([
    Put('services/:id/active'),
    Biz('services.edit'),
    ZodBody(activeBody),
    ZodOk(serviceOut),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('id')),
    __param(3, Body(new Zod(activeBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object]),
    __metadata("design:returntype", void 0)
], ServicesController.prototype, "setActive", null);
__decorate([
    Put('services/:id/tech-break'),
    Biz('services.edit'),
    ZodBody(techBreakBody),
    ZodOk(serviceOut),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('id')),
    __param(3, Body(new Zod(techBreakBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object]),
    __metadata("design:returntype", void 0)
], ServicesController.prototype, "setTechBreak", null);
__decorate([
    Get('services/:id/delete-impact'),
    Biz('services.view'),
    ZodOk(deleteImpactOut),
    __param(0, Param('businessId')),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], ServicesController.prototype, "deleteImpact", null);
__decorate([
    Delete('services/:id'),
    Biz('services.edit'),
    ZodOk(serviceOut),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String]),
    __metadata("design:returntype", void 0)
], ServicesController.prototype, "deleteService", null);
__decorate([
    Get('services/:id/staff'),
    Biz('services.view'),
    __param(0, Param('businessId')),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], ServicesController.prototype, "listServiceStaff", null);
__decorate([
    Get('services/:id/assignable-staff'),
    Biz('services.view'),
    __param(0, Param('businessId')),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], ServicesController.prototype, "listAssignableStaff", null);
__decorate([
    Post('services/:id/staff/:staffId'),
    Biz('services.edit'),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('id')),
    __param(3, Param('staffId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, String]),
    __metadata("design:returntype", void 0)
], ServicesController.prototype, "assignStaff", null);
__decorate([
    Delete('services/:id/staff/:staffId'),
    Biz('services.edit'),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('id')),
    __param(3, Param('staffId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, String]),
    __metadata("design:returntype", void 0)
], ServicesController.prototype, "removeStaff", null);
__decorate([
    Get('services/:id/staff/:staffId/term'),
    Biz('services.view'),
    __param(0, Param('businessId')),
    __param(1, Param('id')),
    __param(2, Param('staffId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String]),
    __metadata("design:returntype", void 0)
], ServicesController.prototype, "getStaffTerm", null);
__decorate([
    Put('services/:id/staff/:staffId/term'),
    Biz('services.edit'),
    ZodBody(staffTermBody),
    __param(0, Param('businessId')),
    __param(1, Param('id')),
    __param(2, Param('staffId')),
    __param(3, Body(new Zod(staffTermBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, Object]),
    __metadata("design:returntype", void 0)
], ServicesController.prototype, "setStaffTerm", null);
__decorate([
    Get('staff/:staffId/service-groups'),
    Biz('services.view'),
    ApiOperation({ summary: 'Услуги мастера по категориям — вклад в карточку сотрудника (F-10-027)' }),
    __param(0, Param('businessId')),
    __param(1, Param('staffId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], ServicesController.prototype, "listStaffServices", null);
__decorate([
    Get('staff/:staffId/assignable-services'),
    Biz('services.view'),
    __param(0, Param('businessId')),
    __param(1, Param('staffId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], ServicesController.prototype, "listAssignableServices", null);
__decorate([
    Get('services/:id/extra'),
    Biz('services.view'),
    __param(0, Param('businessId')),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], ServicesController.prototype, "getServiceExtra", null);
__decorate([
    Put('services/:id/extra'),
    Biz('services.edit'),
    ZodBody(serviceExtraBody),
    __param(0, Param('businessId')),
    __param(1, Param('id')),
    __param(2, Body(new Zod(serviceExtraBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object]),
    __metadata("design:returntype", void 0)
], ServicesController.prototype, "updateServiceExtra", null);
__decorate([
    Get('services/:id/receipt-name'),
    Biz('services.view'),
    __param(0, Param('businessId')),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], ServicesController.prototype, "getReceiptName", null);
__decorate([
    Get('services/:id/translations'),
    Biz('services.view'),
    __param(0, Param('businessId')),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], ServicesController.prototype, "getServiceTranslations", null);
__decorate([
    Get('packages'),
    Biz('resources.manage'),
    ZodOk(z.array(packageOut)),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], ServicesController.prototype, "listPackages", null);
__decorate([
    Get('packages/:id'),
    Biz('resources.manage'),
    ZodOk(packageOut),
    __param(0, Param('businessId')),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], ServicesController.prototype, "getPackage", null);
__decorate([
    Post('packages'),
    Biz('resources.manage'),
    ZodBody(packageCreateBody),
    ZodOk(packageOut),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(packageCreateBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], ServicesController.prototype, "createPackage", null);
__decorate([
    Patch('packages/:id'),
    Biz('resources.manage'),
    ZodBody(packageSaveBody),
    ZodOk(packageOut),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('id')),
    __param(3, Body(new Zod(packageSaveBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object]),
    __metadata("design:returntype", void 0)
], ServicesController.prototype, "savePackage", null);
__decorate([
    Get('packages/:id/future-bookings'),
    Biz('resources.manage'),
    __param(0, Param('businessId')),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], ServicesController.prototype, "futureBookings", null);
__decorate([
    Delete('packages/:id'),
    Biz('resources.manage'),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String]),
    __metadata("design:returntype", void 0)
], ServicesController.prototype, "deletePackage", null);
__decorate([
    Get('staff/:staffId/photo-slots'),
    Biz('services.view'),
    ZodOk(photoSlotsOut),
    __param(0, Param('businessId')),
    __param(1, Param('staffId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], ServicesController.prototype, "getPhotoSlots", null);
__decorate([
    Put('staff/:staffId/photo-profile'),
    Biz('services.edit'),
    ApiOperation({ summary: '«Сохранить» на экране фото работ (У3): снимки и привязки одной операцией' }),
    ZodBody(photoProfileBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('staffId')),
    __param(3, Body(new Zod(photoProfileBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object]),
    __metadata("design:returntype", void 0)
], ServicesController.prototype, "savePhotoProfile", null);
__decorate([
    Get('staff/:staffId/documents'),
    Biz('services.view'),
    ZodOk(z.array(staffDocumentOut)),
    __param(0, Param('businessId')),
    __param(1, Param('staffId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], ServicesController.prototype, "listStaffDocuments", null);
__decorate([
    Post('staff/:staffId/documents'),
    Biz('services.edit'),
    ZodBody(staffDocumentBody),
    ZodOk(staffDocumentOut),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('staffId')),
    __param(3, Body(new Zod(staffDocumentBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object]),
    __metadata("design:returntype", void 0)
], ServicesController.prototype, "addStaffDocument", null);
__decorate([
    Delete('services/documents/:id'),
    Biz('services.edit'),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String]),
    __metadata("design:returntype", void 0)
], ServicesController.prototype, "removeStaffDocument", null);
__decorate([
    Post('services/documents/restore'),
    Biz('services.edit'),
    ApiOperation({ summary: '«Отменить» после удаления документа (У26)' }),
    ZodBody(staffDocumentRestoreBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(staffDocumentRestoreBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], ServicesController.prototype, "restoreStaffDocument", null);
__decorate([
    Get('staff/:staffId/sterilization'),
    Biz('services.view'),
    __param(0, Param('businessId')),
    __param(1, Param('staffId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], ServicesController.prototype, "getSterilization", null);
__decorate([
    Put('staff/:staffId/materials-profile'),
    Biz('services.edit'),
    ApiOperation({ summary: '«Сохранить» на экране материалов (У3): метки и стерилизация одной операцией' }),
    ZodBody(materialsProfileBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('staffId')),
    __param(3, Body(new Zod(materialsProfileBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object]),
    __metadata("design:returntype", void 0)
], ServicesController.prototype, "saveMaterialsProfile", null);
__decorate([
    Get('services/:id/materials'),
    Biz('services.view'),
    ZodOk(serviceMaterialsOut),
    __param(0, Param('businessId')),
    __param(1, Param('id')),
    __param(2, Query('locationIds')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String]),
    __metadata("design:returntype", void 0)
], ServicesController.prototype, "getServiceMaterials", null);
__decorate([
    Get('staff-content-counts'),
    Biz('services.view'),
    ZodOk(staffContentCountsOut),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], ServicesController.prototype, "listStaffContentCounts", null);
ServicesController = __decorate([
    ApiTags('services'),
    Controller('v1/biz/:businessId'),
    __metadata("design:paramtypes", [ServicesService])
], ServicesController);
export { ServicesController };
//# sourceMappingURL=services.controller.js.map