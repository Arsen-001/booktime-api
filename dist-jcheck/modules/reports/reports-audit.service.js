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
import { PrismaService } from '../../common/prisma.service.js';
import { utcToLocal } from '../../common/time/time.js';
const ENTITY_TYPE_OF = { booking: 'booking', financeOperation: 'finOp', stockOperation: 'stockOperation' };
const ACTION_OF = { create: 'create', update: 'update', status: 'update', pay: 'update', cancel: 'delete', delete: 'delete', restore: 'restore', refund: 'update' };
/**
 * «Изменения данных» (F-12-076/077, docs/backend/02 §16 `dataChanges` — не в списке 11 маршрутов документа,
 * но дёшево реализуется поверх уже существующего журнала AuditEvent (этап 1, `AuditService`), который bookings/
 * stock-ops/fin-ops уже пишут). Отличие от мока: там своя лента на каждый раздел (BookingEvent, journal history,
 * снимки stock/finance); здесь один общий журнал — решение записано в docs/PROGRESS.md этапа 16.
 */
let ReportsAuditService = class ReportsAuditService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async dataChanges(businessId, filters) {
        const entityTypes = filters.entity ? [ENTITY_TYPE_OF[filters.entity]] : Object.values(ENTITY_TYPE_OF);
        const from = new Date(`${filters.from}T00:00:00.000Z`);
        const to = new Date(`${filters.to}T23:59:59.999Z`);
        const events = await this.prisma.auditEvent.findMany({
            where: { businessId, entityType: { in: entityTypes }, at: { gte: from, lte: to } },
            orderBy: { at: 'asc' },
            take: 5000,
        });
        const byEntity = new Map();
        for (const e of events) {
            const key = `${e.entityType}:${e.entityId}`;
            const list = byEntity.get(key) ?? [];
            list.push(e);
            byEntity.set(key, list);
        }
        const entityFromType = { booking: 'booking', finOp: 'financeOperation', stockOperation: 'stockOperation' };
        const clientIds = [
            ...new Set(events
                .map((e) => e.diff?.clientId?.[1])
                .filter((x) => typeof x === 'string')),
        ];
        const clients = clientIds.length ? await this.prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, name: true } }) : [];
        const clientNameMap = new Map(clients.map((c) => [c.id, c.name]));
        let rows = [...byEntity.entries()].map(([key, list]) => {
            const [entityType, entityId] = key.split(':');
            const last = list[list.length - 1];
            return {
                id: `dc_${key}`,
                entity: entityFromType[entityType],
                entityId: entityId,
                entityLabel: clientNameMap.get(entityId) ?? '',
                deleted: last.action === 'delete' || last.action === 'cancel',
                authorName: last.actorName,
                action: ACTION_OF[last.action] ?? 'update',
                at: utcToLocal(last.at),
                history: list.map((e) => ({ at: utcToLocal(e.at), authorName: e.actorName, summary: e.action })),
            };
        });
        if (filters.entity)
            rows = rows.filter((r) => r.entity === filters.entity);
        if (filters.action)
            rows = rows.filter((r) => r.action === filters.action);
        if (filters.authorName)
            rows = rows.filter((r) => r.authorName === filters.authorName);
        return rows.sort((a, b) => b.at.localeCompare(a.at));
    }
};
ReportsAuditService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [PrismaService])
], ReportsAuditService);
export { ReportsAuditService };
//# sourceMappingURL=reports-audit.service.js.map