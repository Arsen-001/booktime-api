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
import { Biz, Ctx } from '../../common/http/guards.js';
import { ZodBody } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { billingAddressBody, brandBody, categoryBody, changeLogQuery, contactsBody, galleryBody, helpBody, legalBody, onboardingBody, prefsBody, sphereBody, systemBody, } from './settings.schemas.js';
import { SettingsService } from './settings.service.js';
/** Настройки компании — /v1/biz/{b}/company/…, обращения, личные настройки (docs/backend/02 §18) */
let SettingsController = class SettingsController {
    constructor(s) {
        this.s = s;
    }
    legal(b) {
        return this.s.legal(b);
    }
    saveLegal(ctx, b, body) {
        return this.s.saveLegal(ctx, b, body);
    }
    billingAddress(ctx, b, body) {
        return this.s.saveBillingAddress(ctx, b, body.billingAddress);
    }
    system(b) {
        return this.s.system(b);
    }
    saveSystem(ctx, b, body) {
        return this.s.saveSystem(ctx, b, body);
    }
    brand(b) {
        return this.s.brand(b);
    }
    saveBrand(ctx, b, body) {
        return this.s.saveBrand(ctx, b, body);
    }
    contacts(b) {
        return this.s.contacts(b);
    }
    saveContacts(ctx, b, body) {
        return this.s.saveContacts(ctx, b, body);
    }
    gallery(b) {
        return this.s.gallery(b);
    }
    saveGallery(ctx, b, body) {
        return this.s.saveGallery(ctx, b, body.photos);
    }
    profile(b) {
        return this.s.companyProfile(b);
    }
    changeLog(b, q) {
        return this.s.changeLog(b, q.section);
    }
    categories(b) {
        return this.s.categories(b);
    }
    addCategory(ctx, b, body) {
        return this.s.saveCategory(ctx, b, undefined, body);
    }
    editCategory(ctx, b, id, body) {
        return this.s.saveCategory(ctx, b, id, body);
    }
    async deleteCategory(ctx, b, id) {
        await this.s.deleteCategory(ctx, b, id);
    }
    onboarding(b) {
        return this.s.onboarding(b);
    }
    saveOnboarding(ctx, b, body) {
        return this.s.saveOnboarding(ctx, b, body);
    }
    checklist(b) {
        return this.s.checklist(b);
    }
    help(b) {
        return this.s.requests(b, 'help');
    }
    createHelp(ctx, b, body) {
        return this.s.createRequest(ctx, b, 'help', body);
    }
    appRequests(b) {
        return this.s.requests(b, 'mobileApp');
    }
    createAppRequest(ctx, b) {
        return this.s.createRequest(ctx, b, 'mobileApp', {});
    }
    spheres(b) {
        return this.s.sphereRequests(b);
    }
    sphere(b, id) {
        return this.s.sphereRequest(b, id);
    }
    createSphere(ctx, b, body) {
        return this.s.createSphereRequest(ctx, b, body);
    }
    prefs(ctx) {
        return this.s.prefs(ctx.member.staffId);
    }
    savePrefs(ctx, body) {
        return this.s.savePrefs(ctx.member.staffId, body);
    }
};
__decorate([
    Get('company/legal'),
    Biz(),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], SettingsController.prototype, "legal", null);
