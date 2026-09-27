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
import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../common/errors/api-error.js';
import { Biz, Ctx } from '../../common/http/guards.js';
import { Zod } from '../../common/http/validation.js';
import { PrismaService } from '../../common/prisma.service.js';
import { NotifyChannelsService } from './notify-channels.service.js';
import { NotifyClientPrefsService } from './notify-client-prefs.service.js';
import { NotifyInboxService } from './notify-inbox.service.js';
import { NotifyNewsService } from './notify-news.service.js';
import { NotifyStaffPrefsService } from './notify-staff-prefs.service.js';
import { NotifyTypesService } from './notify-types.service.js';
import { clientNotifyPatchBody, connectChannelBody, createNewsBody, inboxReadBody, sendTestChannelBody, staffNotifyPatchBody, updateTemplatesBody, updateTypeBody, } from './notify.schemas.js';
/** Уведомления (docs/backend/02-api.md §10, docs/backend/05) — /v1/biz/{b}/notify, /inbox, /news, вложенные /staff /clients */
let NotifyController = class NotifyController {
    constructor(prisma, types, news, staffPrefs, clientPrefs, inbox, channels) {
        this.prisma = prisma;
        this.types = types;
        this.news = news;
        this.staffPrefs = staffPrefs;
        this.clientPrefs = clientPrefs;
        this.inbox = inbox;
        this.channels = channels;
    }
    // ─────────── типы и шаблоны (F-05-001…023) ───────────
    listTypes(businessId) {
        return this.types.list(businessId);
    }
    updateType(ctx, businessId, body) {
        return this.types.updateType(ctx, businessId, body.kind, body.patch);
    }
    getTemplates(businessId, kind) {
        return this.types.getTemplates(businessId, kind);
    }
    updateTemplates(ctx, businessId, kind, body) {
        return this.types.updateTemplates(ctx, businessId, kind, body);
    }
    preview(businessId, kind, locale = 'ru') {
        return this.types.preview(businessId, kind, locale);
    }
    // ─────────── журнал отправок (F-05-107…109) — читает notify_outbox напрямую, это и есть журнал (05 §4) ───────────
    async log(businessId) {
        const rows = await this.prisma.notifyOutbox.findMany({ where: { businessId }, orderBy: { createdAt: 'desc' }, take: 200 });
        return rows.map((r) => ({ id: r.id, kind: r.kind, app: r.app, title: r.title, status: r.status, createdAt: r.createdAt.toISOString(), sentAt: r.sentAt?.toISOString(), lastError: r.lastError ?? undefined }));
    }
    // ─────────── подключение своего SMS/WhatsApp (В-08) ───────────
    getChannel(businessId) {
        return this.channels.get(businessId);
    }
    connectChannel(businessId, body) {
        return this.channels.connect(businessId, body);
    }
    async disconnectChannel(businessId) {
        await this.channels.disconnect(businessId);
        return { connected: false };
    }
    sendTestChannel(businessId, body) {
        return this.channels.sendTest(businessId, body.to);
    }
    // ─────────── новости подписчикам (F-00-114) ───────────
    createNews(ctx, businessId, body) {
        return this.news.create(ctx, businessId, body.text);
    }
    listNews(businessId) {
        return this.news.list(businessId);
    }
    newsQuota(businessId) {
        return this.news.quota(businessId);
    }
    newsSuggestions(businessId) {
        return this.news.suggestions(businessId);
    }
    // ─────────── что приходит сотруднику (F-05-055…060) — сам сотрудник или staff.manage ───────────
    async getStaffNotify(ctx, businessId, staffId) {
        await this.assertStaffAccess(ctx, businessId, staffId);
        return this.staffPrefs.get(staffId);
    }
    async updateStaffNotify(ctx, businessId, staffId, body) {
        await this.assertStaffAccess(ctx, businessId, staffId);
        return this.staffPrefs.update(staffId, body);
    }
    async assertStaffAccess(ctx, businessId, staffId) {
        if (ctx.member.staffId === staffId || ctx.member.permissions.has('staff.manage'))
            return;
        const row = await this.prisma.staff.findFirst({ where: { id: staffId, businessId }, select: { id: true } });
        if (!row)
            throw new ApiError('not_found', 'Staff not found');
        throw new ApiError('forbidden', 'Missing permission: staff.manage');
    }
    // ─────────── колокольчик кабинета (F-05-061) ───────────
    listInbox(businessId, preview) {
        return preview ? this.inbox.preview(businessId, Number(preview) || 5) : this.inbox.list(businessId);
    }
    unreadCount(businessId) {
        return this.inbox.countUnread(businessId).then((value) => ({ value }));
    }
    async markOneRead(businessId, id) {
        await this.inbox.markRead(businessId, [id]);
        return { ok: true };
    }
    async markManyRead(businessId, body) {
        await this.inbox.markRead(businessId, body.ids);
        return { ok: true };
    }
    async markAllRead(businessId) {
        await this.inbox.markAllRead(businessId);
        return { ok: true };
    }
    // ─────────── настройки уведомлений на клиента (F-04-087…090) ───────────
    getClientNotify(businessId, clientId) {
        return this.clientPrefs.get(businessId, clientId);
    }
    updateClientNotify(businessId, clientId, body) {
        return this.clientPrefs.update(businessId, clientId, body);
    }
};
__decorate([
    Get('notify/types'),
    Biz('notify.manage'),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], NotifyController.prototype, "listTypes", null);
