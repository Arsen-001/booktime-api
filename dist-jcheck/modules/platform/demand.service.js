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
import { PrismaService } from '../../common/prisma.service.js';
import { grantCoins } from '../billing/coins.js';
import { grantFreeDays } from '../billing/subscription.js';
/** Спрос без предложения (F-00-180) и «первый в районе/сфере» (F-00-181, docs/backend/02 §19). */
function todayLocal() {
    return dayjs().format('YYYY-MM-DD');
}
function periodRange(period) {
    const t = todayLocal();
    if (period === 'week')
        return { from: dayjs(t).subtract(6, 'day').format('YYYY-MM-DD'), to: t };
    if (period === 'prevWeek')
        return { from: dayjs(t).subtract(13, 'day').format('YYYY-MM-DD'), to: dayjs(t).subtract(7, 'day').format('YYYY-MM-DD') };
    return { from: dayjs(t).subtract(29, 'day').format('YYYY-MM-DD'), to: t };
}
const capitalize = (text) => (text ? text[0].toLocaleUpperCase() + text.slice(1) : text);
/** Мирроит FIRST_AWARD_SPHERES фронта (src/api/platform/demand.ts) — вручную, каталога сфер между репо нет */
const FIRST_AWARD_SPHERES = ['nails', 'barber', 'hair', 'cosmetology', 'massage', 'dental', 'fitness', 'carwash'];
let DemandService = class DemandService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    /** Где у нас есть предложение: сфера → районы, сфера → бизнесов в городе (один проход по бизнесам/филиалам) */
    async offerIndex() {
        const [businesses, locations] = await Promise.all([
            this.prisma.business.findMany({ select: { id: true, sphereIds: true } }),
            this.prisma.location.findMany({ where: { deletedAt: null }, select: { businessId: true, district: true } }),
        ]);
        const districtsByBiz = new Map();
        for (const l of locations) {
            const set = districtsByBiz.get(l.businessId) ?? new Set();
            set.add(l.district);
            districtsByBiz.set(l.businessId, set);
        }
        const districtsBySphere = new Map();
        const cityBySphere = new Map();
        for (const b of businesses) {
            const spheres = b.sphereIds ?? [];
            for (const sph of spheres) {
                cityBySphere.set(sph, (cityBySphere.get(sph) ?? 0) + 1);
                const byDistrict = districtsBySphere.get(sph) ?? new Map();
                districtsByBiz.get(b.id)?.forEach((d) => byDistrict.set(d, (byDistrict.get(d) ?? 0) + 1));
                districtsBySphere.set(sph, byDistrict);
            }
        }
        return {
            inDistrict: (sph, d) => (sph ? (districtsBySphere.get(sph)?.get(d) ?? 0) : 0),
            inCity: (sph) => (sph ? (cityBySphere.get(sph) ?? 0) : 0),
            businesses,
        };
    }
    async getReport(period = 'week') {
        const { from, to } = periodRange(period);
        const offers = await this.offerIndex();
        const entries = await this.prisma.demandLead.findMany({
            where: { createdAt: { gte: dayjs(from).startOf('day').toDate(), lt: dayjs(to).add(1, 'day').startOf('day').toDate() } },
            select: { query: true, sphereId: true, district: true, appUserId: true, notify: true },
        });
        const byQuery = new Map();
        entries.forEach((e, i) => {
            const key = e.query.trim().toLowerCase();
            const person = e.appUserId ?? `anon_${i}`;
            const row = byQuery.get(key) ?? { query: capitalize(e.query.trim()), sphereId: e.sphereId ?? undefined, people: new Set(), requests: 0, notify: 0, districts: new Map() };
            row.people.add(person);
            row.requests += 1;
            if (e.notify)
                row.notify += 1;
            if (e.district) {
                const inDistrict = row.districts.get(e.district) ?? new Set();
                inDistrict.add(person);
                row.districts.set(e.district, inDistrict);
            }
            byQuery.set(key, row);
        });
        const groups = Array.from(byQuery.entries()).map(([key, r]) => {
            const districts = Array.from(r.districts.entries())
                .map(([district, people]) => ({ district, people: people.size, offerInDistrict: offers.inDistrict(r.sphereId, district) }))
                .sort((a, b) => a.offerInDistrict - b.offerInDistrict || b.people - a.people);
            return {
                key,
                query: r.query,
                sphereId: r.sphereId,
                people: r.people.size,
                requests: r.requests,
                notify: r.notify,
                offerInCity: offers.inCity(r.sphereId),
                districts,
                districtsWithoutOffer: districts.filter((d) => d.offerInDistrict === 0).length,
            };
        });
        groups.sort((a, b) => Number(b.districtsWithoutOffer > 0) - Number(a.districtsWithoutOffer > 0) || b.people - a.people);
        const noSphere = groups
            .filter((g) => g.offerInCity === 0)
            .map((g) => ({ key: g.key, query: g.query, sphereId: g.sphereId, people: g.people, districts: g.districts.map((d) => d.district) }));
        return {
            period,
            from,
            to,
            groups,
            noSphere,
            totalPeople: new Set(entries.map((e, i) => e.appUserId ?? `anon_${i}`)).size,
            withoutOffer: groups.filter((g) => g.districtsWithoutOffer > 0).length,
        };
    }
    /** Первый мастер в районе ИЛИ единственный в сфере по городу (F-00-181) */
    async listFirstCandidates() {
        const [businesses, locations, awards] = await Promise.all([
            this.prisma.business.findMany({ select: { id: true, name: true, sphereIds: true } }),
            this.prisma.location.findMany({ where: { deletedAt: null }, select: { businessId: true, district: true } }),
            this.prisma.firstAward.findMany(),
        ]);
        const districtsByBiz = new Map();
        for (const l of locations) {
            const set = districtsByBiz.get(l.businessId) ?? new Set();
            set.add(l.district);
            districtsByBiz.set(l.businessId, set);
        }
        const candidates = [];
        for (const sph of FIRST_AWARD_SPHERES) {
            const inCity = businesses.filter((b) => (b.sphereIds ?? []).includes(sph));
            if (inCity.length === 1) {
                const biz = inCity[0];
                candidates.push({ key: `sphere__${sph}`, businessId: biz.id, businessName: biz.name, scope: 'sphere', sphereId: sph, awarded: awards.find((a) => a.businessId === biz.id && a.scope === 'sphere' && a.sphereId === sph) });
                continue;
            }
            const byDistrict = new Map();
            inCity.forEach((b) => {
                districtsByBiz.get(b.id)?.forEach((d) => byDistrict.set(d, [...(byDistrict.get(d) ?? []), b.id]));
            });
            byDistrict.forEach((ids, d) => {
                if (ids.length !== 1)
                    return;
                const biz = inCity.find((b) => b.id === ids[0]);
                if (!biz)
                    return;
                candidates.push({
                    key: `district__${sph}__${d}`,
                    businessId: biz.id,
                    businessName: biz.name,
                    scope: 'district',
                    sphereId: sph,
                    district: d,
                    awarded: awards.find((a) => a.businessId === biz.id && a.scope === 'district' && a.sphereId === sph && a.district === d),
                });
            });
        }
        return candidates.sort((a, b) => Number(Boolean(a.awarded)) - Number(Boolean(b.awarded))).slice(0, 40);
    }
    /** Выдать «первому»: бесплатные дни (reason='first', уже принимает subscription.ts) + монеты (reason='firstAward') */
    async grantFirstAward(platformUserId, input) {
        const biz = await this.prisma.business.findUnique({ where: { id: input.businessId }, select: { id: true } });
        if (!biz)
            throw new ApiError('not_found', 'Business not found');
        const existing = await this.prisma.firstAward.findFirst({ where: { businessId: input.businessId, scope: input.scope, sphereId: input.sphereId, district: input.district ?? null } });
        if (existing)
            return existing;
        const award = await this.prisma.$transaction(async (tx) => {
            if (input.freeDays > 0)
                await grantFreeDays(tx, { businessId: input.businessId, days: input.freeDays, reason: 'first', by: platformUserId });
            if (input.coins > 0)
                await grantCoins(tx, { businessId: input.businessId, amount: input.coins, reason: 'firstAward', area: 'platform', by: platformUserId }, 'gift');
            return tx.firstAward.create({ data: { id: newId('firstAward'), businessId: input.businessId, scope: input.scope, sphereId: input.sphereId, district: input.district ?? null, freeDays: input.freeDays, coins: input.coins } });
        });
        return award;
    }
};
DemandService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [PrismaService])
], DemandService);
export { DemandService };
//# sourceMappingURL=demand.service.js.map