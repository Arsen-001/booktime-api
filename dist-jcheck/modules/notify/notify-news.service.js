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
import { ApiError } from '../../common/errors/api-error.js';
import { newId } from '../../common/ids/ids.js';
import { PrismaService } from '../../common/prisma.service.js';
import { enqueueClientNotification } from './outbox.js';
import { weekKeyOf } from './week-key.js';
const J = (v) => v;
export const WEEKLY_NEWS_LIMIT = 3;
function pickText(text, locale) {
    return text[locale] || text.ru;
}
/**
 * Новость подписчикам (05 §5, F-00-114): не больше WEEKLY_NEWS_LIMIT в неделю НА БИЗНЕС (не на мастера).
 * Получатели — те, кто подписан ❤ на сам бизнес или на кого-то из его мастеров, и не приглушил новости
 * (Favorite.newsMuted, F-00-115) — тот же переключатель, что использует «освободилось окно» (waitlist_available):
 * оба «не транзакционных, не про мою запись» пуша уважают одну и ту же настройку клиента.
 */
let NotifyNewsService = class NotifyNewsService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async quota(businessId) {
        const weekKey = weekKeyOf(new Date());
        const row = await this.prisma.newsQuota.findUnique({ where: { businessId_weekKey: { businessId, weekKey } } });
        const sent = row?.sent ?? 0;
        return { limit: WEEKLY_NEWS_LIMIT, sent, remaining: Math.max(0, WEEKLY_NEWS_LIMIT - sent) };
    }
    async list(businessId) {
        const rows = await this.prisma.newsPost.findMany({ where: { businessId }, orderBy: { createdAt: 'desc' }, take: 50 });
        return rows.map((r) => ({ id: r.id, businessId: r.businessId, text: r.text, recipientsCount: r.recipientsCount, createdAt: r.createdAt.toISOString() }));
    }
    /** «Что можно предложить» (F-00-114, предл.) — реальная, но простая эвристика: новое за последние 7 дней */
    async suggestions(businessId) {
        const since = new Date(Date.now() - 7 * 86_400_000);
        const [newServices, newStaff] = await Promise.all([
            this.prisma.service.findMany({ where: { businessId, createdAt: { gte: since }, deletedAt: null }, select: { id: true, name: true }, take: 5 }),
            this.prisma.staff.findMany({ where: { businessId, createdAt: { gte: since }, status: 'active' }, select: { id: true, name: true }, take: 5 }),
        ]);
        return [
            ...newServices.map((s) => ({ kind: 'new_service', id: s.id, label: pickText(s.name, 'ru') })),
            ...newStaff.map((s) => ({ kind: 'new_staff', id: s.id, label: s.name })),
        ];
    }
    async create(ctx, businessId, text) {
        if (!text.ru.trim())
            throw new ApiError('validation', 'Text is required', { text: 'required' });
        const weekKey = weekKeyOf(new Date());
        const postId = newId('newsPost');
        const recipients = await this.recipients(businessId);
        await this.prisma.$transaction(async (tx) => {
            // «Замок»-строка недели (§5): SELECT … FOR UPDATE — два администратора не отправят 4-ю одновременно
            await tx.$executeRaw `INSERT INTO news_quota (business_id, week_key, sent) VALUES (${businessId}, ${weekKey}, 0) ON DUPLICATE KEY UPDATE business_id = business_id`;
            const locked = await tx.$queryRaw `SELECT sent FROM news_quota WHERE business_id = ${businessId} AND week_key = ${weekKey} FOR UPDATE`;
            if ((locked[0]?.sent ?? 0) >= WEEKLY_NEWS_LIMIT)
                throw new ApiError('weekly_push_limit', 'Weekly news push limit reached (3/week per business)');
            await tx.newsPost.create({ data: { id: postId, businessId, weekKey, text: J(text), recipientsCount: recipients.length, createdBy: ctx.member?.staffId } });
            await tx.$executeRaw `UPDATE news_quota SET sent = sent + 1 WHERE business_id = ${businessId} AND week_key = ${weekKey}`;
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
    async recipients(businessId) {
        const business = await this.prisma.business.findUnique({ where: { id: businessId }, select: { name: true } });
        const staff = await this.prisma.staff.findMany({ where: { businessId }, select: { id: true } });
        const favorites = await this.prisma.favorite.findMany({
            where: { newsMuted: false, OR: [{ targetType: 'business', targetId: businessId }, { targetType: 'staff', targetId: { in: staff.map((s) => s.id) } }] },
            select: { appUserId: true },
            distinct: ['appUserId'],
        });
        if (!favorites.length)
            return [];
        const users = await this.prisma.user.findMany({ where: { id: { in: favorites.map((f) => f.appUserId) }, blockedAt: null, deletedAt: null }, select: { id: true, locale: true } });
        return users.map((u) => ({ appUserId: u.id, locale: u.locale, businessName: business?.name ?? 'BookTime' }));
    }
};
NotifyNewsService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [PrismaService])
], NotifyNewsService);
export { NotifyNewsService };
//# sourceMappingURL=notify-news.service.js.map