__decorate([
    Put('notify/types'),
    Biz('notify.manage'),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(updateTypeBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], NotifyController.prototype, "updateType", null);
__decorate([
    Get('notify/templates/:kind'),
    Biz('notify.manage'),
    __param(0, Param('businessId')),
    __param(1, Param('kind')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], NotifyController.prototype, "getTemplates", null);
__decorate([
    Put('notify/templates/:kind'),
    Biz('notify.manage'),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('kind')),
    __param(3, Body(new Zod(updateTemplatesBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object]),
    __metadata("design:returntype", void 0)
], NotifyController.prototype, "updateTemplates", null);
__decorate([
    Post('notify/templates/:kind/preview'),
    Biz('notify.manage'),
    __param(0, Param('businessId')),
    __param(1, Param('kind')),
    __param(2, Query('locale')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object]),
    __metadata("design:returntype", void 0)
], NotifyController.prototype, "preview", null);
__decorate([
    Get('notify/log'),
    Biz('notify.log'),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], NotifyController.prototype, "log", null);
__decorate([
    Get('notify/channels'),
    Biz('notify.manage'),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], NotifyController.prototype, "getChannel", null);
__decorate([
    Put('notify/channels'),
    Biz('notify.manage'),
    __param(0, Param('businessId')),
    __param(1, Body(new Zod(connectChannelBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], NotifyController.prototype, "connectChannel", null);
__decorate([
    Post('notify/channels/disconnect'),
    Biz('notify.manage'),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], NotifyController.prototype, "disconnectChannel", null);
__decorate([
    Post('notify/channels/test'),
    Biz('notify.manage'),
    __param(0, Param('businessId')),
    __param(1, Body(new Zod(sendTestChannelBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], NotifyController.prototype, "sendTestChannel", null);
__decorate([
    Post('news'),
    Biz('notify.manage'),
    ApiOperation({ summary: 'Не больше 3 в неделю на бизнес (§5) — 409 weekly_push_limit сверх лимита' }),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Body(new Zod(createNewsBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], NotifyController.prototype, "createNews", null);
__decorate([
    Get('news'),
    Biz('notify.manage'),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], NotifyController.prototype, "listNews", null);
__decorate([
    Get('news/quota'),
    Biz('notify.manage'),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], NotifyController.prototype, "newsQuota", null);
__decorate([
    Get('news/suggestions'),
    Biz('notify.manage'),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], NotifyController.prototype, "newsSuggestions", null);
__decorate([
    Get('staff/:staffId/notify'),
    Biz(),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('staffId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String]),
    __metadata("design:returntype", Promise)
], NotifyController.prototype, "getStaffNotify", null);
__decorate([
    Put('staff/:staffId/notify'),
    Biz(),
    __param(0, Ctx()),
    __param(1, Param('businessId')),
    __param(2, Param('staffId')),
    __param(3, Body(new Zod(staffNotifyPatchBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object]),
    __metadata("design:returntype", Promise)
], NotifyController.prototype, "updateStaffNotify", null);
__decorate([
    Get('inbox'),
    Biz(),
    __param(0, Param('businessId')),
    __param(1, Query('preview')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], NotifyController.prototype, "listInbox", null);
__decorate([
    Get('inbox/unread-count'),
    Biz(),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], NotifyController.prototype, "unreadCount", null);
__decorate([
    Post('inbox/:id/read'),
    Biz(),
    __param(0, Param('businessId')),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], NotifyController.prototype, "markOneRead", null);
__decorate([
    Post('inbox/read'),
    Biz(),
    __param(0, Param('businessId')),
    __param(1, Body(new Zod(inboxReadBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], NotifyController.prototype, "markManyRead", null);
__decorate([
    Post('inbox/read-all'),
    Biz(),
    __param(0, Param('businessId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], NotifyController.prototype, "markAllRead", null);
__decorate([
    Get('clients/:clientId/notify'),
    Biz('clients.edit'),
    __param(0, Param('businessId')),
    __param(1, Param('clientId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], NotifyController.prototype, "getClientNotify", null);
__decorate([
    Put('clients/:clientId/notify'),
    Biz('clients.edit'),
    __param(0, Param('businessId')),
    __param(1, Param('clientId')),
    __param(2, Body(new Zod(clientNotifyPatchBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object]),
    __metadata("design:returntype", void 0)
], NotifyController.prototype, "updateClientNotify", null);
NotifyController = __decorate([
    ApiTags('notify'),
    Controller('v1/biz/:businessId'),
    __metadata("design:paramtypes", [PrismaService,
        NotifyTypesService,
        NotifyNewsService,
        NotifyStaffPrefsService,
        NotifyClientPrefsService,
        NotifyInboxService,
        NotifyChannelsService])
], NotifyController);
export { NotifyController };
//# sourceMappingURL=notify.controller.js.map