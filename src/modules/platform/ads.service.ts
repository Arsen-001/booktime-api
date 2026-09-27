import { Injectable } from '@nestjs/common';
import dayjs from 'dayjs';
import type { Prisma } from '../../generated/prisma/client.js';
import { ApiError } from '../../common/errors/api-error.js';
import { newId } from '../../common/ids/ids.js';
import { money, moneyToJson } from '../../common/money/money.js';
import { PrismaService } from '../../common/prisma.service.js';
import { AD_PLACEMENTS, adState } from './ads.constants.js';

function todayLocal(): string {
  return dayjs().format('YYYY-MM-DD');
}

type AdInput = {
  kind: 'banner' | 'supplier';
  title: string;
  text?: string;
  imageUrl?: string;
  ctaUrl?: string;
  advertiser: { name: string; contact: string };
  placementId: string;
  target: { sphereIds: string[]; districts: string[]; size: string; minStars?: number };
  productKeywords: string[];
  startDate: string;
  endDate: string;
  price: number;
  paused?: boolean;
  supportTicketId?: string;
};

/** Реклама (F-00-163…166) и сторис-места (F-00-160), docs/backend/02 §19: 1:1 с src/api/platform/ads.ts мока. */
@Injectable()
export class AdsService {
  constructor(private readonly prisma: PrismaService) {}

  listPlacements() {
    return AD_PLACEMENTS;
  }

  private async toView(ad: Prisma.AdGetPayload<object>) {
    const stats = await this.prisma.adDayStat.findMany({ where: { adId: ad.id } });
    const totals = stats.reduce((acc, d) => ({ views: acc.views + d.views, clicks: acc.clicks + d.clicks }), { views: 0, clicks: 0 });
    return this.view(ad, totals);
  }

  private view(ad: Prisma.AdGetPayload<object>, totals: { views: number; clicks: number }) {
    const placement = AD_PLACEMENTS.find((p) => p.id === ad.placementId);
    return {
      id: ad.id,
      kind: ad.kind as 'banner' | 'supplier',
      title: ad.title,
      text: ad.text ?? undefined,
      imageUrl: ad.imageUrl ?? undefined,
      ctaUrl: ad.ctaUrl ?? undefined,
      advertiser: { name: ad.advertiserName, contact: ad.advertiserContact },
      placementId: ad.placementId,
      target: { sphereIds: (ad.targetSphereIds as string[]) ?? [], districts: (ad.targetDistricts as string[]) ?? [], size: ad.targetSize, minStars: ad.targetMinStars ?? undefined },
      productKeywords: (ad.productKeywords as string[]) ?? [],
      startDate: ad.startDate,
      endDate: ad.endDate,
      price: moneyToJson(ad.price),
      paused: ad.paused,
      supportTicketId: ad.supportTicketId ?? undefined,
      createdAt: ad.createdAt.toISOString(),
      state: adState(ad, todayLocal()),
      views: totals.views,
      clicks: totals.clicks,
      placementName: placement?.name,
    };
  }

  async list(kind?: 'banner' | 'supplier') {
    const rows = await this.prisma.ad.findMany({ where: kind ? { kind } : undefined, orderBy: { createdAt: 'desc' }, take: 500 });
    const ids = rows.map((r) => r.id);
    const stats = await this.prisma.adDayStat.findMany({ where: { adId: { in: ids } } });
    const byAd = new Map<string, { views: number; clicks: number }>();
    for (const s of stats) {
      const t = byAd.get(s.adId) ?? { views: 0, clicks: 0 };
      byAd.set(s.adId, { views: t.views + s.views, clicks: t.clicks + s.clicks });
    }
    return rows.map((ad) => this.view(ad, byAd.get(ad.id) ?? { views: 0, clicks: 0 }));
  }

  async create(input: AdInput) {
    if (!input.title.trim() || !input.placementId) throw new ApiError('validation', 'Title and placement required');
    if (input.endDate < input.startDate) throw new ApiError('validation', 'endDate before startDate', { endDate: 'range' });
    const ad = await this.prisma.ad.create({
      data: {
        id: newId('ad'),
        kind: input.kind,
        title: input.title.trim(),
        text: input.text,
        imageUrl: input.imageUrl,
        ctaUrl: input.ctaUrl,
        advertiserName: input.advertiser.name,
        advertiserContact: input.advertiser.contact,
        placementId: input.placementId,
        targetSphereIds: input.target.sphereIds,
        targetDistricts: input.target.districts,
        targetSize: input.target.size,
        targetMinStars: input.target.minStars,
        productKeywords: input.productKeywords,
        startDate: input.startDate,
        endDate: input.endDate,
        price: money(input.price),
        paused: input.paused ?? false,
        supportTicketId: input.supportTicketId,
      },
    });
    return this.toView(ad);
  }

