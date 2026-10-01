import { Injectable } from '@nestjs/common';
import { Prisma, type StoryBooking } from '../../generated/prisma/client.js';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { newId } from '../../common/ids/ids.js';
import { PrismaService } from '../../common/prisma.service.js';
import { utcToLocal, utcToLocalDate } from '../../common/time/time.js';
import { spendCoins } from '../billing/coins.js';
import { businessView } from '../businesses/views.js';
import { enqueueClientNotification } from '../notify/outbox.js';
import { weekKeyOf } from '../notify/week-key.js';
import { ModerationService } from '../platform/moderation.service.js';
import type { NewsPostBody, PurchaseStoryBody } from './client-promo.schemas.js';

/**
 * Этап 21 (сдача, попытка 6): сторис, новости подписчикам и продвижение из кабинета (client.ts b05, F-00-103,
 * F-00-114, F-00-155…168, F-00-167, F-14-032…036, F-14-172) — порт мока один-в-один.
 *
 * Модель цены сторис — та, что видит кабинет (монеты за 24 ч: 1 500, в очереди 2 500, мест одновременно —
 * `StoryConfig.places`, по умолчанию 6 = STORY_MAX_ACTIVE_SLOTS фронта). Доска мест панели (цена за день из
 * `StoryConfig.pricePerDay`) — другая модель; какая верна, решает владелец (вопрос в docs/PROGRESS.md). Покупка
 * пишется в ту же `story_bookings`, что читает доска панели, — место занято и там, и здесь.
 */

type Json = Record<string, unknown>;
const J = (v: unknown) => v as Prisma.InputJsonValue;
const DAY = 24 * 60 * 60 * 1000;

export const STORY_BASE_PRICE = 1500;
export const STORY_QUEUE_PRICE = 2500;
export const NEWS_FREE_PER_WEEK = 3;
export const NEWS_EXTRA_PRICE = 300;
export const BOOST_DAYS = 7;
export const BOOST_PRICE = { search: 2000, home: 3000 } as const;
const PROMOTION_AREA = 'client-promotion';

interface StoryData {
  kind: 'generated' | 'photo';
  lang: string[];
  showStaffNames: boolean;
  windows: { staffId?: string; staffName?: string; label: string }[];
  bookingTarget?: { staffId?: string; serviceId?: string };
  caption?: string;
  /** Решение владельца 01.10.2026: сторис мастера без billing.manage — автор (видит/снимает только свои) */
  authorStaffId?: string;
}

/** Кто и чьи сторис видит/публикует/снимает (storyAuthorScope мока): с billing.manage — все, иначе — только свои */
export type StoryScope = { all: true } | { all: false; staffId: string };
export function storyScopeOf(ctx: RequestContext): StoryScope {
  if (ctx.member!.permissions.has('billing.manage')) return { all: true };
  return { all: false, staffId: ctx.member!.staffId };
}

type ModerationState = { status: string; decidedAt: Date | null };

