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
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Biz, Ctx } from '../../common/http/guards.js';
import { ZodBody } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { ifMatch } from '../../common/http/version.js';
import { Idempotent } from '../../common/idempotency/idempotency.js';
import { newId } from '../../common/ids/ids.js';
import { isLocale, t } from '../../common/i18n/i18n.js';
import { utcToLocal, nowLocal } from '../../common/time/time.js';
import { ApiError } from '../../common/errors/api-error.js';
import { waLink } from '../notify/wa-link.js';
import { JournalAccess, csv } from './access.js';
import { BookingsService, staffActor } from './bookings.service.js';
import { JournalService } from './journal.service.js';
import { arrivedBody, decisionBody, delayBody, deleteBody, extrasPatchBody, finishEarlyBody, goodsLineBody, goodsLinePatchBody, historyBody, idsBody, instantPayBody, patchBody, paymentLinesBody, placeBody, rawBody, refundBody, statusBody, } from './journal.schemas.js';
/** Записи кабинета (02 §4): /v1/biz/{b}/bookings… */
let BookingsController = class BookingsController {
    constructor(svc, journal, access) {
        this.svc = svc;
        this.journal = journal;
        this.access = access;
    }
    async list(ctx, q) {
        const businessIds = await this.access.businessIds(ctx, q['businessIds']);
        return this.svc.list({
            businessIds,
            locationId: q['locationId'],
            staffId: q['staffId'],
            clientId: q['clientId'],
            appUserId: q['appUserId'],
            from: q['from'],
            to: q['to'],
            statuses: csv(q['statuses']),
            includeDeleted: q['includeDeleted'] === 'true' || q['includeDeleted'] === '1',
            groupEventId: q['groupEventId'],
            seriesId: q['seriesId'],
            visitId: q['visitId'],
        });
    }
    createRaw(ctx, p, body) {
        return this.svc.createRaw(staffActor(ctx), { ...body, businessId: p.businessId });
    }
    place(ctx, p, body) {
        return this.svc.place(staffActor(ctx), { ...body, businessId: p.businessId, status: body.status });
    }
    external(ctx, p, body) {
        return this.journal.external(staffActor(ctx), p.businessId, body);
    }
    async extrasMany(ctx, body) {
        const businessIds = await this.access.businessIds(ctx, undefined);
        const rows = await this.svc.prisma.booking.findMany({ where: { id: { in: body.ids }, businessId: { in: businessIds } } });
        const out = {};
        for (const r of rows)
            out[r.id] = await this.svc.extras(this.svc.prisma, r);
        return out;
    }
    async get(ctx, id) {
        return this.svc.view(this.svc.prisma, await this.svc.find(this.svc.prisma, [ctx.member.businessId], id));
    }
    async remindText(ctx, id) {
        const b = await this.svc.find(this.svc.prisma, [ctx.member.businessId], id);
        const client = b.clientId ? await this.svc.prisma.client.findUnique({ where: { id: b.clientId } }) : null;
        if (!client || !client.phone)
            throw new ApiError('not_found', 'No client phone for this booking');
        const business = await this.svc.prisma.business.findUnique({ where: { id: b.businessId }, select: { name: true } });
        const serviceId = b.services?.[0]?.serviceId;
        const service = serviceId ? await this.svc.prisma.service.findUnique({ where: { id: serviceId }, select: { name: true } }) : null;
        const serviceName = service?.name?.ru;
        const tz = await this.svc.tzOfLocation(this.svc.prisma, b.locationId);
        const time = utcToLocal(b.startAt, tz).slice(11, 16);
        const locale = isLocale(ctx.session?.locale) ? ctx.session.locale : 'ru';
        const text = t(locale, 'booking.remindTemplate', { name: client.name, time, service: serviceName ?? '', business: business?.name ?? 'BookTime' });
        return { phone: client.phone, text, whatsappUrl: waLink(client.phone, text) };
    }
    patch(ctx, req, id, body) {
        const { expectedUpdatedAt, ...patch } = body;
        return this.svc.update(staffActor(ctx), [ctx.member.businessId], id, patch, { expectedUpdatedAt, version: ifMatch(req) });
    }
    status(ctx, id, body) {
        return this.svc.changeStatus(staffActor(ctx), [ctx.member.businessId], id, body.status, 'business');
    }
    arrived(ctx, id, body) {
        return this.svc.markArrived(staffActor(ctx), [ctx.member.businessId], id, body.amount);
    }
    remove(ctx, id, body) {
        return this.svc.remove(staffActor(ctx), [ctx.member.businessId], id, body ?? {});
    }
    restore(ctx, id) {
        return this.svc.restore(staffActor(ctx), [ctx.member.businessId], id);
    }
    async impact(ctx, id) {
        const e = await this.svc.extras(this.svc.prisma, await this.svc.find(this.svc.prisma, [ctx.member.businessId], id));
        return { paidAmount: e.paidAmount, consumablesReturned: Boolean(e.consumablesDeducted), subscriptionVisitReturned: e.autoWriteoff?.status === 'written_off' };
    }
    confirm(ctx, id) {
        return this.svc.confirm(staffActor(ctx), [ctx.member.businessId], id);
    }
    decline(ctx, id) {
        return this.svc.decline(staffActor(ctx), [ctx.member.businessId], id);
    }
    prepaymentReceived(ctx, id) {
        return this.svc.prepaymentReceived(staffActor(ctx), [ctx.member.businessId], id);
    }
    refundDone(ctx, id) {
        return this.svc.refundDone(staffActor(ctx), [ctx.member.businessId], id);
    }
    finishEarly(ctx, id, body) {
        return this.svc.finishEarly(staffActor(ctx), [ctx.member.businessId], id, body.actualDurationMin);
    }
    delay(ctx, id, body) {
        return this.svc.reportDelay(staffActor(ctx), [ctx.member.businessId], id, body.delayMin);
    }
    duplicate(ctx, id) {
        return this.journal.duplicate(ctx, [ctx.member.businessId], id);
    }
    // ─────────── доп. данные визита ───────────
    async extras(ctx, id) {
        return this.svc.extras(this.svc.prisma, await this.svc.find(this.svc.prisma, [ctx.member.businessId], id));
    }
    setExtras(ctx, id, body) {
        return this.svc.patchExtras(staffActor(ctx), [ctx.member.businessId], id, (e) => {
            for (const [k, v] of Object.entries(body)) {
                if (v === undefined)
                    continue;
                if (v === null)
                    delete e[k];
                else
                    e[k] = v;
            }
            if (body.payments && body.paidAmount === undefined)
                e.paidAmount = body.payments.reduce((s, l) => s + l.amount, 0);
        });
    }
    pay(ctx, id, body) {
        return this.svc.patchExtras(staffActor(ctx), [ctx.member.businessId], id, (e) => {
            const at = nowLocal();
            e.payments = [...(e.payments ?? []), ...body.lines.map((l) => ({ ...l, id: newId('payment'), at }))];
            e.paidAmount = e.payments.reduce((s, l) => s + l.amount, 0);
        });
    }
    instant(ctx, id, body) {
        return this.svc.patchExtras(staffActor(ctx), [ctx.member.businessId], id, (e) => {
            e.payments = [{ id: newId('payment'), method: 'cash', amount: body.total, label: 'Наличные', at: nowLocal() }];
            e.paidAmount = body.total;
        });
    }
    cancelPayments(ctx, id) {
        return this.svc.patchExtras(staffActor(ctx), [ctx.member.businessId], id, (e) => {
            e.payments = [];
            e.paidAmount = 0;
        });
    }
    cancelLine(ctx, id, lineId) {
        return this.svc.patchExtras(staffActor(ctx), [ctx.member.businessId], id, (e) => {
            e.payments = (e.payments ?? []).filter((l) => l.id !== lineId);
            e.paidAmount = e.payments.reduce((s, l) => s + l.amount, 0);
        });
    }
    refund(ctx, id, lineId, body) {
        return this.svc.patchExtras(staffActor(ctx), [ctx.member.businessId], id, (e) => {
            e.payments = (e.payments ?? []).map((l) => (l.id === lineId ? { ...l, amount: Math.max(0, l.amount - body.amount) } : l)).filter((l) => l.amount > 0);
            e.paidAmount = e.payments.reduce((s, l) => s + l.amount, 0);
        });
    }
    decide(ctx, id, body) {
        return this.svc.patchExtras(staffActor(ctx), [ctx.member.businessId], id, (e) => {
            e.prepaymentDecision = { ...body, decidedAt: nowLocal() };
        });
    }
    addGoods(ctx, id, body) {
        return this.svc.patchExtras(staffActor(ctx), [ctx.member.businessId], id, (e) => {
            e.goodsLines = [...e.goodsLines, { ...body, id: newId('goodsLine') }];
        });
    }
    patchGoods(ctx, id, lineId, body) {
        return this.svc.patchExtras(staffActor(ctx), [ctx.member.businessId], id, (e) => {
            e.goodsLines = e.goodsLines.map((l) => (l.id === lineId ? { ...l, ...Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) } : l));
        });
    }
    removeGoods(ctx, id, lineId) {
        return this.svc.patchExtras(staffActor(ctx), [ctx.member.businessId], id, (e) => {
            e.goodsLines = e.goodsLines.filter((l) => l.id !== lineId);
        });
    }
    // ─────────── история, серия, пакет ───────────
    history(ctx, id) {
        return this.journal.history([ctx.member.businessId], id);
    }
    logHistory(ctx, id, body) {
        return this.journal.logHistory([ctx.member.businessId], id, body);
    }
};
__decorate([
    Get(),
    Biz('journal.view'),
    ApiOperation({ summary: 'Записи по фильтру (BookingQuery фронта); ?businessIds= — «Все филиалы» сети' }),
    __param(0, Ctx()),
    __param(1, Query()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], BookingsController.prototype, "list", null);
__decorate([
    Post(),
    Biz('journal.edit'),
    Idempotent(),
    ApiOperation({ summary: 'createBooking «как есть» (строки посчитаны окном); занятость — под замком на мастера' }),
    ZodBody(rawBody),
    __param(0, Ctx()),
    __param(1, Param()),
    __param(2, Body(new Zod(rawBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object]),
    __metadata("design:returntype", void 0)
], BookingsController.prototype, "createRaw", null);
__decorate([
    Post('place'),
    Biz('journal.edit'),
    Idempotent(),
    ApiOperation({ summary: 'Единый поток записи (rules/booking-flow): проверки, клиент по номеру, статус, предоплата' }),
    ZodBody(placeBody),
    __param(0, Ctx()),
    __param(1, Param()),
    __param(2, Body(new Zod(placeBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object]),
    __metadata("design:returntype", void 0)
], BookingsController.prototype, "place", null);
__decorate([
    Post('external'),
    Biz('journal.edit'),
    Idempotent(),
    ApiOperation({ summary: 'Запись от бота/CRM (F-01-036): «любой свободный», клиент по номеру' }),
    __param(0, Ctx()),
    __param(1, Param()),
    __param(2, Body()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object]),
    __metadata("design:returntype", void 0)
], BookingsController.prototype, "external", null);
__decorate([
    Post('extras'),
    HttpCode(200),
    Biz('journal.view'),
    ApiOperation({ summary: 'Доп. данные визитов пачкой (цвет, категории, оплаты) — одним запросом на сетку дня' }),
    ZodBody(idsBody),
    __param(0, Ctx()),
    __param(1, Body(new Zod(idsBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], BookingsController.prototype, "extrasMany", null);
__decorate([
    Get(':id'),
    Biz('journal.view'),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], BookingsController.prototype, "get", null);
__decorate([
    Get(':id/remind-text'),
    Biz('journal.view'),
    ApiOperation({ summary: 'Готовый текст + wa.me для клиента без приложения (F-00-121, 05 §1 «мастер напоминает сам»)' }),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], BookingsController.prototype, "remindText", null);
__decorate([
    Patch(':id'),
    Biz('journal.edit'),
    ApiOperation({ summary: 'Правка/перенос (F-01-109…117); expectedUpdatedAt или If-Match — «побеждает первое» (F-01-033)' }),
    ZodBody(patchBody),
    __param(0, Ctx()),
    __param(1, Req()),
    __param(2, Param('id')),
    __param(3, Body(new Zod(patchBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, String, Object]),
    __metadata("design:returntype", void 0)
], BookingsController.prototype, "patch", null);
__decorate([
    Post(':id/status'),
    HttpCode(200),
    Biz('journal.edit'),
    ApiOperation({ summary: 'Смена статуса по правилам (переход, неявки, занятость, подтверждение)' }),
    ZodBody(statusBody),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body(new Zod(statusBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], BookingsController.prototype, "status", null);
__decorate([
    Post(':id/arrived'),
    HttpCode(200),
    Biz('journal.edit'),
    ApiOperation({ summary: '«Пришёл · сумма» (F-00-127, В-39)' }),
    ZodBody(arrivedBody),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body(new Zod(arrivedBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], BookingsController.prototype, "arrived", null);
__decorate([
    Delete(':id'),
    HttpCode(200),
    Biz('journal.edit'),
    ApiOperation({ summary: 'Мягкое удаление с автором (F-01-118…120): деньги/расходники снимаются, время освобождается' }),
    ZodBody(deleteBody),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body(new Zod(deleteBody.optional().default({})))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], BookingsController.prototype, "remove", null);
__decorate([
    Post(':id/restore'),
    HttpCode(200),
    Biz('journal.edit'),
    ApiOperation({ summary: 'Вернуть удалённую (F-01-121: 7 дней, если время свободно) — и «Отменить» 5 с' }),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], BookingsController.prototype, "restore", null);
__decorate([
    Get(':id/deletion-impact'),
    Biz('journal.view'),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], BookingsController.prototype, "impact", null);
__decorate([
    Post(':id/confirm'),
    HttpCode(200),
    Biz('journal.edit'),
    ApiOperation({ summary: 'Подтвердить заявку (В-03, F-00-067)' }),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], BookingsController.prototype, "confirm", null);
__decorate([
    Post(':id/decline'),
    HttpCode(200),
    Biz('journal.edit'),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], BookingsController.prototype, "decline", null);
__decorate([
    Post(':id/prepayment-received'),
    HttpCode(200),
    Biz('journal.edit'),
    ApiOperation({ summary: 'Ручная предоплата получена (В-05, F-00-097)' }),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], BookingsController.prototype, "prepaymentReceived", null);
__decorate([
    Post(':id/refund-done'),
    HttpCode(200),
    Biz('journal.edit'),
    ApiOperation({ summary: 'Предоплата возвращена клиенту (F-00-100)' }),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], BookingsController.prototype, "refundDone", null);
__decorate([
    Post(':id/finished-early'),
    HttpCode(200),
    Biz('journal.edit'),
    ApiOperation({ summary: '«Закончил раньше» (F-00-058): остаток становится окном' }),
    ZodBody(finishEarlyBody),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body(new Zod(finishEarlyBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], BookingsController.prototype, "finishEarly", null);
__decorate([
    Post(':id/delay'),
    HttpCode(200),
    Biz('journal.edit'),
    ApiOperation({ summary: '«Задерживаюсь» (F-00-059): событие delayed клиенту и кабинету' }),
    ZodBody(delayBody),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body(new Zod(delayBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], BookingsController.prototype, "delay", null);
__decorate([
    Post(':id/duplicate'),
    HttpCode(200),
    Biz('journal.edit'),
    ApiOperation({ summary: 'Копия записи без оплаты и депозита (F-01-192)' }),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], BookingsController.prototype, "duplicate", null);
__decorate([
    Get(':id/extras'),
    Biz('journal.view'),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], BookingsController.prototype, "extras", null);
__decorate([
    Put(':id/extras'),
    Biz('journal.edit'),
    ApiOperation({ summary: 'Доп. данные визита (F-01-050…053, 058…061): категории, цвет, поля, товары, скидки строк' }),
    ZodBody(extrasPatchBody),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body(new Zod(extrasPatchBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], BookingsController.prototype, "setExtras", null);
__decorate([
    Post(':id/payments'),
    HttpCode(200),
    Biz('journal.edit'),
    Idempotent(),
    ApiOperation({ summary: 'Оплата визита (F-01-138/139): строки оплаты, paidAmount — их сумма' }),
    ZodBody(paymentLinesBody),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body(new Zod(paymentLinesBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], BookingsController.prototype, "pay", null);
__decorate([
    Post(':id/payments/instant'),
    HttpCode(200),
    Biz('journal.edit'),
    ApiOperation({ summary: 'Мгновенная оплата всей суммы (F-01-141)' }),
    ZodBody(instantPayBody),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body(new Zod(instantPayBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], BookingsController.prototype, "instant", null);
__decorate([
    Delete(':id/payments'),
    HttpCode(200),
    Biz('journal.edit'),
    ApiOperation({ summary: 'Снять отметку оплаты (F-01-079)' }),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], BookingsController.prototype, "cancelPayments", null);
__decorate([
    Delete(':id/payments/:lineId'),
    HttpCode(200),
    Biz('journal.edit'),
    ApiOperation({ summary: 'Удалить ошибочную строку оплаты (F-01-143)' }),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Param('lineId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String]),
    __metadata("design:returntype", void 0)
], BookingsController.prototype, "cancelLine", null);
__decorate([
    Post(':id/payments/:lineId/refund'),
    HttpCode(200),
    Biz('journal.edit'),
    ApiOperation({ summary: 'Частичный возврат по строке оплаты (F-01-212)' }),
    ZodBody(refundBody),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Param('lineId')),
    __param(3, Body(new Zod(refundBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object]),
    __metadata("design:returntype", void 0)
], BookingsController.prototype, "refund", null);
__decorate([
    Post(':id/prepayment-decision'),
    HttpCode(200),
    Biz('journal.edit'),
    ApiOperation({ summary: '«Удержать / Простить» предоплату при позднем переносе или неявке (В-04, F-01-116/124)' }),
    ZodBody(decisionBody),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body(new Zod(decisionBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], BookingsController.prototype, "decide", null);
__decorate([
    Post(':id/goods-lines'),
    HttpCode(200),
    Biz('journal.edit'),
    ZodBody(goodsLineBody),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body(new Zod(goodsLineBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], BookingsController.prototype, "addGoods", null);
__decorate([
    Patch(':id/goods-lines/:lineId'),
    Biz('journal.edit'),
    ZodBody(goodsLinePatchBody),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Param('lineId')),
    __param(3, Body(new Zod(goodsLinePatchBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object]),
    __metadata("design:returntype", void 0)
], BookingsController.prototype, "patchGoods", null);
__decorate([
    Delete(':id/goods-lines/:lineId'),
    HttpCode(200),
    Biz('journal.edit'),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Param('lineId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String]),
    __metadata("design:returntype", void 0)
], BookingsController.prototype, "removeGoods", null);
__decorate([
    Get(':id/history'),
    Biz('journal.view'),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], BookingsController.prototype, "history", null);
__decorate([
    Post(':id/history'),
    HttpCode(200),
    Biz('journal.edit'),
    ZodBody(historyBody),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body(new Zod(historyBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], BookingsController.prototype, "logHistory", null);
BookingsController = __decorate([
    ApiTags('journal'),
    Controller('v1/biz/:businessId/bookings'),
    __metadata("design:paramtypes", [BookingsService,
        JournalService,
        JournalAccess])
], BookingsController);
export { BookingsController };
//# sourceMappingURL=bookings.controller.js.map