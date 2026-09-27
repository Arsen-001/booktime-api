import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { ApiError } from '../../common/errors/api-error.js';
import { newId } from '../../common/ids/ids.js';
import type { RequestContext } from '../../common/http/context.js';
import { PrismaService } from '../../common/prisma.service.js';
import { enqueueClientNotification } from './outbox.js';
import { weekKeyOf } from './week-key.js';

const J = (v: unknown) => v as Prisma.InputJsonValue;

export const WEEKLY_NEWS_LIMIT = 3;

type LocalizedText = { ru: string; hy?: string; en?: string };

function pickText(text: LocalizedText, locale: string): string {
  return (text as Record<string, string | undefined>)[locale] || text.ru;
}

/**
 * Новость подписчикам (05 §5, F-00-114): не больше WEEKLY_NEWS_LIMIT в неделю НА БИЗНЕС (не на мастера).
 * Получатели — те, кто подписан ❤ на сам бизнес или на кого-то из его мастеров, и не приглушил новости
 * (Favorite.newsMuted, F-00-115) — тот же переключатель, что использует «освободилось окно» (waitlist_available):
 * оба «не транзакционных, не про мою запись» пуша уважают одну и ту же настройку клиента.
 */
@Injectable()
export class NotifyNewsService {
  constructor(private readonly prisma: PrismaService) {}

  async quota(businessId: string): Promise<{ limit: number; sent: number; remaining: number }> {
    const weekKey = weekKeyOf(new Date());
    const row = await this.prisma.newsQuota.findUnique({ where: { businessId_weekKey: { businessId, weekKey } } });
    const sent = row?.sent ?? 0;
    return { limit: WEEKLY_NEWS_LIMIT, sent, remaining: Math.max(0, WEEKLY_NEWS_LIMIT - sent) };
  }

  async list(businessId: string) {
    const rows = await this.prisma.newsPost.findMany({ where: { businessId }, orderBy: { createdAt: 'desc' }, take: 50 });
    return rows.map((r) => ({ id: r.id, businessId: r.businessId, text: r.text as LocalizedText, recipientsCount: r.recipientsCount, createdAt: r.createdAt.toISOString() }));
  }

  /** «Что можно предложить» (F-00-114, предл.) — реальная, но простая эвристика: новое за последние 7 дней */
  async suggestions(businessId: string) {
    const since = new Date(Date.now() - 7 * 86_400_000);
    const [newServices, newStaff] = await Promise.all([
      this.prisma.service.findMany({ where: { businessId, createdAt: { gte: since }, deletedAt: null }, select: { id: true, name: true }, take: 5 }),
      this.prisma.staff.findMany({ where: { businessId, createdAt: { gte: since }, status: 'active' }, select: { id: true, name: true }, take: 5 }),
    ]);
    return [
      ...newServices.map((s) => ({ kind: 'new_service' as const, id: s.id, label: pickText(s.name as LocalizedText, 'ru') })),
      ...newStaff.map((s) => ({ kind: 'new_staff' as const, id: s.id, label: s.name })),
    ];
  }

  async create(ctx: RequestContext, businessId: string, text: LocalizedText): Promise<{ id: string; recipientsCount: number }> {
    if (!text.ru.trim()) throw new ApiError('validation', 'Text is required', { text: 'required' });
    const weekKey = weekKeyOf(new Date());
    const postId = newId('newsPost');
    const recipients = await this.recipients(businessId);
    await this.prisma.$transaction(async (tx) => {
      // «Замок»-строка недели (§5): SELECT … FOR UPDATE — два администратора не отправят 4-ю одновременно
      await tx.$executeRaw`INSERT INTO news_quota (business_id, week_key, sent) VALUES (${businessId}, ${weekKey}, 0) ON DUPLICATE KEY UPDATE business_id = business_id`;
      const locked = await tx.$queryRaw<{ sent: number }[]>`SELECT sent FROM news_quota WHERE business_id = ${businessId} AND week_key = ${weekKey} FOR UPDATE`;
      if ((locked[0]?.sent ?? 0) >= WEEKLY_NEWS_LIMIT) throw new ApiError('weekly_push_limit', 'Weekly news push limit reached (3/week per business)');
      await tx.newsPost.create({ data: { id: postId, businessId, weekKey, text: J(text), recipientsCount: recipients.length, createdBy: ctx.member?.staffId } });
      await tx.$executeRaw`UPDATE news_quota SET sent = sent + 1 WHERE business_id = ${businessId} AND week_key = ${weekKey}`;
      for (const r of recipients) {
        await enqueueClientNotification(tx, {
          businessId,
          kind: 'news',
          appUserId: r.appUserId,
          title: r.businessName,
          body: pickText(text, r.locale),
          dedupeKey: `news:${postId}:${r.appUserId}`,
        });
      }
    });
    return { id: postId, recipientsCount: recipients.length };
  }

  private async recipients(businessId: string): Promise<{ appUserId: string; locale: string; businessName: string }[]> {
    const business = await this.prisma.business.findUnique({ where: { id: businessId }, select: { name: true } });
    const staff = await this.prisma.staff.findMany({ where: { businessId }, select: { id: true } });
    const favorites = await this.prisma.favorite.findMany({
      where: { newsMuted: false, OR: [{ targetType: 'business', targetId: businessId }, { targetType: 'staff', targetId: { in: staff.map((s) => s.id) } }] },
      select: { appUserId: true },
      distinct: ['appUserId'],
    });
    if (!favorites.length) return [];
    const users = await this.prisma.user.findMany({ where: { id: { in: favorites.map((f) => f.appUserId) }, blockedAt: null, deletedAt: null }, select: { id: true, locale: true } });
    return users.map((u) => ({ appUserId: u.id, locale: u.locale, businessName: business?.name ?? 'BookTime' }));
  }
}
