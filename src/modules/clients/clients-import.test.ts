/**
 * Импорт клиентов пачками (04.10.2026, «переезд за минуту»): нормализация телефонов (+374 и иностранные), повторы в
 * пачке, «дополнить пустые поля» без удвоения сумм, «пропустить», пробный прогон без записи, журнал прогона из
 * нескольких пачек, право clients.edit и лимит 1000 строк. База — в памяти. Запуск: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { normalizeImportPhone, cleanImportRow, fillEmptyPatch } = await import('./clients-import.rules.js');
const { ClientsImportExportService } = await import('./clients-import-export.service.js');
const { importBatchBody } = await import('./clients.schemas.js');
const { ClientsController } = await import('./clients.controller.js');
const { BizGuard } = await import('../../common/http/guards.js');
const { RateLimitGuard } = await import('../../common/rate-limit/rate-limit.js');
const { ApiError } = await import('../../common/errors/api-error.js');

type Row = Record<string, unknown>;

function matches(r: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v === undefined) return true;
    if (v === null) return r[k] === null || r[k] === undefined;
    if (typeof v === 'object' && v && 'in' in v) return (v as { in: unknown[] }).in.includes(r[k]);
    return r[k] === v;
  });
}

function applyData(row: Row, data: Row) {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && 'increment' in (v as Row)) row[k] = ((row[k] as number) ?? 0) + (v as { increment: number }).increment;
    else if (v !== undefined) row[k] = v;
  }
  return row;
}

function table(rows: Row[] = []) {
  return {
    rows,
    findFirst: async ({ where }: { where?: Row } = {}) => rows.find((r) => matches(r, where)) ?? null,
    findMany: async ({ where }: { where?: Row } = {}) => rows.filter((r) => matches(r, where)),
    create: async ({ data }: { data: Row }) => (rows.push({ ...data }), data),
    createMany: async ({ data }: { data: Row[] }) => (rows.push(...data.map((d) => ({ ...d }))), { count: data.length }),
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const r = rows.find((x) => matches(x, where));
      if (!r) throw new Error('not found');
      return applyData(r, data);
    },
  };
}

function client(over: Row = {}): Row {
  return {
    id: 'cl_1',
    businessId: 'biz_1',
    phone: '+37493000001',
    name: 'Ани',
    lastName: null,
    email: null,
    note: null,
    birthday: null,
    gender: 'unknown',
    tags: [],
    additionalPhone: null,
    discountPercent: 0,
    cardNumber: null,
    importedSold: 0n,
    paidAmount: 0n,
    deletedAt: null,
    version: 1,
    ...over,
  };
}

function setup(clients: Row[] = []) {
  // auditEvent — общий журнал «Операции с данными» (staff/data-ops.ts): одна строка на прогон импорта
  const db = { client: table(clients), clientImportRun: table(), auditEvent: table(), audits: [] as Row[] };
  const prisma = { ...db, $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db) };
  const audit = { record: async (_tx: unknown, _ctx: unknown, input: Row) => void db.audits.push(input) };
  const svc = new ClientsImportExportService(prisma as never, audit as never);
  const ctx = { member: { staffId: 'st_1', businessId: 'biz_1' } } as never;
  return { db, svc, ctx };
}

const base = { onExisting: 'fillEmpty' as const, authorName: 'Лилит', method: 'file' as const };

// ─────────────────────────── телефоны ───────────────────────────

test('normalizeImportPhone: армянские номера в любом виде → +374XXXXXXXX', () => {
  for (const raw of ['093 000 001', '93000001', '374 93 00 00 01', '+374-93-000-001', '(+374) 093 000 001', '37493000001', '0037493000001', '3.7493000001E+10']) {
    assert.deepEqual(normalizeImportPhone(raw), { phone: '+37493000001', foreign: false }, raw);
  }
  // «00» в начале — международный выход только перед полным номером; «000 900 001» — местный с кодом 00 (демо)
  assert.deepEqual(normalizeImportPhone('000 900 001'), { phone: '+37400900001', foreign: false });
  assert.deepEqual(normalizeImportPhone('0044 7700 900123'), { phone: '+447700900123', foreign: true });
});

test('normalizeImportPhone: иностранные — E.164 с пометкой, мусор — нет', () => {
  assert.deepEqual(normalizeImportPhone('+7 916 123-45-67'), { phone: '+79161234567', foreign: true });
  assert.deepEqual(normalizeImportPhone('79161234567'), { phone: '+79161234567', foreign: true });
  assert.deepEqual(normalizeImportPhone('+1 (415) 555-0100'), { phone: '+14155550100', foreign: true });
  for (const raw of ['', '12345', '+374 93 00', 'abc', '0123456789012']) assert.equal(normalizeImportPhone(raw), undefined, raw);
});

test('cleanImportRow: плохие почта, дата и второй номер выбрасываются, строка остаётся; без имени — номер', () => {
  const r = cleanImportRow({ rowIndex: 3, name: '  ', phone: '093000002', email: 'bad@', birthday: '1990-02-31', additionalPhone: '12' });
  assert.ok('row' in r);
  assert.deepEqual(r.row, { rowIndex: 3, name: '+37493000002', phone: '+37493000002' });
  assert.deepEqual(cleanImportRow({ rowIndex: 0, name: 'A', phone: '' }), { error: 'noPhone' });
  assert.deepEqual(cleanImportRow({ rowIndex: 0, name: 'A', phone: '555' }), { error: 'phoneFormat' });
});

// ─────────────────────────── пачка ───────────────────────────

test('importBatch: новые создаются одной пачкой, повтор номера в пачке пропускается, ошибки — по строкам', async () => {
  const { db, svc, ctx } = setup();
  const res = await svc.importBatch(ctx, 'biz_1', {
    ...base,
    rows: [
      { rowIndex: 0, name: 'Ани', phone: '093 000 001', email: 'ANI@x.am', tags: ['VIP'], sold: 45000, paid: 40000, birthday: '1990-03-15', gender: 'female' },
      { rowIndex: 1, name: 'Ани ещё раз', phone: '+374 93 000 001' },
      { rowIndex: 2, name: 'Без номера', phone: '' },
      { rowIndex: 3, name: 'Гость', phone: '+7 916 123 45 67' },
    ],
  });
  assert.deepEqual(
    res.results.map((r) => [r.rowIndex, r.status, r.code]),
    [
      [0, 'created', undefined],
      [1, 'skipped', 'duplicateInFile'],
      [2, 'error', 'noPhone'],
      [3, 'created', undefined],
    ],
  );
  assert.equal(db.client.rows.length, 2);
  const ani = db.client.rows.find((c) => c.phone === '+37493000001')!;
  assert.equal(ani.email, 'ani@x.am');
  assert.deepEqual(ani.tags, ['VIP']);
  assert.equal(ani.importedSold, 45000n);
  assert.equal(ani.paidAmount, 40000n);
  assert.equal(ani.source, 'import');
  assert.ok(db.client.rows.some((c) => c.phone === '+79161234567'));
  assert.ok(res.runId);
  const run = db.clientImportRun.rows[0]!;
  assert.deepEqual([run.totalRows, run.createdCount, run.updatedCount, run.rejectedCount], [4, 2, 0, 1]);
});

test('importBatch fillEmpty: дописывает только пустое, имя не меняет; повтор того же файла ничего не удваивает', async () => {
  const { db, svc, ctx } = setup([client({ email: 'old@x.am', paidAmount: 500n })]);
  const rows = [{ rowIndex: 0, name: 'Анна', phone: '37493000001', email: 'new@x.am', birthday: '1990-03-15', note: 'Любит кофе', sold: 1000, paid: 1000 }];
  const first = await svc.importBatch(ctx, 'biz_1', { ...base, rows });
  assert.equal(first.results[0]!.status, 'updated');
  const c = db.client.rows[0]!;
  assert.equal(c.name, 'Ани');
  assert.equal(c.email, 'old@x.am');
  assert.equal(c.birthday, '1990-03-15');
  assert.equal(c.note, 'Любит кофе');
  assert.equal(c.importedSold, 1000n);
  assert.equal(c.paidAmount, 500n, 'оплачено уже было — не трогаем');
  assert.equal(c.version, 2);

  const again = await svc.importBatch(ctx, 'biz_1', { ...base, rows });
  assert.deepEqual([again.results[0]!.status, again.results[0]!.code], ['skipped', 'nothingToFill']);
  assert.equal(db.client.rows[0]!.importedSold, 1000n);
  assert.equal(db.client.rows.length, 1);
});

test('importBatch skip: номер уже в базе — карточка не меняется', async () => {
  const { db, svc, ctx } = setup([client()]);
  const res = await svc.importBatch(ctx, 'biz_1', { ...base, onExisting: 'skip', rows: [{ rowIndex: 0, name: 'X', phone: '093000001', email: 'x@x.am' }] });
  assert.deepEqual([res.results[0]!.status, res.results[0]!.code, res.results[0]!.clientId], ['skipped', 'exists', 'cl_1']);
  assert.equal(db.client.rows[0]!.email, null);
});

test('importBatch dryRun: те же решения по строкам, но без записи и без журнала', async () => {
  const { db, svc, ctx } = setup([client()]);
  const res = await svc.importBatch(ctx, 'biz_1', {
    ...base,
    dryRun: true,
    rows: [
      { rowIndex: 0, name: 'Ани', phone: '093000001', email: 'a@x.am' },
      { rowIndex: 1, name: 'Новая', phone: '093000009' },
    ],
  });
  assert.deepEqual(
    res.results.map((r) => r.status),
    ['updated', 'created'],
  );
  assert.equal(res.runId, undefined);
  assert.equal(db.client.rows.length, 1);
  assert.equal(db.client.rows[0]!.email, null);
  assert.equal(db.clientImportRun.rows.length, 0);
  assert.equal(db.audits.length, 0);
});

test('importBatch: клиенты другого бизнеса и удалённые не считаются «уже в базе»', async () => {
  const { db, svc, ctx } = setup([client({ businessId: 'biz_2' }), client({ id: 'cl_del', deletedAt: new Date() })]);
  const res = await svc.importBatch(ctx, 'biz_1', { ...base, rows: [{ rowIndex: 0, name: 'Ани', phone: '093000001' }] });
  assert.equal(res.results[0]!.status, 'created');
  assert.equal(db.client.rows.length, 3);
});

test('importBatch: прогон из нескольких пачек — одна строка журнала, отказы экрана считаются один раз', async () => {
  const { db, svc, ctx } = setup();
  const first = await svc.importBatch(ctx, 'biz_1', { ...base, rejectedBeforeSend: 2, rows: [{ rowIndex: 0, name: 'A', phone: '093000001' }] });
  await svc.importBatch(ctx, 'biz_1', { ...base, runId: first.runId, rows: [{ rowIndex: 1, name: 'B', phone: '093000002' }, { rowIndex: 2, name: 'C', phone: 'x' }] });
  assert.equal(db.clientImportRun.rows.length, 1);
  const run = db.clientImportRun.rows[0]!;
  assert.deepEqual([run.totalRows, run.createdCount, run.rejectedCount], [5, 2, 3]);
  // «Операции с данными»: прогон из двух пачек — одна строка, числа — итог прогона
  const ops = db.auditEvent.rows.filter((r) => r.action === 'data_op');
  assert.equal(ops.length, 1);
  assert.equal(ops[0]!.entityId, run.id);
  assert.deepEqual([(ops[0]!.diff as Row).count, (ops[0]!.diff as Row).failed], [[null, 2], [null, 3]]);
  // чужой runId не прибавляется к чужому журналу — заводится новый прогон
  db.clientImportRun.rows[0]!.businessId = 'biz_2';
  await svc.importBatch(ctx, 'biz_1', { ...base, runId: first.runId, rows: [{ rowIndex: 0, name: 'D', phone: '093000003' }] });
  assert.equal(db.clientImportRun.rows.length, 2);
});

test('лимит пачки: больше 1000 строк не проходит ни схему, ни сервис', async () => {
  const rows = Array.from({ length: 1001 }, (_, i) => ({ rowIndex: i, name: `C${i}`, phone: `0930${String(i).padStart(5, '0')}` }));
  assert.equal(importBatchBody.safeParse({ ...base, rows }).success, false);
  assert.equal(importBatchBody.safeParse({ ...base, rows: rows.slice(0, 1000) }).success, true);
  assert.equal(importBatchBody.safeParse({ ...base, rows: [] }).success, false);
  const { svc, ctx } = setup();
  await assert.rejects(svc.importBatch(ctx, 'biz_1', { ...base, rows }), (e: unknown) => e instanceof ApiError && e.code === 'too_many_rows');
});

test('маршрут импорта: право clients.edit, проверка бизнеса и лимит частоты', () => {
  const handler = (ClientsController.prototype as unknown as Record<string, object>)['importClients']!;
  const guards: unknown[] = Reflect.getMetadata('__guards__', handler) ?? [];
  assert.ok(guards.includes(BizGuard));
  assert.ok(guards.includes(RateLimitGuard));
  assert.deepEqual(Reflect.getMetadata('bt:required-permissions', handler), ['clients.edit']);
});

test('fillEmptyPatch: пол «не указан» заполняется, указанный — нет; категории — только если их не было', () => {
  const ex = { lastName: null, email: null, note: null, birthday: null, gender: 'female', tags: ['VIP'], additionalPhone: null, discountPercent: 5, cardNumber: null, importedSold: 0n, paidAmount: 0n };
  assert.deepEqual(fillEmptyPatch(ex, { rowIndex: 0, name: 'A', phone: '+37493000001', gender: 'male', tags: ['New'], discountPercent: 10, lastName: 'Б' }), { lastName: 'Б' });
});