@Injectable()
export class ClientPromoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly moderation: ModerationService,
  ) {}

  // ─────────── Сторис ───────────

  private async moderationOf(rows: { moderationItemId: string | null }[]): Promise<Map<string, ModerationState>> {
    const ids = rows.map((r) => r.moderationItemId).filter((v): v is string => Boolean(v));
    if (!ids.length) return new Map();
    const items = await this.prisma.moderationItem.findMany({ where: { id: { in: ids } }, select: { id: true, status: true, decidedAt: true } });
    return new Map(items.map((i) => [i.id, { status: i.status, decidedAt: i.decidedAt }]));
  }

  /** Статус с решением нашей панели (storyLiveStatus мока): фото ждёт проверки; одобрили — 24 ч от решения */
  private statusOf(row: StoryBooking, mod: Map<string, ModerationState>, now: Date): string {
    if (row.status === 'rejected' || row.status === 'cancelled') return 'rejected';
    if (row.source === 'photo' && row.moderationItemId) {
      const item = mod.get(row.moderationItemId);
      if (!item || item.status === 'pending') return 'pending_review';
      if (item.status === 'rejected') return 'rejected';
      const from = item.decidedAt ?? row.createdAt;
      return from.getTime() + DAY > now.getTime() ? 'active' : 'expired';
    }
    if (row.mode === 'queue') return 'queued';
    if (row.expiresAt && row.expiresAt <= now) return 'expired';
    return 'active';
  }

  private storyView(row: StoryBooking, status: string): Json {
    const d = (row.data as StoryData | null) ?? { kind: row.source === 'photo' ? 'photo' : 'generated', lang: ['ru'], showStaffNames: false, windows: [] };
    return {
      id: row.id,
      businessId: row.businessId,
      kind: d.kind,
      imageUrl: row.imageUrl ?? '',
      lang: d.lang,
      showStaffNames: d.showStaffNames,
      windows: d.windows,
      ...(d.bookingTarget ? { bookingTarget: d.bookingTarget } : {}),
      ...(d.caption ? { caption: d.caption } : {}),
      ...(d.authorStaffId ? { authorStaffId: d.authorStaffId } : {}),
      status,
      price: row.price,
      createdAt: utcToLocal(row.createdAt),
      ...(row.expiresAt ? { expiresAt: utcToLocal(row.expiresAt) } : {}),
      viewCount: row.views,
      clickCount: row.clicks,
      bookingCount: row.bookingsFromStory,
    };
  }

  /** Живые сторис кабинета (не старше 3 суток — дольше ни одна не показывается) со статусом */
  private async recentStories(where: Prisma.StoryBookingWhereInput = {}): Promise<{ row: StoryBooking; status: string }[]> {
    const now = new Date();
    const rows = await this.prisma.storyBooking.findMany({ where: { ...where, data: { not: Prisma.DbNull }, createdAt: { gte: new Date(now.getTime() - 3 * DAY) } }, orderBy: { createdAt: 'desc' } });
    const mod = await this.moderationOf(rows);
    return rows.map((row) => ({ row, status: this.statusOf(row, mod, now) }));
  }

  private async maxSlots(): Promise<number> {
    const cfg = await this.prisma.storyConfig.findUnique({ where: { id: 'singleton' }, select: { places: true } });
    return cfg?.places ?? 6;
  }

  async slotsInfo(): Promise<{ used: number; max: number }> {
    const [rows, max] = await Promise.all([this.recentStories(), this.maxSlots()]);
    return { used: rows.filter((r) => r.status === 'active').length, max };
  }

  async listBusinessStories(businessId: string, scope: StoryScope = { all: true }): Promise<Json[]> {
    const now = new Date();
    const all = await this.prisma.storyBooking.findMany({ where: { businessId, data: { not: Prisma.DbNull } }, orderBy: { createdAt: 'desc' }, take: 100 });
    // Мастер без billing.manage — только свои сторис (authorStaffId), как мок
    const rows = scope.all ? all : all.filter((r) => (r.data as StoryData | null)?.authorStaffId === scope.staffId);
    const mod = await this.moderationOf(rows);
    return rows.map((row) => this.storyView(row, this.statusOf(row, mod, now)));
  }

  /** «Снять сторис» (deleteStory мока): своё — автору, любую — с billing.manage. Монеты не возвращаются, как в моке */
  async deleteStory(ctx: RequestContext, businessId: string, storyId: string): Promise<void> {
    const row = await this.prisma.storyBooking.findFirst({ where: { id: storyId, businessId } });
    if (!row) throw new ApiError('not_found', 'Story not found');
    const scope = storyScopeOf(ctx);
    if (!scope.all && (row.data as StoryData | null)?.authorStaffId !== scope.staffId) throw new ApiError('forbidden', 'Only your own stories');
    await this.prisma.storyBooking.delete({ where: { id: row.id } });
  }

  async listBusinessPromoStories(businessId: string): Promise<Json[]> {
    return (await this.recentStories({ businessId })).filter((r) => r.status === 'active').map((r) => this.storyView(r.row, r.status));
  }

  private async withBusinesses(list: { row: StoryBooking; status: string }[]): Promise<Json[]> {
    const ids = [...new Set(list.map((r) => r.row.businessId))];
    if (!ids.length) return [];
    const [businesses, locations] = await Promise.all([
      this.prisma.business.findMany({ where: { id: { in: ids }, status: 'active' } }),
      this.prisma.location.findMany({ where: { businessId: { in: ids }, deletedAt: null }, select: { id: true, businessId: true } }),
    ]);
    const out: Json[] = [];
    for (const r of list) {
      const b = businesses.find((x) => x.id === r.row.businessId);
      if (!b) continue;
      out.push({ ...this.storyView(r.row, r.status), business: businessView(b, locations.filter((l) => l.businessId === b.id).map((l) => l.id)) });
    }
    return out;
  }

  /** Главная приложения (F-00-159/161): видят все; сначала подписки клиента, потом остальные, новые первыми */
  async listHomeStories(appUserId?: string): Promise<Json[]> {
    const active = (await this.recentStories()).filter((r) => r.status === 'active');
    let subscribed = new Set<string>();
    if (appUserId) {
      const favs = await this.prisma.favorite.findMany({ where: { appUserId }, select: { targetType: true, targetId: true } });
      const staffIds = favs.filter((f) => f.targetType === 'staff').map((f) => f.targetId);
      const staffBiz = staffIds.length ? await this.prisma.staff.findMany({ where: { id: { in: staffIds } }, select: { businessId: true } }) : [];
      subscribed = new Set([...favs.filter((f) => f.targetType === 'business').map((f) => f.targetId), ...staffBiz.map((s) => s.businessId)]);
    }
    active.sort((a, b) => {
      const aSub = subscribed.has(a.row.businessId);
      const bSub = subscribed.has(b.row.businessId);
      if (aSub !== bSub) return aSub ? -1 : 1;
      return b.row.createdAt.getTime() - a.row.createdAt.getTime();
    });
    return this.withBusinesses(active);
  }

  /** По прямому адресу — только действующая (decision-c3 №17) */
  async getStory(id: string): Promise<Json | null> {
    const row = await this.prisma.storyBooking.findUnique({ where: { id } });
    if (!row || !row.data) return null;
    const status = this.statusOf(row, await this.moderationOf([row]), new Date());
    if (status !== 'active') return null;
    return (await this.withBusinesses([{ row, status }]))[0] ?? null;
  }

  async recordView(id: string): Promise<void> {
    await this.prisma.storyBooking.updateMany({ where: { id }, data: { views: { increment: 1 } } });
  }

  async recordClick(id: string): Promise<void> {
    await this.prisma.storyBooking.updateMany({ where: { id }, data: { clicks: { increment: 1 } } });
  }

  /** Покупка (F-00-159/160): шаблон — сразу на 24 ч; нет мест — очередь дороже; своё фото — ждёт проверки панели */
  async purchaseStory(ctx: RequestContext, businessId: string, body: PurchaseStoryBody): Promise<Json> {
    const now = new Date();
    const max = await this.maxSlots();
    const id = newId('storyBooking');
    // Решение владельца 01.10.2026: мастер без billing.manage публикует свои сторис — только свои окна и запись к себе
    const scope = storyScopeOf(ctx);
    const windows = scope.all ? body.windows : body.windows.filter((w) => w.staffId === scope.staffId);
    const bookingTarget = scope.all ? body.bookingTarget : { ...(body.bookingTarget ?? {}), staffId: scope.staffId };
    const data: StoryData = {
      kind: body.kind,
      lang: body.lang,
      showStaffNames: body.showStaffNames,
      windows: windows.map((w) => ({ ...(w.staffId ? { staffId: w.staffId } : {}), ...(w.staffName ? { staffName: w.staffName } : {}), label: w.times.join(', ') })),
      ...(bookingTarget ? { bookingTarget } : {}),
      ...(body.caption ? { caption: body.caption.slice(0, 70) } : {}),
      ...(scope.all ? {} : { authorStaffId: scope.staffId }),
    };
    const row = await this.prisma.$transaction(async (tx) => {
      // «Замок» мест (PLAN §4.2): два кабинета не займут последнее место одновременно
      await tx.$executeRaw`INSERT IGNORE INTO story_day_locks (day_key) VALUES ('client-stories')`;
      await tx.$queryRaw`SELECT day_key FROM story_day_locks WHERE day_key = 'client-stories' FOR UPDATE`;
      const recent = await tx.storyBooking.findMany({ where: { data: { not: Prisma.DbNull }, createdAt: { gte: new Date(now.getTime() - 3 * DAY) } } });
      const mod = await this.moderationOf(recent);
      const used = recent.filter((r) => this.statusOf(r, mod, now) === 'active').length;
      const full = used >= max;
      const price = full ? STORY_QUEUE_PRICE : STORY_BASE_PRICE;
      await spendCoins(tx, { businessId, amount: price, reason: body.kind === 'photo' ? 'storyPhoto' : 'storyPlace', area: 'client', refId: id, by: ctx.member?.staffId ?? 'system' });
      return tx.storyBooking.create({
        data: {
          id,
          businessId,
          date: utcToLocalDate(now),
          mode: full ? 'queue' : 'place',
          price,
          status: 'active',
          source: body.kind === 'photo' ? 'photo' : 'template',
          imageUrl: body.imageUrl,
          expiresAt: body.kind === 'photo' || full ? null : new Date(now.getTime() + DAY),
          data: J(data),
        },
      });
    });
    let final = row;
    if (body.kind === 'photo') {
      // Своё фото — в очередь панели (decision-c3 №8): отклонят — монеты вернёт сама модерация (paidCoins)
      const item = await this.moderation.submit({ kind: 'story', businessId, refId: row.id, imageUrl: body.imageUrl, text: body.caption, paidCoins: row.price });
      final = await this.prisma.storyBooking.update({ where: { id: row.id }, data: { moderationItemId: item.id } });
    }
    return this.storyView(final, this.statusOf(final, await this.moderationOf([final]), new Date()));
  }

  // ─────────── Новости подписчикам (F-00-114) ───────────

  private newsView(r: { id: string; businessId: string; text: unknown; photoUrl: string | null; createdAt: Date; paidWithCoins: boolean; status: string; sentAt: Date | null }): Json {
    const text = r.text as { ru?: string } | string;
    return {
      id: r.id,
      businessId: r.businessId,
      text: typeof text === 'string' ? text : (text.ru ?? ''),
      ...(r.photoUrl ? { photoUrl: r.photoUrl } : {}),
      createdAt: utcToLocal(r.createdAt),
      paidWithCoins: r.paidWithCoins,
      status: r.status,
      ...(r.sentAt ? { sentAt: utcToLocal(r.sentAt) } : {}),
    };
  }

  /** Разослать одобренные (deliverApprovedNews мока): один раз, при первом чтении после решения панели */
  private async deliverDecided(businessId: string): Promise<void> {
    const pending = await this.prisma.newsPost.findMany({ where: { businessId, status: 'pending_review', moderationItemId: { not: null } } });
    if (!pending.length) return;
    const mod = await this.moderationOf(pending);
    for (const post of pending) {
      const item = mod.get(post.moderationItemId!);
      if (!item || item.status === 'pending') continue;
      if (item.status === 'rejected') {
        await this.prisma.newsPost.updateMany({ where: { id: post.id, status: 'pending_review' }, data: { status: 'rejected' } });
        continue;
      }
      const recipients = await this.newsRecipients(businessId);
      const text = typeof post.text === 'string' ? post.text : ((post.text as { ru?: string }).ru ?? '');
      await this.prisma.$transaction(async (tx) => {
        // Атомарно забрать строку: два параллельных чтения не разошлют дважды
        const taken = await tx.newsPost.updateMany({ where: { id: post.id, status: 'pending_review' }, data: { status: 'sent', sentAt: new Date(), recipientsCount: recipients.length } });
        if (!taken.count) return;
        for (const r of recipients) {
          await enqueueClientNotification(tx, {
            businessId,
            kind: 'news',
            appUserId: r.appUserId,
            title: r.businessName,
            body: text,
            dedupeKey: `news:${post.id}:${r.appUserId}`,
            inbox: { kind: 'broadcast', businessId, params: { text } },
          });
        }
      });
    }
  }

  private async newsRecipients(businessId: string): Promise<{ appUserId: string; businessName: string }[]> {
    const [business, staff] = await Promise.all([
      this.prisma.business.findUnique({ where: { id: businessId }, select: { name: true } }),
      this.prisma.staff.findMany({ where: { businessId }, select: { id: true } }),
    ]);
    const favorites = await this.prisma.favorite.findMany({
      where: { newsMuted: false, OR: [{ targetType: 'business', targetId: businessId }, { targetType: 'staff', targetId: { in: staff.map((s) => s.id) } }] },
      select: { appUserId: true },
      distinct: ['appUserId'],
    });
    return favorites.map((f) => ({ appUserId: f.appUserId, businessName: business?.name ?? 'BookTime' }));
  }

  async listNews(businessId: string): Promise<Json[]> {
    await this.deliverDecided(businessId);
    const rows = await this.prisma.newsPost.findMany({ where: { businessId }, orderBy: { createdAt: 'desc' }, take: 100 });
    return rows.map((r) => this.newsView(r));
  }

  async newsWeekStatus(businessId: string): Promise<{ used: number; free: number }> {
    const used = await this.prisma.newsPost.count({ where: { businessId, createdAt: { gt: new Date(Date.now() - 7 * DAY) } } });
    return { used, free: NEWS_FREE_PER_WEEK };
  }

  async createNews(ctx: RequestContext, businessId: string, body: NewsPostBody): Promise<Json> {
    const text = body.text.trim();
    if (!text) throw new ApiError('validation', 'Text is required', { text: 'required' });
    const now = new Date();
    const id = newId('newsPost');
    const weekKey = weekKeyOf(now);
    const row = await this.prisma.$transaction(async (tx) => {
      // «Замок» бизнеса (PLAN §4.2): бесплатный лимит 7 дней считается под блокировкой строки
      await tx.$executeRaw`INSERT INTO news_quota (business_id, week_key, sent) VALUES (${businessId}, 'roll7', 0) ON DUPLICATE KEY UPDATE business_id = business_id`;
      await tx.$queryRaw`SELECT sent FROM news_quota WHERE business_id = ${businessId} AND week_key = 'roll7' FOR UPDATE`;
      const used = await tx.newsPost.count({ where: { businessId, createdAt: { gt: new Date(now.getTime() - 7 * DAY) } } });
      const paidWithCoins = used >= NEWS_FREE_PER_WEEK;
      if (paidWithCoins) await spendCoins(tx, { businessId, amount: NEWS_EXTRA_PRICE, reason: 'newsExtra', area: 'client', refId: id, by: ctx.member?.staffId ?? 'system' });
      return tx.newsPost.create({
        data: { id, businessId, weekKey, text: J({ ru: text }), photoUrl: body.photoUrl ?? null, paidWithCoins, status: 'pending_review', createdBy: ctx.member?.staffId ?? null },
      });
    });
    // Текст и фото — только после нашей проверки (F-00-168, decision-c3 №7)
    const item = await this.moderation.submit({ kind: 'text', businessId, refId: row.id, text, imageUrl: body.photoUrl, paidCoins: row.paidWithCoins ? NEWS_EXTRA_PRICE : undefined });
    const updated = await this.prisma.newsPost.update({ where: { id: row.id }, data: { moderationItemId: item.id } });
    return this.newsView(updated);
  }

  // ─────────── Продвижение (F-00-103, F-00-167) — область business_settings 'client-promotion' ───────────

  async getPromotion(businessId: string): Promise<Json> {
    const row = await this.prisma.businessSetting.findUnique({ where: { businessId_area: { businessId, area: PROMOTION_AREA } } });
    return (row?.data as Json | undefined) ?? {};
  }

  private async savePromotion(tx: Prisma.TransactionClient, ctx: RequestContext, businessId: string, patch: Json): Promise<void> {
    const row = await tx.businessSetting.findUnique({ where: { businessId_area: { businessId, area: PROMOTION_AREA } } });
    const data = { ...((row?.data as Json | undefined) ?? {}), ...patch };
    for (const [k, v] of Object.entries(data)) if (v === undefined || v === null) delete data[k];
    await tx.businessSetting.upsert({
      where: { businessId_area: { businessId, area: PROMOTION_AREA } },
      create: { businessId, area: PROMOTION_AREA, data: J(data), updatedBy: ctx.member?.staffId ?? null },
      update: { data: J(data), updatedBy: ctx.member?.staffId ?? null, version: { increment: 1 } },
    });
  }

  async setHotSlotDiscount(ctx: RequestContext, businessId: string, percent: number | null): Promise<void> {
    await this.prisma.$transaction((tx) => this.savePromotion(tx, ctx, businessId, { hotSlotDiscountPercent: percent }));
  }

  async purchaseBoost(ctx: RequestContext, businessId: string, kind: 'search' | 'home'): Promise<void> {
    const key = kind === 'search' ? 'boostSearch' : 'boostHome';
    await this.prisma.$transaction(async (tx) => {
      await spendCoins(tx, { businessId, amount: BOOST_PRICE[kind], reason: key, area: 'client', by: ctx.member?.staffId ?? 'system' });
      await this.savePromotion(tx, ctx, businessId, { [key]: { active: true, expiresAt: utcToLocal(new Date(Date.now() + BOOST_DAYS * DAY)) } });
    });
  }
}
