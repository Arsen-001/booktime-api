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
import dayjs from 'dayjs';
import { ApiError } from '../../common/errors/api-error.js';
import { newId } from '../../common/ids/ids.js';
import { money, moneyToJson } from '../../common/money/money.js';
import { PrismaService } from '../../common/prisma.service.js';
import { AD_PLACEMENTS, adState } from './ads.constants.js';
function todayLocal() {
    return dayjs().format('YYYY-MM-DD');
}
/** Реклама (F-00-163…166) и сторис-места (F-00-160), docs/backend/02 §19: 1:1 с src/api/platform/ads.ts мока. */
let AdsService = class AdsService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    listPlacements() {
        return AD_PLACEMENTS;
    }
    async toView(ad) {
        const stats = await this.prisma.adDayStat.findMany({ where: { adId: ad.id } });
        const totals = stats.reduce((acc, d) => ({ views: acc.views + d.views, clicks: acc.clicks + d.clicks }), { views: 0, clicks: 0 });
        return this.view(ad, totals);
    }
    view(ad, totals) {
        const placement = AD_PLACEMENTS.find((p) => p.id === ad.placementId);
        return {
            id: ad.id,
            kind: ad.kind,
            title: ad.title,
            text: ad.text ?? undefined,
            imageUrl: ad.imageUrl ?? undefined,
            ctaUrl: ad.ctaUrl ?? undefined,
            advertiser: { name: ad.advertiserName, contact: ad.advertiserContact },
            placementId: ad.placementId,
            target: { sphereIds: ad.targetSphereIds ?? [], districts: ad.targetDistricts ?? [], size: ad.targetSize, minStars: ad.targetMinStars ?? undefined },
            productKeywords: ad.productKeywords ?? [],
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
    async list(kind) {
        const rows = await this.prisma.ad.findMany({ where: kind ? { kind } : undefined, orderBy: { createdAt: 'desc' }, take: 500 });
        const ids = rows.map((r) => r.id);
        const stats = await this.prisma.adDayStat.findMany({ where: { adId: { in: ids } } });
        const byAd = new Map();
        for (const s of stats) {
            const t = byAd.get(s.adId) ?? { views: 0, clicks: 0 };
            byAd.set(s.adId, { views: t.views + s.views, clicks: t.clicks + s.clicks });
        }
        return rows.map((ad) => this.view(ad, byAd.get(ad.id) ?? { views: 0, clicks: 0 }));
    }
    async create(input) {
        if (!input.title.trim() || !input.placementId)
            throw new ApiError('validation', 'Title and placement required');
        if (input.endDate < input.startDate)
            throw new ApiError('validation', 'endDate before startDate', { endDate: 'range' });
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
    async setPaused(id, paused) {
        const n = await this.prisma.ad.updateMany({ where: { id }, data: { paused } });
        if (!n.count)
            throw new ApiError('not_found', 'Ad not found');
        return this.toView(await this.prisma.ad.findUniqueOrThrow({ where: { id } }));
    }
    /** Охват рекламы поставщиков: сколько бизнесов её увидит (только согласившиеся, F-00-164) */
    async reach() {
        const [businesses, optedIn] = await Promise.all([this.prisma.business.count(), this.prisma.business.count({ where: { adsOptIn: true } })]);
        return { businesses, optedIn };
    }
    async businessAdSize(businessId) {
        const business = await this.prisma.business.findUnique({ where: { id: businessId }, select: { kind: true } });
        if (!business)
            return 'any';
        if (business.kind === 'individual')
            return 'individual';
        const staffCount = await this.prisma.staff.count({ where: { businessId, status: 'active' } });
        return staffCount > 3 ? 'salonLarge' : 'salonSmall';
    }
    /** Для приложения клиента и кабинета: объявления места на дату (F-00-163, публично) */
    async getActive(placementId, ctx) {
        const t = ctx.date ?? todayLocal();
        const placement = AD_PLACEMENTS.find((p) => p.id === placementId);
        if (placement?.audience === 'business' && ctx.businessId) {
            const biz = await this.prisma.business.findUnique({ where: { id: ctx.businessId }, select: { adsOptIn: true } });
            if (!biz?.adsOptIn)
                return [];
        }
        const size = ctx.businessId ? await this.businessAdSize(ctx.businessId) : undefined;
        const rows = await this.prisma.ad.findMany({ where: { placementId, paused: false, startDate: { lte: t }, endDate: { gte: t } } });
        const filtered = rows.filter((a) => {
            const sphereIds = a.targetSphereIds ?? [];
            const districts = a.targetDistricts ?? [];
            if (ctx.sphereId && sphereIds.length && !sphereIds.includes(ctx.sphereId))
                return false;
            if (ctx.district && districts.length && !districts.includes(ctx.district))
                return false;
            if (size && a.targetSize !== 'any' && a.targetSize !== size)
                return false;
            return true;
        });
        return Promise.all(filtered.map((a) => this.toView(a)));
    }
    /** F-00-165: предложение поставщика у товара на исходе — только в даты объявления, по ключевым словам */
    async getStockOffer(businessId, productName) {
        const biz = await this.prisma.business.findUnique({ where: { id: businessId }, select: { adsOptIn: true } });
        if (!biz?.adsOptIn)
            return undefined;
        const t = todayLocal();
        const name = productName.toLowerCase();
        const rows = await this.prisma.ad.findMany({ where: { placementId: 'pl_stock', paused: false, startDate: { lte: t }, endDate: { gte: t } } });
        const ad = rows.find((a) => (a.productKeywords ?? []).some((k) => name.includes(k.toLowerCase())));
        return ad ? this.toView(ad) : undefined;
    }
    async track(id, field) {
        const exists = await this.prisma.ad.findUnique({ where: { id }, select: { id: true } });
        if (!exists)
            return; // тихо — как мок: показ рекламы, которую сняли между запросами, не ошибка клиента
        const date = todayLocal();
        // Атомарный upsert-инкремент (не read-modify-write) — параллельные показы не теряют счёт
        if (field === 'views')
            await this.prisma.$executeRaw `INSERT INTO ad_day_stats (ad_id, date, views, clicks) VALUES (${id}, ${date}, 1, 0) ON DUPLICATE KEY UPDATE views = views + 1`;
        else
            await this.prisma.$executeRaw `INSERT INTO ad_day_stats (ad_id, date, views, clicks) VALUES (${id}, ${date}, 0, 1) ON DUPLICATE KEY UPDATE clicks = clicks + 1`;
    }
    trackImpression(id) {
        return this.track(id, 'views');
    }
    trackClick(id) {
        return this.track(id, 'clicks');
    }
};
AdsService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [PrismaService])
], AdsService);
export { AdsService };
//# sourceMappingURL=ads.service.js.map