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
@Injectable()
export class OverviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly moderation: ModerationService,
    private readonly support: PlatformSupportService,
    private readonly visits: VisitsService,
  ) {}

  async summary() {
    const [counts, tickets, callbacks] = await Promise.all([this.moderation.counts(), this.support.list({ status: 'active' }), this.visits.listCallbacksToday()]);
    const weekAgo = new Date(Date.now() - 7 * 86_400_000);
    const [connectedWeek, appBookings] = await Promise.all([
      this.prisma.salesVisit.count({ where: { status: 'connected', updatedAt: { gte: weekAgo } } }),
      this.prisma.booking.findMany({ where: { source: 'app', createdAt: { gte: weekAgo }, deletedAt: null }, select: { createdAt: true } }),
    ]);
    const byDay = new Map<string, number>();
    for (let i = 6; i >= 0; i--) byDay.set(utcToLocalDate(new Date(Date.now() - i * 86_400_000)), 0);
    for (const b of appBookings) {
      const day = utcToLocalDate(b.createdAt);
      if (byDay.has(day)) byDay.set(day, (byDay.get(day) ?? 0) + 1);
    }
    return {
      pendingModeration: counts.pending,
      openTickets: tickets.length,
      connectedWeek,
      demandWithoutOffer: 0,
      callbacks,
      appBookings: [...byDay.entries()].map(([date, count]) => ({ date, count })),
      appBookingsTotal: appBookings.length,
      waves: [] as { wave: 1 | 2 | 3; passed: number; total: number }[],
    };
  }
}
