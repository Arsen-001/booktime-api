var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service.js';
import { isOnlineSource } from '../journal/rules.js';
const CANCELLED = new Set(['cancelled_by_client', 'cancelled_by_master']);
/**
 * Колокольчик кабинета (F-05-061): та же лента, что фронт раньше строил сам из booking_events —
 * не переизобретаем правило перехода, только читаем его с сервера (тот же `BookingEvent`, что пишет
 * `BookingsService.logEvents`, docs/backend/02-api.md §10). «Прочитано» — общее на бизнес, не персональное
 * (как в моке `s.inboxRead[businessId]`, не на сотрудника — F-05-061 не просит персонального счётчика).
 */
let NotifyInboxService = class NotifyInboxService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async events(businessId) {
        const rows = await this.prisma.bookingEvent.findMany({ where: { businessId }, orderBy: { at: 'desc' }, take: 200 });
        const bookingIds = [...new Set(rows.filter((r) => r.kind === 'created').map((r) => r.bookingId))];
        const bookings = bookingIds.length ? await this.prisma.booking.findMany({ where: { id: { in: bookingIds } }, select: { id: true, source: true } }) : [];
        const sourceById = new Map(bookings.map((b) => [b.id, b.source]));
        const out = [];
        for (const e of rows) {
            let kind;
            if (e.kind === 'created')
                kind = isOnlineSource(sourceById.get(e.bookingId) ?? '') ? 'onlineCreated' : 'created';
            else if (e.kind === 'status' && e.toStatus && CANCELLED.has(e.toStatus))
                kind = 'cancelled';
            else if (e.kind === 'moved')
                kind = 'moved';
            else if (e.kind === 'deleted')
                kind = 'deleted';
            else if (e.kind === 'delayed')
                kind = 'delayed';
            if (!kind)
                continue;
            out.push({ id: e.id, bookingId: e.bookingId, createdAt: e.at.toISOString(), date: (e.startLocal || e.at.toISOString()).slice(0, 10), kind });
        }
        return out.slice(0, 30);
    }
    async countUnread(businessId) {
        const [events, read] = await Promise.all([this.events(businessId), this.readIds(businessId)]);
        return events.filter((e) => !read.has(e.id)).length;
    }
    async preview(businessId, limit = 5) {
        const [events, read] = await Promise.all([this.events(businessId), this.readIds(businessId)]);
        return events.slice(0, limit).map((e) => ({ ...e, unread: !read.has(e.id) }));
    }
    async list(businessId) {
        const [events, read] = await Promise.all([this.events(businessId), this.readIds(businessId)]);
        return events.map((e) => ({ ...e, unread: !read.has(e.id) }));
    }
    async markRead(businessId, ids) {
        if (!ids.length)
            return;
        await this.prisma.bizInboxRead.createMany({ data: ids.map((eventId) => ({ businessId, eventId })), skipDuplicates: true });
    }
    async markAllRead(businessId) {
        const events = await this.events(businessId);
        await this.markRead(businessId, events.map((e) => e.id));
    }
    async readIds(businessId) {
        const rows = await this.prisma.bizInboxRead.findMany({ where: { businessId }, select: { eventId: true } });
        return new Set(rows.map((r) => r.eventId));
    }
};
NotifyInboxService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [PrismaService])
], NotifyInboxService);
export { NotifyInboxService };
//# sourceMappingURL=notify-inbox.service.js.map