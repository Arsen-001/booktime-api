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
import { ZodBody, ZodOk } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { LoyaltyCatalogService } from './loyalty-catalog.service.js';
import { LoyaltyInstancesService } from './loyalty-instances.service.js';
import { LoyaltyProgramService } from './loyalty-program.service.js';
import { requireAny } from './loyalty.owner.js';
import { accountOpBody, accountTypeBody, accountTypePatchBody, applyBody, archiveBody, bonusBody, cardTypeBody, cardTypePatchBody, certTypeBody, certTypePatchBody, clientVisibilityBody, confirmCertificateBody, confirmMembershipBody, freezeMembershipBody, issueCardBody, loyaltyProgramBody, membershipTypeBody, membershipTypePatchBody, openAccountBody, promotionBody, promotionPatchBody, referralBody, sellCertificateBody, sellMembershipBody, } from './loyalty.schemas.js';
/**
 * Лояльность — /v1/biz/:businessId/loyalty (docs/backend/02-api.md §11, PLAN §6 №11). Владелец данных — сеть
 * (F-06-002/В-09): каждый метод резолвит ownerId сам (loyalty.owner.ts), путь остаётся /v1/biz как у всех
 * разделов (PLAN §2 не просит отдельный /v1/net для этого раздела).
 */
let LoyaltyController = class LoyaltyController {
    constructor(program, catalog, instances) {
        this.program = program;
        this.catalog = catalog;
        this.instances = instances;
    }
    // ─────────── Программа локации (F-04-114…122) ───────────
    getProgram(businessId) {
        return this.program.get(businessId);
    }
    saveProgram(ctx, businessId, body) {
        return this.program.save(ctx, businessId, body);
    }
    recalculate(ctx, businessId) {
        return this.program.recalcAll(ctx, businessId, 'manual').then((recalculated) => ({ recalculated }));
    }
    recalculateOne(ctx, businessId, clientId) {
        return this.program.recalcOne(ctx, businessId, clientId, 'manual');
    }
    // ─────────── Видимость клиенту (В-06) ───────────
    getClientVisibility(businessId) {
        return this.program.getShowToClient(businessId).then((showToClient) => ({ showToClient }));
    }
    setClientVisibility(ctx, businessId, body) {
        return this.program.setShowToClient(ctx, businessId, body.showToClient);
    }
    // ─────────── Типы карт (F-06-020…030) ───────────
    listCardTypes(ctx) {
        return this.catalog.listCardTypes(ctx);
    }
    createCardType(ctx, body) {
        return this.catalog.createCardType(ctx, body);
    }
    updateCardType(ctx, id, body) {
        return this.catalog.updateCardType(ctx, id, body);
    }
    archiveCardType(ctx, id, body) {
        return this.catalog.archiveCardType(ctx, id, body.archived);
    }
    async deleteCardType(ctx, id) {
        await this.catalog.deleteCardType(ctx, id);
    }
    // ─────────── Карты клиентов (F-06-051…060) ───────────
    listClientCards(ctx, clientId) {
        return this.instances.listClientCards(ctx, clientId);
    }
    issueCard(ctx, clientId, body) {
        return this.instances.issueCard(ctx, clientId, body.cardTypeId, body.number);
    }
    adjustBonus(ctx, cardId, body) {
        requireAny(ctx, ['loyalty.manage', 'journal.edit']);
        return this.instances.adjustBonus(ctx, cardId, body.kind, body.amount, body.note);
    }
    // ─────────── Акции (F-06-031…050) ───────────
    listPromotions(ctx) {
        return this.catalog.listPromotions(ctx);
    }
    createPromotion(ctx, body) {
        return this.catalog.createPromotion(ctx, body);
    }
    updatePromotion(ctx, id, body) {
        return this.catalog.updatePromotion(ctx, id, body);
    }
    async deletePromotion(ctx, id) {
        await this.catalog.deletePromotion(ctx, id);
    }
    // ─────────── Применение при оплате визита (F-06-061…075) ───────────
    applyToBooking(ctx, businessId, bookingId, body) {
        return this.instances.applyToBooking(ctx, businessId, bookingId, body.lines);
    }
    // ─────────── Транзакции (F-06-076/077) ───────────
    listTx(ctx, clientId) {
        return this.instances.listTx(ctx, clientId);
    }
    // ─────────── Рефералы (F-06-081…085) ───────────
    getReferral(ctx) {
        return this.catalog.getReferral(ctx);
    }
    setReferral(ctx, body) {
        return this.catalog.setReferral(ctx, body);
    }
    // ─────────── Типы сертификатов (F-06-086…104) ───────────
    listCertTypes(ctx) {
        return this.catalog.listCertTypes(ctx);
    }
    createCertType(ctx, body) {
        return this.catalog.createCertType(ctx, body);
    }
    updateCertType(ctx, id, body) {
        return this.catalog.updateCertType(ctx, id, body);
    }
    archiveCertType(ctx, id, body) {
        return this.catalog.archiveCertType(ctx, id, body.archived);
    }
    async deleteCertType(ctx, id) {
        await this.catalog.deleteCertType(ctx, id);
    }
    // ─────────── Сертификаты — продажа/подтверждение/возврат (F-06-086…104, В-17) ───────────
    sellCertificate(ctx, body) {
        requireAny(ctx, ['loyalty.manage', 'finance.edit']);
        return this.instances.sellCertificate(ctx, body.typeId, body);
    }
    listCertificateRequests(ctx) {
        requireAny(ctx, ['loyalty.manage', 'finance.edit']);
        return this.instances.listPendingCertificates(ctx);
    }
    confirmCertificate(ctx, id, body) {
        requireAny(ctx, ['loyalty.manage', 'finance.edit']);
        return this.instances.confirmCertificate(ctx, id, body.clientId);
    }
    rejectCertificate(ctx, id) {
        requireAny(ctx, ['loyalty.manage', 'finance.edit']);
        return this.instances.rejectCertificate(ctx, id);
    }
    refundCertificate(ctx, id) {
        requireAny(ctx, ['loyalty.manage', 'finance.edit']);
        return this.instances.refundCertificate(ctx, id);
    }
    // ─────────── Типы абонементов (F-06-105…134) ───────────
    listMembershipTypes(ctx) {
        return this.catalog.listMembershipTypes(ctx);
    }
    createMembershipType(ctx, body) {
        return this.catalog.createMembershipType(ctx, body);
    }
    updateMembershipType(ctx, id, body) {
        return this.catalog.updateMembershipType(ctx, id, body);
    }
    archiveMembershipType(ctx, id, body) {
        return this.catalog.archiveMembershipType(ctx, id, body.archived);
    }
    async deleteMembershipType(ctx, id) {
        await this.catalog.deleteMembershipType(ctx, id);
    }
    // ─────────── Абонементы — продажа/заморозка/возврат (F-06-105…134, В-17) ───────────
    listMembershipRequests(ctx) {
        requireAny(ctx, ['loyalty.manage', 'finance.edit']);
        return this.instances.listPendingMemberships(ctx);
    }
    sellMembership(ctx, body) {
        requireAny(ctx, ['loyalty.manage', 'finance.edit']);
        return this.instances.sellMembership(ctx, body.typeId, body);
    }
    confirmMembership(ctx, id, body) {
        requireAny(ctx, ['loyalty.manage', 'finance.edit']);
        return this.instances.confirmMembership(ctx, id, body.clientId);
    }
    rejectMembership(ctx, id) {
        requireAny(ctx, ['loyalty.manage', 'finance.edit']);
        return this.instances.rejectMembership(ctx, id);
    }
    freezeMembership(ctx, id, body) {
        requireAny(ctx, ['loyalty.manage', 'finance.edit']);
        return this.instances.freezeMembership(ctx, id, true, body.toAt);
    }
    unfreezeMembership(ctx, id) {
        requireAny(ctx, ['loyalty.manage', 'finance.edit']);
        return this.instances.freezeMembership(ctx, id, false);
    }
    refundMembership(ctx, id) {
        requireAny(ctx, ['loyalty.manage', 'finance.edit']);
        return this.instances.refundMembership(ctx, id);
    }
    // ─────────── Типы счетов клиентов и счета (F-06-135…146) ───────────
    listAccountTypes(ctx) {
        return this.catalog.listAccountTypes(ctx);
    }
    createAccountType(ctx, body) {
        return this.catalog.createAccountType(ctx, body);
    }
    updateAccountType(ctx, id, body) {
        return this.catalog.updateAccountType(ctx, id, body);
    }
    archiveAccountType(ctx, id, body) {
        return this.catalog.archiveAccountType(ctx, id, body.archived);
    }
    async deleteAccountType(ctx, id) {
        await this.catalog.deleteAccountType(ctx, id);
    }
    listClientAccounts(ctx, clientId) {
        return this.instances.listClientAccounts(ctx, clientId);
    }
    openAccount(ctx, clientId, body) {
        return this.instances.openAccount(ctx, body.typeId, clientId);
    }
    topupAccount(ctx, id, body) {
        return this.instances.accountOp(ctx, id, 'topup', body.amount, body.note, body.bookingId);
    }
    refundAccount(ctx, id, body) {
        return this.instances.accountOp(ctx, id, 'refund', body.amount, body.note, body.bookingId);
    }
};
__decorate([
    Get('program'),
    Biz('loyalty.rules'),
    ZodOk(loyaltyProgramBody),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], LoyaltyController.prototype, "getProgram", null);
