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
import { addCommentBody, addCustomFieldDefBody, addFileBody, adConsentBody, autoSaveChatLeadsBody, bulkCategoryBody, bulkIdsBody, categoryUpsertBody, changeLogEntryOut, clientListPageOut, clientRowOut, columnsPrefsOut, categoryOut, commentOut, countMatchingBody, createClientBody, exportClientsBody, exportLogEntryOut, fileOut, fineRightsBody, importRunOut, lostAfterDaysBody, mergeBody, runImportBody, searchBody, setColumnsBody, showFullNameBody, showLoyaltySearchBody, togglePinBody, updateClientBody, } from './clients.schemas.js';
import { ClientsService } from './clients.service.js';
import { ClientsExtrasService } from './clients-extras.service.js';
import { ClientsImportExportService } from './clients-import-export.service.js';
/** Клиенты / CRM — /v1/biz (docs/backend/01 §5, 02 §6, PLAN §6 №5) */
let ClientsController = class ClientsController {
    constructor(svc, extras, importExport) {
        this.svc = svc;
        this.extras = extras;
        this.importExport = importExport;
    }
    // ─────────── список / поиск (K8: фильтр и подсчёт — на сервере) ───────────
    search(ctx, businessId, body) {
        return this.svc.search(ctx, businessId, body);
    }
    listRows(ctx, businessId) {
        return this.svc.listRows(ctx, businessId);
    }
    countMatching(businessId, body) {
        return this.svc.countMatching(businessId, body).then((count) => ({ count }));
    }
    // ─────────── колонки (F-04-004/005, регистрируются раньше /clients/:id) ───────────
    getColumns(businessId, staffId) {
        return this.extras.getColumnsPrefs(businessId, staffId);
    }
    setColumns(businessId, body) {
        return this.extras.setVisibleColumns(businessId, body.staffId, body.visible);
    }
    togglePin(businessId, body) {
        return this.extras.togglePinnedColumn(businessId, body.staffId, body.id);
    }
    // ─────────── категории (F-04-109/110) ───────────
    listCategories(businessId) {
        return this.svc.listCategories(businessId);
    }
    listCategoryOptions(businessId) {
        return this.svc.listCategoryOptions(businessId);
    }
    createCategory(businessId, body) {
        return this.svc.createCategory(businessId, body.name, body.color);
    }
    updateCategory(businessId, name, body) {
        return this.svc.updateCategory(businessId, decodeURIComponent(name), body);
    }
    deleteCategory(businessId, name) {
        return this.svc.deleteCategory(businessId, decodeURIComponent(name));
    }
    changeLogAll(businessId) {
        return this.svc.changeLog(businessId);
    }
    getSettings(businessId) {
        return this.extras.getSettings(businessId);
    }
    listImportRuns(businessId) {
        return this.importExport.listImportRuns(businessId);
    }
    listExportLog(businessId) {
        return this.importExport.listExportLog(businessId);
    }
    // ─────────── карточка (F-04-044…074) ───────────
    createClient(ctx, businessId, body) {
        return this.svc.createClient(ctx, businessId, body);
    }
    getRow(ctx, businessId, id, locationIds, onlyStaffId) {
        return this.svc.getRow(ctx, businessId, id, locationIds ? locationIds.split(',') : undefined, onlyStaffId);
    }
    updateClient(ctx, req, businessId, id, body) {
        return this.svc.updateClient(ctx, businessId, id, body, ifMatch(req));
    }
    updateNote(businessId, id, body) {
        return this.svc.updateNote(businessId, id, body.note);
    }
    deleteClient(ctx, businessId, id) {
        return this.svc.deleteClient(ctx, businessId, id);
    }
    purge(ctx, businessId, id) {
        return this.svc.purgeClientData(ctx, businessId, id);
    }
    getCustomFieldValues(businessId, id) {
        return this.svc.getCustomFieldValues(businessId, id);
    }
    changeLogOne(businessId, id) {
        return this.svc.changeLog(businessId, id);
    }
    // ─────────── дубли: объединение и массовое удаление (F-04-135…137, F-04-042) ───────────
    merge(ctx, businessId, body) {
        return this.svc.mergeClients(ctx, businessId, body.keepId, body.duplicateId);
    }
    bulkDelete(ctx, businessId, body) {
        return this.svc.bulkDeleteClients(ctx, businessId, body.clientIds);
    }
    bulkCategory(businessId, body) {
        return this.svc.bulkAddCategory(businessId, body.clientIds, body.category, body.color);
    }
    // ─────────── комментарии (F-04-070) ───────────
    listComments(id) {
        return this.extras.listComments(id);
    }
    addComment(ctx, id, body) {
        return this.extras.addComment(ctx, id, body.text);
    }
    deleteComment(id, commentId) {
        return this.extras.deleteComment(id, commentId);
    }
    // ─────────── файлы (F-04-086) ───────────
    listFiles(id) {
        return this.extras.listFiles(id);
    }
    addFile(ctx, id, body) {
        return this.extras.addFile(ctx, id, body);
    }
    deleteFile(id, fileId) {
        return this.extras.deleteFile(id, fileId);
    }
    // ─────────── приложение клиента (F-04-072, F-00-130) ───────────
    async getAppActivity(businessId, id) {
        const phone = await this.svc.getPhone(businessId, id);
        if (!phone)
            return null;
        return this.extras.getAppActivity(phone);
    }
    getInvitedAt(businessId, id) {
        return this.extras.getInvitedAt(businessId, id);
    }
    invite(businessId, id) {
        return this.extras.inviteToApp(businessId, id);
    }
    // ─────────── согласие на рекламу (F-04-153/227) ───────────
    recordConsent(businessId, id, body) {
        return this.extras.recordAdConsent(businessId, id, body.given, body.method);
    }
    // ─────────── доп. поля (F-04-060, 139…145) ───────────
    listCustomFieldDefs(businessId) {
        return this.extras.listCustomFieldDefs(businessId);
    }
    addCustomFieldDef(businessId, body) {
        return this.extras.addCustomFieldDef(businessId, body);
    }
    deleteCustomFieldDef(businessId, fieldId) {
        return this.extras.deleteCustomFieldDef(businessId, fieldId);
    }
    // ─────────── настройки базы (arch-a1 №2) ───────────
    setShowFullName(businessId, body) {
        return this.extras.setShowFullNameFields(businessId, body.value);
    }
    setShowLoyaltySearch(businessId, body) {
        return this.extras.setShowLoyaltySearchInBookingWindow(businessId, body.value);
    }
    setAutoSaveChatLeads(businessId, body) {
        return this.extras.setAutoSaveChatLeads(businessId, body.value);
    }
    setLostAfterDays(businessId, body) {
        return this.extras.setLostAfterDays(businessId, body.days);
    }
    simulateChatLead(ctx, businessId) {
        return this.extras.simulateChatLead(ctx, businessId).then((c) => ({ id: c.id, businessId: c.businessId, name: c.name, phone: c.phone }));
    }
    // ─────────── тонкие права «Клиентская база» (F-04-194…204) ───────────
    getFineRights(staffId) {
        return this.extras.getFineRights(staffId);
    }
    setFineRights(businessId, staffId, body) {
        return this.extras.setFineRights(businessId, staffId, body);
    }
    // ─────────── импорт (F-04-126…129) ───────────
    runImport(ctx, businessId, body) {
        return this.importExport.runImport(ctx, businessId, body.authorName, body.mapping, body.rows, body.method).then((r) => ({
            results: r.results,
            summary: r.summary,
        }));
    }
    // ─────────── выгрузка (F-04-130, P4) ───────────
    exportClients(ctx, businessId, body) {
        return this.importExport.exportClients(ctx, businessId, body.ids, body.authorName, body.fileName);
    }
};
__decorate([
    Post('clients/search'),
    Biz('clients.view'),
    ZodBody(searchBody),
    ZodOk(clientListPageOut),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(searchBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "search", null);
__decorate([
    Get('clients'),
    Biz('clients.view'),
    ZodOk(z.array(clientRowOut)),
    ApiOperation({ summary: 'Все клиенты бизнеса строками (окно записи, импорт, объединение)' }),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "listRows", null);
__decorate([
    Post('clients/count-matching'),
    Biz('clients.view'),
    ZodBody(countMatchingBody),
    __param(0, Param('businessId')),
    __param(1, Body(new Zod(countMatchingBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "countMatching", null);
__decorate([
    Get('clients/columns'),
    Biz('clients.view'),
    ZodOk(columnsPrefsOut),
    __param(0, Param('businessId')),
    __param(1, Query('staffId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "getColumns", null);
__decorate([
    Put('clients/columns'),
    Biz('clients.view'),
    ZodBody(setColumnsBody),
    ZodOk(columnsPrefsOut),
    __param(0, Param('businessId')),
    __param(1, Body(new Zod(setColumnsBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "setColumns", null);
__decorate([
    Put('clients/columns/pin'),
    Biz('clients.view'),
    ZodBody(togglePinBody),
    ZodOk(columnsPrefsOut),
    __param(0, Param('businessId')),
    __param(1, Body(new Zod(togglePinBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "togglePin", null);
__decorate([
    Get('client-categories'),
    Biz('clients.view'),
    ZodOk(z.array(categoryOut)),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "listCategories", null);
__decorate([
    Get('client-categories/options'),
    Biz('clients.view'),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "listCategoryOptions", null);
__decorate([
    Post('client-categories'),
    Biz('settings.manage'),
    ZodBody(categoryUpsertBody),
    __param(0, Param('businessId')),
    __param(1, Body(new Zod(categoryUpsertBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "createCategory", null);
__decorate([
    Patch('client-categories/:name'),
    Biz('settings.manage'),
    ZodBody(categoryUpsertBody),
    __param(0, Param('businessId')),
    __param(1, Param('name')),
    __param(2, Body(new Zod(categoryUpsertBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "updateCategory", null);
__decorate([
    Delete('client-categories/:name'),
    Biz('settings.manage'),
    __param(0, Param('businessId')),
    __param(1, Param('name')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "deleteCategory", null);
__decorate([
    Get('clients/changelog'),
    Biz('clients.view'),
    ZodOk(z.array(changeLogEntryOut)),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "changeLogAll", null);
__decorate([
    Get('clients/settings'),
    Biz('clients.view'),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "getSettings", null);
__decorate([
    Get('clients/import-runs'),
    Biz('settings.manage'),
    ZodOk(z.array(importRunOut)),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "listImportRuns", null);
__decorate([
    Get('clients/export-log'),
    Biz('clients.export'),
    ZodOk(z.array(exportLogEntryOut)),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "listExportLog", null);
__decorate([
    Post('clients'),
    Biz('clients.edit'),
    ZodBody(createClientBody),
    ZodOk(clientRowOut),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(createClientBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "createClient", null);
__decorate([
    Get('clients/:id'),
    Biz('clients.view'),
    ZodOk(clientRowOut),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('id')),
    __param(3, Query('locationIds')),
    __param(4, Query('onlyStaffId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, String, String]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "getRow", null);
__decorate([
    Patch('clients/:id'),
    Biz('clients.edit'),
    ZodBody(updateClientBody),
    ZodOk(clientRowOut),
    __param(0, Ctx()),
    __param(1, Req()),
    __param(2, Param('businessId')),
    __param(3, Param('id')),
    __param(4, Body(new Zod(updateClientBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, String, String, Object]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "updateClient", null);
__decorate([
    Patch('clients/:id/note'),
    Biz('clients.edit'),
    ZodBody(z.object({ note: z.string().max(2000) })),
    __param(0, Param('businessId')),
    __param(1, Param('id')),
    __param(2, Body()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "updateNote", null);
__decorate([
    Delete('clients/:id'),
    Biz('clients.delete'),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "deleteClient", null);
__decorate([
    Post('clients/:id/anonymize'),
    Biz('clients.delete'),
    ApiOperation({ summary: 'P11: обезличивание по требованию клиента (GDPR) — навсегда, право как у удаления' }),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "purge", null);
__decorate([
    Get('clients/:id/fields'),
    Biz('clients.view'),
    __param(0, Param('businessId')),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "getCustomFieldValues", null);
__decorate([
    Get('clients/:id/changelog'),
    Biz('clients.view'),
    ZodOk(z.array(changeLogEntryOut)),
    __param(0, Param('businessId')),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "changeLogOne", null);
__decorate([
    Post('clients/merge'),
    Biz('clients.edit'),
    ZodBody(mergeBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(mergeBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "merge", null);
__decorate([
    Post('clients/bulk-delete'),
    Biz('clients.delete'),
    ZodBody(bulkIdsBody),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(bulkIdsBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "bulkDelete", null);
__decorate([
    Post('clients/bulk-category'),
    Biz('clients.edit'),
    ZodBody(bulkCategoryBody),
    __param(0, Param('businessId')),
    __param(1, Body(new Zod(bulkCategoryBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "bulkCategory", null);
__decorate([
    Get('clients/:id/comments'),
    Biz('clients.view'),
    ZodOk(z.array(commentOut)),
    __param(0, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "listComments", null);
__decorate([
    Post('clients/:id/comments'),
    Biz('clients.edit'),
    ZodBody(addCommentBody),
    ZodOk(commentOut),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body(new Zod(addCommentBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "addComment", null);
__decorate([
    Delete('clients/:id/comments/:commentId'),
    Biz('clients.edit'),
    __param(0, Param('id')),
    __param(1, Param('commentId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "deleteComment", null);
__decorate([
    Get('clients/:id/files'),
    Biz('clients.view'),
    ZodOk(z.array(fileOut)),
    __param(0, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "listFiles", null);
__decorate([
    Post('clients/:id/files'),
    Biz('clients.edit'),
    ZodBody(addFileBody),
    ZodOk(fileOut),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body(new Zod(addFileBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "addFile", null);
__decorate([
    Delete('clients/:id/files/:fileId'),
    Biz('clients.edit'),
    __param(0, Param('id')),
    __param(1, Param('fileId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "deleteFile", null);
__decorate([
    Get('clients/:id/app'),
    Biz('clients.view'),
    __param(0, Param('businessId')),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], ClientsController.prototype, "getAppActivity", null);
__decorate([
    Get('clients/:id/invited-at'),
    Biz('clients.view'),
    __param(0, Param('businessId')),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "getInvitedAt", null);
__decorate([
    Post('clients/:id/invite'),
    Biz('clients.view'),
    ApiOperation({ summary: 'Приглашение из CRM в приложение (F-00-130) — ссылка для WhatsApp мастера, само сообщение шлёт этап 10' }),
    __param(0, Param('businessId')),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "invite", null);
__decorate([
    Post('clients/:id/consent'),
    Biz('clients.edit'),
    ZodBody(adConsentBody),
    __param(0, Param('businessId')),
    __param(1, Param('id')),
    __param(2, Body(new Zod(adConsentBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "recordConsent", null);
__decorate([
    Get('client-fields'),
    Biz('clients.view'),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "listCustomFieldDefs", null);
__decorate([
    Post('client-fields'),
    Biz('settings.manage'),
    ZodBody(addCustomFieldDefBody),
    __param(0, Param('businessId')),
    __param(1, Body(new Zod(addCustomFieldDefBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "addCustomFieldDef", null);
__decorate([
    Delete('client-fields/:fieldId'),
    Biz('settings.manage'),
    __param(0, Param('businessId')),
    __param(1, Param('fieldId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "deleteCustomFieldDef", null);
__decorate([
    Put('clients/settings/show-full-name'),
    Biz('settings.manage'),
    ZodBody(showFullNameBody),
    __param(0, Param('businessId')),
    __param(1, Body(new Zod(showFullNameBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "setShowFullName", null);
__decorate([
    Put('clients/settings/show-loyalty-search'),
    Biz('settings.manage'),
    ZodBody(showLoyaltySearchBody),
    __param(0, Param('businessId')),
    __param(1, Body(new Zod(showLoyaltySearchBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "setShowLoyaltySearch", null);
__decorate([
    Put('clients/settings/auto-save-chat-leads'),
    Biz('settings.manage'),
    ZodBody(autoSaveChatLeadsBody),
    __param(0, Param('businessId')),
    __param(1, Body(new Zod(autoSaveChatLeadsBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "setAutoSaveChatLeads", null);
__decorate([
    Put('clients/settings/lost-after-days'),
    Biz('settings.manage'),
    ZodBody(lostAfterDaysBody),
    __param(0, Param('businessId')),
    __param(1, Body(new Zod(lostAfterDaysBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "setLostAfterDays", null);
__decorate([
    Post('clients/simulate-chat-lead'),
    Biz('clients.edit'),
    ApiOperation({ summary: 'Демонстрационная кнопка F-04-016/187: что сделает хук чата при автосохранении лидов' }),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "simulateChatLead", null);
__decorate([
    Get('staff/:staffId/client-fine-rights'),
    Biz('staff.manage'),
    __param(0, Param('staffId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "getFineRights", null);
__decorate([
    Put('staff/:staffId/client-fine-rights'),
    Biz('staff.manage'),
    ZodBody(fineRightsBody),
    __param(0, Param('businessId')),
    __param(1, Param('staffId')),
    __param(2, Body(new Zod(fineRightsBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "setFineRights", null);
__decorate([
    Post('clients/import'),
    Biz('settings.manage'),
    ZodBody(runImportBody),
    ApiOperation({ summary: 'Импорт из Excel/CSV — до 500 строк, разбор текста делает экран (parseImportText)' }),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(runImportBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "runImport", null);
__decorate([
    Post('clients/export'),
    Biz('clients.export'),
    ZodBody(exportClientsBody),
    ZodOk(z.array(clientRowOut)),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(exportClientsBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "exportClients", null);
ClientsController = __decorate([
    ApiTags('clients'),
    Controller('v1/biz/:businessId'),
    __metadata("design:paramtypes", [ClientsService,
        ClientsExtrasService,
        ClientsImportExportService])
], ClientsController);
export { ClientsController };
//# sourceMappingURL=clients.controller.js.map