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
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../common/errors/api-error.js';
import { Authed, Biz, Ctx } from '../../common/http/guards.js';
import { ZodBody } from '../../common/http/openapi.js';
import { MEMBERSHIP_RESOLVER } from '../../common/http/resolvers.js';
import { Zod } from '../../common/http/validation.js';
import { Idempotent } from '../../common/idempotency/idempotency.js';
import { isLocalDate } from '../../common/time/time.js';
import { JournalAccess, csv } from './access.js';
import { BookingsService, canJournal, clientActor, staffActor } from './bookings.service.js';
import { GroupEventsService } from './group-events.service.js';
import { JournalService } from './journal.service.js';
import { attachLinkedBody, authorBody, categoryBody, checkBody, checkLinkedBody, claimMintBody, clientRescheduleBody, configPatchBody, dataOpBody, groupEventBody, groupEventPatchBody, importBody, medicalCardBody, medicalVisitBody, packageBody, packageTransferBody, planBody, recurrenceBody, seriesBody, seriesPreviewBody, templateBody, visitIdBody, visitStatusBody, waitlistBody, waitlistCloseBody, waitlistPatchBody, windowTagsBody, } from './journal.schemas.js';
import { SeriesService } from './series.service.js';
const date = (v, name) => {
    if (!isLocalDate(v))
        throw new ApiError('validation', 'Invalid input', { [name]: 'YYYY-MM-DD' });
    return v;
};
/** Журнал вокруг записей (02 §4, §9): /v1/biz/{b}/journal…, waitlist, events, series, packages, медкарта */
let JournalController = class JournalController {
    constructor(bookings, journal, events, series, access) {
        this.bookings = bookings;
        this.journal = journal;
        this.events = events;
        this.series = series;
        this.access = access;
    }
    // ─────────── настройки ───────────
    config(p) {
        return this.journal.config(p.businessId);
    }
    patchConfig(ctx, p, body) {
        return this.journal.patchConfig(ctx, p.businessId, body);
    }
    addCategory(ctx, p, body) {
        return this.journal.addCategory(ctx, p.businessId, body);
    }
    addTemplate(ctx, p, body) {
        return this.journal.addRecurrenceTemplate(ctx, p.businessId, body);
    }
    // ─────────── проверки, визит, зеркало, события ───────────
    check(p, body) {
        return this.journal.check(p.businessId, body);
    }
    visitId(p, body) {
        return this.journal.visitId(p.businessId, body);
    }
    visitStatus(ctx, visitId, body) {
        return this.journal.syncVisitStatus(staffActor(ctx), [ctx.member.businessId], visitId, body.status, body.excludeId);
    }
    async mirror(ctx, from, to, ids) {
        const businessIds = await this.access.businessIds(ctx, ids);
        return this.journal.mirror(businessIds, date(from, 'from'), date(to, 'to'));
    }
    async bookingEvents(ctx, q) {
        const businessIds = await this.access.businessIds(ctx, q['businessIds']);
        return this.bookings.listEvents({
            businessIds,
            staffId: q['staffId'],
            bookingId: q['bookingId'],
            clientId: q['clientId'],
            appUserId: q['appUserId'],
            kinds: csv(q['kinds']),
            since: q['since'],
            freedOnly: q['freedOnly'] === 'true' || q['freedOnly'] === '1',
        });
    }
    // ─────────── импорт / выгрузка ───────────
    import(ctx, p, body) {
        return this.journal.importRows(ctx, p.businessId, body.locationId, body.createdBy, body.rows);
    }
    logDataOp(ctx, p, body) {
        if (body.kind === 'export' && !ctx.member.permissions.has('clients.export'))
            throw new ApiError('forbidden', 'clients.export required');
        return this.journal.logDataOp(ctx, p.businessId, body.kind, body.count);
    }
    dataOps(ctx, p) {
        return this.journal.dataOps(p.businessId, ctx.member.staffId);
    }
    // ─────────── повтор записи из окна (F-01-100…107) ───────────
    recurrence(ctx, id, body) {
        return this.journal.createRecurrence(ctx, [ctx.member.businessId], id, body);
    }
    seriesBookings(ctx, seriesId) {
        return this.journal.seriesBookings([ctx.member.businessId], seriesId);
    }
    deleteSeriesBookings(ctx, seriesId, body) {
        return this.journal.deleteSeries(ctx, [ctx.member.businessId], seriesId, body.authorName);
    }
    // ─────────── серии по правилу (F-00-064, K5) ───────────
    listSeries(p, staffId) {
        return this.series.list(p.businessId, staffId);
    }
    createSeries(ctx, p, body) {
        return this.series.create(ctx, p.businessId, body);
    }
    previewSeries(body) {
        return this.series.preview(body);
    }
    async extendDue(ctx, p) {
        return { added: await this.series.extendDue(staffActor(ctx), p.businessId) };
    }
    occurrences(ctx, seriesId) {
        return this.series.occurrences([ctx.member.businessId], seriesId);
    }
    extend(ctx, p, seriesId, ifNeeded) {
        return this.series.extend(staffActor(ctx), p.businessId, seriesId, ifNeeded === 'true' || ifNeeded === '1');
    }
    stop(p, seriesId) {
        return this.series.setActive(p.businessId, seriesId, false);
    }
    resume(p, seriesId) {
        return this.series.setActive(p.businessId, seriesId, true);
    }
    // ─────────── пакеты (F-01-113, 134…136, F-16-125…130) ───────────
    createPackage(ctx, p, body) {
        return this.journal.createPackage(ctx, p.businessId, body);
    }
    getPackage(ctx, groupId) {
        return this.journal.getPackage([ctx.member.businessId], groupId);
    }
    siblings(ctx, id) {
        return this.journal.packageSiblings([ctx.member.businessId], id);
    }
    transfer(ctx, id, body) {
        return this.journal.transferPackage(ctx, [ctx.member.businessId], id, body.deltaMin, body.authorName);
    }
    deletePackage(ctx, id, body) {
        return this.journal.deletePackage(ctx, [ctx.member.businessId], id, body.authorName);
    }
    checkLinked(p, body) {
        return this.journal.checkLinked(p.businessId, body.plans);
    }
    attach(ctx, p, body) {
        return this.journal.attachLinked(ctx, p.businessId, body);
    }
    // ─────────── лист ожидания (F-01-156…162) ───────────
    waitlist(p, q) {
        return this.journal.listWaitlist(p.businessId, { status: q['status'], dateMode: q['dateMode'], selectedDate: q['selectedDate'], sort: q['sort'], query: q['query'] });
    }
    addWaitlist(ctx, p, body) {
        return this.journal.createWaitlist(ctx, p.businessId, body);
    }
    patchWaitlist(p, id, body) {
        return this.journal.updateWaitlist(p.businessId, id, body);
    }
    closeWaitlist(p, id, body) {
        return this.journal.closeWaitlist(p.businessId, id, body.bookingId);
    }
    deleteWaitlist(p, id) {
        return this.journal.deleteWaitlist(p.businessId, id);
    }
    // ─────────── групповые события (F-01-035, F-16-036…) ───────────
    async listEvents(ctx, q) {
        const businessIds = await this.access.businessIds(ctx, q['businessIds']);
        return this.events.list({ businessIds, locationId: q['locationId'], staffId: q['staffId'], serviceId: q['serviceId'], from: q['from'], to: q['to'], statuses: csv(q['statuses']) });
    }
    createEvent(ctx, p, body) {
        return this.events.create(ctx, p.businessId, body);
    }
    patchEvent(ctx, id, body) {
        return this.events.update(ctx, [ctx.member.businessId], id, body);
    }
    // ─────────── медицинские сферы (F-01-189…191) ───────────
    medical(ctx, id) {
        return this.journal.medicalVisit([ctx.member.businessId], id);
    }
    setMedical(ctx, id, body) {
        return this.journal.setMedicalVisit([ctx.member.businessId], id, body.patch, body.authorName);
    }
    card(p, clientId) {
        return this.journal.medicalCard(p.businessId, clientId);
    }
    setCard(p, clientId, body) {
        return this.journal.setMedicalCard(p.businessId, clientId, body);
    }
    plans(p, clientId) {
        return this.journal.listPlans(p.businessId, clientId);
    }
    addPlan(p, clientId, body) {
        return this.journal.addPlan(p.businessId, clientId, body);
    }
    refreshPlans(p, clientId) {
        return this.journal.refreshPlanPrices(p.businessId, clientId);
    }
    duplicatePlan(p, clientId, planId) {
        return this.journal.duplicatePlan(p.businessId, clientId, planId);
    }
    deletePlan(p, clientId, planId) {
        return this.journal.deletePlan(p.businessId, clientId, planId);
    }
    async windowTags(ctx, p, clientId, body) {
        await this.journal.setClientTags(ctx, p.businessId, clientId, body.tags);
    }
    // ─────────── «Закрыть окно» (F-00-107): выдать ссылку на окно мастера ───────────
    async mintClaim(p, body) {
        return { token: await this.journal.mintClaim({ ...body, businessId: p.businessId }) };
    }
};
__decorate([
    Get('journal/config'),
    Biz('journal.view'),
    ApiOperation({ summary: 'Настройки «Цифрового журнала», категории, свои поля, шаблоны повтора, права блоков, разметка' }),
    __param(0, Param()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], JournalController.prototype, "config", null);
__decorate([
    Patch('journal/config'),
    Biz('journal.view'),
    ZodBody(configPatchBody),
    __param(0, Ctx()),
    __param(1, Param()),
    __param(2, Body(new Zod(configPatchBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object]),
    __metadata("design:returntype", void 0)
], JournalController.prototype, "patchConfig", null);
__decorate([
    Post('journal/categories'),
    Biz('journal.edit'),
    ZodBody(categoryBody),
    __param(0, Ctx()),
    __param(1, Param()),
    __param(2, Body(new Zod(categoryBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object]),
    __metadata("design:returntype", void 0)
], JournalController.prototype, "addCategory", null);
__decorate([
    Post('journal/recurrence-templates'),
    Biz('journal.edit'),
    ZodBody(templateBody),
    __param(0, Ctx()),
    __param(1, Param()),
    __param(2, Body(new Zod(templateBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object]),
    __metadata("design:returntype", void 0)
], JournalController.prototype, "addTemplate", null);
__decorate([
    Post('journal/check'),
    HttpCode(200),
    Biz('journal.view'),
    ApiOperation({ summary: 'Занято ли время человека во всех его бизнесах / экземпляр ресурса; внутри ли часов (F-01-034, F-01-215)' }),
    ZodBody(checkBody),
    __param(0, Param()),
    __param(1, Body(new Zod(checkBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], JournalController.prototype, "check", null);
__decorate([
    Post('journal/visit-id'),
    HttpCode(200),
    Biz('journal.edit'),
    ZodBody(visitIdBody),
    __param(0, Param()),
    __param(1, Body(new Zod(visitIdBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], JournalController.prototype, "visitId", null);
__decorate([
    Post('visits/:visitId/status'),
    HttpCode(200),
    Biz('journal.edit'),
    ApiOperation({ summary: 'Статус сразу на весь визит (F-01-041)' }),
    ZodBody(visitStatusBody),
    __param(0, Ctx()),
    __param(1, Param('visitId')),
    __param(2, Body(new Zod(visitStatusBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], JournalController.prototype, "visitStatus", null);
__decorate([
    Get('journal/mirror'),
    Biz('journal.view'),
    ApiOperation({ summary: 'Записи, доп. данные, групповые события и пакеты за период — зеркало экранов, считающих у себя (до этапа 21)' }),
    __param(0, Ctx()),
    __param(1, Query('from')),
    __param(2, Query('to')),
    __param(3, Query('businessIds')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, String]),
    __metadata("design:returntype", Promise)
], JournalController.prototype, "mirror", null);
__decorate([
    Get('booking-events'),
    Biz('journal.view'),
    ApiOperation({ summary: 'Журнал событий записей (создана/статус/перенос/удалена/задерживается), старые → новые' }),
    __param(0, Ctx()),
    __param(1, Query()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], JournalController.prototype, "bookingEvents", null);
__decorate([
    Post('bookings-import'),
    HttpCode(200),
    Biz('settings.manage'),
    ApiOperation({ summary: 'Импорт визитов (F-01-182): строки после разбора файла, до 5000' }),
    ZodBody(importBody),
    __param(0, Ctx()),
    __param(1, Param()),
    __param(2, Body(new Zod(importBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object]),
    __metadata("design:returntype", void 0)
], JournalController.prototype, "import", null);
__decorate([
    Post('journal/data-ops'),
    HttpCode(200),
    Biz('journal.view'),
    ZodBody(dataOpBody),
    __param(0, Ctx()),
    __param(1, Param()),
    __param(2, Body(new Zod(dataOpBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object]),
    __metadata("design:returntype", void 0)
], JournalController.prototype, "logDataOp", null);
__decorate([
    Get('journal/data-ops'),
    Biz('journal.view'),
    __param(0, Ctx()),
    __param(1, Param()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], JournalController.prototype, "dataOps", null);
__decorate([
    Post('bookings/:id/recurrence'),
    HttpCode(200),
    Biz('journal.edit'),
    ZodBody(recurrenceBody),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body(new Zod(recurrenceBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], JournalController.prototype, "recurrence", null);
__decorate([
    Get('series/:seriesId/bookings'),
    Biz('journal.view'),
    __param(0, Ctx()),
    __param(1, Param('seriesId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], JournalController.prototype, "seriesBookings", null);
__decorate([
    Post('series/:seriesId/delete-bookings'),
    HttpCode(200),
    Biz('journal.edit'),
    ZodBody(authorBody),
    __param(0, Ctx()),
    __param(1, Param('seriesId')),
    __param(2, Body(new Zod(authorBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], JournalController.prototype, "deleteSeriesBookings", null);
__decorate([
    Get('series'),
    Biz('journal.view'),
    __param(0, Param()),
    __param(1, Query('staffId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], JournalController.prototype, "listSeries", null);
__decorate([
    Post('series'),
    Biz('journal.edit'),
    Idempotent(),
    ApiOperation({ summary: 'Серия записей: правило + записи на 8 недель вперёд (выходной/занято — ближайший свободный день)' }),
    ZodBody(seriesBody),
    __param(0, Ctx()),
    __param(1, Param()),
    __param(2, Body(new Zod(seriesBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object]),
    __metadata("design:returntype", void 0)
], JournalController.prototype, "createSeries", null);
__decorate([
    Post('series/preview'),
    HttpCode(200),
    Biz('journal.view'),
    ZodBody(seriesPreviewBody),
    __param(0, Body(new Zod(seriesPreviewBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], JournalController.prototype, "previewSeries", null);
__decorate([
    Post('series/extend-due'),
    HttpCode(200),
    Biz('journal.edit'),
    __param(0, Ctx()),
    __param(1, Param()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], JournalController.prototype, "extendDue", null);
__decorate([
    Get('series/:seriesId/occurrences'),
    Biz('journal.view'),
    __param(0, Ctx()),
    __param(1, Param('seriesId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], JournalController.prototype, "occurrences", null);
__decorate([
    Post('series/:seriesId/extend'),
    HttpCode(200),
    Biz('journal.edit'),
    __param(0, Ctx()),
    __param(1, Param()),
    __param(2, Param('seriesId')),
    __param(3, Query('ifNeeded')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, String, String]),
    __metadata("design:returntype", void 0)
], JournalController.prototype, "extend", null);
__decorate([
    Post('series/:seriesId/stop'),
    HttpCode(204),
    Biz('journal.edit'),
    __param(0, Param()),
    __param(1, Param('seriesId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], JournalController.prototype, "stop", null);
__decorate([
    Post('series/:seriesId/resume'),
    HttpCode(204),
    Biz('journal.edit'),
    __param(0, Param()),
    __param(1, Param('seriesId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], JournalController.prototype, "resume", null);
__decorate([
    Post('booking-packages'),
    Biz('journal.edit'),
    Idempotent(),
    ZodBody(packageBody),
    __param(0, Ctx()),
    __param(1, Param()),
    __param(2, Body(new Zod(packageBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object]),
    __metadata("design:returntype", void 0)
], JournalController.prototype, "createPackage", null);
__decorate([
    Get('booking-packages/:groupId'),
    Biz('journal.view'),
    __param(0, Ctx()),
    __param(1, Param('groupId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], JournalController.prototype, "getPackage", null);
__decorate([
    Get('bookings/:id/package-siblings'),
    Biz('journal.view'),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], JournalController.prototype, "siblings", null);
__decorate([
    Post('bookings/:id/package-transfer'),
    HttpCode(200),
    Biz('journal.edit'),
    ZodBody(packageTransferBody),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body(new Zod(packageTransferBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], JournalController.prototype, "transfer", null);
__decorate([
    Post('bookings/:id/package-delete'),
    HttpCode(200),
    Biz('journal.edit'),
    ZodBody(authorBody),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body(new Zod(authorBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], JournalController.prototype, "deletePackage", null);
__decorate([
    Post('booking-packages/check-linked'),
    HttpCode(200),
    Biz('journal.view'),
    ZodBody(checkLinkedBody),
    __param(0, Param()),
    __param(1, Body(new Zod(checkLinkedBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], JournalController.prototype, "checkLinked", null);
__decorate([
    Post('booking-packages/attach'),
    HttpCode(200),
    Biz('journal.edit'),
    ZodBody(attachLinkedBody),
    __param(0, Ctx()),
    __param(1, Param()),
    __param(2, Body(new Zod(attachLinkedBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object]),
    __metadata("design:returntype", void 0)
], JournalController.prototype, "attach", null);
__decorate([
    Get('waitlist'),
    Biz('journal.view'),
    __param(0, Param()),
    __param(1, Query()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], JournalController.prototype, "waitlist", null);
__decorate([
    Post('waitlist'),
    Biz('journal.edit'),
    ZodBody(waitlistBody),
    __param(0, Ctx()),
    __param(1, Param()),
    __param(2, Body(new Zod(waitlistBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object]),
    __metadata("design:returntype", void 0)
], JournalController.prototype, "addWaitlist", null);
__decorate([
    Patch('waitlist/:id'),
    Biz('journal.edit'),
    ZodBody(waitlistPatchBody),
    __param(0, Param()),
    __param(1, Param('id')),
    __param(2, Body(new Zod(waitlistPatchBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], JournalController.prototype, "patchWaitlist", null);
__decorate([
    Post('waitlist/:id/close'),
    HttpCode(204),
    Biz('journal.edit'),
    ZodBody(waitlistCloseBody),
    __param(0, Param()),
    __param(1, Param('id')),
    __param(2, Body(new Zod(waitlistCloseBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], JournalController.prototype, "closeWaitlist", null);
__decorate([
    Delete('waitlist/:id'),
    HttpCode(204),
    Biz('journal.edit'),
    __param(0, Param()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], JournalController.prototype, "deleteWaitlist", null);
__decorate([
    Get('events'),
    Biz('journal.view'),
    __param(0, Ctx()),
    __param(1, Query()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], JournalController.prototype, "listEvents", null);
__decorate([
    Post('events'),
    Biz('journal.edit'),
    ZodBody(groupEventBody),
    __param(0, Ctx()),
    __param(1, Param()),
    __param(2, Body(new Zod(groupEventBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object]),
    __metadata("design:returntype", void 0)
], JournalController.prototype, "createEvent", null);
__decorate([
    Patch('events/:id'),
    Biz('journal.edit'),
    ZodBody(groupEventPatchBody),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body(new Zod(groupEventPatchBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], JournalController.prototype, "patchEvent", null);
__decorate([
    Get('bookings/:id/medical'),
    Biz('journal.view'),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], JournalController.prototype, "medical", null);
__decorate([
    Put('bookings/:id/medical'),
    Biz('journal.edit'),
    ZodBody(medicalVisitBody),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body(new Zod(medicalVisitBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], JournalController.prototype, "setMedical", null);
__decorate([
    Get('clients/:clientId/medical-card'),
    Biz('clients.view'),
    __param(0, Param()),
    __param(1, Param('clientId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], JournalController.prototype, "card", null);
__decorate([
    Put('clients/:clientId/medical-card'),
    Biz('clients.view'),
    ZodBody(medicalCardBody),
    __param(0, Param()),
    __param(1, Param('clientId')),
    __param(2, Body(new Zod(medicalCardBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], JournalController.prototype, "setCard", null);
__decorate([
    Get('clients/:clientId/treatment-plans'),
    Biz('clients.view'),
    __param(0, Param()),
    __param(1, Param('clientId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], JournalController.prototype, "plans", null);
__decorate([
    Post('clients/:clientId/treatment-plans'),
    Biz('clients.view'),
    ZodBody(planBody),
    __param(0, Param()),
    __param(1, Param('clientId')),
    __param(2, Body(new Zod(planBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], JournalController.prototype, "addPlan", null);
__decorate([
    Post('clients/:clientId/treatment-plans/refresh-prices'),
    HttpCode(204),
    Biz('clients.view'),
    __param(0, Param()),
    __param(1, Param('clientId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], JournalController.prototype, "refreshPlans", null);
__decorate([
    Post('clients/:clientId/treatment-plans/:planId/duplicate'),
    HttpCode(200),
    Biz('clients.view'),
    __param(0, Param()),
    __param(1, Param('clientId')),
    __param(2, Param('planId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String]),
    __metadata("design:returntype", void 0)
], JournalController.prototype, "duplicatePlan", null);
__decorate([
    Delete('clients/:clientId/treatment-plans/:planId'),
    HttpCode(204),
    Biz('clients.view'),
    __param(0, Param()),
    __param(1, Param('clientId')),
    __param(2, Param('planId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String]),
    __metadata("design:returntype", void 0)
], JournalController.prototype, "deletePlan", null);
__decorate([
    Put('clients/:clientId/window-tags'),
    HttpCode(204),
    Biz('journal.edit'),
    ApiOperation({ summary: 'Метки клиента из окна записи (F-01-070) — правят саму карточку, без накладки поверх ядра' }),
    ZodBody(windowTagsBody),
    __param(0, Ctx()),
    __param(1, Param()),
    __param(2, Param('clientId')),
    __param(3, Body(new Zod(windowTagsBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, String, Object]),
    __metadata("design:returntype", Promise)
], JournalController.prototype, "windowTags", null);
__decorate([
    Post('claims'),
    HttpCode(200),
    Biz('journal.view'),
    ZodBody(claimMintBody),
    __param(0, Param()),
    __param(1, Body(new Zod(claimMintBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], JournalController.prototype, "mintClaim", null);
JournalController = __decorate([
    ApiTags('journal'),
    Controller('v1/biz/:businessId'),
    __metadata("design:paramtypes", [BookingsService,
        JournalService,
        GroupEventsService,
        SeriesService,
        JournalAccess])
], JournalController);
export { JournalController };
/**
 * Ссылка «Закрыть окно» из переписки (F-00-107): /v1/claims/{token}. Срабатывает только для вошедшего мастера этого
 * окна (или того, кто вправе записывать за него — journal.create на этого мастера); остальным — ничего о самом окне.
 */
let ClaimsController = class ClaimsController {
    constructor(bookings, memberships) {
        this.bookings = bookings;
        this.memberships = memberships;
    }
    async actorFor(ctx, token) {
        const claim = await this.bookings.prisma.slotClaim.findUnique({ where: { token } });
        if (!claim || !ctx.session)
            return { claim: null, member: null };
        const member = await this.memberships.resolve(ctx.session, claim.businessId);
        if (!member)
            return { claim, member: null };
        const c = { ...ctx, member };
        return { claim, member: canJournal(c, 'journal.create', claim.staffId) ? c : null };
    }
    async get(ctx, token) {
        const { claim, member } = await this.actorFor(ctx, token);
        if (!claim || !member)
            return { status: 'wrong_actor' };
        const [staff, business, service] = await Promise.all([
            this.bookings.prisma.staff.findUnique({ where: { id: claim.staffId }, select: { name: true } }),
            this.bookings.prisma.business.findUnique({ where: { id: claim.businessId }, select: { name: true } }),
            claim.serviceId ? this.bookings.prisma.service.findUnique({ where: { id: claim.serviceId }, select: { name: true, durationMin: true, durationMax: true } }) : null,
        ]);
        const shared = { start: claim.startLocal, staffName: staff?.name, businessName: business?.name, serviceName: service?.name };
        if (claim.status === 'used')
            return { status: 'used', ...shared, usedBookingId: claim.usedBookingId };
        if (claim.startAt.getTime() < Date.now() || Date.now() - claim.createdAt.getTime() >= 7 * 86_400_000)
            return { status: 'expired', ...shared };
        const duration = service ? Math.max(service.durationMin, service.durationMax ?? 0) : 30;
        const staffRow = await this.bookings.prisma.staff.findUnique({ where: { id: claim.staffId }, select: { id: true, userId: true } });
        const busy = staffRow
            ? await this.bookings.prisma.busyBlock.count({
                where: { personKey: staffRow.userId ?? staffRow.id, active: true, source: { not: 'mark_busy' }, startAt: { lt: new Date(claim.startAt.getTime() + duration * 60_000) }, endAt: { gt: claim.startAt } },
            })
            : 0;
        if (busy)
            return { status: 'taken', ...shared };
        return { status: 'ready', ...shared, clientName: claim.clientName ?? undefined, clientPhone: claim.clientPhone ?? undefined };
    }
    async close(ctx, token) {
        const { claim, member } = await this.actorFor(ctx, token);
        if (!claim)
            throw new ApiError('not_found', 'Claim not found');
        if (!member)
            throw new ApiError('forbidden', 'Not the master of this slot');
        if (claim.status === 'used')
            throw new ApiError('already_used', 'Already used');
        if (claim.startAt.getTime() < Date.now() || Date.now() - claim.createdAt.getTime() >= 7 * 86_400_000)
            throw new ApiError('expired', 'Claim expired');
        const res = await this.bookings.place(staffActor(member), {
            source: 'phone',
            businessId: claim.businessId,
            staffId: claim.staffId,
            start: claim.startLocal,
            services: claim.serviceId ? [{ serviceId: claim.serviceId }] : [],
            client: claim.clientPhone ? { phone: claim.clientPhone, name: claim.clientName ?? undefined } : undefined,
            staffAssignment: 'specific',
        });
        await this.bookings.prisma.slotClaim.update({ where: { token }, data: { status: 'used', usedBookingId: res.booking.id } });
        return { bookingId: res.booking.id };
    }
};
__decorate([
    Get(':token'),
    ApiOperation({ summary: 'Карточка ссылки: ready | wrong_actor | expired | used | taken (без входа — wrong_actor, без деталей)' }),
    __param(0, Ctx()),
    __param(1, Param('token')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], ClaimsController.prototype, "get", null);
__decorate([
    Post(':token/close'),
    HttpCode(200),
    Authed(),
    ApiOperation({ summary: '«Закрыть окно»: запись по единому потоку (source phone) — только мастер этого окна' }),
    __param(0, Ctx()),
    __param(1, Param('token')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], ClaimsController.prototype, "close", null);
ClaimsController = __decorate([
    ApiTags('journal'),
    Controller('v1/claims'),
    __param(1, Inject(MEMBERSHIP_RESOLVER)),
    __metadata("design:paramtypes", [BookingsService, Object])
], ClaimsController);
export { ClaimsController };
/** Клиент со своей записью (02 §2.2): отмена, перенос, подтверждение, «Я оплатил», лента событий. Только свои записи. */
let MeBookingsController = class MeBookingsController {
    constructor(bookings) {
        this.bookings = bookings;
    }
    cancel(ctx, id) {
        return this.bookings.cancelByClient(clientActor(ctx), id, { appUserId: ctx.session.userId });
    }
    reschedule(ctx, id, body) {
        return this.bookings.rescheduleByClient(clientActor(ctx), id, body.start, { appUserId: ctx.session.userId });
    }
    confirm(ctx, id) {
        return this.bookings.confirmByClient(clientActor(ctx), id, ctx.session.userId);
    }
    paid(ctx, id) {
        return this.bookings.markPaidByClient(ctx.session.userId, id);
    }
    async events(ctx, since, kinds) {
        const rows = await this.bookings.listEvents({ appUserId: ctx.session.userId, since, kinds: kinds ? csv(kinds) : ['created', 'status', 'moved', 'deleted', 'delayed'], excludeBy: 'client' });
        return rows.reverse();
    }
};
__decorate([
    Post('bookings/:id/cancel'),
    HttpCode(200),
    ApiOperation({ summary: 'Отмена клиентом (В-04): позже срока — «поздно» и +1 неявка у этого бизнеса' }),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], MeBookingsController.prototype, "cancel", null);
__decorate([
    Post('bookings/:id/reschedule'),
    HttpCode(200),
    ZodBody(clientRescheduleBody),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body(new Zod(clientRescheduleBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], MeBookingsController.prototype, "reschedule", null);
__decorate([
    Post('bookings/:id/confirm'),
    HttpCode(200),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], MeBookingsController.prototype, "confirm", null);
__decorate([
    Post('bookings/:id/paid'),
    HttpCode(200),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], MeBookingsController.prototype, "paid", null);
__decorate([
    Get('booking-events'),
    ApiOperation({ summary: 'Лента событий моих записей (новые → старые), кроме моих собственных действий' }),
    __param(0, Ctx()),
    __param(1, Query('since')),
    __param(2, Query('kinds')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String]),
    __metadata("design:returntype", Promise)
], MeBookingsController.prototype, "events", null);
MeBookingsController = __decorate([
    ApiTags('journal'),
    Controller('v1/me'),
    Authed(),
    __metadata("design:paramtypes", [BookingsService])
], MeBookingsController);
export { MeBookingsController };
/**
 * Выдать ссылку «Закрыть окно» на ближайшее окно мастера (F-00-107) — зовёт карточка мастера у клиента (этап 9),
 * без входа тоже. Ссылка сама ничего не даёт тому, кто её получил: закрыть окно может только мастер этого окна.
 */
let PublicClaimsController = class PublicClaimsController {
    constructor(journal, bookings) {
        this.journal = journal;
        this.bookings = bookings;
    }
    async mint(ctx, body) {
        const staff = await this.bookings.prisma.staff.findFirst({ where: { id: body.staffId, status: 'active', deletedAt: null }, select: { businessId: true, onlineBookingEnabled: true } });
        if (!staff || !staff.onlineBookingEnabled)
            throw new ApiError('not_found', 'Staff not found');
        const user = ctx.session && !ctx.session.platform ? await this.bookings.prisma.user.findUnique({ where: { id: ctx.session.userId }, select: { name: true, phone: true } }) : null;
        const token = await this.journal.mintClaim({
            businessId: staff.businessId,
            staffId: body.staffId,
            serviceId: body.serviceId,
            start: body.start,
            clientName: user?.name ?? undefined,
            clientPhone: user?.phone ?? undefined,
        });
        return { token };
    }
};
__decorate([
    Post(),
    HttpCode(200),
    ZodBody(claimMintBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(claimMintBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], PublicClaimsController.prototype, "mint", null);
PublicClaimsController = __decorate([
    ApiTags('journal'),
    Controller('v1/public/claims'),
    __metadata("design:paramtypes", [JournalService,
        BookingsService])
], PublicClaimsController);
export { PublicClaimsController };
//# sourceMappingURL=journal.controller.js.map