__decorate([
    Put('program'),
    Biz('loyalty.rules'),
    ApiOperation({ summary: 'Сохранить программу и пересчитать всех клиентов (F-04-121)' }),
    ZodBody(loyaltyProgramBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(loyaltyProgramBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], LoyaltyController.prototype, "saveProgram", null);
__decorate([
    Post('program/recalculate'),
    HttpCode(200),
    Biz('loyalty.rules'),
    ApiOperation({ summary: 'Ручной пересчёт правил (F-04-073)' }),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], LoyaltyController.prototype, "recalculate", null);
__decorate([
    Post('clients/:clientId/program/recalculate'),
    HttpCode(200),
    Biz('loyalty.rules'),
    ApiOperation({ summary: 'Пересчёт одного клиента (F-04-073)' }),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('clientId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String]),
    __metadata("design:returntype", void 0)
], LoyaltyController.prototype, "recalculateOne", null);
__decorate([
    Get('client-visibility'),
    Biz('loyalty.manage'),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], LoyaltyController.prototype, "getClientVisibility", null);
__decorate([
    Put('client-visibility'),
    Biz('loyalty.manage'),
    ZodBody(clientVisibilityBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(clientVisibilityBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], LoyaltyController.prototype, "setClientVisibility", null);
__decorate([
    Get('card-types'),
    Biz('loyalty.manage'),
    __param(0, Ctx()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], LoyaltyController.prototype, "listCardTypes", null);
__decorate([
    Post('card-types'),
    Biz('loyalty.manage'),
    ZodBody(cardTypeBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(cardTypeBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], LoyaltyController.prototype, "createCardType", null);
__decorate([
    Patch('card-types/:id'),
    Biz('loyalty.manage'),
    ZodBody(cardTypePatchBody),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body(new Zod(cardTypePatchBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], LoyaltyController.prototype, "updateCardType", null);
__decorate([
    Put('card-types/:id/archive'),
    Biz('loyalty.manage'),
    ApiOperation({ summary: 'В-40: «В архив» вместо удаления' }),
    ZodBody(archiveBody),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body(new Zod(archiveBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], LoyaltyController.prototype, "archiveCardType", null);
__decorate([
    Delete('card-types/:id'),
    Biz('loyalty.manage'),
    ApiOperation({ summary: 'В-40: отказывает (has_issued_cards), если есть выданные карты' }),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], LoyaltyController.prototype, "deleteCardType", null);
__decorate([
    Get('clients/:clientId/cards'),
    Biz('loyalty.manage'),
    __param(0, Ctx()),
    __param(1, Param('clientId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], LoyaltyController.prototype, "listClientCards", null);
__decorate([
    Post('clients/:clientId/cards'),
    Biz('loyalty.manage'),
    ApiOperation({ summary: 'Выдать карту (F-14-102) — номер генерируется, если не введён' }),
    ZodBody(issueCardBody),
    __param(0, Ctx()),
    __param(1, Param('clientId')),
    __param(2, Body(new Zod(issueCardBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], LoyaltyController.prototype, "issueCard", null);
__decorate([
    Post('cards/:cardId/bonuses'),
    Biz(),
    ApiOperation({ summary: 'Ручное начисление/списание бонусов — loyalty.manage либо в окне записи journal.edit' }),
    ZodBody(bonusBody),
    __param(0, Ctx()),
    __param(1, Param('cardId')),
    __param(2, Body(new Zod(bonusBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], LoyaltyController.prototype, "adjustBonus", null);
__decorate([
    Get('promotions'),
    Biz('loyalty.manage'),
    __param(0, Ctx()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], LoyaltyController.prototype, "listPromotions", null);
__decorate([
    Post('promotions'),
    Biz('loyalty.manage'),
    ApiOperation({ summary: 'Мастер из 5 шагов фронта — одна форма, один POST' }),
    ZodBody(promotionBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(promotionBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], LoyaltyController.prototype, "createPromotion", null);
__decorate([
    Patch('promotions/:id'),
    Biz('loyalty.manage'),
    ZodBody(promotionPatchBody),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body(new Zod(promotionPatchBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], LoyaltyController.prototype, "updatePromotion", null);
__decorate([
    Delete('promotions/:id'),
    Biz('loyalty.manage'),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], LoyaltyController.prototype, "deletePromotion", null);
__decorate([
    Post('bookings/:bookingId/apply'),
    Biz('finance.edit'),
    ApiOperation({ summary: 'Строки оплаты «лояльностью» — списывает бонусы/сертификат/абонемент/счёт' }),
    ZodBody(applyBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('bookingId')),
    __param(3, Body(new Zod(applyBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object]),
    __metadata("design:returntype", void 0)
], LoyaltyController.prototype, "applyToBooking", null);
__decorate([
    Get('transactions'),
    Biz('loyalty.manage'),
    __param(0, Ctx()),
    __param(1, Query('clientId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], LoyaltyController.prototype, "listTx", null);
__decorate([
    Get('referral'),
    Biz('loyalty.manage'),
    __param(0, Ctx()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], LoyaltyController.prototype, "getReferral", null);
__decorate([
    Put('referral'),
    Biz('loyalty.manage'),
    ZodBody(referralBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(referralBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], LoyaltyController.prototype, "setReferral", null);
__decorate([
    Get('certificate-types'),
    Biz('loyalty.manage'),
    __param(0, Ctx()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], LoyaltyController.prototype, "listCertTypes", null);
__decorate([
    Post('certificate-types'),
    Biz('loyalty.manage'),
    ZodBody(certTypeBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(certTypeBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], LoyaltyController.prototype, "createCertType", null);
__decorate([
    Patch('certificate-types/:id'),
    Biz('loyalty.manage'),
    ZodBody(certTypePatchBody),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body(new Zod(certTypePatchBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], LoyaltyController.prototype, "updateCertType", null);
__decorate([
    Put('certificate-types/:id/archive'),
    Biz('loyalty.manage'),
    ZodBody(archiveBody),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body(new Zod(archiveBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], LoyaltyController.prototype, "archiveCertType", null);
__decorate([
    Delete('certificate-types/:id'),
    Biz('loyalty.manage'),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], LoyaltyController.prototype, "deleteCertType", null);
__decorate([
    Post('certificates'),
    Biz(),
    ZodBody(sellCertificateBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(sellCertificateBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], LoyaltyController.prototype, "sellCertificate", null);
__decorate([
    Get('certificate-requests'),
    Biz(),
    ApiOperation({ summary: 'В-17: заявки клиентов «ждут подтверждения»' }),
    __param(0, Ctx()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], LoyaltyController.prototype, "listCertificateRequests", null);
__decorate([
    Post('certificates/:id/confirm'),
    HttpCode(200),
    Biz(),
    ApiOperation({ summary: 'В-17: «Подтвердить оплату» заявки из приложения' }),
    ZodBody(confirmCertificateBody),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body(new Zod(confirmCertificateBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], LoyaltyController.prototype, "confirmCertificate", null);
__decorate([
    Post('certificates/:id/reject'),
    HttpCode(200),
    Biz(),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], LoyaltyController.prototype, "rejectCertificate", null);
__decorate([
    Post('certificates/:id/refund'),
    HttpCode(200),
    Biz(),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], LoyaltyController.prototype, "refundCertificate", null);
__decorate([
    Get('membership-types'),
    Biz('loyalty.manage'),
    __param(0, Ctx()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], LoyaltyController.prototype, "listMembershipTypes", null);
__decorate([
    Post('membership-types'),
    Biz('loyalty.manage'),
    ZodBody(membershipTypeBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(membershipTypeBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], LoyaltyController.prototype, "createMembershipType", null);
__decorate([
    Patch('membership-types/:id'),
    Biz('loyalty.manage'),
    ZodBody(membershipTypePatchBody),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body(new Zod(membershipTypePatchBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], LoyaltyController.prototype, "updateMembershipType", null);
__decorate([
    Put('membership-types/:id/archive'),
    Biz('loyalty.manage'),
    ZodBody(archiveBody),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body(new Zod(archiveBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], LoyaltyController.prototype, "archiveMembershipType", null);
__decorate([
    Delete('membership-types/:id'),
    Biz('loyalty.manage'),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], LoyaltyController.prototype, "deleteMembershipType", null);
__decorate([
    Get('membership-requests'),
    Biz(),
    ApiOperation({ summary: 'В-17: заявки клиентов «ждут подтверждения»' }),
    __param(0, Ctx()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], LoyaltyController.prototype, "listMembershipRequests", null);
__decorate([
    Post('memberships'),
    Biz(),
    ZodBody(sellMembershipBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(sellMembershipBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], LoyaltyController.prototype, "sellMembership", null);
__decorate([
    Post('memberships/:id/confirm'),
    HttpCode(200),
    Biz(),
    ZodBody(confirmMembershipBody),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body(new Zod(confirmMembershipBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], LoyaltyController.prototype, "confirmMembership", null);
__decorate([
    Post('memberships/:id/reject'),
    HttpCode(200),
    Biz(),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], LoyaltyController.prototype, "rejectMembership", null);
__decorate([
    Post('memberships/:id/freeze'),
    HttpCode(200),
    Biz(),
    ZodBody(freezeMembershipBody),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body(new Zod(freezeMembershipBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], LoyaltyController.prototype, "freezeMembership", null);
__decorate([
    Post('memberships/:id/unfreeze'),
    HttpCode(200),
    Biz(),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], LoyaltyController.prototype, "unfreezeMembership", null);
__decorate([
    Post('memberships/:id/refund'),
    HttpCode(200),
    Biz(),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], LoyaltyController.prototype, "refundMembership", null);
__decorate([
    Get('account-types'),
    Biz('finance.edit'),
    __param(0, Ctx()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], LoyaltyController.prototype, "listAccountTypes", null);
__decorate([
    Post('account-types'),
    Biz('finance.edit'),
    ZodBody(accountTypeBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(accountTypeBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], LoyaltyController.prototype, "createAccountType", null);
__decorate([
    Patch('account-types/:id'),
    Biz('finance.edit'),
    ZodBody(accountTypePatchBody),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body(new Zod(accountTypePatchBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], LoyaltyController.prototype, "updateAccountType", null);
__decorate([
    Put('account-types/:id/archive'),
    Biz('finance.edit'),
    ZodBody(archiveBody),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body(new Zod(archiveBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], LoyaltyController.prototype, "archiveAccountType", null);
__decorate([
    Delete('account-types/:id'),
    Biz('finance.edit'),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], LoyaltyController.prototype, "deleteAccountType", null);
__decorate([
    Get('clients/:clientId/accounts'),
    Biz('finance.edit'),
    __param(0, Ctx()),
    __param(1, Param('clientId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], LoyaltyController.prototype, "listClientAccounts", null);
__decorate([
    Post('clients/:clientId/accounts'),
    Biz('finance.edit'),
    __param(0, Ctx()),
    __param(1, Param('clientId')),
    __param(2, Body(new Zod(openAccountBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], LoyaltyController.prototype, "openAccount", null);
__decorate([
    Post('accounts/:id/topup'),
    HttpCode(200),
    Biz('finance.edit'),
    ZodBody(accountOpBody),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body(new Zod(accountOpBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], LoyaltyController.prototype, "topupAccount", null);
__decorate([
    Post('accounts/:id/refund'),
    HttpCode(200),
    Biz('finance.edit'),
    ZodBody(accountOpBody),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body(new Zod(accountOpBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], LoyaltyController.prototype, "refundAccount", null);
LoyaltyController = __decorate([
    ApiTags('loyalty'),
    Controller('v1/biz/:businessId/loyalty'),
    __metadata("design:paramtypes", [LoyaltyProgramService,
        LoyaltyCatalogService,
        LoyaltyInstancesService])
], LoyaltyController);
export { LoyaltyController };
//# sourceMappingURL=loyalty.controller.js.map