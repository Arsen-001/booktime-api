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
import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { LiveService } from '../../common/live/live.service.js';
import { PrismaService } from '../../common/prisma.service.js';
import { DEFAULT_TZ, localDayRangeUtc, nowLocal } from '../../common/time/time.js';
import { REDIS } from '../../common/tokens.js';
import { addDays, computeFreeSlots, computeQuickSlots, } from './engine.js';
import { personKeyOf } from './occupy.js';
export const DEFAULT_SCHEDULE_SETTINGS = {
    anySpecialistAllowed: false,
    allowOnlineOverNoShow: true,
    planningPeriodYears: 1,
    notifyMasterOnScheduleChange: false,
    skipStaffSelection: {},
    historyLimitDays: {},
    includeInFillRate: {},
    googleCalendar: {},
};
const STAFF_SELECT = {
    id: true,
    businessId: true,
    userId: true,
    name: true,
    status: true,
    calendarMode: true,
    onlineBookingEnabled: true,
    serviceIds: true,
    deletedAt: true,
    locations: { select: { locationId: true } },
};
const minutesSince = (at, dayStart) => Math.round((at.getTime() - dayStart.getTime()) / 60000);
/**
 * Свободные окна на сервере (docs/backend/04, PLAN.md §6 №6): загрузка входа из базы → чистый расчёт engine.ts →
 * кеш в Redis. Кеш сбрасывается по событию (правка графика, отметка, правила, занятость) — версией бизнеса, а не
 * перебором ключей; при записи окно всё равно проверяет «замок на мастера» (occupy.ts), кеш никогда не пропускает
 * двойную запись (04 §6).
 */
