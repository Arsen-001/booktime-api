import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service.js';
import { utcToLocal } from '../../common/time/time.js';

export type DataChangeEntity = 'booking' | 'financeOperation' | 'stockOperation';
export type DataChangeAction = 'create' | 'update' | 'delete' | 'restore';

const ENTITY_TYPE_OF: Record<DataChangeEntity, string> = { booking: 'booking', financeOperation: 'finOp', stockOperation: 'stockOperation' };
const ACTION_OF: Record<string, DataChangeAction> = { create: 'create', update: 'update', status: 'update', pay: 'update', cancel: 'delete', delete: 'delete', restore: 'restore', refund: 'update' };

/**
 * «Изменения данных» (F-12-076/077, docs/backend/02 §16 `dataChanges` — не в списке 11 маршрутов документа,
 * но дёшево реализуется поверх уже существующего журнала AuditEvent (этап 1, `AuditService`), который bookings/
 * stock-ops/fin-ops уже пишут). Отличие от мока: там своя лента на каждый раздел (BookingEvent, journal history,
 * снимки stock/finance); здесь один общий журнал — решение записано в docs/PROGRESS.md этапа 16.
 */
@Injectable()
export class ReportsAuditService {
  constructor(private readonly prisma: PrismaService) {}

  async dataChanges(businessId: string, filters: { from: string; to: string; entity?: DataChangeEntity; authorName?: string; action?: DataChangeAction }) {
    const entityTypes = filters.entity ? [ENTITY_TYPE_OF[filters.entity]] : Object.values(ENTITY_TYPE_OF);
    const from = new Date(`${filters.from}T00:00:00.000Z`);
    const to = new Date(`${filters.to}T23:59:59.999Z`);
    const events = await this.prisma.auditEvent.findMany({
      where: { businessId, entityType: { in: entityTypes }, at: { gte: from, lte: to } },
      orderBy: { at: 'asc' },
      take: 5000,
    });
    const byEntity = new Map<string, typeof events>();
    for (const e of events) {
      const key = `${e.entityType}:${e.entityId}`;
      const list = byEntity.get(key) ?? [];
      list.push(e);
      byEntity.set(key, list);
    }
    const entityFromType: Record<string, DataChangeEntity> = { booking: 'booking', finOp: 'financeOperation', stockOperation: 'stockOperation' };
    const clientIds = [
      ...new Set(
        events
          .map((e) => (e.diff as Record<string, [unknown, unknown]> | null)?.clientId?.[1])
          .filter((x): x is string => typeof x === 'string'),
      ),
    ];
    const clients = clientIds.length ? await this.prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, name: true } }) : [];
    const clientNameMap = new Map(clients.map((c) => [c.id, c.name] as const));

    let rows = [...byEntity.entries()].map(([key, list]) => {
      const [entityType, entityId] = key.split(':');
      const last = list[list.length - 1]!;
      return {
        id: `dc_${key}`,
        entity: entityFromType[entityType!]!,
        entityId: entityId!,
        entityLabel: clientNameMap.get(entityId!) ?? '',
        deleted: last.action === 'delete' || last.action === 'cancel',
        authorName: last.actorName,
        action: ACTION_OF[last.action] ?? 'update',
        at: utcToLocal(last.at),
        history: list.map((e) => ({ at: utcToLocal(e.at), authorName: e.actorName, summary: e.action })),
      };
    });
    if (filters.entity) rows = rows.filter((r) => r.entity === filters.entity);
    if (filters.action) rows = rows.filter((r) => r.action === filters.action);
    if (filters.authorName) rows = rows.filter((r) => r.authorName === filters.authorName);
    return rows.sort((a, b) => b.at.localeCompare(a.at));
  }
}
