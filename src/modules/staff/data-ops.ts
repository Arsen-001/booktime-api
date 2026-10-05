import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.js';
import { actorOf } from '../../common/audit/audit.service.js';
import type { RequestContext } from '../../common/http/context.js';
import { newId } from '../../common/ids/ids.js';
import type { PrismaService } from '../../common/prisma.service.js';
import { utcToLocal } from '../../common/time/time.js';

type Db = Prisma.TransactionClient | PrismaService;

/**
 * Общий журнал «Операции с данными» (F-02-063, F-14-114, F-00-082, F-04-126/130, F-16-066): загрузки и выгрузки Excel,
 * массовое удаление — кто, когда, что и сколько. Хранится в audit_events (action = 'data_op', без новой таблицы):
 * entityType 'dataOp', entityId — id прогона (импорт клиентов пачками — одна строка на прогон) или новый id,
 * поля операции — в diff как [null, значение], как у остальных строк журнала.
 *
 * Пишут: сервер — там, где операция идёт одним запросом (клиенты: выгрузка и импорт, перерыв услуг из Excel,
 * массовая отмена групповых событий, импорт визитов); экран — POST …/data-ops для операций, которые собирает сам
 * (выгрузка файла в браузере, импорт каталога и массовое удаление услуг из отдельных запросов). Читает — экран
 * «Журнал безопасности → Операции с данными» (GET …/data-ops, право clients.export).
 */
export const DATA_OP_ACTION = 'data_op';
export const DATA_OP_ENTITY = 'dataOp';

export const dataOpBody = z.object({
  kind: z.enum(['import', 'export', 'delete']),
  /** Раздел, сделавший операцию: clients, services, reports, resources, journal… */
  area: z.string().min(1).max(20).regex(/^[a-zA-Z][\w-]*$/),
  /** Что: clients, services, appointments, groupEvents… */
  entity: z.string().min(1).max(40).regex(/^[a-zA-Z][\w-]*$/),
  count: z.number().int().min(0).max(1_000_000),
  failed: z.number().int().min(0).max(1_000_000).optional(),
  fileName: z.string().max(200).optional(),
});
export type DataOpInput = z.infer<typeof dataOpBody>;

export const dataOpOut = z.object({
  id: z.string(),
  businessId: z.string(),
  kind: z.enum(['import', 'export', 'delete']),
  area: z.string(),
  entity: z.string(),
  count: z.number(),
  failed: z.number().optional(),
  fileName: z.string().optional(),
  /** Кто: id сотрудника или 'system' */
  by: z.string(),
  /** Имя на момент операции */
  byName: z.string(),
  at: z.string(),
});
export type DataOpView = z.infer<typeof dataOpOut>;

type Diff = Record<string, [unknown, unknown]>;

function diffOfOp(op: DataOpInput): Diff {
  const diff: Diff = { kind: [null, op.kind], area: [null, op.area], entity: [null, op.entity], count: [null, op.count] };
  if (op.failed) diff.failed = [null, op.failed];
  if (op.fileName) diff.fileName = [null, op.fileName];
  return diff;
}

/**
 * Записать операцию — в той же транзакции, что и сама операция (упала — строки не будет). refId — одна строка на
 * прогон: повторный вызов с тем же refId обновляет числа, а не добавляет строку (импорт клиентов пачками).
 */
export async function recordDataOp(db: Db, ctx: RequestContext | null, businessId: string, op: DataOpInput, refId?: string): Promise<string> {
  const diff = diffOfOp(op) as Prisma.InputJsonValue;
  if (refId) {
    const prev = await db.auditEvent.findFirst({ where: { businessId, action: DATA_OP_ACTION, entityType: DATA_OP_ENTITY, entityId: refId }, select: { id: true } });
    if (prev) {
      await db.auditEvent.update({ where: { id: prev.id }, data: { diff } });
      return prev.id;
    }
  }
  const id = newId('auditEvent');
  await db.auditEvent.create({
    data: {
      id,
      businessId,
      ...actorOf(ctx),
      action: DATA_OP_ACTION,
      entityType: DATA_OP_ENTITY,
      entityId: refId ?? id,
      diff,
      requestId: ctx?.requestId ?? null,
      ip: ctx?.ip ?? null,
      device: ctx?.device ?? null,
    },
  });
  return id;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** Строка audit_events → операция экрана (DataOperation фронта + byName) */
export function dataOpView(r: { id: string; businessId: string | null; actorType: string; actorId: string | null; actorName: string; diff: unknown; at: Date }, tz?: string): DataOpView {
  const d = (r.diff ?? {}) as Diff;
  const kind = str(d.kind?.[1]);
  const failed = num(d.failed?.[1]);
  const fileName = str(d.fileName?.[1]);
  return {
    id: r.id,
    businessId: r.businessId ?? '',
    kind: kind === 'import' || kind === 'delete' ? kind : 'export',
    area: str(d.area?.[1]),
    entity: str(d.entity?.[1]),
    count: num(d.count?.[1]),
    ...(failed ? { failed } : {}),
    ...(fileName ? { fileName } : {}),
    by: r.actorType === 'staff' && r.actorId ? r.actorId : 'system',
    byName: r.actorName,
    at: utcToLocal(r.at, tz),
  };
}

export interface DataOpsQuery {
  kinds?: DataOpView['kind'][];
  area?: string;
  limit?: number;
}

/** Журнал бизнеса, новые → старые; фильтр по виду и разделу (как listDataOperations мока) */
export async function listDataOps(db: Db, businessId: string, q: DataOpsQuery = {}, tz?: string): Promise<DataOpView[]> {
  const rows = await db.auditEvent.findMany({
    where: { businessId, action: DATA_OP_ACTION, entityType: DATA_OP_ENTITY },
    orderBy: { at: 'desc' },
    take: Math.min(Math.max(q.limit ?? 500, 1), 500),
  });
  return rows.map((r) => dataOpView(r, tz)).filter((o) => (!q.kinds?.length || q.kinds.includes(o.kind)) && (!q.area || o.area === q.area));
}