let AvailabilityService = class AvailabilityService {
    constructor(prisma, redis, live) {
        this.prisma = prisma;
        this.redis = redis;
        this.live = live;
    }
    // ─────────── загрузка ───────────
    async staffRows(db, where) {
        return db.staff.findMany({ where, select: STAFF_SELECT, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
    }
    toStaffLike(s) {
        return {
            id: s.id,
            businessId: s.businessId,
            status: s.deletedAt ? 'disabled' : s.status,
            calendarMode: s.calendarMode,
            onlineBookingEnabled: s.onlineBookingEnabled,
        };
    }
    /** Графики сотрудников с исключениями в диапазоне дат */
    async schedules(db, staffIds, from, to) {
        if (!staffIds.length)
            return [];
        const rows = await db.workSchedule.findMany({
            where: { staffId: { in: [...staffIds] } },
            include: { days: from && to ? { where: { date: { gte: from, lte: to } } } : true },
            orderBy: { createdAt: 'asc' },
        });
        return rows.map((r) => ({
            id: r.id,
            staffId: r.staffId,
            locationId: r.locationId,
            workplace: r.workplace,
            week: r.week,
            openUntil: r.openUntil,
            overrides: Object.fromEntries(r.days.map((d) => [d.date, d.hours])),
        }));
    }
    async marks(db, staffIds, from, to) {
        if (!staffIds.length)
            return [];
        const rows = await db.calendarMark.findMany({
            where: { staffId: { in: [...staffIds] }, date: { gte: from, lte: to } },
            orderBy: [{ date: 'asc' }, { fromTime: 'asc' }],
        });
        return rows.map((m) => ({
            id: m.id,
            staffId: m.staffId,
            date: m.date,
            from: m.fromTime,
            to: m.toTime,
            kind: m.kind,
            workplace: m.workplace,
            note: m.note,
        }));
    }
    /** Занятость человека в местный день (все его бизнесы, F-00-045); просроченные «держит до» не занимают */
    async busyMinutes(db, personKey, date, tz = DEFAULT_TZ, opts = {}) {
        const { from, to } = localDayRangeUtc(date, tz);
        const now = new Date();
        const rows = await db.busyBlock.findMany({
            where: {
                personKey,
                active: true,
                startAt: { lt: to },
                endAt: { gt: from },
                OR: [{ holdUntil: null }, { holdUntil: { gt: now } }],
                ...(opts.withMarks ? {} : { source: { not: 'mark_busy' } }),
            },
            orderBy: { startAt: 'asc' },
        });
        return rows.map((b) => ({
            from: Math.max(0, minutesSince(b.startAt, from)),
            to: Math.min(24 * 60, minutesSince(b.endAt, from)),
            serviceTo: Math.min(24 * 60, minutesSince(b.serviceEndAt, from)),
            source: b.source,
            sourceId: b.sourceId,
            businessId: b.businessId,
            staffId: b.staffId,
            workplace: b.workplace,
            noShow: b.noShow,
        }));
    }
    async settings(db, businessId) {
        const row = await db.businessSetting.findUnique({ where: { businessId_area: { businessId, area: 'schedule' } } });
        return { ...DEFAULT_SCHEDULE_SETTINGS, ...(row?.data ?? {}) };
    }
    async ruleSets(db, businessId) {
        const rows = await db.onlineSlotRuleSet.findMany({ where: { businessId } });
        return new Map(rows.map((r) => [
            `${r.scope}:${r.scopeId}`,
            {
                scope: r.scope,
                scopeId: r.scopeId,
                rules: r.rules ?? null,
                ownRules: r.ownRules,
                unavailable: r.unavailable ?? [],
                bufferMin: r.bufferMin,
            },
        ]));
    }
    async tzOf(db, locationId) {
        if (!locationId)
            return DEFAULT_TZ;
        const loc = await db.location.findUnique({ where: { id: locationId }, select: { tz: true } });
        return loc?.tz ?? DEFAULT_TZ;
    }
    // ─────────── окна ───────────
    /** Окна мастера на дату (режим клиента/онлайн-правил, 04 §2). null — сотрудник не найден в бизнесе. */
    async freeSlots(businessId, q) {
        return this.cached(businessId, 'free', q, () => this.computeFree(this.prisma, businessId, q));
    }
    async computeFree(db, businessId, q, preloaded) {
        const [staff] = await this.staffRows(db, { id: q.staffId, businessId });
        if (!staff)
            return [];
        const tz = await this.tzOf(db, q.locationId ?? staff.locations[0]?.locationId);
        const [schedules, marks, busy] = await Promise.all([
            this.schedules(db, [staff.id], q.date, q.date),
            this.marks(db, [staff.id], q.date, q.date),
            this.busyMinutes(db, personKeyOf(staff), q.date, tz),
        ]);
        const settings = preloaded?.settings ?? (await this.settings(db, businessId));
        const rules = preloaded?.rules ?? (await this.ruleSets(db, businessId));
        const own = rules.get(`staff:${staff.id}`);
        const rulesFor = (locationId) => (own?.ownRules ? own.rules : (rules.get(`location:${locationId}`)?.rules ?? null));
        const unavailableFor = (locationId) => [...(rules.get(`location:${locationId}`)?.unavailable ?? []), ...(own?.unavailable ?? [])];
        const bufferFor = (locationId) => own?.bufferMin ?? rules.get(`location:${locationId}`)?.bufferMin ?? 0;
        let serviceWindow = null;
        let resourcesFor;
        if (q.serviceId) {
            const svc = await db.service.findFirst({ where: { id: q.serviceId, businessId }, select: { id: true, onlineWindow: true } });
            serviceWindow = svc?.onlineWindow ? { ...svc.onlineWindow, serviceId: svc.id } : null;
            resourcesFor = await this.resourceNeeds(db, businessId, q.serviceId, q.date, tz, settings.allowOnlineOverNoShow);
        }
        return computeFreeSlots({
            staff: this.toStaffLike(staff),
            schedules,
            marks,
            busy,
            date: q.date,
            now: nowLocal(tz),
            durationMin: q.durationMin,
            durationMax: q.durationMax,
            bufferAfterMin: q.bufferAfterMin,
            locationId: q.locationId,
            stepMin: q.stepMin,
            rulesFor,
            unavailableFor,
            bufferFor,
            serviceWindow,
            resourcesFor,
            overNoShow: settings.allowOnlineOverNoShow,
        });
    }
    /** Ресурсы услуги по местам и их занятость в день (F-02-064, F-02-070) */
    async resourceNeeds(db, businessId, serviceId, date, tz, overNoShow) {
        const resources = (await db.resource.findMany({ where: { businessId, active: true } })).filter((r) => (r.serviceIds ?? []).includes(serviceId));
        if (!resources.length)
            return undefined;
        const { from, to } = localDayRangeUtc(date, tz);
        const now = new Date();
        const busy = await db.resourceBusy.findMany({
            where: {
                resourceId: { in: resources.map((r) => r.id) },
                active: true,
                startAt: { lt: to },
                endAt: { gt: from },
                OR: [{ holdUntil: null }, { holdUntil: { gt: now } }],
                ...(overNoShow ? { noShow: false } : {}),
            },
        });
        return (locationId) => resources
            .filter((r) => r.locationId === locationId)
            .map((r) => ({
            resourceId: r.id,
            instances: (r.instances ?? []).length,
            used: busy.filter((b) => b.resourceId === r.id).map((b) => [minutesSince(b.startAt, from), minutesSince(b.endAt, from)]),
        }));
    }
    /** Ближайшие окна на N дней (каталог «кто когда свободен») */
    async nearestSlots(businessId, q) {
        const limit = Math.min(50, q.limit ?? 5);
        const days = Math.min(60, q.days ?? 14);
        const today = nowLocal().slice(0, 10);
        const out = [];
        for (let i = 0; i < days && out.length < limit; i++)
            out.push(...(await this.freeSlots(businessId, { ...q, date: addDays(today, i) })));
        return out.slice(0, limit);
    }
    /** «Любой специалист» (F-02-079): окно — случайный свободный мастер из пула «Пропуск выбора сотрудника» */
    async anySpecialistSlots(businessId, q) {
        const settings = await this.settings(this.prisma, businessId);
        if (!settings.anySpecialistAllowed)
            return [];
        const pool = (await this.staffRows(this.prisma, { businessId, status: 'active', deletedAt: null, onlineBookingEnabled: true })).filter((s) => s.locations.some((l) => l.locationId === q.locationId) &&
            (settings.skipStaffSelection[s.id] ?? false) &&
            (!q.serviceId || (s.serviceIds ?? []).includes(q.serviceId)));
        const byTime = new Map();
        for (const s of pool) {
            for (const slot of await this.freeSlots(businessId, { ...q, staffId: s.id }))
                byTime.set(slot.start, [...(byTime.get(slot.start) ?? []), slot]);
        }
        return [...byTime.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([, candidates]) => ({ ...candidates[Math.floor(Math.random() * candidates.length)], candidateIds: candidates.map((c) => c.staffId) }));
    }
    /** Окна быстрой записи мастера (F-00-060): база без правил онлайн-записи, шаг 15 */
    async quickSlots(businessId, q) {
        const [staff] = await this.staffRows(this.prisma, { id: q.staffId, businessId });
        if (!staff)
            return [];
        const svc = q.serviceId ? await this.prisma.service.findFirst({ where: { id: q.serviceId, businessId } }) : null;
        const tz = await this.tzOf(this.prisma, q.locationId ?? staff.locations[0]?.locationId);
        const [schedules, marks, busy] = await Promise.all([
            this.schedules(this.prisma, [staff.id], q.date, q.date),
            this.marks(this.prisma, [staff.id], q.date, q.date),
            this.busyMinutes(this.prisma, personKeyOf(staff), q.date, tz),
        ]);
        return computeQuickSlots({
            staff: this.toStaffLike(staff),
            schedules,
            marks,
            busy,
            date: q.date,
            now: nowLocal(tz),
            durationMin: svc ? (svc.durationMax ?? svc.durationMin) : 30,
            bufferAfterMin: svc?.bufferAfterMin ?? 0,
            locationId: q.locationId,
        });
    }
    // ─────────── кеш и события ───────────
    async cached(businessId, kind, q, compute) {
        const ver = (await this.redis.get(`slotsver:biz:${businessId}`)) ?? '0';
        const bucket = Math.floor(Date.now() / 300_000);
        const hash = createHash('sha1').update(JSON.stringify(q)).digest('hex').slice(0, 16);
        const key = `slots:${businessId}:${ver}:${kind}:${bucket}:${hash}`;
        const hit = await this.redis.get(key);
        if (hit)
            return JSON.parse(hit);
        const value = await compute();
        await this.redis.set(key, JSON.stringify(value), 'EX', 300);
        return value;
    }
    /**
     * После коммита правки: сбросить кеш окон у всех бизнесов, где работают эти люди (запись в одном месте закрывает
     * время в другом, F-00-045), и сказать открытым экранам перечитать (SSE, F-00-001 «без перезагрузки»).
     */
    async invalidate(input) {
        const businessIds = new Set(input.businessIds ?? []);
        const staffIds = new Set(input.staffIds ?? []);
        if (input.personKeys?.length) {
            const rows = await this.prisma.staff.findMany({
                where: { OR: [{ userId: { in: input.personKeys } }, { id: { in: input.personKeys } }] },
                select: { id: true, businessId: true },
            });
            for (const r of rows) {
                businessIds.add(r.businessId);
                staffIds.add(r.id);
            }
        }
        for (const b of businessIds)
            await this.redis.incr(`slotsver:biz:${b}`);
        const dates = (input.dates ?? []).slice(0, 31);
        for (const s of staffIds)
            await this.live.publish(`staff:${s}`, { type: 'slots.changed', data: { staffId: s, dates } });
        for (const b of businessIds) {
            for (const d of dates)
                await this.live.publish(`biz:${b}:day:${d}`, { type: 'schedule.changed', data: { staffIds: [...staffIds], date: d } });
        }
    }
};
AvailabilityService = __decorate([
    Injectable(),
    __param(1, Inject(REDIS)),
    __metadata("design:paramtypes", [PrismaService, Function, LiveService])
], AvailabilityService);
export { AvailabilityService };
//# sourceMappingURL=availability.service.js.map