var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { ApiError } from '../../common/errors/api-error.js';
import { newId } from '../../common/ids/ids.js';
/** Ключ человека: мастер с аккаунтом — user_id, без аккаунта — staff.id */
export function personKeyOf(staff) {
    return staff.userId ?? staff.id;
}
/** Что показать чужому бизнесу по месту работы */
export function visibilityOf(workplace) {
    if (workplace === 'home')
        return 'home';
    if (workplace === 'visit')
        return 'visit';
    return 'salon';
}
let OccupyService = class OccupyService {
    /** FOR UPDATE по строкам замков в порядке ключа. Строки создаются при первом обращении. */
    async lock(tx, personKeys, resourceIds = []) {
        const people = [...new Set(personKeys)].sort();
        const res = [...new Set(resourceIds)].sort();
        if (people.length) {
            await tx.$executeRaw `INSERT IGNORE INTO person_locks (person_key) VALUES ${Prisma.join(people.map((p) => Prisma.sql `(${p})`))}`;
            await tx.$queryRaw `SELECT person_key FROM person_locks WHERE person_key IN (${Prisma.join(people)}) ORDER BY person_key FOR UPDATE`;
        }
        if (res.length) {
            await tx.$executeRaw `INSERT IGNORE INTO resource_locks (resource_id) VALUES ${Prisma.join(res.map((r) => Prisma.sql `(${r})`))}`;
            await tx.$queryRaw `SELECT resource_id FROM resource_locks WHERE resource_id IN (${Prisma.join(res)}) ORDER BY resource_id FOR UPDATE`;
        }
    }
    /** Снять занятость источника (отмена, удаление, «не пришёл» без «поверх неявок» — решает вызывающий) */
    async release(tx, source, sourceId) {
        const rows = await tx.busyBlock.findMany({ where: { source, sourceId, active: true }, select: { personKey: true } });
        await tx.busyBlock.updateMany({ where: { source, sourceId, active: true }, data: { active: false } });
        await tx.resourceBusy.updateMany({ where: { source, sourceId, active: true }, data: { active: false } });
        return [...new Set(rows.map((r) => r.personKey))];
    }
    /** Держать до (подтверждение/предоплата) — снять или продлить удержание без пересчёта блоков */
    async setHold(tx, source, sourceId, holdUntil) {
        await tx.busyBlock.updateMany({ where: { source, sourceId, active: true }, data: { holdUntil } });
        await tx.resourceBusy.updateMany({ where: { source, sourceId, active: true }, data: { holdUntil } });
    }
    /** Пометить «не пришёл» у занятости источника (F-02-066) */
    async setNoShow(tx, source, sourceId, noShow) {
        await tx.busyBlock.updateMany({ where: { source, sourceId, active: true }, data: { noShow } });
        await tx.resourceBusy.updateMany({ where: { source, sourceId, active: true }, data: { noShow } });
    }
    /**
     * Занять время. Бросает 409 slot_taken, если время человека (или ресурса) уже занято. Возвращает ключи людей —
     * для сброса кеша окон после коммита.
     */
    async occupy(tx, input) {
        const people = input.blocks.map((b) => b.personKey);
        const resourceIds = (input.resources ?? []).map((r) => r.resourceId);
        await this.lock(tx, people, resourceIds);
        if (input.replace)
            await this.release(tx, input.replace.source, input.replace.sourceId);
        if (!input.allowOverlap) {
            const now = new Date();
            for (const b of input.blocks) {
                const clash = await tx.busyBlock.findFirst({
                    where: {
                        personKey: b.personKey,
                        active: true,
                        source: { not: 'mark_busy' },
                        startAt: { lt: b.endAt },
                        endAt: { gt: b.startAt },
                        OR: [{ holdUntil: null }, { holdUntil: { gt: now } }],
                        ...(input.ignoreNoShow ? { noShow: false } : {}),
                    },
                    select: { id: true },
                });
                if (clash)
                    throw new ApiError('slot_taken', 'Staff is busy at this time');
            }
            for (const r of input.resources ?? []) {
                const used = await tx.resourceBusy.count({
                    where: {
                        resourceId: r.resourceId,
                        active: true,
                        startAt: { lt: r.endAt },
                        endAt: { gt: r.startAt },
                        OR: [{ holdUntil: null }, { holdUntil: { gt: now } }],
                        ...(input.ignoreNoShow ? { noShow: false } : {}),
                    },
                });
                if (used >= r.instances)
                    throw new ApiError('resource_unavailable', 'Resource is busy at this time');
                if (r.instanceId) {
                    const same = await tx.resourceBusy.count({
                        where: {
                            resourceId: r.resourceId,
                            instanceId: r.instanceId,
                            active: true,
                            startAt: { lt: r.endAt },
                            endAt: { gt: r.startAt },
                            OR: [{ holdUntil: null }, { holdUntil: { gt: now } }],
                            ...(input.ignoreNoShow ? { noShow: false } : {}),
                        },
                    });
                    if (same > 0)
                        throw new ApiError('resource_unavailable', 'Resource instance is busy at this time');
                }
            }
        }
        if (input.blocks.length) {
            await tx.busyBlock.createMany({
                data: input.blocks.map((b) => ({
                    id: newId('busyBlock'),
                    personKey: b.personKey,
                    staffId: b.staffId,
                    businessId: b.businessId,
                    locationId: b.locationId ?? null,
                    workplace: b.workplace ?? null,
                    startAt: b.startAt,
                    endAt: b.endAt,
                    serviceEndAt: b.serviceEndAt ?? b.endAt,
                    source: b.source,
                    sourceId: b.sourceId,
                    visibilityLabel: b.visibilityLabel,
                    holdUntil: b.holdUntil ?? null,
                })),
            });
        }
        if (input.resources?.length) {
            await tx.resourceBusy.createMany({
                data: input.resources.map((r) => ({
                    id: newId('resourceBusy'),
                    resourceId: r.resourceId,
                    businessId: r.businessId,
                    startAt: r.startAt,
                    endAt: r.endAt,
                    source: r.source,
                    sourceId: r.sourceId,
                    instanceId: r.instanceId ?? null,
                    holdUntil: r.holdUntil ?? null,
                })),
            });
        }
        return [...new Set(people)];
    }
};
OccupyService = __decorate([
    Injectable()
], OccupyService);
export { OccupyService };
//# sourceMappingURL=occupy.js.map