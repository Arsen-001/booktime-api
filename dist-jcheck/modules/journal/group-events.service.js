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
import { AuditService } from '../../common/audit/audit.service.js';
import { ApiError } from '../../common/errors/api-error.js';
import { newId } from '../../common/ids/ids.js';
import { localDayRangeUtc, localToUtc, utcToLocalDate } from '../../common/time/time.js';
import { AvailabilityService } from '../availability/availability.service.js';
import { OccupyService, personKeyOf } from '../availability/occupy.js';
import { assertJournal, BookingsService } from './bookings.service.js';
import { groupEventView } from './journal.views.js';
const arr = (v) => (Array.isArray(v) ? v : []);
const addMin = (d, m) => new Date(d.getTime() + m * 60_000);
/**
 * Групповые события (F-01-035, F-16-036…): время мастера и ресурсов держит само событие (busy_blocks,
 * source=group_event, через замок); участники — записи с group_event_id, мест не больше capacity (group_full).
 */
let GroupEventsService = class GroupEventsService {
    constructor(bookings, occupy, availability, audit) {
        this.bookings = bookings;
        this.occupy = occupy;
        this.availability = availability;
        this.audit = audit;
    }
    get prisma() {
        return this.bookings.prisma;
    }
    async list(q) {
        const tz = await this.bookings.tzOfBusiness(this.prisma, q.businessIds[0] ?? '');
        const where = { businessId: { in: q.businessIds } };
        if (q.locationId)
            where.locationId = q.locationId;
        if (q.staffId)
            where.staffId = q.staffId;
        if (q.serviceId)
            where.serviceId = q.serviceId;
        if (q.statuses?.length)
            where.status = { in: q.statuses };
        const range = {};
        if (q.from)
            range.gte = localDayRangeUtc(q.from, tz).from;
        if (q.to)
            range.lt = localDayRangeUtc(q.to, tz).to;
        if (q.from || q.to)
            where.startAt = range;
        const rows = await this.prisma.groupEvent.findMany({ where, orderBy: { startAt: 'asc' } });
        return rows.map((e) => groupEventView(e, tz));
    }
    async occupyEvent(tx, e, replace) {
        const staff = await tx.staff.findUnique({ where: { id: e.staffId }, select: { id: true, userId: true } });
        if (!staff)
            throw new ApiError('not_found', 'Staff not found');
        const svc = await tx.service.findUnique({ where: { id: e.serviceId }, select: { bufferAfterMin: true } });
        const end = addMin(e.startAt, e.durationMin + (svc?.bufferAfterMin ?? 0));
        const resources = await tx.resource.findMany({ where: { businessId: e.businessId }, select: { id: true, instances: true } });
        const res = arr(e.resourceIds)
            .map((id) => {
            const direct = resources.find((r) => r.id === id);
            const owner = direct ?? resources.find((r) => arr(r.instances).some((i) => i.id === id));
            return owner ? { resourceId: owner.id, instances: Math.max(1, arr(owner.instances).length), instanceId: direct ? null : id } : null;
        })
            .filter((x) => Boolean(x));
        return this.occupy.occupy(tx, {
            blocks: [
                {
                    personKey: personKeyOf(staff),
                    staffId: staff.id,
                    businessId: e.businessId,
                    locationId: e.locationId,
                    workplace: 'salon',
                    startAt: e.startAt,
                    endAt: end,
                    serviceEndAt: addMin(e.startAt, e.durationMin),
                    source: 'group_event',
                    sourceId: e.id,
                    visibilityLabel: 'salon',
                },
            ],
            resources: res.map((r) => ({ ...r, businessId: e.businessId, startAt: e.startAt, endAt: end, source: 'group_event', sourceId: e.id })),
            ...(replace ? { replace: { source: 'group_event', sourceId: e.id } } : {}),
        });
    }
    async done(e, keys) {
        const tz = await this.bookings.tzOfLocation(this.prisma, e.locationId);
        await this.availability.invalidate({ businessIds: [e.businessId], staffIds: [e.staffId], personKeys: keys, dates: [utcToLocalDate(e.startAt, tz)] });
        return groupEventView(e, tz);
    }
    async create(ctx, businessId, input) {
        assertJournal(ctx, 'journal.edit', input.staffId);
        const tz = await this.bookings.tzOfLocation(this.prisma, input.locationId);
        let keys = [];
        const row = await this.prisma.$transaction(async (tx) => {
            const e = await tx.groupEvent.create({
                data: {
                    id: newId('groupEvent'),
                    businessId,
                    locationId: input.locationId,
                    serviceId: input.serviceId,
                    staffId: input.staffId,
                    startAt: localToUtc(input.start, tz),
                    durationMin: input.durationMin,
                    capacity: Math.max(1, input.capacity),
                    resourceIds: input.resourceIds ?? [],
                    onlineUrl: input.onlineUrl ?? null,
                    seriesId: input.seriesId ?? null,
                    status: input.status ?? 'scheduled',
                    createdBy: ctx.member.staffId,
                    updatedBy: ctx.member.staffId,
                },
            });
            if (e.status === 'scheduled')
                keys = await this.occupyEvent(tx, e, false);
            await this.audit.record(tx, ctx, { action: 'create', entityType: 'groupEvent', entityId: e.id, businessId, after: { start: input.start, staffId: input.staffId } });
            return e;
        });
        return this.done(row, keys);
    }
    async update(ctx, businessIds, id, patch) {
        let keys = [];
        const row = await this.prisma.$transaction(async (tx) => {
            const prev = await tx.groupEvent.findFirst({ where: { id, businessId: { in: businessIds } } });
            if (!prev)
                throw new ApiError('not_found', 'Event not found');
            assertJournal(ctx, 'journal.edit', prev.staffId);
            const tz = await this.bookings.tzOfLocation(tx, patch.locationId ?? prev.locationId);
            const saved = await tx.groupEvent.update({
                where: { id },
                data: {
                    ...(patch.locationId !== undefined ? { locationId: patch.locationId } : {}),
                    ...(patch.serviceId !== undefined ? { serviceId: patch.serviceId } : {}),
                    ...(patch.staffId !== undefined ? { staffId: patch.staffId } : {}),
                    ...(patch.start !== undefined ? { startAt: localToUtc(patch.start, tz) } : {}),
                    ...(patch.durationMin !== undefined ? { durationMin: patch.durationMin } : {}),
                    ...(patch.capacity !== undefined ? { capacity: Math.max(1, patch.capacity) } : {}),
                    ...(patch.resourceIds !== undefined ? { resourceIds: patch.resourceIds } : {}),
                    ...(patch.onlineUrl !== undefined ? { onlineUrl: patch.onlineUrl || null } : {}),
                    ...(patch.seriesId !== undefined ? { seriesId: patch.seriesId || null } : {}),
                    ...(patch.status !== undefined ? { status: patch.status } : {}),
                    updatedBy: ctx.member.staffId,
                    version: { increment: 1 },
                },
            });
            if (saved.status !== 'scheduled')
                keys = await this.occupy.release(tx, 'group_event', id);
            else
                keys = await this.occupyEvent(tx, saved, true);
            await this.audit.record(tx, ctx, {
                action: 'update',
                entityType: 'groupEvent',
                entityId: id,
                businessId: prev.businessId,
                before: { startAt: prev.startAt.toISOString(), staffId: prev.staffId, status: prev.status, capacity: prev.capacity },
                after: { startAt: saved.startAt.toISOString(), staffId: saved.staffId, status: saved.status, capacity: saved.capacity },
            });
            return saved;
        });
        return this.done(row, keys);
    }
};
GroupEventsService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [BookingsService,
        OccupyService,
        AvailabilityService,
        AuditService])
], GroupEventsService);
export { GroupEventsService };
//# sourceMappingURL=group-events.service.js.map