  async setPaused(id: string, paused: boolean) {
    const n = await this.prisma.ad.updateMany({ where: { id }, data: { paused } });
    if (!n.count) throw new ApiError('not_found', 'Ad not found');
    return this.toView(await this.prisma.ad.findUniqueOrThrow({ where: { id } }));
  }

  /** Охват рекламы поставщиков: сколько бизнесов её увидит (только согласившиеся, F-00-164) */
  async reach() {
    const [businesses, optedIn] = await Promise.all([this.prisma.business.count(), this.prisma.business.count({ where: { adsOptIn: true } })]);
    return { businesses, optedIn };
  }

  private async businessAdSize(businessId: string): Promise<string> {
    const business = await this.prisma.business.findUnique({ where: { id: businessId }, select: { kind: true } });
    if (!business) return 'any';
    if (business.kind === 'individual') return 'individual';
    const staffCount = await this.prisma.staff.count({ where: { businessId, status: 'active' } });
    return staffCount > 3 ? 'salonLarge' : 'salonSmall';
  }

  /** Для приложения клиента и кабинета: объявления места на дату (F-00-163, публично) */
  async getActive(placementId: string, ctx: { date?: string; businessId?: string; district?: string; sphereId?: string }) {
    const t = ctx.date ?? todayLocal();
    const placement = AD_PLACEMENTS.find((p) => p.id === placementId);
    if (placement?.audience === 'business' && ctx.businessId) {
      const biz = await this.prisma.business.findUnique({ where: { id: ctx.businessId }, select: { adsOptIn: true } });
      if (!biz?.adsOptIn) return [];
    }
    const size = ctx.businessId ? await this.businessAdSize(ctx.businessId) : undefined;
    const rows = await this.prisma.ad.findMany({ where: { placementId, paused: false, startDate: { lte: t }, endDate: { gte: t } } });
    const filtered = rows.filter((a) => {
      const sphereIds = (a.targetSphereIds as string[]) ?? [];
      const districts = (a.targetDistricts as string[]) ?? [];
      if (ctx.sphereId && sphereIds.length && !sphereIds.includes(ctx.sphereId)) return false;
      if (ctx.district && districts.length && !districts.includes(ctx.district)) return false;
      if (size && a.targetSize !== 'any' && a.targetSize !== size) return false;
      return true;
    });
    return Promise.all(filtered.map((a) => this.toView(a)));
  }

  /** F-00-165: предложение поставщика у товара на исходе — только в даты объявления, по ключевым словам */
  async getStockOffer(businessId: string, productName: string) {
    const biz = await this.prisma.business.findUnique({ where: { id: businessId }, select: { adsOptIn: true } });
    if (!biz?.adsOptIn) return undefined;
    const t = todayLocal();
    const name = productName.toLowerCase();
    const rows = await this.prisma.ad.findMany({ where: { placementId: 'pl_stock', paused: false, startDate: { lte: t }, endDate: { gte: t } } });
    const ad = rows.find((a) => ((a.productKeywords as string[]) ?? []).some((k) => name.includes(k.toLowerCase())));
    return ad ? this.toView(ad) : undefined;
  }

  private async track(id: string, field: 'views' | 'clicks') {
    const exists = await this.prisma.ad.findUnique({ where: { id }, select: { id: true } });
    if (!exists) return; // тихо — как мок: показ рекламы, которую сняли между запросами, не ошибка клиента
    const date = todayLocal();
    // Атомарный upsert-инкремент (не read-modify-write) — параллельные показы не теряют счёт
    if (field === 'views') await this.prisma.$executeRaw`INSERT INTO ad_day_stats (ad_id, date, views, clicks) VALUES (${id}, ${date}, 1, 0) ON DUPLICATE KEY UPDATE views = views + 1`;
    else await this.prisma.$executeRaw`INSERT INTO ad_day_stats (ad_id, date, views, clicks) VALUES (${id}, ${date}, 0, 1) ON DUPLICATE KEY UPDATE clicks = clicks + 1`;
  }

  trackImpression(id: string) {
    return this.track(id, 'views');
  }

  trackClick(id: string) {
    return this.track(id, 'clicks');
  }
}
