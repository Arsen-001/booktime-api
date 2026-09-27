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
import { utcToLocalDate } from '../../common/time/time.js';
import { ModerationService } from './moderation.service.js';
import { PlatformSupportService } from './support.service.js';
import { VisitsService } from './visits.service.js';
/**
 * Обзор панели одним ответом (docs/backend/02 §19, DTO OverviewSummary). demandWithoutOffer и waves — этот проход
 * не строит (спрос/first-awards и план запуска — отдельный, см. PROGRESS.md); отдаются честными нулём/пустым
 * массивом, а не выдумкой — экран не ломается, просто эти два виджета показывают «нечего показать».
 */
let OverviewService = class OverviewService {
    constructor(prisma, moderation, support, visits) {
        this.prisma = prisma;
        this.moderation = moderation;
        this.support = support;
        this.visits = visits;
    }
    async summary() {
        const [counts, tickets, callbacks] = await Promise.all([this.moderation.counts(), this.support.list({ status: 'active' }), this.visits.listCallbacksToday()]);
        const weekAgo = new Date(Date.now() - 7 * 86_400_000);
        const [connectedWeek, appBookings] = await Promise.all([
            this.prisma.salesVisit.count({ where: { status: 'connected', updatedAt: { gte: weekAgo } } }),
            this.prisma.booking.findMany({ where: { source: 'app', createdAt: { gte: weekAgo }, deletedAt: null }, select: { createdAt: true } }),
        ]);
        const byDay = new Map();
        for (let i = 6; i >= 0; i--)
            byDay.set(utcToLocalDate(new Date(Date.now() - i * 86_400_000)), 0);
        for (const b of appBookings) {
            const day = utcToLocalDate(b.createdAt);
            if (byDay.has(day))
                byDay.set(day, (byDay.get(day) ?? 0) + 1);
        }
        return {
            pendingModeration: counts.pending,
            openTickets: tickets.length,
            connectedWeek,
            demandWithoutOffer: 0,
            callbacks,
            appBookings: [...byDay.entries()].map(([date, count]) => ({ date, count })),
            appBookingsTotal: appBookings.length,
            waves: [],
        };
    }
};
OverviewService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [PrismaService,
        ModerationService,
        PlatformSupportService,
        VisitsService])
], OverviewService);
export { OverviewService };
//# sourceMappingURL=overview.service.js.map