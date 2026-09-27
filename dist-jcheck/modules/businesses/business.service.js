var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { onBusinessRegistered } from '../billing/registration.js';
import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { ApiError } from '../../common/errors/api-error.js';
import { DbMembership } from '../../common/http/membership.js';
import { updateVersioned } from '../../common/http/version.js';
import { newId } from '../../common/ids/ids.js';
import { LiveService } from '../../common/live/live.service.js';
import { normalizePhone } from '../../common/phone.js';
import { PrismaService } from '../../common/prisma.service.js';
import { slugify } from '../../common/text.js';
import { utcToLocalDate } from '../../common/time/time.js';
import { categoryView } from '../services/services.views.js';
import { serviceView } from '../services/services.views.js';
import { resourceView } from '../resources/resources.views.js';
import { businessView, locationView, networkView, staffViewWithLogin } from './views.js';
/** Значение JSON-колонки: null — SQL NULL («нет поля» у экрана) */
const J = (v) => (v === null ? Prisma.DbNull : v);
const STAFF_INCLUDE = {
    locations: { select: { locationId: true } },
    logins: { select: { login: true, disabledAt: true } },
};
/** Свободный slug: база из названия, занято — «-2», «-3»… (как uniqueBusinessSlug фронта) */
export async function uniqueSlug(tx, name) {
    const base = slugify(name) || 'business';
    const taken = new Set((await tx.business.findMany({ where: { slug: { startsWith: base } }, select: { slug: true } })).map((b) => b.slug));
    if (!taken.has(base))
        return base;
    let i = 2;
    while (taken.has(`${base}-${i}`))
        i++;
    return `${base}-${i}`;
}
let BusinessService = class BusinessService {
    constructor(prisma, audit, membership, live) {
        this.prisma = prisma;
        this.audit = audit;
        this.membership = membership;
        this.live = live;
    }
    // ─────────── регистрация (F-00-035, F-00-052, В-02) ───────────
    async register(ctx, input) {
        const session = ctx.session;
        if (session.staffLoginId)
            throw new ApiError('forbidden', 'Admin login cannot register a business');
        const phone = normalizePhone(input.phone);
        if (!phone)
            throw new ApiError('invalid_phone', 'Phone must be +374');
        const name = input.name.trim();
        if (!name)
            throw new ApiError('bad_name', 'Name required');
        if (!input.sphereIds.length)
            throw new ApiError('bad_sphere', 'At least one sphere');
        const user = await this.prisma.user.findUniqueOrThrow({ where: { id: session.userId } });
        const created = await this.prisma.$transaction(async (tx) => {
            const businessId = newId('business');
            const locationId = newId('location');
            const staffId = newId('staff');
            const slug = await uniqueSlug(tx, name);
            await tx.business.create({
                data: {
                    id: businessId,
                    kind: input.kind,
                    name,
                    slug,
                    sphereIds: input.sphereIds,
                    ownerStaffId: staffId,
                    phone,
                    photos: [],
                    // В-02: настраивает бесплатно, клиентам бизнес виден после оплаты или промокода (этап 18)
                    status: 'draft',
                    signupPromoCode: input.promoCode?.trim() || null,
                    createdBy: session.userId,
                    updatedBy: session.userId,
                },
            });
            await tx.location.create({
                data: {
                    id: locationId,
                    businessId,
                    name: { ru: name },
                    address: { ru: input.address?.trim() ?? '' },
                    district: input.district ?? 'kentron',
                    phone,
                    createdBy: session.userId,
                    updatedBy: session.userId,
                },
            });
            await tx.staff.create({
                data: {
                    id: staffId,
                    businessId,
                    userId: session.userId,
                    name: input.ownerName?.trim() || user.name,
                    phone,
                    role: 'owner',
                    roleTemplateId: 'owner',
                    status: 'active',
                    sphereIds: input.sphereIds,
                    photos: [],
                    materials: [],
                    workplaces: ['salon'],
                    serviceIds: [],
                    calendarMode: input.calendarMode ?? 'free',
                    confirmMode: 'manual', // В-03
                    colorIndex: 1,
                    hiredAt: utcToLocalDate(new Date()),
                    createdBy: session.userId,
                    updatedBy: session.userId,
                    locations: { create: [{ locationId }] },
                },
            });
            await this.audit.record(tx, { ...ctx, member: null }, {
                action: 'create',
                entityType: 'business',
                entityId: businessId,
                businessId,
                after: { name, kind: input.kind, sphereIds: input.sphereIds, slug },
            });
            await tx.session.update({ where: { id: session.sessionId }, data: { mode: 'business', activeBusinessId: businessId } });
            // Этап 18: подписка (В-02: unpaid до оплаты) и промокод регистрации (В-13) — в той же транзакции
            const promoApplied = await onBusinessRegistered(tx, businessId, input.promoCode, session.userId);
            return { businessId, promoApplied };
        });
        const [m] = (await this.membership.list(session.userId)).filter((x) => x.businessId === created.businessId);
        return {
            businessId: created.businessId,
            persona: input.kind === 'individual' ? 'individual' : 'owner',
            promoApplied: created.promoApplied,
            membership: m ?? null,
            core: await this.core(created.businessId, [created.businessId]),
        };
    }
    // ─────────── чтение ───────────
    /** Бизнесы, филиалы, сотрудники и сеть — одним ответом (кабинет и зеркало ядра во фронте) */
    async core(businessId, businessIds) {
        const ids = businessIds.includes(businessId) ? businessIds : [businessId, ...businessIds];
        const [businesses, locations, staff, categories, services, resources] = await Promise.all([
            this.prisma.business.findMany({ where: { id: { in: ids } }, orderBy: { createdAt: 'asc' } }),
            this.prisma.location.findMany({ where: { businessId: { in: ids }, deletedAt: null }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }),
            this.prisma.staff.findMany({ where: { businessId: { in: ids }, deletedAt: null }, include: STAFF_INCLUDE, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }),
            this.prisma.serviceCategory.findMany({ where: { businessId: { in: ids } }, orderBy: [{ sortOrder: 'asc' }] }),
            this.prisma.service.findMany({ where: { businessId: { in: ids } }, orderBy: [{ order: 'asc' }] }),
            this.prisma.resource.findMany({ where: { businessId: { in: ids } } }),
        ]);
        const networkId = businesses.find((b) => b.id === businessId)?.networkId;
        const network = networkId ? await this.prisma.network.findUnique({ where: { id: networkId }, include: { businesses: { select: { id: true }, where: { leftAt: null } } } }) : null;
        return {
            businesses: businesses.map((b) => businessView(b, locations.filter((l) => l.businessId === b.id).map((l) => l.id))),
            locations: locations.map(locationView),
            staff: staff.map(staffViewWithLogin),
            networks: network ? [networkView(network, network.businesses.map((b) => b.id))] : [],
            // Каталог (этап 4) — зеркало во фронте кладёт это в core.serviceCategories/services/resources,
            // чтобы разделы, ещё живущие на моке (журнал, график, клиент, online), видели настоящий каталог
            serviceCategories: categories.map(categoryView),
            services: services.map(serviceView),
            resources: resources.map(resourceView),
        };
    }
    async get(businessId) {
        const b = await this.prisma.business.findUnique({ where: { id: businessId } });
        if (!b)
            throw new ApiError('not_found', 'Business not found');
        const locations = await this.prisma.location.findMany({ where: { businessId, deletedAt: null }, select: { id: true }, orderBy: { sortOrder: 'asc' } });
        return businessView(b, locations.map((l) => l.id));
    }
    // ─────────── правка профиля (F-15-097…120) ───────────
    async patch(ctx, businessId, input, version) {
        const before = await this.prisma.business.findUnique({ where: { id: businessId } });
        if (!before)
            throw new ApiError('not_found', 'Business not found');
        const data = { updatedBy: ctx.member.staffId };
        if (input.name !== undefined) {
            if (!input.name.trim())
                throw new ApiError('bad_name', 'Name required');
            data.name = input.name.trim();
        }
        if (input.phone !== undefined) {
            const phone = normalizePhone(input.phone);
            if (!phone)
                throw new ApiError('invalid_phone', 'Phone must be +374');
            data.phone = phone;
        }
        if (input.sphereIds !== undefined) {
            if (!input.sphereIds.length)
                throw new ApiError('bad_sphere', 'At least one sphere');
            data.sphereIds = input.sphereIds;
        }
        if (input.description !== undefined)
            data.description = J(input.description);
        if (input.logoUrl !== undefined)
            data.logoUrl = input.logoUrl;
        if (input.photos !== undefined)
            data.photos = input.photos.slice(0, 6);
        if (input.socials !== undefined)
            data.socials = J(input.socials);
        if (input.bookingRules !== undefined)
            data.bookingRules = J(input.bookingRules);
        if (input.brandName !== undefined)
            data.brandName = input.brandName?.trim() || null;
        if (input.forbidHomeBookingsDuringShift !== undefined)
            data.forbidHomeBookingsDuringShift = input.forbidHomeBookingsDuringShift;
        if (input.adsOptIn !== undefined)
            data.adsOptIn = input.adsOptIn;
        await this.prisma.$transaction(async (tx) => {
            await updateVersioned(tx.business, { id: businessId }, version, data);
            const after = await tx.business.findUniqueOrThrow({ where: { id: businessId } });
            await this.audit.record(tx, ctx, {
                action: 'update',
                entityType: 'business',
                entityId: businessId,
                businessId,
                before: pickAudit(before),
                after: pickAudit(after),
            });
        });
        await this.live.publish(`biz:${businessId}:day:${utcToLocalDate(new Date())}`, { type: 'business.changed', data: { businessId } });
        return this.get(businessId);
    }
    // ─────────── филиалы (F-15-104…106, F-11-001…023) ───────────
    async locations(businessId) {
        const rows = await this.prisma.location.findMany({ where: { businessId, deletedAt: null }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
        return rows.map(locationView);
    }
    async addLocation(ctx, businessId, input) {
        const name = input.name.ru?.trim();
        if (!name)
            throw new ApiError('bad_name', 'Name required');
        const id = newId('location');
        await this.prisma.$transaction(async (tx) => {
            const count = await tx.location.count({ where: { businessId, deletedAt: null } });
            await tx.location.create({
                data: {
                    id,
                    businessId,
                    name: input.name,
                    address: (input.address ?? { ru: '' }),
                    district: input.district ?? 'kentron',
                    phone: input.phone ? (normalizePhone(input.phone) ?? null) : null,
                    hoursText: input.hoursText ?? null,
                    tz: input.timezone ?? 'Asia/Yerevan',
                    sortOrder: count,
                    createdBy: ctx.member.staffId,
                    updatedBy: ctx.member.staffId,
                },
            });
            await this.audit.record(tx, ctx, { action: 'create', entityType: 'location', entityId: id, businessId, after: { name } });
        });
        return locationView(await this.prisma.location.findUniqueOrThrow({ where: { id } }));
    }
    async patchLocation(ctx, businessId, locationId, input, version) {
        const before = await this.prisma.location.findFirst({ where: { id: locationId, businessId, deletedAt: null } });
        if (!before)
            throw new ApiError('not_found', 'Location not found');
        const data = { updatedBy: ctx.member.staffId };
        if (input.name !== undefined)
            data.name = input.name;
        if (input.address !== undefined)
            data.address = input.address;
        if (input.district !== undefined)
            data.district = input.district;
        if (input.yandexMapsUrl !== undefined)
            data.yandexMapsUrl = input.yandexMapsUrl || null;
        if (input.phone !== undefined) {
            const phone = input.phone ? normalizePhone(input.phone) : null;
            if (input.phone && !phone)
                throw new ApiError('invalid_phone', 'Phone must be +374');
            data.phone = phone;
        }
        if (input.extraPhones !== undefined)
            data.extraPhones = input.extraPhones;
        if (input.hoursText !== undefined)
            data.hoursText = input.hoursText || null;
        if (input.openHours !== undefined)
            data.openHours = J(input.openHours);
        if (input.journalKind !== undefined)
            data.journalKind = input.journalKind;
        if (input.timezone !== undefined)
            data.tz = input.timezone;
        await this.prisma.$transaction(async (tx) => {
            await updateVersioned(tx.location, { id: locationId }, version, data);
            const after = await tx.location.findUniqueOrThrow({ where: { id: locationId } });
            await this.audit.record(tx, ctx, {
                action: 'update',
                entityType: 'location',
                entityId: locationId,
                businessId,
                before: locationView(before),
                after: locationView(after),
            });
        });
        return locationView(await this.prisma.location.findUniqueOrThrow({ where: { id: locationId } }));
    }
    /** «Я сейчас на месте работы» (F-00-075): точка филиала; координаты мастера в логи не пишутся */
    async markHere(ctx, businessId, locationId, input) {
        const loc = await this.prisma.location.findFirst({ where: { id: locationId, businessId, deletedAt: null } });
        if (!loc)
            throw new ApiError('not_found', 'Location not found');
        await this.prisma.location.update({
            where: { id: locationId },
            data: { lat: input.lat.toFixed(6), lng: input.lng.toFixed(6), coordsAt: new Date(), updatedBy: ctx.member.staffId, version: { increment: 1 } },
        });
        return locationView(await this.prisma.location.findUniqueOrThrow({ where: { id: locationId } }));
    }
    // ─────────── настройки разделов (01 §2) ───────────
    async getSetting(businessId, area) {
        const row = await this.prisma.businessSetting.findUnique({ where: { businessId_area: { businessId, area } } });
        return { area, data: (row?.data ?? {}), version: row?.version ?? 0 };
    }
    async putSetting(ctx, businessId, area, data, version) {
        await this.prisma.$transaction(async (tx) => {
            const before = await tx.businessSetting.findUnique({ where: { businessId_area: { businessId, area } } });
            if (version !== undefined && (before?.version ?? 0) !== version)
                throw new ApiError('conflict', 'Changed by someone else');
            await tx.businessSetting.upsert({
                where: { businessId_area: { businessId, area } },
                create: { businessId, area, data: data, updatedBy: ctx.member.staffId },
                update: { data: data, updatedBy: ctx.member.staffId, version: { increment: 1 } },
            });
            await this.audit.record(tx, ctx, {
                action: 'update',
                entityType: `settings.${area}`.slice(0, 40),
                entityId: businessId,
                businessId,
                before: (before?.data ?? {}),
                after: data,
            });
        });
        return this.getSetting(businessId, area);
    }
};
BusinessService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [PrismaService,
        AuditService,
        DbMembership,
        LiveService])
], BusinessService);
export { BusinessService };
function pickAudit(b) {
    return {
        name: b.name,
        phone: b.phone,
        sphereIds: b.sphereIds,
        status: b.status,
        brandName: b.brandName,
        socials: b.socials,
        description: b.description,
        forbidHomeBookingsDuringShift: b.forbidHomeBookingsDuringShift,
        adsOptIn: b.adsOptIn,
    };
}
//# sourceMappingURL=business.service.js.map