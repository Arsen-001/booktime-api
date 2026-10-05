/** «Операции с данными» на сервере (F-02-063, F-14-114): запись, прогон одной строкой, чтение с фильтрами. Запуск: npm test */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DATA_OP_ACTION, dataOpBody, listDataOps, recordDataOp } from './data-ops.js';

interface Row { id: string; businessId: string | null; actorType: string; actorId: string | null; actorName: string; action: string; entityType: string; entityId: string; diff: unknown; at: Date }

function fakeDb() {
  const rows: Row[] = [];
  let tick = 0;
  const match = (r: Row, w: Record<string, unknown>) => Object.entries(w).every(([k, v]) => (r as unknown as Record<string, unknown>)[k] === v);
  const db = {
    auditEvent: {
      create: async ({ data }: { data: Omit<Row, 'at'> }) => {
        rows.push({ ...data, at: new Date(Date.UTC(2026, 9, 6, 8, tick++)) } as Row);
      },
      findFirst: async ({ where }: { where: Record<string, unknown> }) => rows.find((r) => match(r, where)) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: { diff: unknown } }) => {
        rows.find((r) => r.id === where.id)!.diff = data.diff;
      },
      findMany: async ({ where }: { where: Record<string, unknown> }) => rows.filter((r) => match(r, where)).sort((a, b) => b.at.getTime() - a.at.getTime()),
    },
  };
  return { db: db as never, rows };
}

const staffCtx = { requestId: 'rq', member: { businessId: 'biz_1', staffId: 'st_lilit', name: 'Лилит', permissions: new Set<string>() } } as never;

test('операция пишется в audit_events с автором из сессии; читается в форме экрана', async () => {
  const { db, rows } = fakeDb();
  await recordDataOp(db, staffCtx, 'biz_1', { kind: 'export', area: 'clients', entity: 'clients', count: 120, fileName: 'clients.xlsx' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.action, DATA_OP_ACTION);
  const [op] = await listDataOps(db, 'biz_1');
  assert.deepEqual(op, {
    id: rows[0]!.id,
    businessId: 'biz_1',
    kind: 'export',
    area: 'clients',
    entity: 'clients',
    count: 120,
    fileName: 'clients.xlsx',
    by: 'st_lilit',
    byName: 'Лилит',
    at: '2026-10-06T12:00',
  });
});

test('прогон импорта пачками — одна строка, числа обновляются', async () => {
  const { db, rows } = fakeDb();
  await recordDataOp(db, staffCtx, 'biz_1', { kind: 'import', area: 'clients', entity: 'clients', count: 900 }, 'run_1');
  await recordDataOp(db, staffCtx, 'biz_1', { kind: 'import', area: 'clients', entity: 'clients', count: 1700, failed: 3 }, 'run_1');
  assert.equal(rows.length, 1);
  const [op] = await listDataOps(db, 'biz_1');
  assert.equal(op!.count, 1700);
  assert.equal(op!.failed, 3);
});

test('фильтр по виду и разделу, новые первыми; чужой бизнес не виден; без сессии — system', async () => {
  const { db } = fakeDb();
  await recordDataOp(db, staffCtx, 'biz_1', { kind: 'import', area: 'services', entity: 'services', count: 10 });
  await recordDataOp(db, null, 'biz_1', { kind: 'delete', area: 'resources', entity: 'groupEvents', count: 4 });
  await recordDataOp(db, staffCtx, 'biz_2', { kind: 'export', area: 'clients', entity: 'clients', count: 1 });
  const all = await listDataOps(db, 'biz_1');
  assert.deepEqual(all.map((o) => o.entity), ['groupEvents', 'services']);
  assert.equal(all[0]!.by, 'system');
  assert.deepEqual((await listDataOps(db, 'biz_1', { kinds: ['import'] })).map((o) => o.area), ['services']);
  assert.deepEqual((await listDataOps(db, 'biz_1', { area: 'resources' })).map((o) => o.kind), ['delete']);
});

test('тело запроса экрана: только известные виды, короткие имена без мусора', () => {
  assert.equal(dataOpBody.safeParse({ kind: 'export', area: 'reports', entity: 'appointments', count: 5, fileName: 'a.csv' }).success, true);
  assert.equal(dataOpBody.safeParse({ kind: 'drop', area: 'reports', entity: 'x', count: 1 }).success, false);
  assert.equal(dataOpBody.safeParse({ kind: 'export', area: '<script>', entity: 'x', count: 1 }).success, false);
  assert.equal(dataOpBody.safeParse({ kind: 'export', area: 'clients', entity: 'clients', count: -1 }).success, false);
});