__decorate([
    Put('company/legal'),
    Biz('settings.manage'),
    ApiOperation({ summary: 'Реквизиты (F-15-112): ՀՎՀՀ — 8 цифр (bad_tax_id)' }),
    ZodBody(legalBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(legalBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], SettingsController.prototype, "saveLegal", null);
__decorate([
    Put('company/billing-address'),
    Biz('billing.manage'),
    ZodBody(billingAddressBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(billingAddressBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], SettingsController.prototype, "billingAddress", null);
__decorate([
    Get('company/system'),
    Biz(),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], SettingsController.prototype, "system", null);
__decorate([
    Put('company/system'),
    Biz('settings.manage'),
    ZodBody(systemBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(systemBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], SettingsController.prototype, "saveSystem", null);
__decorate([
    Get('company/brand'),
    Biz(),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], SettingsController.prototype, "brand", null);
__decorate([
    Put('company/brand'),
    Biz('settings.manage'),
    ZodBody(brandBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(brandBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], SettingsController.prototype, "saveBrand", null);
__decorate([
    Get('company/contacts'),
    Biz(),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], SettingsController.prototype, "contacts", null);
__decorate([
    Put('company/contacts'),
    Biz('settings.manage'),
    ApiOperation({ summary: 'Контакты (F-15-104…110): Telegram — https://t.me/username (bad_telegram_url)' }),
    ZodBody(contactsBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(contactsBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], SettingsController.prototype, "saveContacts", null);
__decorate([
    Get('company/gallery'),
    Biz(),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], SettingsController.prototype, "gallery", null);
__decorate([
    Put('company/gallery'),
    Biz('settings.manage'),
    ZodBody(galleryBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(galleryBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], SettingsController.prototype, "saveGallery", null);
__decorate([
    Get('company/profile'),
    Biz(),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], SettingsController.prototype, "profile", null);
__decorate([
    Get('company/change-log'),
    Biz('settings.manage'),
    __param(0, Param('businessId')),
    __param(1, Query(new Zod(changeLogQuery))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], SettingsController.prototype, "changeLog", null);
__decorate([
    Get('record-categories'),
    Biz(),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], SettingsController.prototype, "categories", null);
__decorate([
    Post('record-categories'),
    Biz('settings.manage'),
    ZodBody(categoryBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(categoryBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], SettingsController.prototype, "addCategory", null);
__decorate([
    Patch('record-categories/:id'),
    Biz('settings.manage'),
    ZodBody(categoryBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('id')),
    __param(3, Body(new Zod(categoryBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object]),
    __metadata("design:returntype", void 0)
], SettingsController.prototype, "editCategory", null);
__decorate([
    Delete('record-categories/:id'),
    Biz('settings.manage'),
    HttpCode(204),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String]),
    __metadata("design:returntype", Promise)
], SettingsController.prototype, "deleteCategory", null);
__decorate([
    Get('onboarding'),
    Biz(),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], SettingsController.prototype, "onboarding", null);
__decorate([
    Put('onboarding'),
    Biz(),
    ApiOperation({ summary: 'Цели анкеты (F-15-007), тур просмотрен (F-15-021)' }),
    ZodBody(onboardingBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(onboardingBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], SettingsController.prototype, "saveOnboarding", null);
__decorate([
    Get('onboarding/checklist'),
    Biz(),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], SettingsController.prototype, "checklist", null);
__decorate([
    Get('help-requests'),
    Biz(),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], SettingsController.prototype, "help", null);
__decorate([
    Post('help-requests'),
    Biz(),
    ZodBody(helpBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(helpBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], SettingsController.prototype, "createHelp", null);
__decorate([
    Get('mobile-app-requests'),
    Biz(),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], SettingsController.prototype, "appRequests", null);
__decorate([
    Post('mobile-app-requests'),
    Biz('settings.manage'),
    ApiOperation({ summary: '«Хочу своё приложение» (В-29: позже, платно) — только заявка' }),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], SettingsController.prototype, "createAppRequest", null);
__decorate([
    Get('sphere-requests'),
    Biz(),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], SettingsController.prototype, "spheres", null);
__decorate([
    Get('sphere-requests/:id'),
    Biz(),
    __param(0, Param('businessId')),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], SettingsController.prototype, "sphere", null);
__decorate([
    Post('sphere-requests'),
    Biz(),
    ZodBody(sphereBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(sphereBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], SettingsController.prototype, "createSphere", null);
__decorate([
    Get('me/prefs'),
    Biz(),
    __param(0, Ctx()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], SettingsController.prototype, "prefs", null);
__decorate([
    Put('me/prefs'),
    Biz(),
    ApiOperation({ summary: 'Личные: уведомления (F-15-150), стартовая страница (F-15-157)' }),
    ZodBody(prefsBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(prefsBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], SettingsController.prototype, "savePrefs", null);
SettingsController = __decorate([
    ApiTags('settings'),
    Controller('v1/biz/:businessId'),
    __metadata("design:paramtypes", [SettingsService])
], SettingsController);
export { SettingsController };
//# sourceMappingURL=settings.controller.js.map